/**
 * Chat log — durable, per-conversation transcript on disk.
 *
 * The passive-listen buffer it replaces lived in RAM: bounded, lost on restart,
 * and unreachable by the agent (a separate process). Writing the transcript to
 * a file instead means the agent can go back further than whatever we chose to
 * inject, so the prompt stays small without capping how much context is
 * *available*.
 *
 * Layout, one directory per conversation, one file per month:
 *
 *   <project>/.claude/claudeclaw/chatlog/
 *   ├── index.json                     conversation id -> name, kind, counts
 *   ├── group-C0123…/2026-07.jsonl
 *   └── user-U0abc…/2026-07.jsonl
 *
 * Monthly files keep any single read cheap and make "what happened in June"
 * a matter of opening one file. Entries are JSONL so appending never rewrites
 * what is already there.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  /** Local path of the downloaded attachment, for kinds that have one.
   *  Stickers have none — LINE serves no content for them, so the description
   *  in `text` is the whole record. */
  mediaPath?: string;
  /** True when the speaker was not on the allowlist (overheard, never answered). */
  unpaired?: boolean;
}

export interface ChatLogConfig {
  enabled: boolean;
  /** How many prior entries to inject into the prompt. The rest stay on disk. */
  injectRecent: number;
}

const CHATLOG_ROOT = join(process.cwd(), ".claude", "claudeclaw", "chatlog");

/** Stable directory name for a conversation. Group and user ids never collide
 *  in practice, but the prefix keeps the directory listing readable. */
export function conversationKey(kind: "group" | "room" | "user", id: string): string {
  return `${kind}-${id}`;
}

function monthStamp(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function conversationDir(key: string): string {
  return join(CHATLOG_ROOT, key);
}

/** index.json is a convenience for humans and for the agent: it answers "which
 *  directory is the 業務群?" without opening every transcript. */
async function updateIndex(key: string, name: string | undefined, kind: string): Promise<void> {
  const indexPath = join(CHATLOG_ROOT, "index.json");
  let index: Record<string, { name?: string; kind: string; lastActive: string }> = {};
  try {
    if (existsSync(indexPath)) index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    // A corrupt index is not worth failing a message over — start a fresh one.
  }
  const prev = index[key];
  index[key] = {
    // Keep the last known name when this event has none (media from an
    // unresolvable user, API hiccup) rather than blanking a good value.
    name: name || prev?.name,
    kind,
    lastActive: new Date().toISOString(),
  };
  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
}

/** Append one entry. Never throws: losing a log line must not drop a message. */
export async function appendChatLog(
  key: string,
  kind: "group" | "room" | "user",
  displayName: string | undefined,
  entry: ChatLogEntry,
): Promise<void> {
  try {
    const dir = conversationDir(key);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${monthStamp(new Date())}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
    await updateIndex(key, displayName, kind);
  } catch (err) {
    console.error(`[ChatLog] Failed to append for ${key}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Last `limit` entries for a conversation, oldest-first.
 *
 * Walks monthly files newest-first and stops as soon as it has enough, so a
 * years-long transcript costs the same as a one-month one.
 */
export async function readRecentEntries(key: string, limit: number): Promise<ChatLogEntry[]> {
  if (limit <= 0) return [];
  const dir = conversationDir(key);
  if (!existsSync(dir)) return [];

  try {
    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    const collected: ChatLogEntry[] = [];
    for (const file of files) {
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

/** Total entries on record, so the prompt can tell the agent how much more
 *  history exists beyond what was injected. */
export async function countEntries(key: string): Promise<number> {
  const dir = conversationDir(key);
  if (!existsSync(dir)) return 0;
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
