---
description: View or modify heartbeat settings
---

View or modify the heartbeat daemon settings. Use `$ARGUMENTS` to determine the action.

Parse `$ARGUMENTS` to identify what the user wants. If no arguments are given, show the current config.

## Sub-commands

### `show` (default when no arguments)

1. Read `.claude/claudeclaw/settings.json`.
2. Display all settings clearly:

   **General**
   - Model: (e.g. `opus`, `sonnet`, `haiku`, `glm` or "default")
   - API token: (first 5 chars + "..." or "not configured"; used when `model` is `glm`)
   - Fallback model: (e.g. `glm`, `sonnet`, or "not configured")
   - Fallback API token: (first 5 chars + "..." or "not configured")
   - Timezone: (e.g. `America/New_York` or "UTC")

   **Heartbeat**
   - Enabled: yes/no
   - Interval: Xm
   - Prompt: (show full prompt or "not set")
   - Exclude windows: (list each window's days + start-end, or "none")
   - Ping when silent: yes/no (send a "nothing needed attention" line when a heartbeat run comes back silenced)
   - Silent-ping targets: (list them, or "nobody" when empty)

   **Telegram**
   - Token: (first 5 chars + "..." or "not configured")
   - Allowed users: (list IDs or "none")

   **Security**
   - Level: (locked/strict/moderate/unrestricted)
   - Allowed tools: (list or "default")
   - Disallowed tools: (list or "none")

   **Web UI**
   - Enabled: yes/no
   - Address: host:port

3. Also list any cron jobs from `.claude/claudeclaw/jobs/` with their name and schedule.
4. Remind the user that changes are hot-reloaded every 30s — no daemon restart needed.

### `heartbeat on` / `heartbeat off` / `heartbeat enable` / `heartbeat disable`

Toggle the heartbeat on or off.

1. Read `.claude/claudeclaw/settings.json`.
2. Set `heartbeat.enabled` to `true` or `false` based on the command.
3. Write the updated settings back.
4. Confirm the change.

### `heartbeat interval <minutes>` / `interval <minutes>`

Change the heartbeat interval.

1. Parse the number of minutes from `$ARGUMENTS`. If not provided or invalid, use **AskUserQuestion**: "How often should the heartbeat run?" (header: "Interval", options: "5 minutes", "15 minutes (Recommended)", "30 minutes", "60 minutes")
2. Read `.claude/claudeclaw/settings.json`.
3. Set `heartbeat.interval` to the new value.
4. Write the updated settings back.
5. Confirm the change. The daemon will pick up the new interval within 30 seconds.

### `heartbeat prompt` / `prompt`

Change the heartbeat prompt.

1. Read `.claude/claudeclaw/settings.json` and show the current prompt.
2. Use **AskUserQuestion**: "What prompt should the heartbeat run?" (header: "Prompt", options: suggest 2-3 prompts relevant to the project, plus the current prompt if set as an option)
3. Set `heartbeat.prompt` to the new value.
4. Write the updated settings back.
5. Confirm the change.

### `heartbeat silent-ping on` / `heartbeat silent-ping off`

Toggle whether a heartbeat run that found nothing still sends a ping.

Also accept the old spellings (`heartbeat telegram on/off`, `heartbeat forward telegram on/off`) — they set the same thing.

1. Read `.claude/claudeclaw/settings.json`.
2. Set `heartbeat.forwardWhenSilent` to `true` for `on` and `false` for `off`.
   (Older files may carry the previous name `heartbeat.forwardToTelegram`; it is
   still read, but write the new name.)
3. Write the updated settings back.
4. Confirm the change.
5. Clarify behavior:
   - `true` = silent runs ping the recipients in `heartbeat.silentTargets`
   - `false` = silent runs send nothing at all (default)
6. If turning it on while `heartbeat.silentTargets` is empty, say so — nothing
   will be sent until a target is added (see the next command).

### `heartbeat silent-ping to <targets>` / `heartbeat silent-ping to none`

Set who receives the silent-ping. Comma-separated.

1. Read `.claude/claudeclaw/settings.json`.
2. Set `heartbeat.silentTargets` to the parsed list (`none` / `off` clears it to `[]`).
3. Write the updated settings back.
4. Confirm the change.

Accepted target forms:

| Target | Meaning |
|--------|---------|
| `all` | Every configured platform's allowed users |
| `telegram` / `discord` / `slack` / `line` | That one platform's allowed users |
| `<platform>:<id>` | One exact chat — e.g. `line:C0123…` for a group, `telegram:7692339732` for a DM |
| `<name>` or `<name>@<platform>` | A recipient from the shared contacts book |

**Empty means nobody**, even with `forwardWhenSilent` on. This is the opposite
of a cron job's `channels:` field, where empty means broadcast — do not assume
the two behave alike.

### `telegram token <token>` / `telegram token`

Set or update the Telegram bot token.

1. If token is in `$ARGUMENTS`, use it directly.
2. Otherwise, use **AskUserQuestion**: "What is your Telegram bot token from @BotFather?" (header: "Token", options: let user type via Other)
3. Read `.claude/claudeclaw/settings.json`.
4. Set `telegram.token` to the new value.
5. Write and confirm.

### `telegram users <id1,id2,...>` / `telegram users`

Set the allowed Telegram user IDs.

1. If IDs are in `$ARGUMENTS`, parse them as comma-separated numbers.
2. Otherwise, use **AskUserQuestion**: "What Telegram user IDs should be allowed? (comma-separated)" (header: "User IDs", options: let user type via Other)
3. Read `.claude/claudeclaw/settings.json`.
4. Set `telegram.allowedUserIds` to the array of numbers.
5. Write and confirm.

### `telegram off` / `telegram disable`

Disable Telegram integration.

1. Read `.claude/claudeclaw/settings.json`.
2. Set `telegram.token` to `""` and `telegram.allowedUserIds` to `[]`.
3. Write and confirm.

### `model <name>` / `model`

Set the Claude model to use for sessions.

1. If model name is in `$ARGUMENTS`, use it directly.
2. Otherwise, use **AskUserQuestion**: "Which Claude model should ClaudeClaw use?" (header: "Model", options: "opus (default)", "sonnet", "haiku", "glm")
3. Read `.claude/claudeclaw/settings.json`.
4. Set `model` to the new value.
5. If the selected model is `glm`, ask for `api` token (unless already set) and save it to top-level `api`.
6. If model is changed away from `glm`, keep `api` unchanged.
7. Write and confirm.

### `api <token>` / `api`

Set or update the API token used when `model` is `glm`.

1. If token is in `$ARGUMENTS`, use it directly.
2. Otherwise, use **AskUserQuestion**: "What API token should ClaudeClaw use for glm?" (header: "API token", options: let user type via Other)
3. Read `.claude/claudeclaw/settings.json`.
4. Set top-level `api` to the new value.
5. Write and confirm.

### `fallback model <name>` / `fallback model`

Set the fallback model used when the primary model hits a rate limit.

1. If fallback model name is in `$ARGUMENTS`, use it directly.
2. Otherwise, use **AskUserQuestion**: "Which fallback model should ClaudeClaw use?" (header: "Fallback model", options: "glm (Recommended)", "sonnet", "haiku")
3. Read `.claude/claudeclaw/settings.json`.
4. Set `fallback.model` to the chosen value (`""` for none).
5. Write and confirm.

### `fallback api <token>` / `fallback api`

Set or clear the API token for the fallback model.

1. If token is in `$ARGUMENTS`, use it directly.
2. Otherwise, use **AskUserQuestion**: "What API token should ClaudeClaw use for fallback model?" (header: "Fallback API token", options: let user type via Other)
3. Read `.claude/claudeclaw/settings.json`.
4. Set `fallback.api` to the new value.
5. Write and confirm.

### `timezone <tz>` / `timezone`

Set the IANA timezone (e.g. `America/New_York`, `Europe/London`, `UTC`).

1. If timezone is in `$ARGUMENTS`, use it directly.
2. Otherwise, use **AskUserQuestion**: "What timezone should ClaudeClaw use?" (header: "Timezone", options: "UTC (Recommended)", "America/New_York", "Europe/London")
3. Read `.claude/claudeclaw/settings.json`.
4. Set `timezone` to the new value. The `timezoneOffsetMinutes` will be auto-resolved from the timezone name.
5. Write and confirm.

### `security level <level>` / `security`

Set the security level for Claude sessions.

1. If level is in `$ARGUMENTS`, validate it is one of: `locked`, `strict`, `moderate`, `unrestricted`.
2. Otherwise, use **AskUserQuestion**: "What security level should sessions use?" (header: "Security", options: "locked — Read/Grep/Glob only", "strict — No Bash/WebSearch/WebFetch", "moderate — All tools, project-scoped (Recommended)", "unrestricted — All tools, no restrictions")
3. Read `.claude/claudeclaw/settings.json`.
4. Set `security.level` to the new value.
5. Write and confirm. Explain what the chosen level permits.

### `security tools allow <tool1,tool2,...>` / `security tools disallow <tool1,tool2,...>`

Add tools to the allowed or disallowed lists.

1. Parse comma-separated tool names from `$ARGUMENTS`.
2. Read `.claude/claudeclaw/settings.json`.
3. Append to `security.allowedTools` or `security.disallowedTools` (deduplicated).
4. Write and confirm.

### `web on` / `web off` / `web enable` / `web disable`

Toggle the web UI.

1. Read `.claude/claudeclaw/settings.json`.
2. Set `web.enabled` to `true` or `false`.
3. Write and confirm.

### `web port <port>` / `web host <host>`

Configure web UI bind address or port.

1. Parse the value from `$ARGUMENTS`.
2. Read `.claude/claudeclaw/settings.json`.
3. Set `web.port` (number) or `web.host` (string) accordingly.
4. Write and confirm.

### `reset`

Reset all settings to defaults.

1. Use **AskUserQuestion**: "Reset all settings to defaults? This will disable heartbeat and clear Telegram config." (header: "Confirm", options: "Yes, reset everything", "No, keep current settings")

   ⚠️ **Warn the user before writing**: overwriting `settings.json` wipes every platform credential stored in it — `telegram.token`, `discord.token`, `slack.botToken` / `slack.appToken`, `line.channelAccessToken` / `line.channelSecret` — plus every allowlist and pairing code. Offer to back the file up first (e.g. `cp .claude/claudeclaw/settings.json .claude/claudeclaw/settings.json.bak`).

2. If confirmed, write the default settings (this is `DEFAULT_SETTINGS` from `src/config.ts`):
   ```json
   {
     "model": "",
     "api": "",
     "fallback": {
       "model": "",
       "api": ""
     },
     "agentic": {
       "enabled": false,
       "defaultMode": "implementation",
       "modes": [
         {
           "name": "planning",
           "model": "opus",
           "keywords": [
             "plan", "design", "architect", "strategy", "approach",
             "research", "investigate", "analyze", "explore", "understand",
             "think", "consider", "evaluate", "assess", "review",
             "system design", "trade-off", "decision", "choose", "compare",
             "brainstorm", "ideate", "concept", "proposal"
           ],
           "phrases": [
             "how to implement", "how should i", "what's the best way to",
             "should i", "which approach", "help me decide", "help me understand"
           ]
         },
         {
           "name": "implementation",
           "model": "sonnet",
           "keywords": [
             "implement", "code", "write", "create", "build", "add",
             "fix", "debug", "refactor", "update", "modify", "change",
             "deploy", "run", "execute", "install", "configure",
             "test", "commit", "push", "merge", "release",
             "generate", "scaffold", "setup", "initialize"
           ]
         }
       ]
     },
     "timezone": "UTC",
     "timezoneOffsetMinutes": 0,
     "heartbeat": {
       "enabled": false,
       "interval": 15,
       "prompt": "",
       "excludeWindows": [],
       "forwardWhenSilent": false,
       "silentTargets": []
     },
     "telegram": {
       "token": "",
       "allowedUserIds": [],
       "pairing": {
         "enabled": false,
         "code": "",
         "welcomeMessage": "Hi! 我是受保護的 bot，請輸入配對碼以開始使用。",
         "successMessage": "✅ 配對成功，歡迎加入！現在可以開始對話了。"
       }
     },
     "discord": {
       "token": "",
       "allowedUserIds": [],
       "listenChannels": []
     },
     "slack": {
       "botToken": "",
       "appToken": "",
       "allowedUserIds": [],
       "listenChannels": []
     },
     "line": {
       "channelAccessToken": "",
       "channelSecret": "",
       "allowedUserIds": [],
       "pairing": {
         "enabled": false,
         "code": "",
         "welcomeMessage": "Hi! 我是受保護的 bot，請輸入配對碼以開始使用。",
         "successMessage": "✅ 配對成功，歡迎加入！現在可以開始對話了。"
       },
       "requireMention": true,
       "groups": {},
       "webhookPort": 3100,
       "webhookPath": "/webhook"
     },
     "security": {
       "level": "moderate",
       "allowedTools": [],
       "disallowedTools": []
     },
     "web": {
       "enabled": false,
       "host": "127.0.0.1",
       "port": 4632
     },
     "stt": {
       "baseUrl": "",
       "model": ""
     },
     "whisper": {
       "engine": "auto",
       "model": "large-v3-turbo",
       "language": ""
     },
     "agentBus": {
       "enabled": false,
       "name": ""
     },
     "notify": {
       "mode": "explicit"
     }
   }
   ```
3. Confirm the reset. Note: this does not delete cron jobs — use `/claudeclaw:jobs delete` for that.

---

## Reference: Settings File

Location: `.claude/claudeclaw/settings.json`

```json
{
  "model": "opus",
  "api": "",
  "fallback": {
    "model": "glm",
    "api": ""
  },
  "timezone": "America/New_York",
  "timezoneOffsetMinutes": -300,
  "heartbeat": {
    "enabled": true,
    "interval": 15,
    "prompt": "Remind me to drink water and stretch.",
    "excludeWindows": [
      { "days": [0, 6], "start": "23:00", "end": "07:00" }
    ],
    "forwardWhenSilent": true,
    "silentTargets": ["telegram:123456789"]
  },
  "telegram": {
    "token": "123456:ABC-DEF...",
    "allowedUserIds": [123456789]
  },
  "security": {
    "level": "moderate",
    "allowedTools": [],
    "disallowedTools": []
  },
  "web": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4632
  }
}
```

| Key                        | Type       | Description                                    |
|----------------------------|------------|------------------------------------------------|
| `model`                    | string     | Claude model (`opus`, `sonnet`, `haiku`, `glm`, or full ID). Empty = default |
| `api`                      | string     | API token used when model is `glm` (mapped to `ANTHROPIC_AUTH_TOKEN`) |
| `fallback.model`           | string     | Backup model used automatically if primary run returns rate-limit text (recommend `glm` for provider diversity) |
| `fallback.api`             | string     | API token used with `fallback.model` (optional) |
| `timezone`                 | string     | IANA timezone name (e.g. `America/New_York`)   |
| `timezoneOffsetMinutes`    | number     | UTC offset in minutes (auto-resolved from timezone) |
| `heartbeat.enabled`        | boolean    | Whether the recurring heartbeat runs           |
| `heartbeat.interval`       | number     | Minutes between heartbeat executions           |
| `heartbeat.prompt`         | string     | Prompt sent to Claude on each heartbeat        |
| `heartbeat.excludeWindows` | object[]   | Quiet windows where heartbeat is skipped       |
| `heartbeat.excludeWindows[].days` | number[] | Days of week (0=Sun..6=Sat); omit for all days |
| `heartbeat.excludeWindows[].start` | string | Window start time in `HH:MM` 24h format       |
| `heartbeat.excludeWindows[].end`   | string | Window end time in `HH:MM` 24h format         |
| `heartbeat.forwardWhenSilent`      | boolean | Ping even when a heartbeat run found nothing (default `false`; old name `forwardToTelegram` still read) |
| `heartbeat.silentTargets`          | string[] | Who receives that ping. Empty (default) = nobody. `"all"`, a platform name (`telegram`/`discord`/`slack`), `"<platform>:<id>"`, or a contacts-book name. LINE has no broadcast: bare `"line"` and `"all"` do NOT reach LINE — use an explicit `"line:<id>"` target instead |
| `telegram.token`           | string     | Bot token from @BotFather                      |
| `telegram.allowedUserIds`  | number[]   | Telegram user IDs allowed to interact          |
| `security.level`           | string     | `locked` \| `strict` \| `moderate` \| `unrestricted` |
| `security.allowedTools`    | string[]   | Extra tools to allow                           |
| `security.disallowedTools` | string[]   | Tools to block                                 |
| `web.enabled`              | boolean    | Whether the web UI is served                   |
| `web.host`                 | string     | Bind address (default `127.0.0.1`)             |
| `web.port`                 | number     | Port number (default `4632`)                   |

The daemon hot-reloads this file every 30 seconds. No restart needed after changes.
