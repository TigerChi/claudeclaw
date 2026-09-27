# Multi-Session Conversation Support

Technical documentation for ClaudeClaw's multi-session feature.

## Overview

All four messaging platforms — LINE, Telegram, Slack, Discord — give each conversation its own Claude CLI session, keyed in `sessions.json`, enabling parallel conversations. The global session (`session.json`) is used by heartbeat and cron runs, and as a fallback for the one platform case that is still untracked (Discord guild top-level channels).

### Session keys per platform

| Platform | Conversation | Session key | Source |
|---|---|---|---|
| LINE | Group | `line:group:<groupId>` | `src/commands/line.ts` |
| LINE | Room | `line:room:<roomId>` | `src/commands/line.ts` |
| LINE | 1:1 DM | `line:dm:<userId>` | `src/commands/line.ts` |
| Telegram | Chat (+ forum topic) | `tg:<chatId>[:<threadId>]` | `src/commands/telegram.ts` |
| Slack | DM | `slk:<channelId>` | `src/commands/slack.ts` |
| Slack | Channel thread | `slk:<channelId>:<thread_ts>` | `src/commands/slack.ts` |
| Discord | DM | `<channelId>` (DM channel id) | `src/commands/discord.ts` |
| Discord | Known thread | `<channelId>` (thread channel id) | `src/commands/discord.ts` |
| Discord | Guild top-level channel | *(none — global session)* | `src/commands/discord.ts` |

**Consequence:** deleting `session.json` does **not** reset any of these conversations — it only affects heartbeat/cron and untracked Discord guild channels. Per-conversation state lives in `sessions.json`.

## Architecture

```
Platform event
  │
  ├─ Untracked Discord guild channel ──→ Global Queue ──→ Global Session (session.json)
  │
  ├─ Conversation A message ───────────→ Queue A ──→ Session A (sessions.json)
  └─ Conversation B message ───────────→ Queue B ──→ Session B (sessions.json)
```

- **Global queue**: Serializes messages that have no session key.
- **Per-conversation queues**: `enqueue()` in `src/runner.ts` keys a queue off the same id used for the session. Different conversations execute in parallel; messages within one conversation are serialized.

## Session Lifecycle

### Creation
1. A message arrives in a conversation.
2. The platform module builds the session key (see the table above; Discord additionally checks its `knownThreads` cache, populated from `GUILD_CREATE`, `THREAD_CREATE`, `THREAD_LIST_SYNC` events).
3. `runUserMessage()` is called with that key as `threadId`.
4. `execClaude()` checks `sessionManager.getThreadSession(threadId)` — returns `null` for new conversations.
5. Claude CLI is invoked with `--output-format json` to bootstrap a new session.
6. The returned `session_id` is saved via `sessionManager.createThreadSession(threadId, sessionId)`.

### Resume
1. Subsequent messages in the same conversation hit `getThreadSession(threadId)` which returns the existing `sessionId`.
2. Claude CLI is invoked with `--resume <sessionId>`.
3. Turn count is incremented per-conversation.

### Cleanup
Discord thread sessions are removed when:
- **Thread deleted**: `THREAD_DELETE` event triggers `removeThreadSession(threadId)`.
- **Thread archived**: `THREAD_UPDATE` with `thread_metadata.archived = true` triggers cleanup.

There is no equivalent automatic cleanup for LINE/Telegram/Slack conversations or Discord DMs — their entries persist in `sessions.json`.

## Concurrency Model

```
Global Queue:  [msg1] → [msg2] → [msg3]     (serial)
Queue A:       [msgA1] → [msgA2]            (serial within conversation A)
Queue B:       [msgB1] → [msgB2]            (serial within conversation B)

Conversation A and conversation B run in parallel.
Global Queue runs independently of all conversation queues.
```

Each queue prevents concurrent `--resume` calls on the same session (which would cause Claude CLI errors). Different sessions can safely run concurrently.

## Storage

### Global session: `.claude/claudeclaw/session.json`
```json
{
  "sessionId": "uuid",
  "createdAt": "ISO8601",
  "lastUsedAt": "ISO8601",
  "turnCount": 42,
  "compactWarned": false
}
```

### Per-conversation sessions: `.claude/claudeclaw/sessions.json`
```json
{
  "threads": {
    "slk:C0123456:1712345678.000100": {
      "sessionId": "uuid",
      "threadId": "slk:C0123456:1712345678.000100",
      "createdAt": "ISO8601",
      "lastUsedAt": "ISO8601",
      "turnCount": 10,
      "compactWarned": false
    }
  }
}
```

The map key is the platform session key from the table at the top of this document.

## Files

| File | Role |
|------|------|
| `src/sessionManager.ts` | Per-conversation session CRUD, storage in `sessions.json` |
| `src/runner.ts` | Per-conversation queues, `threadId` parameter on `run()`/`runUserMessage()`/`execClaude()` |
| `src/commands/line.ts` | LINE session key (`line:group:` / `line:room:` / `line:dm:`) |
| `src/commands/telegram.ts` | Telegram session key (`tg:<chatId>[:<threadId>]`) |
| `src/commands/slack.ts` | Slack session key (`slk:<channelId>[:<thread_ts>]`) |
| `src/commands/discord.ts` | Thread detection via `knownThreads` cache, event handlers, `/status` enhancement |
| `src/sessions.ts` | Global session (unchanged) |

## Thread Detection

Discord thread channels are tracked via gateway events:

| Event | Action |
|-------|--------|
| `GUILD_CREATE` | Cache all active threads from `data.threads` |
| `THREAD_CREATE` | Add thread to cache |
| `THREAD_DELETE` | Remove from cache + cleanup session |
| `THREAD_UPDATE` | Remove if archived, add if unarchived |
| `THREAD_LIST_SYNC` | Bulk-add active threads |

The `knownThreads` map stores `threadId → { parentId }`. When a message's `channel_id` matches a known thread, it's routed to a thread-specific session.

Threads in listen channels (where the parent channel is in `listenChannels`) auto-respond without requiring a mention.

## Limitations

- No max session limit. Relies on Claude CLI's own rate limiting.
- Per-conversation sessions are not automatically compacted (global `/compact` command only affects the global session).
- `/reset` only resets the global session, not per-conversation sessions.
- Deleting `session.json` does not reset a chat — that only touches the global session.
- Discord guild top-level channels that aren't tracked threads still use the global session.
