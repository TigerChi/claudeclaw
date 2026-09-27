---
description: Manage the LINE webhook proxy that routes multiple agents through a single port
---

Manage the LINE Webhook Proxy. The proxy auto-discovers all Claude Code agents on this machine, reads their LINE settings, and routes webhooks by path to each agent's internal port.

Parse `$ARGUMENTS` to determine the action:

### `status` (default when no arguments)

Run the proxy status command:
```bash
bun run <PLUGIN_ROOT>/src/index.ts proxy status
```

Report the output. Show:
- Whether proxy is running (PID)
- External port
- Discovered agents and their routes
- Which agents are connected / not running / not configured

### `start`

1. Check if proxy is already running — if yes, tell the user and exit.
2. Start the proxy as a background daemon (optionally with `--port <n>` / `--bind <addr>`):
```bash
nohup bun run <PLUGIN_ROOT>/src/index.ts proxy start > ~/.claude/claudeclaw/proxy.log 2>&1 & disown
echo "Proxy PID: $!"
```
3. Wait 3 seconds, then read the log to confirm startup.
4. Show the status output (routes, ports, agent health).
5. Remind the user:
   - Their ngrok tunnel should point to the proxy's external port (default 18789)
   - Each agent's `webhookPort` in settings.json must be a unique internal port (not 18789)
   - Agent daemons can be started/restarted independently — the proxy auto-detects them

### `stop`

Run:
```bash
bun run <PLUGIN_ROOT>/src/index.ts proxy stop
```

Report the output.

### Key information

- **Auto-discovery**: The proxy scans `~/.claude/projects/` to find all agent directories automatically. No manual registration needed.
- **Auto-reload**: Every 15 seconds, the proxy re-scans for new agents or changed settings.
- **Health check**: Every 30 seconds, the proxy checks if each agent's daemon is reachable.
- **Status API**: `GET http://localhost:18789/status` returns JSON with all routes and health.
- **Config**: Routing needs no config — each agent's `webhookPort` and `webhookPath` in their own `settings.json` is enough. The proxy's own listen address comes from `~/.claude/claudeclaw/proxy-config.json` (optional, `{ "port": <n>, "bind": "<addr>" }`), which is read on `proxy start` if present. Precedence: `--port` / `--bind` CLI flags > `proxy-config.json` > defaults (`18789`, `0.0.0.0`).
- **Port rule**: The proxy listens on 18789 (external) by default. Each agent must use a different internal port (e.g., 18801, 18802, 18803). If any agent's `webhookPort` equals the proxy's external port, `proxy start` prints a CRITICAL warning and refuses to start.
