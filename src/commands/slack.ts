import { ensureProjectClaudeMd, runUserMessage, streamUserMessage, compactCurrentSession } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resetSession, peekSession } from "../sessions";
import { listThreadSessions, peekThreadSession } from "../sessionManager";
import { transcribeAudioToText } from "../whisper";
import { resolveSkillPrompt } from "../skills";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { existsSync } from "node:fs";

// Slack-specific directives prompt (loaded once)
const SLACK_DIRECTIVES_PATH = join(import.meta.dir, "..", "prompts", "slack", "DIRECTIVES.md");
let slackDirectivesPrompt: string | null = null;

async function loadSlackDirectives(): Promise<string> {
  if (slackDirectivesPrompt !== null) return slackDirectivesPrompt;
  try {
    if (existsSync(SLACK_DIRECTIVES_PATH)) {
      slackDirectivesPrompt = await Bun.file(SLACK_DIRECTIVES_PATH).text();
    } else {
      slackDirectivesPrompt = "";
    }
  } catch {
    slackDirectivesPrompt = "";
  }
  return slackDirectivesPrompt;
}

// --- Slack API constants ---

const SLACK_API = "https://slack.com/api";

// --- Type interfaces ---

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  filetype?: string;
}

interface SlackMessage {
  type: string;
  subtype?: string;
  text: string;
  user?: string;
  bot_id?: string;
  channel: string;
  ts: string;
  thread_ts?: string;     // set on thread replies; equals ts for the first reply
  files?: SlackFile[];
  channel_type?: string;  // "im" | "mpim" | "channel" | "group"
}

interface SlackSocketPayload {
  envelope_id: string;
  type: string;           // "events_api" | "slash_commands" | "interactive" | "disconnect"
  accepts_response_payload?: boolean;
  payload?: {
    // events_api
    type?: string;
    event?: SlackMessage;
    // slash_commands
    command?: string;
    text?: string;
    user_id?: string;
    channel_id?: string;
    // disconnect
    reason?: string;
  };
  // disconnect event fields
  reason?: string;
}

// --- Socket state ---

let ws: WebSocket | null = null;
let running = true;
let slackDebug = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Dedup: track recently processed message timestamps to avoid handling both message + app_mention
const recentlyProcessed = new Map<string, number>();
const DEDUP_TTL_MS = 10_000;

// #4: Track the bot's last message ts per channel+thread for edit/delete directives
const lastBotMessageTs = new Map<string, string>();

function botMessageKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

// #5: Track threads where history has already been loaded
const threadHistoryLoaded = new Set<string>();

function isDuplicate(channelId: string, ts: string): boolean {
  const key = `${channelId}:${ts}`;
  const now = Date.now();
  // Clean old entries
  for (const [k, t] of recentlyProcessed) {
    if (now - t > DEDUP_TTL_MS) recentlyProcessed.delete(k);
  }
  if (recentlyProcessed.has(key)) return true;
  recentlyProcessed.set(key, now);
  return false;
}

// Bot identity (populated from auth.test)
let botUserId: string | null = null;
let botUsername: string | null = null;

// --- Debug ---

function debugLog(message: string): void {
  if (!slackDebug) return;
  console.log(`[Slack][debug] ${message}`);
}

// --- Slack Web API helper ---

async function slackApi<T = Record<string, unknown>>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slack API ${method}: HTTP ${res.status} ${text}`);
  }

  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`Slack API ${method} error: ${data.error ?? "unknown"}`);
  }
  return data;
}

// --- Assistant API helpers ---

async function setAssistantStatus(
  token: string,
  channelId: string,
  threadTs: string,
  status: string,
): Promise<void> {
  await slackApi(token, "assistant.threads.setStatus", {
    channel_id: channelId,
    thread_ts: threadTs,
    status,
  }).catch((err) => {
    debugLog(`assistant.threads.setStatus failed: ${err instanceof Error ? err.message : err}`);
  });
}

async function clearAssistantStatus(
  token: string,
  channelId: string,
  threadTs: string,
): Promise<void> {
  await slackApi(token, "assistant.threads.setStatus", {
    channel_id: channelId,
    thread_ts: threadTs,
    status: "",
  }).catch((err) => {
    debugLog(`assistant.threads.clearStatus failed: ${err instanceof Error ? err.message : err}`);
  });
}

async function setAssistantSuggestedPrompts(
  token: string,
  channelId: string,
  threadTs: string,
  prompts: { title: string; message: string }[],
): Promise<void> {
  await slackApi(token, "assistant.threads.setSuggestedPrompts", {
    channel_id: channelId,
    thread_ts: threadTs,
    prompts,
  }).catch((err) => {
    debugLog(`assistant.threads.setSuggestedPrompts failed: ${err instanceof Error ? err.message : err}`);
  });
}

// Track channels that are assistant threads (no @mention needed)
const assistantThreadChannels = new Set<string>();

// --- Message sending ---

async function sendMessage(
  token: string,
  channelId: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  // Strip [react:...] directives before sending
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return;

  // Slack max message length is 40000 chars, chunk at 3800 for mrkdwn block limits
  const MAX_LEN = 3800;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    const chunk = normalized.slice(i, i + MAX_LEN);
    const params: Record<string, unknown> = {
      channel: channelId,
      text: chunk,
    };
    if (threadTs) params.thread_ts = threadTs;
    await slackApi(token, "chat.postMessage", params);
  }
}

async function sendReaction(
  token: string,
  channelId: string,
  ts: string,
  emoji: string,
): Promise<void> {
  // Slack emoji names don't have colons and must be lowercase
  const name = emoji.replace(/:/g, "").toLowerCase();
  await slackApi(token, "reactions.add", {
    channel: channelId,
    timestamp: ts,
    name,
  }).catch((err) => {
    debugLog(`Reaction failed (${name}): ${err instanceof Error ? err.message : err}`);
  });
}

async function removeReaction(
  token: string,
  channelId: string,
  ts: string,
  emoji: string,
): Promise<void> {
  const name = emoji.replace(/:/g, "").toLowerCase();
  await slackApi(token, "reactions.remove", {
    channel: channelId,
    timestamp: ts,
    name,
  }).catch((err) => {
    debugLog(`Remove reaction failed (${name}): ${err instanceof Error ? err.message : err}`);
  });
}

// --- Message update (for streaming) ---

async function updateMessage(
  token: string,
  channelId: string,
  messageTs: string,
  text: string,
): Promise<void> {
  await slackApi(token, "chat.update", {
    channel: channelId,
    ts: messageTs,
    text,
  }).catch((err) => {
    debugLog(`chat.update failed: ${err instanceof Error ? err.message : err}`);
  });
}

async function deleteMessage(
  token: string,
  channelId: string,
  messageTs: string,
): Promise<void> {
  await slackApi(token, "chat.delete", {
    channel: channelId,
    ts: messageTs,
  }).catch((err) => {
    debugLog(`chat.delete failed: ${err instanceof Error ? err.message : err}`);
  });
}

async function postMessage(
  token: string,
  channelId: string,
  text: string,
  threadTs?: string,
): Promise<string | null> {
  const params: Record<string, unknown> = {
    channel: channelId,
    text,
  };
  if (threadTs) params.thread_ts = threadTs;
  const data = await slackApi<{ ts: string }>(token, "chat.postMessage", params).catch((err) => {
    debugLog(`chat.postMessage failed: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  return data?.ts ?? null;
}

// Streaming: send initial message then update it as chunks arrive
const STREAM_UPDATE_INTERVAL_MS = 1200; // throttle updates to ~1/sec

// --- Reaction directive extraction ---

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}

// --- #3: Block Kit directive extraction ---

interface BlockKitButton {
  label: string;
  value: string;
  style?: "primary" | "danger";
}

interface BlockKitSelect {
  placeholder: string;
  options: { label: string; value: string }[];
}

function extractBlockKitDirectives(text: string): {
  cleanedText: string;
  buttons: BlockKitButton[] | null;
  select: BlockKitSelect | null;
} {
  let buttons: BlockKitButton[] | null = null;
  let select: BlockKitSelect | null = null;

  let cleaned = text
    // Parse [[slack_buttons: Label1:value1, Label2:value2]]
    .replace(/\[\[slack_buttons:\s*(.+?)\]\]/gi, (_match, raw) => {
      buttons = String(raw).split(",").map((pair) => {
        const trimmed = pair.trim();
        const colonIdx = trimmed.lastIndexOf(":");
        if (colonIdx === -1) return { label: trimmed, value: trimmed.toLowerCase().replace(/\s+/g, "_") };
        const label = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();
        return { label, value };
      }).filter((b) => b.label);
      return "";
    })
    // Parse [[slack_select: Placeholder | Option1:opt1, Option2:opt2]]
    .replace(/\[\[slack_select:\s*(.+?)\]\]/gi, (_match, raw) => {
      const parts = String(raw).split("|");
      const placeholder = parts.length > 1 ? parts[0].trim() : "請選擇";
      const optionsStr = parts.length > 1 ? parts.slice(1).join("|").trim() : parts[0].trim();
      const options = optionsStr.split(",").map((pair) => {
        const trimmed = pair.trim();
        const colonIdx = trimmed.lastIndexOf(":");
        if (colonIdx === -1) return { label: trimmed, value: trimmed.toLowerCase().replace(/\s+/g, "_") };
        return { label: trimmed.slice(0, colonIdx).trim(), value: trimmed.slice(colonIdx + 1).trim() };
      }).filter((o) => o.label);
      if (options.length > 0) select = { placeholder, options };
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleanedText: cleaned, buttons: buttons && buttons.length > 0 ? buttons : null, select };
}

async function sendBlockKitMessage(
  token: string,
  channelId: string,
  text: string,
  buttons: BlockKitButton[] | null,
  select: BlockKitSelect | null,
  threadTs?: string,
): Promise<string | null> {
  const blocks: Record<string, unknown>[] = [];

  if (text) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text },
    });
  }

  const actionElements: Record<string, unknown>[] = [];

  if (buttons) {
    for (const btn of buttons) {
      const element: Record<string, unknown> = {
        type: "button",
        text: { type: "plain_text", text: btn.label },
        action_id: `btn_${btn.value}`,
        value: btn.value,
      };
      if (btn.style) element.style = btn.style;
      actionElements.push(element);
    }
  }

  if (select) {
    actionElements.push({
      type: "static_select",
      placeholder: { type: "plain_text", text: select.placeholder },
      action_id: "select_action",
      options: select.options.map((o) => ({
        text: { type: "plain_text", text: o.label },
        value: o.value,
      })),
    });
  }

  if (actionElements.length > 0) {
    blocks.push({
      type: "actions",
      elements: actionElements,
    });
  }

  const params: Record<string, unknown> = {
    channel: channelId,
    text: text || "Interactive message",
    blocks,
  };
  if (threadTs) params.thread_ts = threadTs;

  const data = await slackApi<{ ts: string }>(token, "chat.postMessage", params).catch((err) => {
    debugLog(`sendBlockKitMessage failed: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  return data?.ts ?? null;
}

// --- #4: Edit/Delete directive extraction ---

function extractEditDirective(text: string): {
  cleanedText: string;
  editContent: string | null;
  deleteCount: number; // 0 = no delete, -1 = delete all, N = delete last N
  deleteMatches: string[]; // content patterns to match for targeted deletion
} {
  let editContent: string | null = null;
  let deleteCount = 0;
  const deleteMatches: string[] = [];

  const cleaned = text
    .replace(/\[edit_last\]([\s\S]*?)\[\/edit_last\]/gi, (_match, content) => {
      editContent = String(content).trim();
      return "";
    })
    .replace(/\[delete_all\]/gi, () => {
      deleteCount = -1;
      return "";
    })
    .replace(/\[delete_last(?::(\d+))?\]/gi, (_match, n) => {
      deleteCount = n ? parseInt(n, 10) : 1;
      return "";
    })
    .replace(/\[delete_match:([^\]]+)\]/gi, (_match, pattern) => {
      deleteMatches.push(String(pattern).trim());
      return "";
    })
    .trim();

  return { cleanedText: cleaned, editContent, deleteCount, deleteMatches };
}

// Fetch bot's own messages from channel/thread history for edit/delete
async function fetchBotMessages(
  token: string,
  channelId: string,
  threadTs?: string,
  limit: number = 50,
): Promise<{ ts: string; text: string }[]> {
  if (threadTs) {
    // Thread: use conversations.replies
    const params = new URLSearchParams({
      channel: channelId,
      ts: threadTs,
      limit: String(limit),
      inclusive: "true",
    });
    const res = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as { ok: boolean; messages?: Array<{ ts: string; text: string; bot_id?: string; user?: string }> };
    if (!data.ok || !data.messages) return [];
    return data.messages
      .filter((m) => m.user === botUserId || m.bot_id)
      .map((m) => ({ ts: m.ts, text: m.text }));
  } else {
    // DM/channel: use conversations.history
    const data = await slackApi<{ messages: Array<{ ts: string; text: string; bot_id?: string; user?: string }> }>(
      token, "conversations.history", { channel: channelId, limit },
    );
    return (data.messages ?? [])
      .filter((m) => m.user === botUserId || m.bot_id)
      .map((m) => ({ ts: m.ts, text: m.text }));
  }
}

// --- #5: Thread history loading ---

async function fetchThreadHistory(
  token: string,
  channelId: string,
  threadTs: string,
  limit: number = 20,
): Promise<{ role: string; text: string; user?: string; ts: string }[]> {
  // conversations.replies uses GET-style params — pass as query string via fetch
  const params = new URLSearchParams({
    channel: channelId,
    ts: threadTs,
    limit: String(limit),
    inclusive: "true",
  });
  const res = await fetch(`${SLACK_API}/conversations.replies?${params}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as {
    ok: boolean;
    error?: string;
    messages?: Array<{
      text: string;
      user?: string;
      bot_id?: string;
      ts: string;
    }>;
  };
  if (!data.ok) {
    throw new Error(`conversations.replies error: ${data.error ?? "unknown"}`);
  }

  return (data.messages ?? []).map((msg) => ({
    role: msg.bot_id ? "assistant" : "user",
    text: msg.text,
    user: msg.user,
    ts: msg.ts,
  }));
}

function formatThreadHistoryAsContext(
  messages: { role: string; text: string; user?: string; ts: string }[],
): string {
  if (messages.length === 0) return "";

  const lines = ["--- Thread History (previous messages) ---"];
  for (const msg of messages) {
    const sender = msg.role === "assistant" ? "Bot" : `User ${msg.user ?? "unknown"}`;
    lines.push(`[${sender}]: ${msg.text}`);
  }
  lines.push("--- End of Thread History ---");
  lines.push("");
  return lines.join("\n");
}

// --- Thread session key ---
// Slack threads are (channel + thread_ts) rather than a distinct channel ID.
// We prefix with "slk:" to avoid collisions with Discord thread IDs in sessions.json.

function slackThreadId(channelId: string, threadTs: string): string {
  return `slk:${channelId}:${threadTs}`;
}

// --- File download ---

async function downloadSlackFile(
  token: string,
  file: SlackFile,
  type: "image" | "voice",
): Promise<string | null> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) return null;

  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "slack");
  await mkdir(dir, { recursive: true });

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Slack file download failed: ${res.status}`);
  }

  const ext = extname(file.name ?? "") || (type === "voice" ? ".webm" : ".jpg");
  const filename = `${file.id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(localPath, bytes);
  debugLog(`File downloaded: ${localPath} (${bytes.length} bytes)`);
  return localPath;
}

// --- Trigger check ---

function isImageFile(f: SlackFile): boolean {
  return Boolean(f.mimetype?.startsWith("image/"));
}

function isVoiceFile(f: SlackFile): boolean {
  return Boolean(
    f.mimetype?.startsWith("audio/") ||
    f.filetype === "webm" ||
    f.filetype === "mp4",
  );
}

function isBotMentioned(text: string): boolean {
  if (!botUserId) return false;
  return text.includes(`<@${botUserId}>`);
}

function isDM(event: SlackMessage): boolean {
  return event.channel_type === "im";
}

// --- Message handler ---

async function handleMessage(event: SlackMessage): Promise<void> {
  const config = getSettings().slack;

  // Ignore bot's own messages and other bot messages
  if (event.bot_id || !event.user) return;
  // Skip subtype messages (edits, joins, etc.) unless they are file_share
  if (event.subtype && event.subtype !== "file_share") return;

  // Deduplicate: Slack sends both message + app_mention for @mentions
  if (isDuplicate(event.channel, event.ts)) {
    debugLog(`Skipping duplicate: channel=${event.channel} ts=${event.ts}`);
    return;
  }

  const userId = event.user;
  const channelId = event.channel;
  const isDirectMessage = isDM(event);
  const isListenChannel = config.listenChannels.includes(channelId);
  const mentioned = isBotMentioned(event.text);

  // Determine if we should respond
  const isAssistantThread = assistantThreadChannels.has(channelId);
  if (!isDirectMessage && !mentioned && !isListenChannel && !isAssistantThread) {
    debugLog(`Skip channel=${channelId} user=${userId} text="${event.text.slice(0, 40)}"`);
    return;
  }

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    if (isDirectMessage) {
      await sendMessage(config.botToken, channelId, "Unauthorized.");
    }
    return;
  }

  // Strip mention from text
  let cleanText = event.text;
  if (botUserId) {
    cleanText = cleanText.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }

  const files = event.files ?? [];
  const imageFiles = files.filter(isImageFile);
  const voiceFiles = files.filter(isVoiceFile);
  const hasImage = imageFiles.length > 0;
  const hasVoice = voiceFiles.length > 0;

  if (!cleanText.trim() && !hasImage && !hasVoice) return;

  const label = userId;
  const mediaParts = [hasImage ? "image" : "", hasVoice ? "voice" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Slack ${label}${mediaSuffix}: "${cleanText.slice(0, 60)}${cleanText.length > 60 ? "..." : ""}"`,
  );

  try {
    // Determine thread context for multi-session support.
    // event.thread_ts is set when the message is inside a thread.
    // For the root message of a thread it equals event.ts.
    // We use it to key per-thread sessions; non-thread messages go to global session.
    const inThread = !!event.thread_ts;
    const replyThreadTs = event.thread_ts ?? event.ts; // reply in same thread
    const sessionThreadId = inThread ? slackThreadId(channelId, event.thread_ts!) : undefined;

    // Recover lost thread from sessions.json if needed
    if (inThread && sessionThreadId) {
      const persisted = await peekThreadSession(sessionThreadId);
      if (persisted) {
        debugLog(`Thread session recovered: ${sessionThreadId}`);
      }
    }

    // #5: Load thread history for new thread sessions
    let threadHistoryContext = "";
    if (inThread && sessionThreadId && !threadHistoryLoaded.has(sessionThreadId)) {
      const existingSession = await peekThreadSession(sessionThreadId);
      if (!existingSession) {
        try {
          const history = await fetchThreadHistory(config.botToken, channelId, event.thread_ts!, 20);
          const pastMessages = history.filter((m) => m.ts !== event.ts);
          if (pastMessages.length > 0) {
            threadHistoryContext = formatThreadHistoryAsContext(pastMessages);
            debugLog(`Loaded ${pastMessages.length} thread history messages for ${sessionThreadId}`);
          }
        } catch (err) {
          debugLog(`Failed to load thread history: ${err instanceof Error ? err.message : err}`);
        }
      }
      threadHistoryLoaded.add(sessionThreadId);
    }

    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;

    if (hasImage) {
      try {
        imagePath = await downloadSlackFile(config.botToken, imageFiles[0], "image");
      } catch (err) {
        console.error(`[Slack] Failed to download image: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (hasVoice) {
      try {
        voicePath = await downloadSlackFile(config.botToken, voiceFiles[0], "voice");
      } catch (err) {
        console.error(`[Slack] Failed to download voice: ${err instanceof Error ? err.message : err}`);
      }

      if (voicePath) {
        try {
          voiceTranscript = await transcribeAudioToText(voicePath, {
            debug: slackDebug,
            log: (msg) => debugLog(msg),
          });
        } catch (err) {
          console.error(`[Slack] Failed to transcribe voice: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Skill routing
    const command = cleanText.startsWith("/") ? cleanText.trim().split(/\s+/, 1)[0].toLowerCase() : null;
    let skillContext: string | null = null;
    if (command) {
      try {
        skillContext = await resolveSkillPrompt(command);
      } catch (err) {
        debugLog(`Skill resolution failed for ${command}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Build prompt
    const slackDirectives = await loadSlackDirectives();
    const promptParts = [`[Slack from ${label}]`];
    if (slackDirectives) {
      promptParts.push(slackDirectives);
    }
    // #5: Prepend thread history context
    if (threadHistoryContext) {
      promptParts.push(threadHistoryContext);
    }
    if (skillContext) {
      const args = cleanText.trim().slice(command!.length).trim();
      promptParts.push(`<command-name>${command}</command-name>`);
      promptParts.push(skillContext);
      if (args) promptParts.push(`User arguments: ${args}`);
    } else if (cleanText.trim()) {
      promptParts.push(`Message: ${cleanText}`);
    }
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (hasImage) {
      promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if (hasVoice) {
      promptParts.push("The user attached voice audio, but it could not be transcribed. Ask them to resend a clearer clip.");
    }

    const prefixedPrompt = promptParts.join("\n");

    // Show "thinking" status via Assistant API
    await setAssistantStatus(config.botToken, channelId, replyThreadTs, "正在思考中...");

    // Add thinking reaction
    await sendReaction(config.botToken, channelId, event.ts, "hourglass_flowing_sand");

    const result = await runUserMessage("slack", prefixedPrompt, sessionThreadId);

    // Remove thinking reaction
    await removeReaction(config.botToken, channelId, event.ts, "hourglass_flowing_sand");

    // Clear assistant status
    await clearAssistantStatus(config.botToken, channelId, replyThreadTs);

    if (result.exitCode !== 0) {
      await sendMessage(
        config.botToken,
        channelId,
        `Error (exit ${result.exitCode}): ${result.stderr || result.stdout || "Unknown error"}`,
        replyThreadTs,
      );
    } else {
      // Extract all directives
      const { cleanedText: afterReact, reactionEmoji } = extractReactionDirective(result.stdout || "");
      const { cleanedText: afterEdit, editContent, deleteCount, deleteMatches } = extractEditDirective(afterReact);
      const { cleanedText: finalText, buttons, select } = extractBlockKitDirectives(afterEdit);

      if (reactionEmoji) {
        await sendReaction(config.botToken, channelId, event.ts, reactionEmoji);
      }

      // #4: Handle edit/delete of bot messages via API history lookup
      const msgKey = botMessageKey(channelId, replyThreadTs);

      if (deleteCount !== 0 || deleteMatches.length > 0) {
        try {
          const botMessages = await fetchBotMessages(config.botToken, channelId, replyThreadTs);
          let toDelete: { ts: string; text: string }[] = [];

          if (deleteCount === -1) {
            toDelete = botMessages;
          } else if (deleteCount > 0) {
            toDelete = botMessages.slice(0, deleteCount);
          }

          // Match specific messages by content
          if (deleteMatches.length > 0) {
            for (const pattern of deleteMatches) {
              const lowerPattern = pattern.toLowerCase();
              const matched = botMessages.filter((m) =>
                m.text.toLowerCase().includes(lowerPattern) && !toDelete.some((d) => d.ts === m.ts)
              );
              toDelete.push(...matched);
            }
          }

          for (const msg of toDelete) {
            await deleteMessage(config.botToken, channelId, msg.ts);
          }
          debugLog(`Deleted ${toDelete.length} bot messages`);
          lastBotMessageTs.delete(msgKey);
        } catch (err) {
          debugLog(`Failed to delete bot messages: ${err instanceof Error ? err.message : err}`);
        }
      }

      if (editContent) {
        try {
          const lastTs = lastBotMessageTs.get(msgKey);
          if (lastTs) {
            await updateMessage(config.botToken, channelId, lastTs, editContent);
            debugLog(`Edited last bot message: ${lastTs}`);
          } else {
            // Fallback: fetch from API
            const botMessages = await fetchBotMessages(config.botToken, channelId, replyThreadTs);
            if (botMessages.length > 0) {
              await updateMessage(config.botToken, channelId, botMessages[0].ts, editContent);
              debugLog(`Edited bot message (from history): ${botMessages[0].ts}`);
            }
          }
        } catch (err) {
          debugLog(`Failed to edit bot message: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Send new response (if any text remains after directives)
      if (finalText) {
        let sentTs: string | null = null;
        if (buttons || select) {
          // #3: Send as Block Kit message
          sentTs = await sendBlockKitMessage(config.botToken, channelId, finalText, buttons, select, replyThreadTs);
        } else {
          sentTs = await postMessage(config.botToken, channelId, finalText, replyThreadTs);
          // Handle long messages that need chunking
          if (sentTs && finalText.length > 3800) {
            // First chunk already sent via postMessage, send remaining
            for (let i = 3800; i < finalText.length; i += 3800) {
              const chunkTs = await postMessage(config.botToken, channelId, finalText.slice(i, i + 3800), replyThreadTs);
              if (chunkTs) sentTs = chunkTs;
            }
          }
        }
        if (sentTs) lastBotMessageTs.set(msgKey, sentTs);
      } else if (!editContent && deleteCount === 0) {
        // No text, no edit, no delete — send empty response
        const sentTs = await postMessage(config.botToken, channelId, "(empty response)", replyThreadTs);
        if (sentTs) lastBotMessageTs.set(msgKey, sentTs);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack] Error for ${label}: ${errMsg}`);
    // Clear thinking reaction and status on error
    await removeReaction(config.botToken, channelId, event.ts, "hourglass_flowing_sand");
    await clearAssistantStatus(config.botToken, event.channel, event.thread_ts ?? event.ts);
    await sendMessage(
      config.botToken,
      event.channel,
      `Error: ${errMsg}`,
      event.thread_ts ?? event.ts,
    );
  }
}

// --- #3: Block action handler ---

async function handleBlockAction(payload: any): Promise<void> {
  const config = getSettings().slack;
  const actions = payload.actions as Array<{
    action_id: string;
    value?: string;
    type: string;
    selected_option?: { value: string; text: { text: string } };
  }>;
  const user = payload.user as { id: string; username?: string };
  const channelId = (payload.channel as { id: string })?.id;
  const message = payload.message as { ts: string; thread_ts?: string } | undefined;

  if (!actions?.length || !channelId || !user?.id) return;

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(user.id)) {
    return;
  }

  const action = actions[0];
  const actionId = action.action_id;
  const value = action.type === "static_select"
    ? action.selected_option?.value ?? ""
    : action.value ?? actionId;
  const label = action.type === "static_select"
    ? action.selected_option?.text?.text ?? value
    : value;

  const threadTs = message?.thread_ts ?? message?.ts;
  const replyThreadTs = threadTs ?? message?.ts;
  const sessionThreadId = threadTs ? slackThreadId(channelId, threadTs) : undefined;

  console.log(
    `[${new Date().toLocaleTimeString()}] Slack ${user.id} [interactive]: "${actionId}" = "${value}"`,
  );

  // Show thinking
  if (replyThreadTs) {
    await setAssistantStatus(config.botToken, channelId, replyThreadTs, "正在處理中...");
  }

  const prompt = `[Slack interactive from ${user.id}]\nUser clicked: "${label}" (action: ${actionId}, value: ${value})`;
  const result = await runUserMessage("slack", prompt, sessionThreadId);

  if (replyThreadTs) {
    await clearAssistantStatus(config.botToken, channelId, replyThreadTs);
  }

  if (result.exitCode === 0 && result.stdout) {
    const { cleanedText } = extractReactionDirective(result.stdout);
    const { cleanedText: finalText, buttons, select } = extractBlockKitDirectives(cleanedText);

    if (finalText) {
      const msgKey = botMessageKey(channelId, replyThreadTs);
      let sentTs: string | null = null;
      if (buttons || select) {
        sentTs = await sendBlockKitMessage(config.botToken, channelId, finalText, buttons, select, replyThreadTs);
      } else {
        sentTs = await postMessage(config.botToken, channelId, finalText, replyThreadTs);
      }
      if (sentTs) lastBotMessageTs.set(msgKey, sentTs);
    }
  } else if (result.exitCode !== 0) {
    await sendMessage(config.botToken, channelId, `Error: ${result.stderr || "Unknown"}`, replyThreadTs);
  }
}

// --- Slash command handler ---

async function handleSlashCommand(
  _token: string,
  command: string,
  _channelId: string,
  userId: string,
): Promise<string> {
  const config = getSettings().slack;

  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    return "Unauthorized.";
  }

  switch (command) {
    case "/reset": {
      await resetSession();
      return "Session reset. Fresh start!";
    }

    case "/compact": {
      const result = await compactCurrentSession();
      if (!result.success) {
        return `Compact failed: ${result.message}`;
      }
      return result.message || "Session compacted.";
    }

    case "/status": {
      const session = await peekSession();
      const threadSessions = await listThreadSessions();
      const lines: string[] = [];

      if (session) {
        lines.push(`*Global session*`);
        lines.push(`  ID: \`${session.sessionId.slice(0, 8)}...\``);
        lines.push(`  Turns: ${session.turnCount}`);
        lines.push(`  Last used: ${new Date(session.lastUsedAt).toLocaleString()}`);
      } else {
        lines.push("No active global session.");
      }

      const slackThreads = threadSessions.filter((ts) => ts.threadId.startsWith("slk:"));
      if (slackThreads.length > 0) {
        lines.push("");
        lines.push(`*Thread sessions* (${slackThreads.length})`);
        const shown = slackThreads.slice(0, 5);
        for (const ts of shown) {
          const parts = ts.threadId.split(":");
          const label = parts.length === 3 ? `#${parts[1]}:${parts[2]}` : ts.threadId;
          lines.push(`  ${label} — ${ts.turnCount} turns`);
        }
        if (slackThreads.length > 5) {
          lines.push(`  ... and ${slackThreads.length - 5} more`);
        }
      }

      lines.push("");
      lines.push(`Security: \`${config.allowedUserIds.length === 0 ? "open" : "restricted"}\``);

      return lines.join("\n");
    }

    default:
      return `Unknown command: ${command}`;
  }
}

// --- Socket payload handler ---

async function handleSocketPayload(
  raw: string,
  sendAck: (envelopeId: string, responsePayload?: unknown) => void,
): Promise<void> {
  let data: SlackSocketPayload;
  try {
    data = JSON.parse(raw) as SlackSocketPayload;
  } catch (err) {
    debugLog(`Failed to parse socket payload: ${err}`);
    return;
  }

  // Slack always expects an ACK within 3 seconds to prevent retry
  if (data.envelope_id) {
    // ACK immediately (before async processing) unless we return a response
    if (!data.accepts_response_payload) {
      sendAck(data.envelope_id);
    }
  }

  const type = data.type;

  if (type === "hello") {
    console.log("[Slack] Socket connected");
    return;
  }

  if (type === "disconnect") {
    debugLog(`Disconnect requested: ${data.reason ?? data.payload?.reason}`);
    ws?.close(1000, "Disconnect requested");
    return;
  }

  if (type === "events_api" && data.payload?.event) {
    const event = data.payload.event;

    // Handle Assistant thread started — user opened the assistant panel
    if (event.type === "assistant_thread_started") {
      const threadChannel = (event as any).assistant_thread?.channel_id;
      const threadTs = (event as any).assistant_thread?.thread_ts;
      if (threadChannel) {
        assistantThreadChannels.add(threadChannel);
        debugLog(`Assistant thread started: channel=${threadChannel} ts=${threadTs}`);
        const config = getSettings().slack;
        // Set suggested prompts for the new thread
        if (threadChannel && threadTs) {
          await setAssistantSuggestedPrompts(config.botToken, threadChannel, threadTs, [
            { title: "專案狀態", message: "目前專案的狀態如何？" },
            { title: "幫我分析", message: "請幫我分析一下..." },
          ]);
        }
      }
      return;
    }

    // Handle Assistant thread context changed
    if (event.type === "assistant_thread_context_changed") {
      const threadChannel = (event as any).assistant_thread?.channel_id;
      if (threadChannel) {
        assistantThreadChannels.add(threadChannel);
        debugLog(`Assistant thread context changed: channel=${threadChannel}`);
      }
      return;
    }

    if (event.type === "message" || event.type === "app_mention") {
      await handleMessage(event).catch((err) => {
        console.error(`[Slack] handleMessage error: ${err instanceof Error ? err.message : err}`);
      });
    }
    return;
  }

  if (type === "slash_commands" && data.payload) {
    const p = data.payload;
    const command = p.command ?? "";
    const channelId = p.channel_id ?? "";
    const userId = p.user_id ?? "";
    const config = getSettings().slack;

    const responseText = await handleSlashCommand(config.botToken, command, channelId, userId).catch(
      (err) => `Error: ${err instanceof Error ? err.message : String(err)}`,
    );

    // For slash commands, Slack expects the response in the ACK itself
    if (data.accepts_response_payload) {
      sendAck(data.envelope_id!, { text: responseText });
    } else {
      sendAck(data.envelope_id!);
      // Fallback: post as message
      await sendMessage(config.botToken, channelId, responseText).catch(() => {});
    }
    return;
  }

  // #3: Handle interactive events (button clicks, select menus)
  if (type === "interactive" && data.payload) {
    const interactivePayload = data.payload as any;
    if (data.accepts_response_payload) {
      sendAck(data.envelope_id!);
    }
    if (interactivePayload.type === "block_actions") {
      await handleBlockAction(interactivePayload).catch((err) => {
        console.error(`[Slack] handleBlockAction error: ${err instanceof Error ? err.message : err}`);
      });
    }
    return;
  }

  debugLog(`Unhandled socket event type: ${type}`);
}

// --- Socket connection ---

function connectSocket(appToken: string): void {
  if (!running) return;

  debugLog("Fetching Socket Mode URL...");

  fetch(`${SLACK_API}/apps.connections.open`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  })
    .then((r) => r.json())
    .then((data: any) => {
      if (!data.ok || !data.url) {
        throw new Error(`apps.connections.open failed: ${data.error ?? "no URL returned"}`);
      }
      openSocket(data.url as string, appToken);
    })
    .catch((err) => {
      console.error(`[Slack] Failed to open socket connection: ${err instanceof Error ? err.message : err}`);
      scheduleReconnect(appToken);
    });
}

function openSocket(url: string, appToken: string): void {
  debugLog(`Opening WebSocket: ${url.slice(0, 60)}...`);

  ws = new WebSocket(url);

  ws.onopen = () => {
    debugLog("WebSocket opened");
  };

  ws.onmessage = (event) => {
    const raw = String(event.data);
    const sendAck = (envelopeId: string, payload?: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) {
        const msg: Record<string, unknown> = { envelope_id: envelopeId };
        if (payload !== undefined) msg.payload = payload;
        ws.send(JSON.stringify(msg));
      }
    };
    handleSocketPayload(raw, sendAck).catch((err) => {
      console.error(`[Slack] Socket payload error: ${err instanceof Error ? err.message : err}`);
    });
  };

  ws.onclose = (event) => {
    debugLog(`WebSocket closed: code=${event.code} reason=${event.reason}`);
    ws = null;
    if (!running) return;
    console.log("[Slack] Connection closed, reconnecting...");
    scheduleReconnect(appToken);
  };

  ws.onerror = () => {
    // onclose fires after onerror, handled there
  };

  // Slack Socket Mode connections rotate every ~30 minutes.
  // We reconnect proactively at ~29 minutes to avoid forced disconnects.
  const RECONNECT_MS = 29 * 60 * 1000;
  setTimeout(() => {
    if (!running) return;
    debugLog("Proactive reconnect (30-min rotation)");
    ws?.close(1000, "Proactive reconnect");
  }, RECONNECT_MS);

}

function scheduleReconnect(appToken: string): void {
  if (!running) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = 3000 + Math.random() * 4000;
  reconnectTimer = setTimeout(() => {
    if (running) connectSocket(appToken);
  }, delay);
}

// --- Exports ---

export { sendMessage };

export async function sendMessageToUser(
  token: string,
  userId: string,
  text: string,
): Promise<void> {
  const data = await slackApi<{ channel: { id: string } }>(token, "conversations.open", {
    users: userId,
  });
  await sendMessage(token, data.channel.id, text);
}

export function stopSlack(): void {
  running = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close(1000, "Stop requested");
    } catch {
      // best-effort
    }
    ws = null;
  }
}

export function startSlack(debug = false): void {
  slackDebug = debug;
  const config = getSettings().slack;

  if (ws) stopSlack();
  running = true;

  console.log("Slack bot started (Socket Mode)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (config.listenChannels.length > 0) {
    console.log(`  Listen channels: ${config.listenChannels.join(", ")}`);
  }
  if (slackDebug) console.log("  Debug: enabled");

  (async () => {
    await ensureProjectClaudeMd();

    // Resolve bot identity
    try {
      const authData = await slackApi<{ user_id: string; user: string }>(
        config.botToken,
        "auth.test",
        {},
      );
      botUserId = authData.user_id;
      botUsername = authData.user;
      console.log(`  Bot: @${botUsername} (${botUserId})`);
    } catch (err) {
      console.error(`[Slack] auth.test failed: ${err instanceof Error ? err.message : err}`);
    }

    connectSocket(config.appToken);
  })().catch((err) => {
    console.error(`[Slack] Fatal: ${err}`);
  });
}

process.on("SIGTERM", () => stopSlack());
process.on("SIGINT", () => stopSlack());

/** Standalone entry point (bun run src/index.ts slack) */
export async function slack(): Promise<void> {
  slackDebug = true; // Enable debug for standalone mode
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().slack;

  if (!config.botToken) {
    console.error("Slack bot token not configured. Set slack.botToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }
  if (!config.appToken) {
    console.error("Slack app token not configured. Set slack.appToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }

  console.log("Slack bot started (Socket Mode, standalone)");

  try {
    const authData = await slackApi<{ user_id: string; user: string }>(config.botToken, "auth.test", {});
    botUserId = authData.user_id;
    botUsername = authData.user;
    console.log(`  Bot: @${botUsername} (${botUserId})`);
  } catch (err) {
    console.error(`[Slack] auth.test failed: ${err instanceof Error ? err.message : err}`);
  }

  connectSocket(config.appToken);
  // Keep process alive
  await new Promise(() => {});
}
