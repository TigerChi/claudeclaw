# Slack Bot — claudeclaw

Start a standalone Slack bot process (Socket Mode).

## Usage

```
bun run src/index.ts slack
```

Or via the daemon (`bun run src/index.ts start`), which auto-starts the bot when `slack.botToken` and `slack.appToken` are configured.

## Configuration

Add to `.claude/claudeclaw/settings.json`:

```json
{
  "slack": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedUserIds": [],
    "listenChannels": []
  }
}
```

| Field | Description |
|---|---|
| `botToken` | Bot OAuth token (`xoxb-...`). Needs `chat:write`, `im:history`, `channels:history`, `reactions:write` scopes. |
| `appToken` | App-level token (`xapp-...`) with `connections:write` scope. Required for Socket Mode. |
| `allowedUserIds` | Slack user IDs (e.g. `["U0123ABC"]`) allowed to interact. Empty = all workspace members. |
| `listenChannels` | Channel IDs where the bot responds to every message without needing a mention. |

## Slack App Setup

1. Create a new Slack app at <https://api.slack.com/apps>
2. Under **Socket Mode**, enable Socket Mode and generate an **App Token** with `connections:write`
3. Under **OAuth & Permissions**, add these Bot Token Scopes:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `channels:history`
   - `groups:history`
   - `reactions:write`
   - `files:read`
4. Under **Event Subscriptions → Subscribe to bot events**, add:
   - `message.im` (DMs)
   - `message.channels` (public channels)
   - `message.groups` (private channels)
   - `app_mention`
5. Under **Slash Commands**, register `/reset`, `/compact`, `/status`
6. Install the app to your workspace and copy the Bot Token

## Multi-Session Conversations

Every Slack conversation gets its own isolated Claude session, stored in `.claude/claudeclaw/sessions.json`:

- **DM** → keyed by `slk:<channelId>`
- **Channel message / thread reply** → keyed by `slk:<channelId>:<thread_ts>`, where `thread_ts` is the thread's anchor (a new top-level message uses its own `ts`)

Nothing on Slack uses the global session (`session.json`) — that one is for heartbeat and cron runs. Deleting `session.json` therefore does not reset a Slack conversation; remove its `slk:...` entry from `sessions.json` instead.

## Slash Commands

| Command | Description |
|---|---|
| `/reset` | Reset the global session |
| `/compact` | Compact the global session context |
| `/status` | Show session info and active thread sessions |

## Reactions

Include `[react:<emoji>]` in your Claude output to add a reaction to the user's message (e.g. `[react:white_check_mark]`).
