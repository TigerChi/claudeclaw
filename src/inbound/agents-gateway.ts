/**
 * Inbound source: Agents Gateway deliveries, posted by the Gateway's bridge
 * (`--adapter http --target http://127.0.0.1:<port>/inbound/agents-gateway`).
 *
 * The bridge owns everything Gateway-facing — long-polling, ack, release and
 * retry, backlog trim, the Agent key. Per delivery it POSTs the bundle (spec
 * 09 §1) here and waits; we answer `{text}` and it sends that to LINE
 * (`{text: ""}` = say nothing, bridge only acks). A 5xx makes it release the
 * delivery and retry after 5 → 15 → 45 s; after the third failure it acks.
 *
 * Sessions: `inbound.agentsGateway.session` — "chat" gives each LINE chat its
 * own session (`agw:<chatId>`), "shared" puts all of this agent's chats in one
 * (`agw:shared`); `chats.<id>.session` overrides per chat.
 *
 * At-most-once replies: a delivery can reach us twice — the bridge retries
 * after a timeout, or the Gateway re-sends once its 5-minute lease runs out
 * while the agent was still working. A local journal records each answered
 * deliveryId; a repeat gets `{text: ""}`. A repeat while the first run is still
 * going joins it instead of starting another. If our answer could not be handed
 * over (the bridge had hung up), it is kept and given to the next attempt.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { CANCEL_CONFIRM_MESSAGE, CANCEL_NOTHING_MESSAGE, isCancelCommand } from "../cancel";
import { appendChatLog, conversationDirPath } from "../chatlog";
import { getSettings, type AgentsGatewayInboundConfig } from "../config";
import { cancelThread, ensureProjectClaudeMd, runUserMessage } from "../runner";
import { peekThreadSession } from "../sessionManager";
import { transcribeAudioToText } from "../whisper";
import { maskSecrets, screenReply } from "./screen";
import type { InboundContext, InboundReply, InboundSource } from "./server";

const STATE_DIR = join(process.cwd(), ".claude", "claudeclaw", "inbound");
const STATE_FILE = join(STATE_DIR, "agents-gateway.json");
const MEDIA_DIR = join(STATE_DIR, "media");
const PROMPTS = join(import.meta.dir, "..", "..", "prompts", "agents-gateway");
const DIRECTIVES_PATH = join(PROMPTS, "DIRECTIVES.md");
/** Added only to the shared session (session: "shared"). */
const SHARED_DIRECTIVES_PATH = join(PROMPTS, "DIRECTIVES-SHARED.md");

/** The bridge gives up after this many failed attempts (bridge loop.ts ADAPTER_MAX_ATTEMPTS). */
const BRIDGE_MAX_ATTEMPTS = 3;
const FAILURE_REPLY = "抱歉，我這邊暫時出了點問題，請稍後再試一次。";
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const OVERHEARD_LIMIT = 40;
const SHARED_THREAD = "agw:shared";

// ─── Bundle (09 §1) — only the fields read here ─────────────────────────────

interface Sender {
  lineUserId?: string;
  displayName: string | null;
  role?: string;
  note?: string | null;
}

interface Media {
  mediaId: string;
  kind: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  filename?: string | null;
  link?: string | null;
  url?: string | null;
  status?: string;
  skipReason?: string | null;
}

interface Chat {
  id: string;
  /** LINE's own id (C… group, R… room, U… user). */
  lineId?: string | null;
  type: "group" | "room" | "user";
  name: string | null;
  description?: string | null;
  reply: boolean;
}

interface Message {
  id: string;
  ts: string;
  type: string;
  text: string | null;
  textWithoutMention: string | null;
  sender: Sender | null;
  quoted?: { text: string | null; senderDisplayName: string | null } | null;
  media?: Media | null;
  transcript?: { status: string; text: string | null } | null;
  postback?: { data: string; params: unknown };
}

interface Bundle {
  deliveryId: string;
  reason: string;
  test?: boolean;
  expectsReply?: boolean;
  bot?: { name?: string; displayName?: string | null; kind?: string };
  chat: Chat | null;
  agent?: { name: string; displayName?: string };
  message: Message | null;
  event?: { type: string; members?: { displayName: string | null }[] };
  context?: {
    recent?: { ts: string; sender: Sender | null; type: string; text: string | null; agent: { displayName?: string } | null }[];
    sinceLastDelivery?: number;
  };
  prompts?: { stacked?: string | null };
  reply?: { canReply?: boolean };
}

function asBundle(payload: unknown): Bundle | null {
  const b = payload as Partial<Bundle> | null;
  if (!b || typeof b !== "object") return null;
  if (typeof b.deliveryId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.deliveryId)) return null;
  if (typeof b.reason !== "string") return null;
  return b as Bundle;
}

// ─── Journal ────────────────────────────────────────────────────────────────

interface DeliveryRecord {
  /** answered = the bridge has our reply; undelivered = reply kept for the next
   *  attempt; absent = only failed runs so far. */
  state?: "answered" | "undelivered";
  text?: string;
  failures?: number;
  /** The inbound message is already in the chat log (a retry must not log it again). */
  logged?: boolean;
  updatedAt: string;
}

interface OverheardLine {
  ts: string;
  who: string;
  text: string;
}

interface ChatRecord {
  /** ts of the newest message of this chat the agent has been shown. */
  lastShownTs?: string;
  /** Listen-only lines not yet shown (drained into the next woken turn). */
  overheard?: OverheardLine[];
}

/** What a session has already been given, so the instruction block is not resent every turn. */
interface SessionRecord {
  sessionId?: string;
  turn?: number;
  /** Hash of the directives this session was last given (resent when they change). */
  directivesHash?: string;
  /** chatId → hash of that chat's Gateway instructions last given in this session. */
  chats?: Record<string, string>;
}

interface Journal {
  deliveries: Record<string, DeliveryRecord>;
  chats: Record<string, ChatRecord>;
  sessions: Record<string, SessionRecord>;
}

let journal: Journal | null = null;
let journalWrite: Promise<void> = Promise.resolve();

async function getJournal(): Promise<Journal> {
  if (journal) return journal;
  journal = { deliveries: {}, chats: {}, sessions: {} };
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as Partial<Journal>;
      journal = { deliveries: raw.deliveries ?? {}, chats: raw.chats ?? {}, sessions: raw.sessions ?? {} };
    }
  } catch (err) {
    console.error(`[agw] ${STATE_FILE} unreadable, starting empty: ${errMsg(err)}`);
  }
  return journal;
}

/** Atomic, serialized write; drops delivery records older than 2 days. */
function saveJournal(): Promise<void> {
  journalWrite = journalWrite.then(async () => {
    if (!journal) return;
    const cutoff = Date.now() - 2 * 24 * 3600 * 1000;
    for (const [id, d] of Object.entries(journal.deliveries)) {
      if (Date.parse(d.updatedAt) < cutoff) delete journal.deliveries[id];
    }
    try {
      await mkdir(STATE_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(journal, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, STATE_FILE);
    } catch (err) {
      console.error(`[agw] journal write failed: ${errMsg(err)}`);
    }
  });
  return journalWrite;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const directiveCache = new Map<string, string>();
/** deliveryId → the run producing its reply text. */
const inflight = new Map<string, Promise<string>>();

class RunFailure extends Error {}

function cfg(): AgentsGatewayInboundConfig {
  return getSettings().inbound.agentsGateway;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function log(msg: string): void {
  console.log(`[${new Date().toLocaleTimeString()}] [agw] ${msg}`);
}

/**
 * Session key. Per-chat sessions reuse the native LINE channel's keys
 * (line.ts `lineSessionId`), so an agent moved from native LINE to the
 * Gateway keeps each chat's conversation; `agw:<chatId>` only when the bundle
 * carries no LINE id.
 */
function threadFor(chat: Chat): string {
  const c = cfg();
  if ((c.chats[chat.id]?.session ?? c.session) === "shared") return SHARED_THREAD;
  if (chat.lineId) return `line:${chat.type === "user" ? "dm" : chat.type}:${chat.lineId}`;
  return `agw:${chat.id}`;
}

/** The directives for a session: base, plus the shared-session part for `agw:shared`. Cached (restart to reload). */
async function loadDirectives(threadId: string): Promise<string> {
  const files = threadId === SHARED_THREAD ? [DIRECTIVES_PATH, SHARED_DIRECTIVES_PATH] : [DIRECTIVES_PATH];
  const parts: string[] = [];
  for (const f of files) {
    if (!directiveCache.has(f)) {
      let text = "";
      try {
        text = existsSync(f) ? (await Bun.file(f).text()).trim() : "";
      } catch {
        // missing or unreadable: send nothing for it
      }
      directiveCache.set(f, text);
    }
    const t = directiveCache.get(f)!;
    if (t) parts.push(t);
  }
  return parts.join("\n\n");
}

/** HH:MM in the agent's configured timezone. */
function clock(ts: string): string {
  const d = Date.parse(ts);
  if (!Number.isFinite(d)) return "";
  return new Date(d + (getSettings().timezoneOffsetMinutes ?? 0) * 60_000).toISOString().slice(11, 16);
}

/** Neutralise our own context fences so user text cannot fake a block boundary. */
function sanitize(text: string): string {
  return text.replace(/^-{3,}/gm, "—");
}

function who(s: Sender | null | undefined): string {
  if (!s) return "?";
  return `${s.displayName ?? s.lineUserId ?? "?"}${s.role ? `（${s.role}）` : ""}`;
}

function describeMessage(m: Message): string {
  if (m.text) return m.text;
  if (m.media) return `[${m.media.kind}${m.media.filename ? `: ${m.media.filename}` : ""}]`;
  return `[${m.type}]`;
}

function canSpeak(b: Bundle): boolean {
  return !!b.chat?.reply && b.reply?.canReply !== false;
}

// ─── Chat log ───────────────────────────────────────────────────────────────

async function logEntry(b: Bundle, role: "user" | "bot", text: string, mediaPath?: string): Promise<void> {
  if (!b.chat || !cfg().chatLog.enabled) return;
  const m = b.message;
  await appendChatLog(`agw-${b.chat.id}`, b.chat.type, b.chat.name ?? undefined, {
    ts: role === "user" && m?.ts ? m.ts : new Date().toISOString(),
    id: role === "user" ? m?.id : undefined,
    role,
    userId: role === "user" ? m?.sender?.lineUserId : undefined,
    name: role === "user" ? (m?.sender?.displayName ?? undefined) : (b.agent?.displayName ?? b.agent?.name),
    kind: role === "user" ? (m?.type ?? "text") : "text",
    text,
    ...(mediaPath ? { mediaPath } : {}),
  });
}

/** Log the delivery's inbound message once, however many times the bridge retries it. */
async function logInboundOnce(b: Bundle, j: Journal, text: string, mediaPath?: string): Promise<void> {
  const cur = j.deliveries[b.deliveryId];
  if (cur?.logged) return;
  await logEntry(b, "user", text, mediaPath);
  j.deliveries[b.deliveryId] = { ...cur, logged: true, updatedAt: new Date().toISOString() };
  await saveJournal();
}

// ─── Media ──────────────────────────────────────────────────────────────────

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/m4a": ".m4a",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "application/pdf": ".pdf",
};

/** Fetch an attachment through its signed `url` (no key needed). Media kept
 *  in the user's own cloud storage has no such url and cannot be fetched here. */
async function downloadMedia(media: Media): Promise<string | null> {
  if (!media.url || (media.sizeBytes ?? 0) > MEDIA_MAX_BYTES) return null;
  const ext = extname(media.filename ?? "") || MIME_EXT[media.mimeType ?? ""] || "";
  const dest = join(MEDIA_DIR, `${media.mediaId.replace(/[^A-Za-z0-9_-]/g, "")}${ext}`);
  if (existsSync(dest)) return dest;
  try {
    const res = await fetch(media.url, { redirect: "follow" });
    if (!res.ok || /text\/html/i.test(res.headers.get("content-type") ?? "")) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MEDIA_MAX_BYTES) return null;
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(dest, buf);
    return dest;
  } catch (err) {
    console.error(`[agw] media ${media.mediaId} download failed: ${errMsg(err)}`);
    return null;
  }
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

/**
 * The generic directives plus this chat's Gateway instructions. Sent when the
 * session is new, was replaced or compacted, or has not yet seen this chat's
 * current instructions — not on every turn.
 */
async function instructionBlock(b: Bundle, threadId: string, j: Journal): Promise<{ text: string; hash: string; directivesHash: string } | null> {
  const chat = b.chat!;
  const stacked = (b.prompts?.stacked ?? "").trim();
  const meta = [
    `Bot: ${b.bot?.displayName ?? b.bot?.name ?? "?"}${b.bot?.kind === "shared" ? " (official shared bot: no push; late replies are queued until someone speaks)" : ""}`,
    `You appear in this chat as: ${b.agent?.displayName ?? b.agent?.name ?? "?"}`,
    chat.description ? `Chat description: ${chat.description}` : "",
  ].filter(Boolean);
  const chatLabel = chat.type === "user" ? "this DM" : `「${chat.name ?? ""}」`;
  const block = `--- Gateway instructions for ${chatLabel} (chat=${chat.id}; set by its owner; follow them for messages from this chat) ---\n${meta.join("\n")}${stacked ? `\n\n${stacked}` : ""}\n--- End of Gateway instructions ---`;
  const hash = createHash("sha256").update(block).digest("hex").slice(0, 16);

  const rec = j.sessions[threadId];
  const session = await peekThreadSession(threadId);
  const sessionFresh =
    !session || !rec || rec.sessionId !== session.sessionId || (session.turnCount ?? 0) < (rec.turn ?? 0); // counter reset ⇒ compacted

  const parts: string[] = [];
  const d = await loadDirectives(threadId);
  const directivesHash = createHash("sha256").update(d).digest("hex").slice(0, 16);
  const directivesChanged = sessionFresh || rec?.directivesHash !== directivesHash;
  if (!directivesChanged && rec?.chats?.[chat.id] === hash) return null;
  if (directivesChanged && d) parts.push(d);
  parts.push(block);
  return { text: parts.join("\n\n"), hash, directivesHash };
}

/** After a successful turn: remember what this session has been given. */
async function recordInstructions(threadId: string, chatId: string, inst: { hash: string; directivesHash: string } | null, j: Journal): Promise<void> {
  const session = await peekThreadSession(threadId);
  if (!session) return;
  const prev = j.sessions[threadId];
  const same = prev && prev.sessionId === session.sessionId;
  const rec: SessionRecord = same ? prev : { sessionId: session.sessionId, chats: {} };
  rec.turn = session.turnCount ?? 0;
  if (inst) {
    rec.chats = { ...(same ? rec.chats : {}), [chatId]: inst.hash };
    rec.directivesHash = inst.directivesHash;
  }
  j.sessions[threadId] = rec;
}

async function buildPrompt(
  b: Bundle,
  threadId: string,
  j: Journal,
  local: { mediaPath: string | null; transcript: string | null },
): Promise<{ prompt: string; inst: { hash: string; directivesHash: string } | null }> {
  const chat = b.chat!;
  const m = b.message!;
  const rec = (j.chats[chat.id] ??= {});
  const parts: string[] = [];

  const chatLabel = chat.type === "user" ? "DM" : `${chat.type}「${chat.name ?? ""}」`;
  parts.push(
    `[Agents Gateway · LINE ${chatLabel} chat=${chat.id} · from ${who(m.sender)}${m.sender?.lineUserId ? ` ${m.sender.lineUserId}` : ""}${m.sender?.note ? ` note=${m.sender.note}` : ""} · reason=${b.reason}]`,
  );

  const inst = await instructionBlock(b, threadId, j);
  if (inst) parts.push(inst.text);

  // Context: listen-only lines held back + Gateway `recent` lines newer than
  // anything already shown for this chat. Older lines are not repeated.
  const since = rec.lastShownTs ? Date.parse(rec.lastShownTs) : 0;
  const trigger = Date.parse(m.ts);
  const lines: { ts: string; line: string }[] = (rec.overheard ?? []).map((o) => ({ ts: o.ts, line: `${clock(o.ts)} ${o.who}：${o.text}` }));
  const seen = new Set((rec.overheard ?? []).map((o) => `${o.ts}|${o.text}`));
  for (const r of b.context?.recent ?? []) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || t <= since || t >= trigger) continue;
    const text = r.text ?? `[${r.type}]`;
    if (seen.has(`${r.ts}|${text}`)) continue;
    const speaker = r.agent ? `${r.agent.displayName ?? "agent"}（agent）` : who(r.sender);
    lines.push({ ts: r.ts, line: `${clock(r.ts)} ${speaker}：${text}` });
  }
  lines.sort((a, c) => Date.parse(a.ts) - Date.parse(c.ts));
  if (lines.length > 0) {
    parts.push(
      `--- Earlier in this chat since you last spoke (${lines.length} line(s), context only — do not reply to these) ---\n${lines.map((l) => sanitize(l.line)).join("\n")}\n--- End of earlier lines ---`,
    );
  }
  const total = b.context?.sinceLastDelivery ?? 0;
  if (total > lines.length) {
    const dir = cfg().chatLog.enabled ? await conversationDirPath(`agw-${chat.id}`) : null;
    parts.push(
      `(${total} message(s) were posted here since your previous turn; ${lines.length} shown.${dir ? ` What you have seen of this chat is archived in ${dir} (.jsonl).` : ""})`,
    );
  }

  if (m.quoted?.text) parts.push(`Quoting ${m.quoted.senderDisplayName ?? "someone"}: 「${sanitize(m.quoted.text)}」`);

  if (b.reason === "system" && b.event) {
    const names = (b.event.members ?? []).map((x) => x.displayName ?? "?").join("、");
    parts.push(`System event: ${b.event.type}${names ? ` (${names})` : ""} — ${m.text ?? ""}`);
    parts.push("No reply is expected. Output NO_SEND unless saying something is clearly useful.");
  } else if (m.type === "postback" && m.postback) {
    parts.push(`Button action data: ${sanitize(m.postback.data)}`);
  } else {
    let text = (m.textWithoutMention ?? m.text ?? "").trim();
    if (!text && m.type === "text") text = "(mentioned you with no other text — see the earlier lines for what they mean)";
    if (text) parts.push(`Message: ${sanitize(text)}`);
  }

  if (m.media && m.media.kind !== "audio") {
    const name = m.media.filename ? ` (${m.media.filename})` : "";
    if (local.mediaPath && m.media.kind === "image") {
      parts.push(`Image path: ${local.mediaPath}`, "The user attached an image. Inspect this file directly before answering.");
    } else if (local.mediaPath) {
      parts.push(`Attached file: ${local.mediaPath}${name}`, "Read and analyse it as needed.");
    } else {
      const why = m.media.status === "stored" ? "it is kept in the owner's cloud storage, which this agent cannot open" : `status: ${m.media.status ?? "unknown"}${m.media.skipReason ? `, ${m.media.skipReason}` : ""}`;
      parts.push(`The user sent a ${m.media.kind}${name}, but it could not be retrieved (${why}).`);
    }
  }
  if (local.transcript) {
    parts.push(`Voice transcript: ${sanitize(local.transcript)}`, "The user sent a voice message. Treat the transcript as what they said.");
  } else if (m.media?.kind === "audio") {
    parts.push("The user sent a voice message, but no transcript is available. Ask them to type it if it matters.");
  }

  if (b.test) parts.push("[Test delivery from the Gateway — your reply is checked but not sent to LINE.]");
  if (!canSpeak(b)) parts.push("[You cannot speak in this chat — reply is disabled here. Output NO_SEND.]");

  return { prompt: parts.join("\n"), inst: inst ? { hash: inst.hash, directivesHash: inst.directivesHash } : null };
}

// ─── Handling ───────────────────────────────────────────────────────────────

/** One delivery → the text to send ("" = nothing). Throws RunFailure on agent failure. */
async function processDelivery(b: Bundle, j: Journal): Promise<string> {
  const chat = b.chat;
  const m = b.message;
  const tag = `${b.deliveryId.slice(-6)} ${chat ? (chat.name ?? chat.type) : "agent-event"} ${b.reason}`;

  // Agent-audience events (chat: null — bridge.update_available, issue.replied, …):
  // about the bridge or the operator, not a chat. Nothing to say.
  if (!chat || !m) {
    log(`${tag}: ${b.event?.type ?? "event"} (no chat) — nothing to do`);
    return "";
  }

  const isSystem = b.reason === "system" || b.expectsReply === false;
  if (isSystem && cfg().systemEvents === "ack") {
    log(`${tag}: system ${b.event?.type ?? ""} — recorded, agent not woken`);
    await logInboundOnce(b, j, `[system] ${m.text ?? b.event?.type ?? ""}`);
    return "";
  }

  if (!isSystem && !canSpeak(b) && cfg().listen === "log") {
    const text = describeMessage(m);
    await logInboundOnce(b, j, text);
    const rec = (j.chats[chat.id] ??= {});
    rec.overheard = [...(rec.overheard ?? []), { ts: m.ts, who: who(m.sender), text }].slice(-OVERHEARD_LIMIT);
    await saveJournal();
    return "";
  }

  const threadId = threadFor(chat);
  const userText = (m.textWithoutMention ?? m.text ?? "").trim();
  if (isCancelCommand(userText)) {
    return cancelThread(threadId) ? CANCEL_CONFIRM_MESSAGE : CANCEL_NOTHING_MESSAGE;
  }

  // Attachment + transcript (the Gateway's transcript first, local whisper as fallback).
  let mediaPath: string | null = null;
  let transcript: string | null = m.transcript?.status === "done" ? (m.transcript.text ?? null) : null;
  if (m.media) {
    mediaPath = await downloadMedia(m.media);
    if (!transcript && mediaPath && m.media.kind === "audio") {
      try {
        transcript = (await transcribeAudioToText(mediaPath)).text || null;
      } catch (err) {
        console.error(`[agw] transcribe failed: ${errMsg(err)}`);
      }
    }
  }
  await logInboundOnce(b, j, transcript ? `${describeMessage(m)} [語音轉文字] ${transcript}` : describeMessage(m), mediaPath ?? undefined);

  const { prompt, inst } = await buildPrompt(b, threadId, j, { mediaPath, transcript });
  // Users do paste keys into chats (e.g. handing one to their agent); keep them out of daemon.log.
  const preview = maskSecrets(userText || describeMessage(m)).slice(0, 60);
  log(`${tag}: from ${who(m.sender)} "${preview}"${threadId === SHARED_THREAD ? " [shared]" : ""}`);

  let result;
  try {
    result = await runUserMessage("agents-gateway", prompt, threadId);
  } catch (err) {
    throw new RunFailure(errMsg(err));
  }
  if (result.exitCode !== 0) throw new RunFailure(result.stderr || result.stdout || `exit ${result.exitCode}`);

  // The session now holds the instructions and everything up to the trigger.
  await recordInstructions(threadId, chat.id, inst, j);
  const rec = (j.chats[chat.id] ??= {});
  rec.lastShownTs = m.ts;
  rec.overheard = [];
  await saveJournal();

  const out = result.stdout.trim();
  if (!out) {
    log(`${tag}: no reply${result.silenced ? " (NO_SEND)" : ""}`);
    return "";
  }
  if (!canSpeak(b)) {
    log(`${tag}: chat is read-only; dropped ${out.length} chars`);
    return "";
  }
  const { text } = await screenReply({ source: "agents-gateway", target: chat.id, text: out, direct: chat.type === "user" });
  await logEntry(b, "bot", text);
  log(`${tag}: reply ${text.length} chars`);
  return text;
}

/** `processDelivery`, counting an agent failure once per run (joined requests share it). */
async function runOnce(b: Bundle, j: Journal): Promise<string> {
  try {
    return await processDelivery(b, j);
  } catch (err) {
    if (err instanceof RunFailure) {
      const cur = j.deliveries[b.deliveryId];
      j.deliveries[b.deliveryId] = { ...cur, failures: (cur?.failures ?? 0) + 1, updatedAt: new Date().toISOString() };
      await saveJournal();
    }
    throw err;
  }
}

async function handle(payload: unknown, signal: AbortSignal): Promise<InboundReply> {
  const b = asBundle(payload);
  if (!b) return { status: 400, body: { error: "not_a_delivery" } };
  const id = b.deliveryId;
  const j = await getJournal();
  const now = () => new Date().toISOString();

  const prev = j.deliveries[id];
  if (prev?.state === "answered") {
    log(`${id.slice(-6)}: already answered — empty reply so the bridge only acks`);
    return { status: 200, body: { text: "" } };
  }
  if (prev?.state === "undelivered") {
    // Our answer never reached the bridge last time; hand over the same text.
    j.deliveries[id] = { state: "answered", updatedAt: now() };
    await saveJournal();
    log(`${id.slice(-6)}: handing over the answer the bridge missed`);
    return { status: 200, body: { text: prev.text ?? "" } };
  }

  let run = inflight.get(id);
  if (run) {
    log(`${id.slice(-6)}: same delivery still running — joining it`);
  } else {
    const started = runOnce(b, j);
    run = started;
    inflight.set(id, started);
    started.then(
      () => inflight.delete(id),
      () => inflight.delete(id),
    );
  }

  try {
    const text = await run;
    if (!signal.aborted) {
      j.deliveries[id] = { state: "answered", updatedAt: now() };
    } else if (j.deliveries[id]?.state !== "answered") {
      // The bridge hung up (its timeout, or a restart) — keep the answer for its retry.
      j.deliveries[id] = { state: "undelivered", text, updatedAt: now() };
    }
    await saveJournal();
    return { status: 200, body: { text } };
  } catch (err) {
    if (!(err instanceof RunFailure)) throw err;
    const failures = j.deliveries[id]?.failures ?? 1;
    console.error(`[agw] ${id.slice(-6)}: agent run failed (${failures}/${BRIDGE_MAX_ATTEMPTS}): ${err.message.slice(0, 300)}`);
    if (failures < BRIDGE_MAX_ATTEMPTS) return { status: 503, body: { error: "agent_failed", attempt: failures } };
    // The bridge's last attempt: say something short (never the internal error) and close it.
    j.deliveries[id] = { state: "answered", failures, updatedAt: now() };
    await saveJournal();
    return { status: 200, body: { text: b.chat && canSpeak(b) ? FAILURE_REPLY : "" } };
  }
}

let claudeMdReady = false;

export const agentsGatewaySource: InboundSource = {
  enabled: () => getSettings().inbound.agentsGateway.enabled,
  handle: async (payload, ctx: InboundContext) => {
    if (!claudeMdReady) {
      await ensureProjectClaudeMd();
      claudeMdReady = true;
    }
    return handle(payload, ctx.signal);
  },
};
