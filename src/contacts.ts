/**
 * Contacts — shared address book + targeted notify directive support.
 *
 * Used by agent-bus, cron jobs, and heartbeat to deliver messages to an
 * explicit platform target instead of broadcasting to every allowed user.
 *
 * Storage lives in the GLOBAL claudeclaw dir (shared across all agents on
 * this machine, like sessions.json / proxy-config.json):
 *
 *   ~/.claude/claudeclaw/contacts/
 *   ├── book.json            # named recipients (single-writer, atomic rename)
 *   ├── seen/<agent>.json    # per-agent harvest shards (no locking needed)
 *   └── dead-letter.jsonl    # failed notify deliveries
 *
 * Directive syntax (extracted from Claude output, same layer as [send-agent:]):
 *
 *   [notify:<target>]message[/notify]
 *
 *   target := <recipientNameOrAlias>              → recipient's default platforms
 *           | <recipientNameOrAlias>@<platform>   → pin one platform
 *           | reply                               → back to the triggering inbound message
 *           | <platform>:<id>[:<threadTs>]        → one-off direct addressing
 */

import { join, basename } from "path";
import { homedir } from "os";
import { mkdir, readdir, rename, appendFile } from "fs/promises";
import { existsSync } from "fs";

const CONTACTS_DIR = join(homedir(), ".claude", "claudeclaw", "contacts");

/**
 * Notify dispatcher hook — the daemon (start.ts) owns the platform send
 * functions, so it registers its dispatchNotifies here at startup; platform
 * reply pipelines (slack/telegram/...) call it to honor [notify:] directives
 * that appear in conversational replies, not just bus/cron/heartbeat runs.
 */
export type NotifyDispatcher = (
  source: string,
  stdout: string,
) => Promise<{ cleaned: string; hadNotify: boolean }>;

let notifyDispatcher: NotifyDispatcher | null = null;

export function setNotifyDispatcher(fn: NotifyDispatcher): void {
  notifyDispatcher = fn;
}

export function getNotifyDispatcher(): NotifyDispatcher | null {
  return notifyDispatcher;
}
const BOOK_FILE = join(CONTACTS_DIR, "book.json");
const SEEN_DIR = join(CONTACTS_DIR, "seen");
const DEAD_LETTER_FILE = join(CONTACTS_DIR, "dead-letter.jsonl");

/** Max harvest entries kept per agent shard (LRU by lastSeen). */
const SEEN_CAP = 200;

export type NotifyPlatform = "telegram" | "slack" | "line" | "discord";
export type AddressKind = "user" | "group" | "channel";

export const NOTIFY_PLATFORMS: NotifyPlatform[] = ["telegram", "slack", "line", "discord"];

/** Names that can never be used as a recipient name or alias. */
export const RESERVED_TARGET_NAMES = new Set(["reply", ...NOTIFY_PLATFORMS]);

/** A platform address: plain id string, or object when kind can't be inferred. */
export interface ContactAddress {
  id: string;
  /** user | group | channel — omit when inferable from the id prefix (see inferKind). */
  kind?: AddressKind;
}

export interface Recipient {
  /** person | group | channel — informational only. */
  type?: "person" | "group" | "channel";
  /** Alternative names that resolve to this recipient (groups rarely have one true name). */
  aliases?: string[];
  /** platform → address (string id, or { id, kind }). */
  platforms: Partial<Record<NotifyPlatform, string | ContactAddress>>;
  /** Platforms used by a bare [notify:<name>]. Missing/empty = all defined platforms. */
  default?: NotifyPlatform[];
  /** Reserved for later enforcement: which agents may notify this recipient. Not enforced in MVP. */
  allowedAgents?: string[];
}

export interface ContactsBook {
  recipients: Record<string, Recipient>;
}

export interface SeenEntry {
  platform: NotifyPlatform;
  id: string;
  kind: AddressKind;
  /** Human-readable name when the platform provides one (TG chat.title, Slack channel name...). */
  name?: string;
  lastSeen: string;
  /** Recent topic keywords — groundwork for content-based lookup (not used in MVP). */
  topics?: string[];
}

export interface DeadLetterEntry {
  at: string;
  /** Which run produced the notify (e.g. "agent-bus", job name, "heartbeat"). */
  source: string;
  target: string;
  error: string;
  /** First 200 chars of the payload, for debugging. */
  preview: string;
}

// ── Book ────────────────────────────────────────────────────────────────────

async function ensureDirs(): Promise<void> {
  await mkdir(SEEN_DIR, { recursive: true });
}

/** Read book.json fresh from disk (hot-reload semantics — never cached). */
export async function loadBook(): Promise<ContactsBook> {
  try {
    if (!existsSync(BOOK_FILE)) return { recipients: {} };
    const raw = JSON.parse(await Bun.file(BOOK_FILE).text());
    const recipients =
      raw && typeof raw === "object" && raw.recipients && typeof raw.recipients === "object"
        ? raw.recipients
        : {};
    return { recipients };
  } catch (err) {
    console.error(`[contacts] Failed to read book.json: ${err instanceof Error ? err.message : err}`);
    return { recipients: {} };
  }
}

/** Atomic write: temp file + rename, so concurrent readers never see a torn file. */
export async function saveBook(book: ContactsBook): Promise<void> {
  await ensureDirs();
  const tmp = `${BOOK_FILE}.tmp-${process.pid}`;
  await Bun.write(tmp, JSON.stringify(book, null, 2) + "\n");
  await rename(tmp, BOOK_FILE);
}

/** Validate a recipient name/alias set against reserved words and cross-recipient collisions.
 *  Returns an error string, or null when valid. */
export function validateRecipientNames(
  book: ContactsBook,
  name: string,
  aliases: string[] = [],
  ignoreExisting?: string,
): string | null {
  const all = [name, ...aliases].map((n) => n.trim().toLowerCase()).filter(Boolean);
  for (const n of all) {
    if (RESERVED_TARGET_NAMES.has(n)) return `"${n}" is a reserved word`;
    if (n.includes(":") || n.includes("@")) return `"${n}" contains a reserved character (: or @)`;
  }
  for (const [key, r] of Object.entries(book.recipients)) {
    if (ignoreExisting && key === ignoreExisting) continue;
    const taken = [key, ...(r.aliases ?? [])].map((n) => n.toLowerCase());
    for (const n of all) {
      if (taken.includes(n)) return `"${n}" already belongs to recipient "${key}"`;
    }
  }
  return null;
}

// ── Address kind inference ──────────────────────────────────────────────────

/** Infer user/group/channel from the platform's id shape. Explicit `kind` always wins. */
export function inferKind(platform: NotifyPlatform, id: string): AddressKind {
  switch (platform) {
    case "slack":
      // U/W = user, C/G = channel (public/private)
      return /^[UW]/.test(id) ? "user" : "channel";
    case "line":
      // U = user, C = group, R = room
      return id.startsWith("U") ? "user" : "group";
    case "telegram":
      // Negative chat ids are groups/supergroups
      return id.startsWith("-") ? "group" : "user";
    case "discord":
      // Snowflakes are shape-identical — default to user; use {id, kind:"channel"} in book.json for channels.
      return "user";
  }
}

function normalizeAddress(
  platform: NotifyPlatform,
  addr: string | ContactAddress,
): { id: string; kind: AddressKind } {
  if (typeof addr === "string") return { id: addr, kind: inferKind(platform, addr) };
  return { id: addr.id, kind: addr.kind ?? inferKind(platform, addr.id) };
}

// ── Directive extraction ────────────────────────────────────────────────────

export interface NotifyDirective {
  target: string;
  payload: string;
}

const NOTIFY_RE = /\[notify:([^\]\r\n]+)\]([\s\S]*?)\[\/notify\]/gi;

/** Extract [notify:target]...[/notify] blocks. Unclosed [notify:] tags are left in place. */
export function extractNotifyDirectives(text: string): {
  cleaned: string;
  directives: NotifyDirective[];
} {
  const directives: NotifyDirective[] = [];
  const cleaned = text
    .replace(NOTIFY_RE, (_m, target: string, payload: string) => {
      const p = payload.trim();
      if (p) directives.push({ target: target.trim(), payload: p });
      return "";
    })
    .trim();
  return { cleaned, directives };
}

// ── Target resolution ───────────────────────────────────────────────────────

export interface NotifyDelivery {
  platform: NotifyPlatform;
  id: string;
  kind: AddressKind;
  /** Slack thread ts from direct addressing (slack:C…:ts). */
  threadTs?: string;
}

export type ResolvedTarget =
  | { ok: true; kind: "reply" }
  | {
      ok: true;
      kind: "deliveries";
      deliveries: NotifyDelivery[];
      /**
       * True when the deliveries came from a recipient's default fan-out.
       * The book is shared across agents with different platform tokens, so a
       * default platform the SENDING agent can't reach is silently skipped
       * (only if at least one other delivery is possible). Pinned (@platform)
       * and direct (platform:id) targets always hard-fail to dead-letter.
       */
      softSkipUnconfigured: boolean;
    }
  | { ok: false; error: string };

function isPlatform(s: string): s is NotifyPlatform {
  return (NOTIFY_PLATFORMS as string[]).includes(s);
}

/** Resolve a directive target string against the shared book. */
export function resolveNotifyTarget(rawTarget: string, book: ContactsBook): ResolvedTarget {
  const raw = rawTarget.trim();
  if (!raw) return { ok: false, error: "empty target" };

  if (raw.toLowerCase() === "reply") return { ok: true, kind: "reply" };

  // Direct addressing: <platform>:<id>[:<threadTs>]
  if (raw.includes(":")) {
    const [p, id, ...rest] = raw.split(":");
    const platform = p.trim().toLowerCase();
    if (!isPlatform(platform)) return { ok: false, error: `unknown platform "${p}"` };
    if (!id?.trim()) return { ok: false, error: `missing id in "${raw}"` };
    const threadTs = rest.length > 0 ? rest.join(":").trim() : undefined;
    return {
      ok: true,
      kind: "deliveries",
      softSkipUnconfigured: false,
      deliveries: [
        { platform, id: id.trim(), kind: inferKind(platform, id.trim()), ...(threadTs ? { threadTs } : {}) },
      ],
    };
  }

  // Named recipient: <name>[@<platform>]
  let name = raw;
  let pinned: NotifyPlatform | null = null;
  const at = raw.lastIndexOf("@");
  if (at > 0) {
    const p = raw.slice(at + 1).trim().toLowerCase();
    if (isPlatform(p)) {
      pinned = p;
      name = raw.slice(0, at).trim();
    }
  }

  const lower = name.toLowerCase();
  let recipient: Recipient | null = null;
  let matchedKey = "";
  for (const [key, r] of Object.entries(book.recipients)) {
    if (key.toLowerCase() === lower || (r.aliases ?? []).some((a) => a.toLowerCase() === lower)) {
      recipient = r;
      matchedKey = key;
      break;
    }
  }
  if (!recipient) return { ok: false, error: `recipient "${name}" not found in contacts book` };

  const defined = Object.keys(recipient.platforms).filter(isPlatform) as NotifyPlatform[];
  if (defined.length === 0) return { ok: false, error: `recipient "${matchedKey}" has no platform addresses` };

  let platforms: NotifyPlatform[];
  if (pinned) {
    if (!recipient.platforms[pinned]) {
      return { ok: false, error: `recipient "${matchedKey}" has no ${pinned} address` };
    }
    platforms = [pinned];
  } else {
    const defaults = (recipient.default ?? []).filter((p) => defined.includes(p));
    platforms = defaults.length > 0 ? defaults : defined;
  }

  const deliveries = platforms.map((p) => {
    const { id, kind } = normalizeAddress(p, recipient!.platforms[p]!);
    return { platform: p, id, kind };
  });
  return { ok: true, kind: "deliveries", softSkipUnconfigured: !pinned, deliveries };
}

// ── Harvest (seen shards) ───────────────────────────────────────────────────

/** Shard name for this agent: bus name when set, else the project dir name. */
export function harvestAgentName(busName?: string): string {
  const n = busName?.trim();
  if (n) return n;
  return basename(process.cwd()).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

/** Record a contact sighting into this agent's shard. Dedupes by (platform,id),
 *  refreshes name/lastSeen, caps the shard at SEEN_CAP entries (LRU). */
export async function recordSeen(
  agentName: string,
  entry: Omit<SeenEntry, "lastSeen">,
): Promise<void> {
  if (!agentName) return;
  try {
    await ensureDirs();
    const shardFile = join(SEEN_DIR, `${agentName}.json`);
    let entries: SeenEntry[] = [];
    if (existsSync(shardFile)) {
      try {
        const raw = JSON.parse(await Bun.file(shardFile).text());
        if (Array.isArray(raw)) entries = raw;
      } catch {
        // corrupted shard — start over rather than crash the message path
      }
    }
    const now = new Date().toISOString();
    const idx = entries.findIndex((e) => e.platform === entry.platform && e.id === entry.id);
    if (idx >= 0) {
      const prev = entries[idx];
      entries[idx] = { ...prev, ...entry, name: entry.name || prev.name, lastSeen: now };
    } else {
      entries.push({ ...entry, lastSeen: now });
    }
    if (entries.length > SEEN_CAP) {
      entries.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
      entries = entries.slice(0, SEEN_CAP);
    }
    const tmp = `${shardFile}.tmp-${process.pid}`;
    await Bun.write(tmp, JSON.stringify(entries, null, 2) + "\n");
    await rename(tmp, shardFile);
  } catch (err) {
    // Harvest must never break the message path
    console.error(`[contacts] recordSeen failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Merge all agents' shards into one candidate list (freshest first). */
export async function listSeen(): Promise<Array<SeenEntry & { seenBy: string }>> {
  try {
    if (!existsSync(SEEN_DIR)) return [];
    const files = (await readdir(SEEN_DIR)).filter((f) => f.endsWith(".json"));
    const all: Array<SeenEntry & { seenBy: string }> = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(await Bun.file(join(SEEN_DIR, f)).text());
        if (Array.isArray(raw)) {
          const agent = f.replace(/\.json$/, "");
          for (const e of raw) all.push({ ...e, seenBy: agent });
        }
      } catch {}
    }
    all.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
    return all;
  } catch {
    return [];
  }
}

// ── Dead letter ─────────────────────────────────────────────────────────────

export async function recordDeadLetter(entry: DeadLetterEntry): Promise<void> {
  try {
    await ensureDirs();
    await appendFile(DEAD_LETTER_FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`[contacts] dead-letter write failed: ${err instanceof Error ? err.message : err}`);
  }
}
