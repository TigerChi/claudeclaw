---
description: Show LINE bot status and manage global session
---

Show the LINE bot integration status. Check the following:

1. **Configuration**: Read `.claude/claudeclaw/settings.json` and check if `line.channelAccessToken` is set (show masked token: first 5 chars + "..."). Show `channelSecret` (masked), `allowedUserIds`, `webhookPort`, and `webhookPath`.

2. **Global Session**: Read `.claude/claudeclaw/session.json` and show:
   - Session UUID (first 8 chars)
   - Created at
   - Last used at
   - Note: This session is used by heartbeat and cron jobs. **LINE messages do not use it** — every DM, group, and room gets its own session keyed `line:dm:<userId>` / `line:group:<groupId>` / `line:room:<roomId>` in `.claude/claudeclaw/sessions.json`.

3. **Per-conversation Sessions**: Read `.claude/claudeclaw/sessions.json` and list the entries whose key starts with `line:` — key, session UUID (first 8 chars), turn count, last used at.

4. **If $ARGUMENTS contains "clear"**: Deleting `.claude/claudeclaw/session.json` only resets the global (heartbeat/cron) session — it does **not** reset any LINE chat. To reset a specific LINE conversation, remove its `line:...` entry from `.claude/claudeclaw/sessions.json`. Confirm with the user which one they meant before deleting anything.

5. **Running**: Check if the daemon is running by reading `.claude/claudeclaw/daemon.pid`. The LINE bot runs a webhook HTTP server in-process with the daemon when credentials are configured.

6. **Webhook URL**: Remind the user that the LINE webhook URL should be set in LINE Developers Console to their public URL + webhookPath (e.g. `https://example.ngrok-free.dev<webhookPath>`).

Format the output clearly for the user.
