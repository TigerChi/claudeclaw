---
description: Manage the ClaudeClaw Hub — multi-agent dashboard and reverse proxy
---

Manage the ClaudeClaw Hub. The hub is a host-global control plane that lists every ClaudeClaw daemon registered on this machine and lets you start/stop/restart them from one dashboard.

Parse `$ARGUMENTS` to determine the action. The first word is the subcommand; remaining words are passed through.

### `status` (default when no arguments)

Run:
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub status
```

Report the output verbatim. Show:
- Whether hub is running (PID + listening URL)
- Auth configured / not configured
- Registered agents and their alive/stopped state

### `init`

Generate the bearer token (one-time setup):
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub init
```

Show the token to the user clearly and remind them: **this token is shown once — copy it now**. Subsequent calls require `--rotate` (see below).

### `start` (with optional flags)

Start the hub daemon. Flags from `$ARGUMENTS` are forwarded:

- `--detach` — run in the background, log to `~/.claude/claudeclaw/hub/hub.log`
- `--host <ip>` — bind a non-loopback IP (e.g. tailscale `100.x.y.z`). Auth must be configured first (`hub init`).
- `--port <n>` — default `4631`.

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub start $ARGUMENTS_AFTER_FIRST_WORD
```

When detaching, wait 1 second after spawn, then run `hub status` to confirm. Show the dashboard URL clearly.

### `stop`

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub stop
```

If the user reports "Hub already running" errors after this, check `ps aux | grep "hub start"` for orphan processes and kill them manually, then `rm ~/.claude/claudeclaw/hub/hub.pid ~/.claude/claudeclaw/hub/hub.port`.

### `token --rotate`

Replace the current token with a new one (revokes the old):
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub token --rotate
```

Show the new token clearly with the same "copy now" warning. Anyone using the old token will need the new one.

### `restart <agent-id|path>`

Restart a specific registered daemon (stop + spawn detached at its `cwd`):
```bash
bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts hub restart $TARGET
```

`$TARGET` is either the 12-char agent ID (from `hub status`) or the absolute project path. Report the new PID and log path.

### Key information

- **First-time setup**: `init` → `start --detach` → open `http://127.0.0.1:4631/` and paste the token.
- **Sharing access**: The token is stable. Click 🔑 Token in the dashboard to copy it. Bind to a tailscale IP (`hub start --host 100.x.y.z`) to share with teammates over a private network.
- **Daemon discovery**: A daemon registers itself in `~/.claude/claudeclaw/daemons/<hash>.json` when it starts. Existing daemons that pre-date the registry feature need to be restarted once before the hub can see them.
- **Full docs**: see `docs/HUB-GUIDE.md` (usage) and `docs/HUB-INTERNALS.md` (architecture).
