/**
 * Chat log — durable, per-conversation transcript on disk.
 *
 * Purely an archive: it is written for every message but is NOT injected into
 * the prompt turn-by-turn. Live conversational context is fed by the passive
 * buffer in line.ts (take-and-clear, incremental). The chat log's job is
 * long-term retention and on-demand lookup — the prompt only carries a one-line
 * pointer telling the agent where the full history lives.
 *
 * Layout — one directory per conversation, files rotated by size/line count:
 *
 *   <project>/.claude/claudeclaw/chatlog/
 *   ├── index.json                                conversation key -> dir, name, kind
 *   ├── 家庭群組__group-C0123…/
 *   │   ├── C0123…_current.jsonl                  active file (still being written)
 *   │   └── C0123…_20260701T0930_20260704T1810.jsonl   sealed, name carries start/end
 *   └── 我__user-U0abc…/
 *       └── U0abc…_current.jsonl
 *
 * The directory name is `<sanitised conversation name>__<key>` so a human can
 * tell whose transcript it is at a glance, while the trailing key keeps lookup
 * stable across renames (the name prefix is cosmetic; index.json is the source
 * of truth). Entries are JSONL so appending never rewrites what is on disk.
 */

import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ChatLogEntry {
  /** ISO-8601 timestamp of the message. */
  ts: string;
  /** Platform message id, used to skip the just-logged message when injecting. */
  id?: string;
  /** "user" for inbound messages, "bot" for what this agent sent back. */
  role: "user" | "bot";
  /** Speaker id (LINE user id); absent for bot entries. */
  userId?: string;
  /** Display name at the time of writing. */
  name?: string;
  /** Message kind: text, image, sticker, … */
  kind: string;
  /** Text content, or a description like "[image]" / "[sticker: 開心]" for non-text. */
  text: string;
  /** Local path of the downloaded attachment, for kinds that have one. */
  mediaPath?: string;
  /** True when the speaker was not on the allowlist (overheard, never answered). */
  unpaired?: boolean;
  /** Message id this entry refers to. Used by machine-generated follow-ups (e.g.
   *  an audio transcript appended after the original voice entry) to link back
   *  to the source message instead of rewriting the original (append-only). */
  refId?: string;
}

export interface ChatLogConfig {
  /** Global default. A conversation is logged unless it opts out via
   *  `line.groups[chatId].chatLog === false`. */
  enabled: boolean;
}

/** Rotate the active file once it reaches either bound, whichever comes first.
 *  Size bounds the real read/memory cost (a file is read whole to inject the
 *  pointer's counts or to look back); the line cap catches pathological
 *  many-tiny-messages before parse time balloons. */
const ROTATE_MAX_BYTES = 1024 * 1024; // 1 MB
const ROTATE_MAX_LINES = 2000;

const CHATLOG_ROOT = join(process.cwd(), ".claude", "claudeclaw", "chatlog");
const INDEX_PATH = join(CHATLOG_ROOT, "index.json");

interface IndexEntry {
  dir: string;
  name?: string;
  kind: string;
  lastActive: string;
}

/** In-memory line counter for each active file, so the line-count rotation
 *  bound does not re-read the file on every append. Seeded lazily. */
const activeLineCounts = new Map<string, number>();

/** Stable logical key for a conversation. Group and user ids never collide in
 *  practice; the kind prefix keeps the key self-describing. */
export function conversationKey(kind: "group" | "room" | "user", id: string): string {
  return `${kind}-${id}`;
}

/** The raw platform id (drop the kind prefix) — used as the file-name stem. */
function keyId(key: string): string {
  const dash = key.indexOf("-");
  return dash >= 0 ? key.slice(dash + 1) : key;
}

/** Make a conversation name safe as a directory-name prefix. Keeps unicode
 *  (Chinese group names are fine on APFS); strips path/reserved characters. */
function sanitiseName(name: string | undefined): string {
  if (!name) return "";
  return name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 40);
}

/** Compact, filename-safe timestamp: 2026-07-01T09:30:12Z -> 20260701T093012 */
function fileStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d+/, "").replace(/Z$/, "");
}

async function readIndex(): Promise<Record<string, IndexEntry>> {
  try {
    if (existsSync(INDEX_PATH)) return JSON.parse(await readFile(INDEX_PATH, "utf8"));
  } catch {
    // A corrupt index is not worth failing a message over — start fresh.
  }
  return {};
}

async function writeIndex(index: Record<string, IndexEntry>): Promise<void> {
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
}

/** Resolve (creating if needed) the on-disk directory for a conversation and
 *  refresh its index entry. Used on the write path where a name is available. */
async function resolveDirForWrite(
  key: string,
  kind: string,
  name: string | undefined,
): Promise<string> {
  const index = await readIndex();
  const prev = index[key];
  let dirName = prev?.dir;
  if (!dirName || !existsSync(join(CHATLOG_ROOT, dirName))) {
    const san = sanitiseName(name);
    dirName = san ? `${san}__${key}` : key;
  }
  const dir = join(CHATLOG_ROOT, dirName);
  await mkdir(dir, { recursive: true });
  index[key] = {
    dir: dirName,
    // Keep the last known name when this event has none (media from an
    // unresolvable user, API hiccup) rather than blanking a good value.
    name: name || prev?.name,
    kind,
    lastActive: new Date().toISOString(),
  };
  await writeIndex(index);
  return dir;
}

/** Resolve a conversation's directory for reading. No name is needed; falls
 *  back to scanning for a folder that ends in the key if the index is missing
 *  the entry (e.g. index lost). Returns null when nothing exists. */
async function resolveDirForRead(key: string): Promise<string | null> {
  const index = await readIndex();
  const dirName = index[key]?.dir;
  if (dirName && existsSync(join(CHATLOG_ROOT, dirName))) return join(CHATLOG_ROOT, dirName);
  if (!existsSync(CHATLOG_ROOT)) return null;
  try {
    const match = (await readdir(CHATLOG_ROOT)).find(
      (d) => d === key || d.endsWith(`__${key}`),
    );
    return match ? join(CHATLOG_ROOT, match) : null;
  } catch {
    return null;
  }
}

/** Public: the directory path for a conversation, for the prompt's pointer. */
export async function conversationDirPath(key: string): Promise<string | null> {
  return resolveDirForRead(key);
}

function activePath(dir: string, key: string): string {
  return join(dir, `${keyId(key)}_current.jsonl`);
}

/** Seal the active file: rename it to carry its first/last entry timestamps,
 *  so "what happened between X and Y" is answerable from the file name alone. */
async function rotateIfNeeded(dir: string, key: string, active: string): Promise<void> {
  let size = 0;
  try {
    size = (await stat(active)).size;
  } catch {
    return;
  }
  const lines = activeLineCounts.get(active) ?? 0;
  if (size < ROTATE_MAX_BYTES && lines < ROTATE_MAX_LINES) return;

  try {
    const content = (await readFile(active, "utf8")).split("\n").filter(Boolean);
    if (content.length === 0) return;
    const first = JSON.parse(content[0]!) as ChatLogEntry;
    const last = JSON.parse(content[content.length - 1]!) as ChatLogEntry;
    const sealed = join(dir, `${keyId(key)}_${fileStamp(first.ts)}_${fileStamp(last.ts)}.jsonl`);
    await rename(active, sealed);
    activeLineCounts.delete(active);
  } catch (err) {
    console.error(`[ChatLog] Failed to rotate ${active}: ${err instanceof Error ? err.message : err}`);
  }
}

/** Append one entry. Never throws: losing a log line must not drop a message. */
export async function appendChatLog(
  key: string,
  kind: "group" | "room" | "user",
  displayName: string | undefined,
  entry: ChatLogEntry,
): Promise<void> {
  try {
    const dir = await resolveDirForWrite(key, kind, displayName);
    const active = activePath(dir, key);
    if (!activeLineCounts.has(active)) {
      // Seed the counter from disk once (e.g. after a restart).
      let existing = 0;
      try {
        existing = (await readFile(active, "utf8")).split("\n").filter(Boolean).length;
      } catch {
        // no active file yet
      }
      activeLineCounts.set(active, existing);
    }
    await appendFile(active, JSON.stringify(entry) + "\n");
    activeLineCounts.set(active, (activeLineCounts.get(active) ?? 0) + 1);
    await rotateIfNeeded(dir, key, active);
  } catch (err) {
    console.error(`[ChatLog] Failed to append for ${key}: ${err instanceof Error ? err.message : err}`);
  }
}

/** All .jsonl files for a conversation, newest activity first: the active file
 *  (if any) leads, then sealed files by start-stamp descending. */
async function orderedFiles(dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  const active = files.filter((f) => f.endsWith("_current.jsonl"));
  const sealed = files.filter((f) => !f.endsWith("_current.jsonl")).sort().reverse();
  return [...active, ...sealed];
}

/**
 * Last `limit` entries for a conversation, oldest-first. Walks files
 * newest-first and stops as soon as it has enough.
 */
export async function readRecentEntries(key: string, limit: number): Promise<ChatLogEntry[]> {
  if (limit <= 0) return [];
  const dir = await resolveDirForRead(key);
  if (!dir) return [];
  try {
    const collected: ChatLogEntry[] = [];
    for (const file of await orderedFiles(dir)) {
      const lines = (await readFile(join(dir, file), "utf8")).split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && collected.length < limit; i--) {
        try {
          collected.push(JSON.parse(lines[i]!));
        } catch {
          // Skip a torn line (e.g. an interrupted write) instead of aborting.
        }
      }
      if (collected.length >= limit) break;
    }
    return collected.reverse();
  } catch (err) {
    console.error(`[ChatLog] Failed to read ${key}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** Total entries on record across all (active + sealed) files. */
export async function countEntries(key: string): Promise<number> {
  const dir = await resolveDirForRead(key);
  if (!dir) return 0;
  try {
    let total = 0;
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      total += (await readFile(join(dir, file), "utf8")).split("\n").filter(Boolean).length;
    }
    return total;
  } catch {
    return 0;
  }
}

/** Render entries for prompt injection: one line each, speaker-prefixed. */
export function formatEntries(entries: ChatLogEntry[]): string[] {
  return entries.map((e) => {
    const time = e.ts.slice(11, 16);
    const who = e.role === "bot" ? "you" : `${e.name ?? "?"}(${e.userId ?? "?"})`;
    const flag = e.unpaired ? " [unpaired]" : "";
    const media = e.mediaPath ? ` (${e.mediaPath})` : "";
    return `${time} ${who}${flag}: ${e.text}${media}`;
  });
}
