---
description: Show Discord bot status and manage global session
---

Show the Discord bot integration status. Check the following:

1. **Configuration**: Read `.claude/claudeclaw/settings.json` and check if `discord.token` is set (show masked token: first 5 chars + "..."). Show `allowedUserIds`.

2. **Global Session**: Read `.claude/claudeclaw/session.json` and show:
   - Session UUID (first 8 chars)
   - Created at
   - Last used at
   - Note: This session is used by heartbeat and cron jobs. On Discord it is only used by messages in guild top-level channels that aren't tracked threads. **DMs and known threads do not use it** — they get their own session keyed by channel id in `.claude/claudeclaw/sessions.json`.

3. **Per-conversation Sessions**: Read `.claude/claudeclaw/sessions.json` and list the entries keyed by a bare numeric Discord channel id (DMs and threads) — key, session UUID (first 8 chars), turn count, last used at.

4. **If $ARGUMENTS contains "clear"**: Deleting `.claude/claudeclaw/session.json` only resets the global session — it does **not** reset a Discord DM or thread. To reset one of those, remove its entry from `.claude/claudeclaw/sessions.json` (Discord also removes a thread's entry automatically when the thread is deleted or archived).

5. **Running**: Check if the daemon is running by reading `.claude/claudeclaw/daemon.pid`. The Discord bot runs in-process with the daemon when a token is configured.

Format the output clearly for the user.
