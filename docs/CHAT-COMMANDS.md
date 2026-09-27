# Chat Commands

Commands you can send **to the bot from inside a chat** (Slack DM, Telegram, Discord, LINE). These are different from the Claude Code slash commands (`/claudeclaw:start`, etc.) which run in your terminal — these run in the messaging platform itself.

> Type the command exactly as shown, on its own line. The bot intercepts the command before treating the message as a prompt for Claude.

---

## `/cancel` — Stop the current reply

Aborts whatever Claude is currently working on for your conversation. Useful when you sent a long request, realized it's wrong, and want to start over without waiting for the full reply.

### How to use

Send `/cancel` as the entire message. Whitespace is trimmed; case is ignored (`/Cancel`, `/CANCEL` all work).

### Behavior

- **Cancels the in-flight Claude run** for your conversation: the subprocess gets `SIGTERM`, and the SDK's `AbortController` fires.
- **Does not clear queued-but-not-yet-started messages.** If you piled up 3 messages and Claude is on message 1, `/cancel` only stops message 1 — messages 2 and 3 still run. Send `/cancel` repeatedly if you want to stop all of them.
- **Does not reset the session.** The conversation history is preserved; the cancelled run just doesn't contribute a reply.

### Scope by channel

What "your conversation" means depends on the platform:

| Channel | Cancel scope |
|---|---|
| **Slack** | The current DM, or the current thread in a channel. |
| **Discord** | The current DM or thread. A message in an untracked guild top-level channel cancels the global session instead. |
| **LINE** | The current LINE source — DM, group, or room. |
| **Telegram** | The current chat (and forum topic, if any). |

So `/cancel` in one conversation never affects another. The only exception is an untracked Discord guild channel, which shares the global session.

### Feedback

After `/cancel`:

- If something was actually running → bot replies "🛑 已取消當前處理中的訊息。" (and on Slack, also adds a 🛑 reaction to your `/cancel` message)
- If nothing was running → bot replies "目前沒有正在處理的訊息可以取消。"

### Important caveat

Aborting Claude mid-turn leaves the session in an unpredictable state. The next message *should* resume normally, but in rare cases the session can get stuck. If you see odd behavior after a `/cancel`, reset the session manually (e.g. `/reset` on Telegram, or restart the daemon).

---

## Message queueing (no command needed)

ClaudeClaw automatically queues incoming messages per conversation. **You don't lose messages by sending them too fast** — they just wait their turn.

### Visual feedback

When you send a message, the bot shows you it's been received and is being worked on:

| Channel | Indicator |
|---|---|
| **Slack** | ⏳ reaction on your message (removed when reply is sent) |
| **Telegram** | ⏳ reaction on your message (cleared or replaced when reply is sent) |
| **Discord** | ⏳ reaction on your message (removed when reply is sent) |
| **LINE** | "對方正在輸入" (typing indicator) — LINE doesn't support reactions |

If you see the indicator, your message is in the queue and will be processed in order.

### Queueing scope

Queues are keyed by the same id as the session, so every conversation has its own queue and different conversations run in parallel:

- **Slack**: per DM, and per thread within a channel.
- **Discord**: per DM and per known thread. Untracked guild top-level channels share the global queue.
- **LINE**: per source (DM / group / room).
- **Telegram**: per chat (and per forum topic, when present).

---

## Future commands

This section will grow as more chat commands are added. Existing platform-specific commands (`/reset`, `/sessions`, `/status`, `/context`, `/compact` on Telegram) are documented inline in [`commands/telegram.md`](../commands/telegram.md). The intent is to converge on a unified set of cross-channel chat commands over time.
