import { ensureProjectClaudeMd, runUserMessage, cancelThread } from "../runner";
import { isCancelCommand, CANCEL_CONFIRM_MESSAGE, CANCEL_NOTHING_MESSAGE } from "../cancel";
import { addLineAllowedUser, getSettings, loadSettings } from "../config";
import { recordSeen, harvestAgentName, recordDeadLetter } from "../contacts";
import {
  appendChatLog,
  conversationDirPath,
  conversationKey,
} from "../chatlog";
import { peekThreadSession } from "../sessionManager";
import { transcribeAudioToText } from "../whisper";
import { mkdir, rename } from "node:fs/promises";
import { extname, join } from "node:path";
import { existsSync } from "node:fs";
import { createHmac } from "node:crypto";

// LINE-specific directives prompt (loaded once)
const LINE_DIRECTIVES_PATH = join(import.meta.dir, "..", "..", "prompts", "line", "DIRECTIVES.md");
let lineDirectivesPrompt: string | null = null;

async function loadLineDirectives(): Promise<string> {
  if (lineDirectivesPrompt !== null) return lineDirectivesPrompt;
  try {
    if (existsSync(LINE_DIRECTIVES_PATH)) {
      lineDirectivesPrompt = await Bun.file(LINE_DIRECTIVES_PATH).text();
    } else {
      lineDirectivesPrompt = "";
    }
  } catch {
    lineDirectivesPrompt = "";
  }
  return lineDirectivesPrompt;
}

// --- LINE API constants ---

const LINE_API = "https://api.line.me/v2";
const LINE_DATA_API = "https://api-data.line.me/v2";

// --- Type interfaces ---

interface LineMessageEvent {
  type: "message";
  replyToken: string;
  timestamp: number;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message: {
    id: string;
    type: "text" | "image" | "video" | "audio" | "file" | "location" | "sticker";
    text?: string;
    // location
    title?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    // sticker
    packageId?: string;
    stickerId?: string;
    keywords?: string[];
    // file
    fileName?: string;
    fileSize?: number;
    contentProvider?: { type: string };
  };
}

interface LineFollowEvent {
  type: "follow" | "unfollow" | "join" | "leave";
  replyToken?: string;
  timestamp: number;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
}

interface LinePostbackEvent {
  type: "postback";
  replyToken: string;
  timestamp: number;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  postback: {
    data: string;
  };
}

type LineEvent = LineMessageEvent | LineFollowEvent | LinePostbackEvent;

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

interface LineProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
  statusMessage?: string;
}

// --- State ---

let running = true;
let lineDebug = false;
let server: ReturnType<typeof Bun.serve> | null = null;

// Dedup recent events
const recentlyProcessed = new Map<string, number>();
const DEDUP_TTL_MS = 10_000;

// Bot identity
let botUserId: string | null = null;
let botDisplayName: string | null = null;

// User profile cache (5-minute TTL)
const profileCache = new Map<string, { profile: LineProfile; fetchedAt: number }>();
const PROFILE_TTL_MS = 5 * 60 * 1000;

// Loading animation interval handles per reply token
const loadingTimers = new Map<string, ReturnType<typeof setInterval>>();


// --- Debug ---

function debugLog(message: string): void {
  if (!lineDebug) return;
  console.log(`[Line][debug] ${message}`);
}

// --- Dedup ---

function isDuplicate(eventId: string): boolean {
  const now = Date.now();
  for (const [k, t] of recentlyProcessed) {
    if (now - t > DEDUP_TTL_MS) recentlyProcessed.delete(k);
  }
  if (recentlyProcessed.has(eventId)) return true;
  recentlyProcessed.set(eventId, now);
  return false;
}

// --- LINE API helpers ---

async function lineApi<T = Record<string, unknown>>(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const config = getSettings().line;
  const res = await fetch(`${LINE_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.channelAccessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LINE API ${endpoint}: HTTP ${res.status} ${text}`);
  }

  // Some endpoints return empty body (e.g. loading animation)
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {} as T;
  }

  return (await res.json()) as T;
}

// --- Webhook signature verification ---

function verifySignature(body: string, signature: string, channelSecret: string): boolean {
  const expected = createHmac("sha256", channelSecret)
    .update(body)
    .digest("base64");
  return signature === expected;
}

// --- Loading animation ---

async function showLoadingAnimation(chatId: string): Promise<void> {
  try {
    await lineApi("POST", "/bot/chat/loading", {
      chatId,
      loadingSeconds: 20,
    });
  } catch (err) {
    debugLog(`Loading animation failed: ${err instanceof Error ? err.message : err}`);
  }
}

function startLoadingAnimation(chatId: string): void {
  // Show immediately, then repeat every 18 seconds (LINE max is 20s per call)
  showLoadingAnimation(chatId);
  const timer = setInterval(() => {
    showLoadingAnimation(chatId);
  }, 18_000);
  loadingTimers.set(chatId, timer);
}

function stopLoadingAnimation(chatId: string): void {
  const timer = loadingTimers.get(chatId);
  if (timer) {
    clearInterval(timer);
    loadingTimers.delete(chatId);
  }
}

// --- User profile ---

async function getUserProfile(userId: string): Promise<LineProfile | null> {
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_TTL_MS) {
    return cached.profile;
  }

  try {
    const profile = await lineApi<LineProfile>("GET", `/bot/profile/${userId}`);
    profileCache.set(userId, { profile, fetchedAt: Date.now() });
    return profile;
  } catch (err) {
    debugLog(`Failed to get profile for ${userId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Resolve a member of a group/room. Unlike `/bot/profile/{userId}` (which only
 *  returns a profile when the user has added the bot as a friend), the member
 *  endpoint resolves anyone currently in a group/room the bot belongs to — so
 *  non-friend group members get a real name instead of falling back to raw id.
 *  Rooms have their own member endpoint; only groups also expose `/summary`. */
async function getMemberProfile(
  source: LineMessageEvent["source"],
  userId: string,
): Promise<LineProfile | null> {
  const path = source.groupId
    ? `/bot/group/${source.groupId}/member/${userId}`
    : source.roomId
      ? `/bot/room/${source.roomId}/member/${userId}`
      : null;
  if (!path) return null;
  const cached = profileCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_TTL_MS) {
    return cached.profile;
  }
  try {
    const profile = await lineApi<LineProfile>("GET", path);
    profileCache.set(userId, { profile, fetchedAt: Date.now() });
    return profile;
  } catch (err) {
    debugLog(`Failed to get member profile for ${userId} in ${getChatId(source)}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function getDisplayName(
  userId: string,
  source?: LineMessageEvent["source"],
): Promise<string> {
  // In a group/room, resolve via the member endpoint first: the 1:1 friend
  // endpoint returns nothing for members who have not added the bot, which is
  // why unpaired group members otherwise show up as raw user ids.
  if (source && (source.groupId || source.roomId)) {
    const member = await getMemberProfile(source, userId);
    if (member?.displayName) return member.displayName;
  }
  const profile = await getUserProfile(userId);
  return profile?.displayName ?? userId;
}

/** Group display names for contact harvest — LINE only exposes them via a
 *  separate summary endpoint (rooms have no such API and return undefined). */
const groupNameCache = new Map<string, string>();

async function getGroupName(groupId: string): Promise<string | undefined> {
  if (!groupId.startsWith("C")) return undefined;
  const cached = groupNameCache.get(groupId);
  if (cached) return cached;
  try {
    const summary = await lineApi<{ groupName?: string }>("GET", `/bot/group/${groupId}/summary`);
    if (summary?.groupName) {
      groupNameCache.set(groupId, summary.groupName);
      return summary.groupName;
    }
  } catch (err) {
    debugLog(`Failed to get group summary for ${groupId}: ${err instanceof Error ? err.message : err}`);
  }
  return undefined;
}

// --- Message sending ---

async function replyMessage(
  replyToken: string,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  await lineApi("POST", "/bot/message/reply", {
    replyToken,
    messages,
  });
}

async function pushMessage(
  to: string,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  await lineApi("POST", "/bot/message/push", {
    to,
    messages,
  });
}

/**
 * LINE doesn't render ANY markdown — turn claude's typical markdown into
 * plain text so users don't see literal `**bold**`, `# Header`, etc.
 * Code blocks and inline code keep their content (drop the fences/backticks).
 */
function stripMarkdownForLine(text: string): string {
  if (!text) return text;
  // Code blocks: ```lang\nbody\n``` -> just body
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) => code);
  // Inline code: `x` -> x
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // Links: [label](url) -> "label (url)"
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  // Headers: '# X' / '## X' -> X
  text = text.replace(/^#{1,6}\s+(.+?)$/gm, "$1");
  // Blockquotes: '> X' -> X
  text = text.replace(/^>\s+(.+?)$/gm, "$1");
  // Bold: **X** / __X__ -> X
  text = text.replace(/\*\*([^*\n]+?)\*\*/g, "$1");
  text = text.replace(/__([^_\n]+?)__/g, "$1");
  // Italic: *X* / _X_ -> X (only when surrounded by non-word, conservative)
  text = text.replace(/(?<![*\w])\*([^*\n]+?)\*(?!\w)/g, "$1");
  text = text.replace(/(?<![_\w])_([^_\n]+?)_(?!\w)/g, "$1");
  // Strikethrough: ~~X~~ -> X
  text = text.replace(/~~([^~\n]+?)~~/g, "$1");
  // Bullets: '- ' / '* ' at line start -> '• '
  text = text.replace(/^[-*]\s+/gm, "• ");
  return text;
}

async function sendText(
  to: string,
  text: string,
  replyToken?: string,
): Promise<void> {
  // Strip [react:...] directives (LINE doesn't support reactions)
  let normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  // LINE renders no markdown — convert to plain text.
  normalized = stripMarkdownForLine(normalized);
  if (!normalized) return;

  // LINE max 5000 chars per message, max 5 messages per reply
  const MAX_LEN = 4500;
  const chunks: string[] = [];
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    chunks.push(normalized.slice(i, i + MAX_LEN));
  }

  // Try reply first (free, faster), fallback to push
  if (replyToken && chunks.length <= 5) {
    try {
      await replyMessage(
        replyToken,
        chunks.map((chunk) => ({ type: "text", text: chunk })),
      );
      return;
    } catch (err) {
      debugLog(`Reply failed, falling back to push: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Push in batches of 5
  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5);
    await pushMessage(
      to,
      batch.map((chunk) => ({ type: "text", text: chunk })),
    );
  }
}

// --- Media download ---

const DOWNLOAD_MAX_RETRIES = 3;

async function downloadLineContent(
  messageId: string,
  type: "image" | "video" | "audio" | "file",
  fileName?: string,
): Promise<string | null> {
  const config = getSettings().line;
  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "line");
  await mkdir(dir, { recursive: true });

  let lastError = "unknown";
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${LINE_DATA_API}/bot/message/${messageId}/content`, {
        headers: { Authorization: `Bearer ${config.channelAccessToken}` },
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        // 4xx (bar 429) won't fix on retry — content expired or bad id.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
        if (attempt < DOWNLOAD_MAX_RETRIES) await Bun.sleep(attempt * 500);
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      const bytes = new Uint8Array(await res.arrayBuffer());
      // LINE has been seen to answer 200 with an empty body (the same bad
      // response that also drops Content-Type). Treat it as a failure instead
      // of writing a 0-byte file and reporting success.
      if (bytes.length === 0) {
        lastError = "empty body (HTTP 200, 0 bytes)";
        if (attempt < DOWNLOAD_MAX_RETRIES) await Bun.sleep(attempt * 500);
        continue;
      }

      // Determine extension from content-type or filename
      let ext = "";
      if (fileName) {
        ext = extname(fileName);
      } else if (contentType.includes("jpeg") || contentType.includes("jpg")) {
        ext = ".jpg";
      } else if (contentType.includes("png")) {
        ext = ".png";
      } else if (contentType.includes("gif")) {
        ext = ".gif";
      } else if (contentType.includes("mp4")) {
        ext = type === "audio" ? ".m4a" : ".mp4";
      } else if (contentType.includes("audio")) {
        ext = ".m4a";
      }

      // Write to a temp file, then rename into place — a reader that sees the
      // final path always sees the full bytes, never a half-written file.
      const localPath = join(dir, `${messageId}${ext}`);
      const tmpPath = `${localPath}.part`;
      await Bun.write(tmpPath, bytes);
      await rename(tmpPath, localPath);
      debugLog(`Downloaded ${type}: ${localPath} (${bytes.length} bytes)`);
      return localPath;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < DOWNLOAD_MAX_RETRIES) await Bun.sleep(attempt * 500);
    }
  }

  // Give up: record a dead letter so the gap is auditable, and return null so
  // the caller omits mediaPath from the chat log rather than recording a path
  // to a file that was never written.
  console.error(`[Line] Media download failed for ${messageId} (${type}): ${lastError}`);
  await recordDeadLetter({
    at: new Date().toISOString(),
    source: "line-media",
    target: `line:${type}:${messageId}`,
    error: lastError,
    preview: fileName ?? type,
  }).catch(() => {});
  return null;
}

// Attachments are fetched twice per message once the chat log is on: once to
// archive it, once to hand the path to the agent. LINE content is single-copy
// (the local file is keyed by message id, so the second write is identical) —
// memoizing keeps it to one round trip instead.
const downloadedMedia = new Map<string, string | null>();
const DOWNLOAD_CACHE_LIMIT = 200;

async function downloadLineContentOnce(
  messageId: string,
  type: "image" | "video" | "audio" | "file",
  fileName?: string,
): Promise<string | null> {
  if (downloadedMedia.has(messageId)) return downloadedMedia.get(messageId)!;
  const path = await downloadLineContent(messageId, type, fileName);
  if (downloadedMedia.size >= DOWNLOAD_CACHE_LIMIT) {
    // Oldest-first eviction; a miss only costs a re-download, never correctness.
    const oldest = downloadedMedia.keys().next().value;
    if (oldest !== undefined) downloadedMedia.delete(oldest);
  }
  downloadedMedia.set(messageId, path);
  return path;
}

// --- Input sanitization ---

function sanitizeUserInput(text: string): string {
  return text
    .replace(/\[react:[^\]]*\]/gi, "[react removed]")
    .replace(/\[\[line_quick_reply:[^\]]*\]\]/gi, "[quick_reply removed]");
}

// --- Thread/session ID helpers ---

function lineSessionId(source: LineMessageEvent["source"]): string | undefined {
  // Every chat type gets its own session; only system/automation use global.
  if (source.groupId) return `line:group:${source.groupId}`;
  if (source.roomId) return `line:room:${source.roomId}`;
  if (source.userId) return `line:dm:${source.userId}`; // 1:1 DM → own per-user session
  return undefined; // no identifiable source → fall back to global
}

function getChatId(source: LineMessageEvent["source"]): string {
  return source.groupId ?? source.roomId ?? source.userId ?? "unknown";
}

// --- Mention detection for groups ---

// The bot's display name can contain regex metacharacters (e.g. a "." or "+"),
// so escape it before splicing into a `new RegExp`.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBotMentioned(text: string): boolean {
  if (!botDisplayName) return false;
  // LINE doesn't have a standardized @mention format like Slack.
  // Check if the message contains the bot's display name.
  return text.includes(`@${botDisplayName}`);
}

// --- Passive listen buffer ---
//
// The live context feed. Text a group says without mentioning the bot is kept
// here instead of discarded. Nothing in this buffer wakes the agent — it is
// drained (and cleared) into the prompt the next time an authorized user
// speaks, so the agent sees the surrounding conversation, incrementally, without
// being driven by it. Always on; the durable chat log is a separate archive.
//
// Bounded per chat and dropped oldest-first: a chatty group must never grow the
// prompt without limit, and stale context is worth less than recent context.
const PASSIVE_BUFFER_LIMIT = 40;

interface PassiveEntry {
  speaker: string;
  body: string;
  /** Source message id — links to a transcription job for audio. */
  messageId?: string;
  /** True while `body` is an audio placeholder awaiting transcription. */
  audioPending?: boolean;
}
const passiveBuffers = new Map<string, PassiveEntry[]>();

/** Max wall-clock a woken prompt waits for a still-pending transcript that lands
 *  in its drained window. Matches the loading-animation cadence; on timeout the
 *  placeholder is injected as-is (the transcript still reaches the chat log). */
const TRANSCRIBE_WAIT_MS = 15_000;

function recordPassiveEntry(chatId: string, entry: PassiveEntry): void {
  const buffer = passiveBuffers.get(chatId) ?? [];
  buffer.push(entry);
  if (buffer.length > PASSIVE_BUFFER_LIMIT) buffer.splice(0, buffer.length - PASSIVE_BUFFER_LIMIT);
  passiveBuffers.set(chatId, buffer);
}

function recordPassiveMessage(chatId: string, speaker: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  recordPassiveEntry(chatId, { speaker, body: trimmed });
}

// --- Async transcription registry ---
//
// Voice that arrives without waking the agent is transcribed in the background
// (never blocks message handling). Keyed by message id so the woken path and
// the passive path share one job. On completion the transcript is appended to
// the chat log as a NEW entry (append-only; the original voice entry is never
// rewritten) linked back via refId.
interface TranscriptionJob {
  status: "pending" | "done" | "failed";
  text: string | null;
  promise: Promise<string | null>;
}
const transcriptions = new Map<string, TranscriptionJob>();

function ensureTranscription(
  messageId: string,
  audioPath: string,
  onDone?: (text: string | null) => Promise<void> | void,
): TranscriptionJob {
  const existing = transcriptions.get(messageId);
  if (existing) return existing;
  const job: TranscriptionJob = { status: "pending", text: null, promise: Promise.resolve(null) };
  job.promise = (async () => {
    try {
      const result = await transcribeAudioToText(audioPath, { debug: lineDebug, log: (m) => debugLog(m) });
      job.text = result.text || null;
      job.status = "done";
    } catch (err) {
      job.status = "failed";
      debugLog(`Transcription failed for ${messageId}: ${err instanceof Error ? err.message : err}`);
    }
    if (onDone) {
      try { await onDone(job.text); } catch (err) {
        debugLog(`Transcription onDone failed for ${messageId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return job.text;
  })();
  transcriptions.set(messageId, job);
  return job;
}

/** Capture a message the agent was NOT woken by, so its content is not lost:
 *  record a passive entry (drained into the next woken prompt) and, for audio,
 *  kick off background transcription. Media is downloaded (memoized) so a later
 *  "@bot handle that file" can reach it. Gated by the caller on chatLog. */
async function captureSkippedMedia(
  event: LineMessageEvent,
  userId: string,
  displayName: string,
  chatId: string,
  kind: "group" | "room" | "user",
  conversationName: string | undefined,
): Promise<void> {
  const speaker = `${displayName}(${userId})`;
  const type = event.message.type;
  if (!DOWNLOADABLE.has(type)) {
    // sticker / location: a text description is the whole record.
    recordPassiveMessage(chatId, speaker, describeMessage(event.message));
    return;
  }

  let path: string | null = null;
  try {
    path = await downloadLineContentOnce(event.message.id, type as "image" | "video" | "audio" | "file", event.message.fileName);
  } catch (err) {
    console.error(`[Line] Failed to download skipped ${type} ${event.message.id}: ${err instanceof Error ? err.message : err}`);
  }
  const fileTag = path ? ` (檔案: ${path})` : "";

  if (type === "audio") {
    recordPassiveEntry(chatId, {
      speaker,
      messageId: event.message.id,
      audioPending: true,
      body: `[語音轉文字 轉錄中…]${fileTag}`,
    });
    if (path) {
      ensureTranscription(event.message.id, path, async (text) => {
        await appendChatLog(conversationKey(kind, chatId), kind, conversationName, {
          ts: new Date().toISOString(),
          role: "user",
          userId,
          name: displayName,
          kind: "transcript",
          refId: event.message.id,
          text: text ? `[語音轉文字] ${text}` : "[語音轉文字失敗]",
        });
      });
    }
    return;
  }

  const label = type === "image" ? "[圖片]" : type === "video" ? "[影片]" : "[檔案]";
  recordPassiveEntry(chatId, { speaker, messageId: event.message.id, body: `${label}${fileTag}` });
}

/** Called on the unauthorized-user paths (group/room only). Text is always kept
 *  as context; media is captured (download + transcription) only when this
 *  conversation's chat log is on, matching the log's cost/gating. */
async function capturePassive(event: LineMessageEvent, userId: string, isGroup: boolean): Promise<void> {
  if (!isGroup) return;
  const chatId = getChatId(event.source);
  const speaker = await getDisplayName(userId, event.source);
  if (event.message.type === "text") {
    recordPassiveMessage(chatId, `${speaker}(${userId})`, event.message.text ?? "");
    debugLog(`Passive listen captured from ${userId} in ${chatId}`);
    return;
  }
  const config = getSettings().line;
  if (!(config.groups[chatId]?.chatLog ?? config.chatLog.enabled)) return;
  const kind = event.source.groupId ? "group" : "room";
  await captureSkippedMedia(event, userId, speaker, chatId, kind, await getGroupName(chatId));
}

// --- Durable chat log ---
//
// Runs before the authorization and mention checks so the transcript is the
// whole conversation, not just the parts the agent was woken for. A log with
// holes is worse than no log: the agent reading it back would silently miss
// whatever happened while it was not addressed.

/** One-line description of a message. Attachments are archived separately (see
 *  `logInbound`); stickers are describable but not downloadable, so their
 *  keywords and ids are the only record there will ever be of what was sent. */
function describeMessage(message: LineMessageEvent["message"]): string {
  switch (message.type) {
    case "text":
      return message.text ?? "";
    case "sticker": {
      const keywords = message.keywords ?? [];
      const ids = `package ${message.packageId ?? "?"}/${message.stickerId ?? "?"}`;
      return keywords.length > 0
        ? `[sticker: ${keywords.join(", ")} — ${ids}]`
        : `[sticker: ${ids}]`;
    }
    case "location":
      return `[location: ${message.title ?? ""} ${message.address ?? ""} (${message.latitude}, ${message.longitude})]`;
    case "file":
      return `[file: ${message.fileName ?? "unknown"}]`;
    default:
      return `[${message.type}]`;
  }
}

const DOWNLOADABLE = new Set(["image", "video", "audio", "file"]);

async function logInbound(
  event: LineMessageEvent,
  userId: string,
  isGroup: boolean,
  unpaired: boolean,
): Promise<void> {
  const config = getSettings().line;
  const kind = isGroup ? (event.source.groupId ? "group" : "room") : "user";
  const chatId = getChatId(event.source);
  // Global default, with per-conversation opt-out (groups map is keyed by
  // chatId — group/room id or DM user id, so this covers DMs too).
  if (!(config.groups[chatId]?.chatLog ?? config.chatLog.enabled)) return;
  const name = await getDisplayName(userId, event.source);
  const conversationName = isGroup ? await getGroupName(chatId) : name;

  // Never persist the pairing code: it is the shared secret that grants access,
  // and a DM that consists of it is a login, not conversation content.
  const described = describeMessage(event.message);
  const text = config.pairing.code && described.trim() === config.pairing.code
    ? "[pairing code]"
    : described;

  // Archive attachments as well as the line describing them. LINE keeps message
  // content for a limited window only, so a path recorded without the bytes
  // would rot into a dead reference.
  let mediaPath: string | null = null;
  if (DOWNLOADABLE.has(event.message.type)) {
    try {
      mediaPath = await downloadLineContentOnce(
        event.message.id,
        event.message.type as "image" | "video" | "audio" | "file",
        event.message.fileName,
      );
    } catch (err) {
      console.error(`[ChatLog] Failed to archive ${event.message.type} ${event.message.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  await appendChatLog(conversationKey(kind, chatId), kind, conversationName, {
    ...(mediaPath ? { mediaPath } : {}),
    ts: new Date(event.timestamp).toISOString(),
    id: event.message.id,
    role: "user",
    userId,
    name,
    kind: event.message.type,
    text,
    ...(unpaired ? { unpaired: true } : {}),
  });
}

async function logOutbound(source: LineMessageEvent["source"], text: string): Promise<void> {
  const config = getSettings().line;
  const isGroup = source.type === "group" || source.type === "room";
  const kind = isGroup ? (source.groupId ? "group" : "room") : "user";
  const chatId = getChatId(source);
  if (!(config.groups[chatId]?.chatLog ?? config.chatLog.enabled)) return;
  await appendChatLog(conversationKey(kind, chatId), kind, undefined, {
    ts: new Date().toISOString(),
    role: "bot",
    kind: "text",
    text,
  });
}

/** Take everything buffered for this chat and clear it, so the same lines are
 *  never replayed into a second prompt. */
function drainPassiveMessages(chatId: string): PassiveEntry[] {
  const buffer = passiveBuffers.get(chatId);
  if (!buffer || buffer.length === 0) return [];
  passiveBuffers.delete(chatId);
  return buffer;
}

// --- Message handler ---

async function handleMessageEvent(event: LineMessageEvent): Promise<void> {
  const config = getSettings().line;
  const userId = event.source.userId;
  if (!userId) return;

  // Dedup by message ID
  if (isDuplicate(event.message.id)) {
    debugLog(`Skipping duplicate message: ${event.message.id}`);
    return;
  }

  const isGroup = event.source.type === "group" || event.source.type === "room";
  const chatId = getChatId(event.source);

  // Open group: this specific group is flagged to let users who are NOT on the
  // allowlist converse with the agent. It only relaxes the group path — the DM
  // path is untouched, and these users are never added to `allowedUserIds`, so a
  // DM from them is still stopped by the pairing gate. Never true for DMs.
  const groupOpen = isGroup && (config.groups[chatId]?.allowUnauthorized ?? false);

  // Authorization check.
  //
  // Pairing flow triggers when there's a pairing code set and the user isn't
  // already on the allowlist — this is the primary way to add users. It works
  // even with an empty `allowedUserIds`, supporting "pairing-only" setups
  // where the operator never has to look up LINE User IDs by hand.
  //
  // If pairing isn't configured, fall back to the classic allowlist behavior:
  // empty list = allow all, non-empty = strict allowlist.
  const hasPairing = config.pairing.enabled && Boolean(config.pairing.code);
  const onAllowlist = config.allowedUserIds.includes(userId);

  // Record first, gate second — see the chat log section above for why the
  // transcript has to cover messages the agent never acts on.
  await logInbound(event, userId, isGroup, !onAllowlist);

  if (hasPairing && !onAllowlist && !groupOpen) {
    if (!isGroup && event.message.type === "text") {
      const text = (event.message.text ?? "").trim();
      if (text === config.pairing.code) {
        try {
          await addLineAllowedUser(userId);
          console.log(`[${new Date().toLocaleTimeString()}] LINE pairing success: ${userId}`);
          await sendText(userId, config.pairing.successMessage, event.replyToken);
        } catch (err) {
          console.error(`[Line] Pairing persist failed for ${userId}: ${err instanceof Error ? err.message : err}`);
          await sendText(userId, "配對流程發生錯誤，請稍後再試。", event.replyToken);
        }
      } else {
        debugLog(`Pairing prompt sent to ${userId} (input did not match code)`);
        await sendText(userId, config.pairing.welcomeMessage, event.replyToken);
      }
      return;
    }
    await capturePassive(event, userId, isGroup);
    debugLog(`Unauthorized user (no pairing channel for groups/non-text): ${userId}`);
    return;
  }

  if (config.allowedUserIds.length > 0 && !onAllowlist && !groupOpen) {
    await capturePassive(event, userId, isGroup);
    debugLog(`Unauthorized user: ${userId}`);
    return;
  }

  const sessionThreadId = lineSessionId(event.source);

  // Contact harvest — feed the shared candidate pool (contacts/seen/). Runs
  // async and never blocks or fails the message path.
  void (async () => {
    const agent = harvestAgentName(getSettings().agentBus.name);
    if (isGroup) {
      await recordSeen(agent, { platform: "line", id: chatId, kind: "group", name: await getGroupName(chatId) });
    } else {
      await recordSeen(agent, { platform: "line", id: userId, kind: "user", name: await getDisplayName(userId, event.source) });
    }
  })();

  // In groups, check requireMention policy (per-group override falls back to global default).
  //
  // Applies to every message type, not just text. A LINE mention lives in a
  // text message's body, so an image/file/sticker can never carry one — gating
  // only text meant media woke the agent unconditionally in a mention-only
  // group, with no instruction attached to act on. Nothing is lost by skipping:
  // the chat log (written before the auth gate above) already archived the
  // attachment, so a follow-up mention can refer back to it.
  if (isGroup) {
    const groupOverride = config.groups[chatId]?.requireMention;
    const requireMention = groupOverride !== undefined ? groupOverride : config.requireMention;
    const isText = event.message.type === "text";
    if (requireMention && !(isText && isBotMentioned(event.message.text ?? ""))) {
      // Buffer what was said so the next woken prompt has no holes. Text is
      // always kept; media is downloaded + (audio) transcribed only when this
      // conversation's chat log is on, so a later "@bot handle that file/voice"
      // can reach it. Drained (and cleared) into the next woken prompt.
      const speaker = await getDisplayName(userId, event.source);
      if (isText) {
        recordPassiveMessage(chatId, `${speaker}(${userId})`, event.message.text ?? "");
      } else if (config.groups[chatId]?.chatLog ?? config.chatLog.enabled) {
        const kind = event.source.groupId ? "group" : "room";
        await captureSkippedMedia(event, userId, speaker, chatId, kind, await getGroupName(chatId));
      }
      debugLog(`Skip group ${event.message.type} message (mention required): ${chatId}`);
      return;
    }
  }

  const displayName = await getDisplayName(userId, event.source);
  const channelType = isGroup ? (event.source.groupId ? "group" : "room") : "DM";

  let messageText = "";
  let imagePath: string | null = null;
  let voicePath: string | null = null;
  let voiceTranscript: string | null = null;
  let voiceVocabHint = "";
  let filePath: string | null = null;

  switch (event.message.type) {
    case "text": {
      messageText = event.message.text ?? "";
      // Strip bot name from mention
      if (botDisplayName) {
        const rawText = messageText;
        messageText = messageText
          .replace(new RegExp(`@${escapeRegExp(botDisplayName)}`, "g"), "")
          .trim();
        // A bare "@Bot" (mention with no other words) strips to empty. In a
        // group that is still a summons — keep it awake with a placeholder so
        // the empty-message guard below does not drop it, and so downstream
        // `if (messageText)` still injects a Message line. The preceding
        // chat-log window carries whatever the user said just before.
        if (!messageText && isGroup && isBotMentioned(rawText)) {
          messageText =
            "(mentioned you with no other text — see the preceding conversation for what they're referring to)";
        }
      }
      break;
    }

    case "image": {
      try {
        imagePath = await downloadLineContentOnce(event.message.id, "image");
      } catch (err) {
        console.error(`[Line] Failed to download image: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }

    case "video": {
      try {
        filePath = await downloadLineContentOnce(event.message.id, "video");
        messageText = "(user sent a video)";
      } catch (err) {
        console.error(`[Line] Failed to download video: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }

    case "audio": {
      try {
        voicePath = await downloadLineContentOnce(event.message.id, "audio");
      } catch (err) {
        console.error(`[Line] Failed to download audio: ${err instanceof Error ? err.message : err}`);
      }

      if (voicePath) {
        try {
          {
            const result = await transcribeAudioToText(voicePath, {
              debug: lineDebug,
              log: (msg) => debugLog(msg),
            });
            voiceTranscript = result.text || null;
            voiceVocabHint = result.vocabHint;
          }
        } catch (err) {
          console.error(`[Line] Failed to transcribe audio: ${err instanceof Error ? err.message : err}`);
        }
        // Unify with the passive path: persist the transcript to the chat log as
        // a new entry linked to the source (append-only; original is untouched).
        if (voiceTranscript && (config.groups[chatId]?.chatLog ?? config.chatLog.enabled)) {
          const kind = isGroup ? (event.source.groupId ? "group" : "room") : "user";
          void appendChatLog(conversationKey(kind, chatId), kind, isGroup ? await getGroupName(chatId) : displayName, {
            ts: new Date().toISOString(),
            role: "user",
            userId,
            name: displayName,
            kind: "transcript",
            refId: event.message.id,
            text: `[語音轉文字] ${voiceTranscript}`,
          });
        }
      }
      break;
    }

    case "file": {
      try {
        filePath = await downloadLineContentOnce(
          event.message.id,
          "file",
          event.message.fileName,
        );
        messageText = `(user sent a file: ${event.message.fileName ?? "unknown"})`;
      } catch (err) {
        console.error(`[Line] Failed to download file: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }

    case "location": {
      const loc = event.message;
      messageText = `(user shared location: ${loc.title ?? ""} ${loc.address ?? ""} [${loc.latitude}, ${loc.longitude}])`;
      break;
    }

    case "sticker": {
      const keywords = event.message.keywords ?? [];
      const desc = keywords.length > 0 ? keywords.join(", ") : `sticker ${event.message.stickerId}`;
      messageText = `(user sent a sticker: ${desc})`;
      break;
    }
  }

  // Skip if nothing to process
  if (!messageText && !imagePath && !voicePath && !filePath) return;

  const mediaParts = [
    imagePath ? "image" : "",
    voicePath ? "voice" : "",
    filePath ? "file" : "",
  ].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Line ${displayName}(${userId})${mediaSuffix} in ${channelType}: "${(messageText || "(media)").slice(0, 60)}"`,
  );

  // /cancel — abort the in-flight Claude run for this LINE source
  if (isCancelCommand(messageText)) {
    const cancelled = cancelThread(sessionThreadId);
    await sendText(chatId, cancelled ? CANCEL_CONFIRM_MESSAGE : CANCEL_NOTHING_MESSAGE, event.replyToken).catch(() => {});
    return;
  }

  try {
    // Start loading animation
    startLoadingAnimation(chatId);

    // Build prompt
    const lineDirectives = await loadLineDirectives();
    const promptParts = [`[LINE from ${displayName}(${userId}) in ${channelType} ${chatId}]`];
    if (lineDirectives) promptParts.push(lineDirectives);

    // Restricted-group speech discipline (e.g. a channel with outside parties).
    // Governs what to say, not whether to wake — see LineGroupConfig.speechPolicy.
    // A per-group setting wins; otherwise the agent-wide default applies, so an
    // agent can be safe-by-default (defaultSpeechPolicy "restricted") and open
    // up only the groups explicitly marked "normal".
    const speechPolicy = isGroup
      ? (config.groups[chatId]?.speechPolicy ?? config.defaultSpeechPolicy)
      : "normal";
    if (speechPolicy === "restricted") {
      promptParts.push(
        [
          "RESTRICTED GROUP — outsiders are present in this chat.",
          "- Reply ONLY to the message that directly addressed you, and keep it as short as possible.",
          "- Do NOT volunteer information, comment on others' messages, or make small talk.",
          "- Do NOT report task or system status here (e.g. \"created a task\", \"updated Notion\").",
          "  If you did such work, confirm it privately to the admin instead — never in this group.",
          "- When in doubt, stay silent. Recording still happens in the background regardless.",
        ].join("\n"),
      );
    }

    // Extra per-conversation prompt, independent of speechPolicy: a free-text
    // directive appended for this chat. A per-conversation value wins, else the
    // agent-wide default. Stacks on top of the restricted template when both
    // apply; injected on its own for a normal/unset chat. Empty = nothing added.
    const extraPrompt = (config.groups[chatId]?.extraPrompt ?? config.defaultExtraPrompt ?? "").trim();
    if (extraPrompt) promptParts.push(extraPrompt);

    // Preceding conversation. Background only: it has already happened, so do
    // not reply to it or act on it directly.
    //
    // Live context comes from the passive buffer: everything said since the
    // agent last spoke, drained and cleared so nothing is replayed twice.
    const overheard = drainPassiveMessages(chatId);
    if (overheard.length > 0) {
      // If a still-pending voice transcript sits in this window, wait for it
      // (bounded) so its text lands in the prompt rather than a placeholder.
      const pending = overheard
        .filter((e) => e.audioPending && e.messageId && transcriptions.get(e.messageId)?.status === "pending")
        .map((e) => transcriptions.get(e.messageId!)!.promise);
      if (pending.length > 0) {
        await Promise.race([
          Promise.all(pending),
          new Promise((resolve) => setTimeout(resolve, TRANSCRIBE_WAIT_MS)),
        ]);
      }
      const lines = overheard.map((e) => {
        let body = e.body;
        if (e.audioPending && e.messageId) {
          const job = transcriptions.get(e.messageId);
          if (job?.text) body = `[語音轉文字] ${job.text}`;
        }
        return sanitizeUserInput(`${e.speaker}: ${body}`);
      });
      promptParts.push(
        `--- Overheard in this group since you last spoke (${lines.length} message(s), context only — do not reply to these) ---\n${lines.join("\n")}\n--- End of overheard messages ---`,
      );
    }

    // The chat log is a durable archive, not injected turn-by-turn. Point the
    // agent at it so it can read further back on its own when needed.
    if (config.groups[chatId]?.chatLog ?? config.chatLog.enabled) {
      const key = conversationKey(isGroup ? (event.source.groupId ? "group" : "room") : "user", chatId);
      const chatDir = await conversationDirPath(key);
      if (chatDir) {
        promptParts.push(
          `This conversation's full history is archived at ${chatDir} (.jsonl files). Read it yourself if you need context earlier than what is shown above.`,
        );
      }
    }

    if (messageText) {
      promptParts.push(`Message: ${sanitizeUserInput(messageText)}`);
    }
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      if (voiceVocabHint) promptParts.push(voiceVocabHint);
      promptParts.push("The user sent a voice message. Use the transcript as their spoken message.");
    } else if (voicePath) {
      promptParts.push("The user sent a voice message, but it could not be transcribed. Ask them to resend.");
    }
    if (filePath && event.message.type !== "audio" && event.message.type !== "image") {
      promptParts.push(`Attached file: ${filePath}`);
      promptParts.push("The user attached a file. Read and analyze it as needed.");
    }

    const prefixedPrompt = promptParts.join("\n");

    // Run agent
    const result = await runUserMessage("line", prefixedPrompt, sessionThreadId);

    // Stop loading animation
    stopLoadingAnimation(chatId);

    if (result.exitCode !== 0) {
      await sendText(
        chatId,
        `Error (exit ${result.exitCode}): ${result.stderr || result.stdout || "Unknown error"}`,
        event.replyToken,
      );
    } else if (result.stdout) {
      // [notify:] blocks were delivered and stripped by run().
      await sendText(chatId, result.stdout, event.replyToken);
      // Log what we said too, so reading the transcript back shows a dialogue
      // rather than a one-sided list of what everyone else said.
      await logOutbound(event.source, result.stdout);
    }
  } catch (err) {
    stopLoadingAnimation(chatId);
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Line] Error for ${displayName}: ${errMsg}`);
    await sendText(chatId, `Error: ${errMsg}`).catch(() => {});
  }
}

// --- Postback handler ---

async function handlePostbackEvent(event: LinePostbackEvent): Promise<void> {
  const config = getSettings().line;
  const userId = event.source.userId;
  if (!userId) return;

  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) return;

  const chatId = getChatId(event.source);
  const sessionThreadId = lineSessionId(event.source);
  const displayName = await getDisplayName(userId, event.source);

  console.log(
    `[${new Date().toLocaleTimeString()}] Line ${displayName} [postback]: "${event.postback.data}"`,
  );

  startLoadingAnimation(chatId);

  const prompt = `[LINE postback from ${displayName}(${userId})]\nUser action data: ${event.postback.data}`;
  const result = await runUserMessage("line", prompt, sessionThreadId);

  stopLoadingAnimation(chatId);

  if (result.exitCode === 0 && result.stdout) {
    await sendText(chatId, result.stdout, event.replyToken);
  } else if (result.exitCode !== 0) {
    await sendText(chatId, `Error: ${result.stderr || "Unknown"}`, event.replyToken);
  }
}

// --- Webhook handler ---

async function handleWebhook(body: string, signature: string): Promise<void> {
  const config = getSettings().line;

  if (!verifySignature(body, signature, config.channelSecret)) {
    console.error("[Line] Invalid webhook signature");
    return;
  }

  let payload: LineWebhookBody;
  try {
    payload = JSON.parse(body) as LineWebhookBody;
  } catch {
    console.error("[Line] Failed to parse webhook body");
    return;
  }

  // Save destination as bot user ID
  if (payload.destination && !botUserId) {
    botUserId = payload.destination;
    debugLog(`Bot user ID: ${botUserId}`);
  }

  for (const event of payload.events) {
    if (event.type === "message") {
      handleMessageEvent(event as LineMessageEvent).catch((err) => {
        console.error(`[Line] handleMessageEvent error: ${err instanceof Error ? err.message : err}`);
      });
    } else if (event.type === "postback") {
      handlePostbackEvent(event as LinePostbackEvent).catch((err) => {
        console.error(`[Line] handlePostbackEvent error: ${err instanceof Error ? err.message : err}`);
      });
    } else if (event.type === "follow") {
      const userId = event.source.userId;
      debugLog(`New follower: ${userId}`);
    } else if (event.type === "join") {
      const groupId = event.source.groupId ?? event.source.roomId;
      debugLog(`Joined group/room: ${groupId}`);
    }
  }
}

// --- Webhook server ---

function startWebhookServer(port: number): void {
  server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      // LINE webhook
      const config = getSettings().line;
      if (req.method === "POST" && url.pathname === config.webhookPath) {
        const signature = req.headers.get("x-line-signature") ?? "";
        const body = await req.text();

        // Always respond 200 immediately (LINE expects it within 1s)
        handleWebhook(body, signature).catch((err) => {
          console.error(`[Line] Webhook error: ${err instanceof Error ? err.message : err}`);
        });

        return new Response("OK", { status: 200 });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const config = getSettings().line;
  console.log(`  Webhook listening on http://localhost:${port}${config.webhookPath}`);
}

// --- Bot info ---

async function fetchBotInfo(): Promise<void> {
  try {
    const info = await lineApi<{ userId: string; displayName: string; pictureUrl?: string }>(
      "GET",
      "/bot/info",
    );
    botUserId = info.userId;
    botDisplayName = info.displayName;
    console.log(`  Bot: ${botDisplayName} (${botUserId})`);
  } catch (err) {
    console.error(`[Line] Failed to fetch bot info: ${err instanceof Error ? err.message : err}`);
  }
}

// --- Exports ---

export { sendText as sendMessage };

export async function sendMessageToUser(
  userId: string,
  text: string,
): Promise<void> {
  await sendText(userId, text);
}

export function stopLine(): void {
  running = false;
  // Stop all loading timers
  for (const timer of loadingTimers.values()) {
    clearInterval(timer);
  }
  loadingTimers.clear();
  if (server) {
    server.stop();
    server = null;
  }
}

export function startLine(debug = false): void {
  lineDebug = debug;
  const config = getSettings().line;

  if (server) stopLine();
  running = true;

  if (!config.channelAccessToken || !config.channelSecret) {
    console.log("  LINE: not configured");
    return;
  }

  console.log("LINE bot started (Webhook)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (lineDebug) console.log("  Debug: enabled");

  (async () => {
    await ensureProjectClaudeMd();
    await fetchBotInfo();
    try {
      startWebhookServer(config.webhookPort);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EADDRINUSE") || msg.includes("Failed to start") || msg.includes("port")) {
        console.error(`[Line] Port ${config.webhookPort} is already in use.`);
        console.error(`[Line] If running multiple LINE agents, start the proxy first:`);
        console.error(`[Line]   bun run <claudeclaw>/src/index.ts proxy start`);
        console.error(`[Line] Then set a unique webhookPort in this agent's settings.json.`);
      } else {
        console.error(`[Line] Fatal: ${msg}`);
      }
    }
  })().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EADDRINUSE") || msg.includes("Failed to start") || msg.includes("port")) {
      console.error(`[Line] Port ${config.webhookPort} is already in use.`);
      console.error(`[Line] If running multiple LINE agents, use /claudeclaw:proxy start first.`);
    } else {
      console.error(`[Line] Fatal: ${msg}`);
    }
  });
}

process.on("SIGTERM", () => stopLine());
process.on("SIGINT", () => stopLine());

/** Standalone entry point (bun run src/index.ts line) */
export async function line(): Promise<void> {
  lineDebug = true;
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().line;

  if (!config.channelAccessToken) {
    console.error("LINE channel access token not configured. Set line.channelAccessToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }
  if (!config.channelSecret) {
    console.error("LINE channel secret not configured. Set line.channelSecret in .claude/claudeclaw/settings.json");
    process.exit(1);
  }

  console.log("LINE bot started (Webhook, standalone)");

  await fetchBotInfo();
  startWebhookServer(config.webhookPort);

  // Keep process alive
  await new Promise(() => {});
}
