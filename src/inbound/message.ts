/**
 * Inbound source: generic messages from any program on this machine.
 *
 *   POST /inbound/message
 *   {
 *     "id": "msg-123",                                   // idempotency key, per caller
 *     "conversation": { "id": "ops", "name": "Ops desk" },
 *     "sender": { "id": "bot-7", "name": "Build bot" },  // optional
 *     "text": "The nightly build failed — summarise the log.",
 *     "attachments": [{ "path": "/abs/path/build.log", "kind": "file" }],  // optional: a local path,
 *                    // or { "name": "x.png", "kind": "image", "data": "<base64>" }; either way the
 *                    // file is copied into the agent's own directory before the agent sees it
 *     "context": ["earlier line", "…"],                  // optional, shown as background
 *     "instructions": "Answer in one paragraph."         // optional, this turn only
 *   }
 *   → 200 { "id": "msg-123", "text": "…" }               // "" = the agent chose not to answer
 *
 * Sessions: `inbound.message.session` — "conversation" gives each caller +
 * conversation id its own session (`inbound:<caller>:<id>`); "shared" puts
 * everything in `inbound:shared`.
 *
 * Idempotent per caller + id: a repeat returns the first answer without
 * running the agent again; a repeat while the first is still running joins it.
 * An agent failure is a 503 and is not remembered, so the caller may retry.
 */

import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { getSettings } from "../config";
import { ensureProjectClaudeMd, runUserMessage } from "../runner";
import { peekThreadSession } from "../sessionManager";
import { transcribeAudioToText } from "../whisper";
import { maskSecrets, screenReply } from "./screen";
import type { InboundContext, InboundReply, InboundSource } from "./server";

const STATE_DIR = join(process.cwd(), ".claude", "claudeclaw", "inbound");
const STATE_FILE = join(STATE_DIR, "message.json");
/** Attachments are copied here: the agent may only read inside its own directory. */
const MEDIA_DIR = join(STATE_DIR, "media");
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DIRECTIVES_PATH = join(import.meta.dir, "..", "..", "prompts", "inbound", "MESSAGE.md");
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_TEXT = 100_000;
const MAX_ATTACHMENTS = 20;
const KEEP_MS = 2 * 24 * 3600 * 1000;
const KEEP_MAX = 2000;

interface Attachment {
  /** Absolute local path… */
  path?: string;
  /** …or the file itself, base64. */
  data?: string;
  name?: string;
  kind?: "image" | "file" | "audio" | "video";
}

interface MessageRequest {
  id: string;
  conversation: { id: string; name?: string };
  sender?: { id?: string; name?: string };
  text: string;
  attachments?: Attachment[];
  context?: string[];
  instructions?: string;
}

/** Validate the body. Returns the request, or the reason it was refused. */
function parse(payload: unknown): MessageRequest | string {
  const p = payload as Partial<MessageRequest> | null;
  if (!p || typeof p !== "object") return "body must be a JSON object";
  if (typeof p.id !== "string" || !ID.test(p.id)) return "id: 1–128 chars of [A-Za-z0-9_.:-]";
  if (!p.conversation || typeof p.conversation.id !== "string" || !ID.test(p.conversation.id)) return "conversation.id: 1–128 chars of [A-Za-z0-9_.:-]";
  if (p.conversation.name !== undefined && typeof p.conversation.name !== "string") return "conversation.name must be a string";
  if (p.sender !== undefined && (typeof p.sender !== "object" || p.sender === null)) return "sender must be an object";
  const text = typeof p.text === "string" ? p.text : "";
  const attachments = Array.isArray(p.attachments) ? p.attachments : [];
  if (!text.trim() && attachments.length === 0) return "text (or at least one attachment) is required";
  if (text.length > MAX_TEXT) return `text longer than ${MAX_TEXT} chars`;
  if (attachments.length > MAX_ATTACHMENTS) return `more than ${MAX_ATTACHMENTS} attachments`;
  for (const a of attachments) {
    if (!a || typeof a !== "object") return "attachments[] must be objects";
    if (typeof a.data === "string") {
      if (!a.name || typeof a.name !== "string") return "attachments[].name is required with data";
      if (a.data.length > (MAX_ATTACHMENT_BYTES * 4) / 3 + 4) return `attachment larger than ${MAX_ATTACHMENT_BYTES} bytes`;
      continue;
    }
    if (typeof a.path !== "string" || !isAbsolute(a.path)) return "attachments[]: give an absolute local path, or name + data (base64)";
    if (!existsSync(a.path) || !statSync(a.path).isFile()) return `attachment not found: ${a.path}`;
    if (statSync(a.path).size > MAX_ATTACHMENT_BYTES) return `attachment larger than ${MAX_ATTACHMENT_BYTES} bytes: ${a.path}`;
  }
  if (p.context !== undefined && !(Array.isArray(p.context) && p.context.every((l) => typeof l === "string"))) return "context must be an array of strings";
  if (p.instructions !== undefined && typeof p.instructions !== "string") return "instructions must be a string";
  return { ...p, text, attachments } as MessageRequest;
}

// ─── Journal ────────────────────────────────────────────────────────────────

interface Journal {
  /** "<caller>:<id>" → the answer already given. */
  answers: Record<string, { text: string; at: string }>;
  /** threadId → which session last got the directives (resent after a reset or compact). */
  sessions: Record<string, { sessionId: string; turn: number }>;
}

let journal: Journal | null = null;
let journalWrite: Promise<void> = Promise.resolve();

async function getJournal(): Promise<Journal> {
  if (journal) return journal;
  journal = { answers: {}, sessions: {} };
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as Partial<Journal>;
      journal = { answers: raw.answers ?? {}, sessions: raw.sessions ?? {} };
    }
  } catch (err) {
    console.error(`[inbound:message] ${STATE_FILE} unreadable, starting empty: ${err instanceof Error ? err.message : err}`);
  }
  return journal;
}

function saveJournal(): Promise<void> {
  journalWrite = journalWrite.then(async () => {
    if (!journal) return;
    const cutoff = Date.now() - KEEP_MS;
    const kept = Object.entries(journal.answers)
      .filter(([, a]) => Date.parse(a.at) >= cutoff)
      .sort((x, y) => Date.parse(y[1].at) - Date.parse(x[1].at))
      .slice(0, KEEP_MAX);
    journal.answers = Object.fromEntries(kept);
    try {
      await mkdir(STATE_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(journal, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, STATE_FILE);
    } catch (err) {
      console.error(`[inbound:message] journal write failed: ${err instanceof Error ? err.message : err}`);
    }
  });
  return journalWrite;
}

// ─── Turn ───────────────────────────────────────────────────────────────────

let directives: string | null = null;
let claudeMdReady = false;
const inflight = new Map<string, Promise<InboundReply>>();

async function loadDirectives(): Promise<string> {
  if (directives !== null) return directives;
  try {
    directives = existsSync(DIRECTIVES_PATH) ? (await Bun.file(DIRECTIVES_PATH).text()).trim() : "";
  } catch {
    directives = "";
  }
  return directives;
}

function log(msg: string): void {
  console.log(`[${new Date().toLocaleTimeString()}] [inbound:message] ${msg}`);
}

/** Context fences are ours; user text must not be able to fake one. */
function sanitize(text: string): string {
  return text.replace(/^-{3,}/gm, "—");
}

/** Copy (or decode) each attachment into MEDIA_DIR; returns the local paths, in order. */
async function materialize(req: MessageRequest, caller: string): Promise<string[]> {
  const out: string[] = [];
  const list = req.attachments ?? [];
  if (list.length === 0) return out;
  await mkdir(MEDIA_DIR, { recursive: true });
  for (const [i, a] of list.entries()) {
    const name = (a.name ?? (a.path ? basename(a.path) : `file-${i}`)).replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 80);
    const dest = join(MEDIA_DIR, `${caller}-${req.id}-${i}-${name}`);
    if (typeof a.data === "string") await writeFile(dest, Buffer.from(a.data, "base64"));
    else await copyFile(a.path!, dest);
    out.push(dest);
  }
  return out;
}

async function buildPrompt(req: MessageRequest, caller: string, threadId: string, j: Journal): Promise<string> {
  const parts: string[] = [];
  const from = req.sender?.name ?? req.sender?.id;
  parts.push(
    `[Inbound · caller=${caller} · conversation「${req.conversation.name ?? req.conversation.id}」(${req.conversation.id})${from ? ` · from ${from}` : ""}]`,
  );

  // Directives once per session — again after the session is replaced or compacted.
  const session = await peekThreadSession(threadId);
  const rec = j.sessions[threadId];
  if (!session || !rec || rec.sessionId !== session.sessionId || (session.turnCount ?? 0) < rec.turn) {
    const d = await loadDirectives();
    if (d) parts.push(d);
  }

  if (req.instructions?.trim()) {
    parts.push(`--- Instructions from the caller for this message ---\n${sanitize(req.instructions.trim())}\n--- End of instructions ---`);
  }
  if (req.context?.length) {
    parts.push(
      `--- Earlier in this conversation (context only — do not reply to these) ---\n${req.context.map(sanitize).join("\n")}\n--- End of earlier lines ---`,
    );
  }
  if (req.text.trim()) parts.push(`Message: ${sanitize(req.text.trim())}`);

  const paths = await materialize(req, caller);
  for (const [i, a] of (req.attachments ?? []).entries()) {
    const path = paths[i]!;
    const name = a.name ? ` (${a.name})` : "";
    if (a.kind === "image") {
      parts.push(`Image path: ${path}${name}`, "Inspect this image file directly before answering.");
    } else if (a.kind === "audio") {
      let transcript = "";
      try {
        transcript = (await transcribeAudioToText(path)).text;
      } catch (err) {
        console.error(`[inbound:message] transcribe failed: ${err instanceof Error ? err.message : err}`);
      }
      parts.push(transcript ? `Voice transcript${name}: ${sanitize(transcript)}` : `Audio file${name}: ${path} (could not be transcribed)`);
    } else {
      parts.push(`Attached file: ${path}${name}`, "Read and analyse it as needed.");
    }
  }
  return parts.join("\n");
}

function threadFor(caller: string, conversationId: string): string {
  return getSettings().inbound.message.session === "shared" ? "inbound:shared" : `inbound:${caller}:${conversationId}`;
}

async function run(req: MessageRequest, caller: string, j: Journal): Promise<InboundReply> {
  const key = `${caller}:${req.id}`;
  const threadId = threadFor(caller, req.conversation.id);
  const prompt = await buildPrompt(req, caller, threadId, j);
  log(`${caller}/${req.conversation.id} ${req.id}: "${maskSecrets(req.text).slice(0, 60)}"`);

  let result;
  try {
    result = await runUserMessage("inbound-message", prompt, threadId);
  } catch (err) {
    result = { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
  if (result.exitCode !== 0) {
    console.error(`[inbound:message] ${key}: agent run failed: ${(result.stderr || result.stdout).slice(0, 300)}`);
    return { status: 503, body: { id: req.id, error: "agent_failed" } };
  }

  const session = await peekThreadSession(threadId);
  if (session) j.sessions[threadId] = { sessionId: session.sessionId, turn: session.turnCount ?? 0 };

  const out = result.stdout.trim();
  const screened = out ? await screenReply({ source: "inbound-message", target: `${caller}/${req.conversation.id}`, text: out, direct: true }) : { text: "", withheld: false };
  j.answers[key] = { text: screened.text, at: new Date().toISOString() };
  await saveJournal();
  log(`${key}: reply ${screened.text.length} chars${screened.withheld ? " (withheld)" : ""}${result.silenced ? " (NO_SEND)" : ""}`);
  return { status: 200, body: { id: req.id, text: screened.text, ...(screened.withheld ? { withheld: true } : {}) } };
}

async function handle(payload: unknown, ctx: InboundContext): Promise<InboundReply> {
  const req = parse(payload);
  if (typeof req === "string") return { status: 400, body: { error: "invalid_request", detail: req } };
  if (!claudeMdReady) {
    await ensureProjectClaudeMd();
    claudeMdReady = true;
  }
  const j = await getJournal();
  const key = `${ctx.caller}:${req.id}`;

  const done = j.answers[key];
  if (done) {
    log(`${key}: repeat — returning the first answer`);
    return { status: 200, body: { id: req.id, text: done.text, repeated: true } };
  }
  let p = inflight.get(key);
  if (p) {
    log(`${key}: same id still running — joining it`);
  } else {
    p = run(req, ctx.caller, j);
    inflight.set(key, p);
    const started = p;
    started.finally(() => inflight.delete(key)).catch(() => {});
  }
  return p;
}

export const messageSource: InboundSource = {
  enabled: () => getSettings().inbound.message.enabled,
  handle,
};
