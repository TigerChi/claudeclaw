---
description: Show Telegram bot status and manage global session
---

Show the Telegram bot integration status. Check the following:

1. **Configuration**: Read `.claude/claudeclaw/settings.json` and check if `telegram.token` is set (show masked token: first 5 chars + "..."). Show `allowedUserIds`.

2. **Global Session**: Read `.claude/claudeclaw/session.json` and show:
   - Session UUID (first 8 chars)
   - Created at
   - Last used at
   - Note: This session is used by heartbeat and cron jobs. **Telegram messages do not use it** — every chat gets its own session keyed `tg:<chatId>` (plus `:<threadId>` for forum topics) in `.claude/claudeclaw/sessions.json`.

3. **Per-conversation Sessions**: Read `.claude/claudeclaw/sessions.json` and list the entries whose key starts with `tg:` — key, session UUID (first 8 chars), turn count, last used at.

4. **If $ARGUMENTS contains "clear"**: Deleting `.claude/claudeclaw/session.json` only resets the global (heartbeat/cron) session — it does **not** reset any Telegram chat. Neither does the in-chat `/reset` command, which also targets the global session. To reset a chat, remove its `tg:...` entry from `.claude/claudeclaw/sessions.json`.

5. **Running**: Check if the daemon is running by reading `.claude/claudeclaw/daemon.pid`. The Telegram bot runs in-process with the daemon when a token is configured.

Format the output clearly for the user.
