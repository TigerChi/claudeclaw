export function hubPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ClaudeClaw Hub</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 12px 20px;
      border-bottom: 1px solid #30363d;
      display: flex;
      align-items: center;
      gap: 16px;
      background: #161b22;
    }
    header h1 { margin: 0; font-size: 16px; font-weight: 600; }
    header .status { color: #8b949e; font-size: 12px; }
    main { display: flex; flex: 1; overflow: hidden; }
    aside {
      width: 320px;
      border-right: 1px solid #30363d;
      overflow-y: auto;
      background: #0d1117;
    }
    aside h2 {
      margin: 0;
      padding: 12px 16px;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #8b949e;
      border-bottom: 1px solid #30363d;
    }
    .agent {
      padding: 10px 16px;
      border-bottom: 1px solid #21262d;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .agent:hover { background: #161b22; }
    .agent.active { background: #1f2937; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: #f85149;
    }
    .dot.alive { background: #3fb950; }
    .agent .meta { flex: 1; min-width: 0; }
    .agent .path { font-size: 12px; color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent .sub { font-size: 11px; color: #8b949e; }
    section.detail {
      flex: 1;
      padding: 24px;
      overflow-y: auto;
    }
    .panel {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .panel h3 { margin: 0 0 8px; font-size: 13px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.04em; }
    .row { display: flex; gap: 16px; margin: 6px 0; }
    .row .label { width: 120px; color: #8b949e; font-size: 12px; }
    .row .value { color: #e6edf3; font-size: 13px; word-break: break-all; }
    button {
      background: #21262d;
      color: #e6edf3;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      margin-right: 8px;
    }
    button:hover { background: #30363d; }
    button.primary { background: #238636; border-color: #2ea043; }
    button.primary:hover { background: #2ea043; }
    button.danger { background: #6e2222; border-color: #8b3232; }
    button.danger:hover { background: #8b3232; }
    .empty { color: #8b949e; padding: 40px 20px; text-align: center; }
    .auth-prompt {
      max-width: 480px;
      margin: 80px auto;
      padding: 24px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
    }
    .auth-prompt input {
      width: 100%;
      padding: 8px 12px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      font-family: monospace;
      margin: 8px 0 12px;
    }
    pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; color: #8b949e; }
    code { background: #0d1117; padding: 2px 6px; border-radius: 4px; }
    .toolbar { margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
  (function () {
    const state = {
      token: localStorage.getItem("claudeclaw_hub_token") || "",
      agents: [],
      selectedId: null,
      detail: null,
      error: null,
    };

    const root = document.getElementById("app");

    function authHeaders() {
      return state.token ? { Authorization: "Bearer " + state.token } : {};
    }

    async function api(path, opts) {
      opts = opts || {};
      const res = await fetch(path, {
        method: opts.method || "GET",
        headers: Object.assign({}, authHeaders(), opts.headers || {}),
        body: opts.body,
      });
      if (res.status === 401) {
        state.token = "";
        localStorage.removeItem("claudeclaw_hub_token");
        render();
        throw new Error("unauthorized");
      }
      return res;
    }

    async function refreshAgents() {
      try {
        const res = await api("/api/agents");
        const data = await res.json();
        state.agents = data.agents || [];
        if (!state.selectedId && state.agents.length > 0) {
          state.selectedId = state.agents[0].id;
        }
        await refreshDetail();
      } catch (e) {
        // ignore
      }
    }

    async function refreshDetail() {
      if (!state.selectedId) {
        state.detail = null;
        render();
        return;
      }
      const agent = state.agents.find((a) => a.id === state.selectedId);
      if (!agent || !agent.alive) {
        state.detail = { agent, state: null, jobs: null };
        render();
        return;
      }
      try {
        const [stateRes, jobsRes] = await Promise.all([
          api("/api/agents/" + agent.id + "/proxy/api/state"),
          api("/api/agents/" + agent.id + "/proxy/api/jobs"),
        ]);
        const stateData = stateRes.ok ? await stateRes.json() : null;
        const jobsData = jobsRes.ok ? await jobsRes.json() : null;
        state.detail = { agent, state: stateData, jobs: jobsData };
      } catch (e) {
        state.detail = { agent, state: null, jobs: null, error: String(e) };
      }
      render();
    }

    async function selectAgent(id) {
      state.selectedId = id;
      await refreshDetail();
    }

    async function actOnAgent(id, action) {
      try {
        await api("/api/agents/" + id + "/" + action, { method: "POST" });
        await refreshAgents();
      } catch (e) {
        alert("Failed: " + e.message);
      }
    }

    function fmtCountdown(ms) {
      if (ms <= 0) return "now";
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (h > 0) return h + "h " + m + "m";
      if (m > 0) return m + "m";
      return (s % 60) + "s";
    }

    function renderAuthPrompt() {
      root.innerHTML =
        '<div class="auth-prompt">' +
        '<h2>ClaudeClaw Hub</h2>' +
        '<p>Bearer token required. Run <code>claudeclaw hub init</code> on the host to generate one.</p>' +
        '<input id="tok" type="password" placeholder="Bearer token" />' +
        '<button class="primary" id="signin">Sign in</button>' +
        '</div>';
      document.getElementById("signin").onclick = () => {
        const v = document.getElementById("tok").value.trim();
        if (!v) return;
        state.token = v;
        localStorage.setItem("claudeclaw_hub_token", v);
        refreshAgents();
      };
      document.getElementById("tok").onkeydown = (e) => {
        if (e.key === "Enter") document.getElementById("signin").click();
      };
    }

    function render() {
      if (!state.token) {
        renderAuthPrompt();
        return;
      }

      const agents = state.agents;
      let aside = '<h2>Agents (' + agents.length + ')</h2>';
      if (agents.length === 0) {
        aside += '<div class="empty">No agents discovered.<br/>Start one with <code>claudeclaw start --detach</code> in any project.</div>';
      } else {
        for (const a of agents) {
          aside +=
            '<div class="agent ' + (a.id === state.selectedId ? "active" : "") + '" data-id="' + a.id + '">' +
            '<span class="dot ' + (a.alive ? "alive" : "") + '"></span>' +
            '<div class="meta">' +
            '<div class="path" title="' + a.path + '">' + a.path + '</div>' +
            '<div class="sub">' + (a.alive ? ("PID " + a.pid + (a.web ? " — :" + a.web.port : "")) : "stopped") + '</div>' +
            '</div></div>';
        }
      }

      let detail = '';
      if (state.detail) {
        const { agent, state: agentState, jobs } = state.detail;
        const now = Date.now();
        detail =
          '<div class="toolbar">' +
          '<button class="primary" data-act="restart" data-id="' + agent.id + '">Restart</button>' +
          (agent.alive
            ? '<button class="danger" data-act="stop" data-id="' + agent.id + '">Stop</button>'
            : '<button data-act="start" data-id="' + agent.id + '">Start</button>') +
          (agent.alive && agent.web
            ? '<a target="_blank" href="/api/agents/' + agent.id + '/proxy/" style="margin-left:auto"><button>Open per-daemon UI</button></a>'
            : '') +
          '</div>' +
          '<div class="panel"><h3>Agent</h3>' +
          row("Path", agent.path) +
          row("ID", agent.id) +
          row("Status", agent.alive ? "running" : "stopped") +
          row("PID", agent.pid != null ? String(agent.pid) : "—") +
          row("Web", agent.web ? agent.web.host + ":" + agent.web.port : "—") +
          row("Started", agent.startedAt ? new Date(agent.startedAt).toLocaleString() : "—") +
          '</div>';

        if (agentState) {
          const sec = agentState.security ? agentState.security.level || agentState.security : "";
          const hb = agentState.heartbeat;
          detail +=
            '<div class="panel"><h3>Heartbeat</h3>' +
            (hb && hb.enabled
              ? row("Status", "every " + (hb.intervalMinutes || hb.interval || "?") + "m") +
                row("Next", hb.nextAt ? fmtCountdown(hb.nextAt - now) : "—")
              : row("Status", "disabled")) +
            '</div>';

          detail +=
            '<div class="panel"><h3>Session</h3>' +
            row("Security", sec) +
            row("Telegram", agentState.telegram ? "on" : "off") +
            row("Discord", agentState.discord ? "on" : "off") +
            '</div>';
        }

        if (jobs && jobs.jobs) {
          let jobRows = '';
          if (jobs.jobs.length === 0) jobRows = '<div class="row"><div class="value">No jobs configured.</div></div>';
          else {
            for (const j of jobs.jobs) {
              jobRows += row(j.name, (j.schedule || "") + " — " + (j.promptPreview || ""));
            }
          }
          detail += '<div class="panel"><h3>Cron Jobs (' + jobs.jobs.length + ')</h3>' + jobRows + '</div>';
        }

        if (!agent.alive) {
          detail += '<div class="panel"><h3>Notice</h3><div class="row"><div class="value">Daemon is stopped. Click Start to spawn it detached.</div></div></div>';
        }
      } else {
        detail = '<div class="empty">Select an agent on the left.</div>';
      }

      root.innerHTML =
        '<header>' +
        '<h1>🦞 ClaudeClaw Hub</h1>' +
        '<span class="status">' + agents.filter((a) => a.alive).length + ' alive / ' + agents.length + ' total</span>' +
        '<button id="refresh" style="margin-left:auto">Refresh</button>' +
        '<button id="signout">Sign out</button>' +
        '</header>' +
        '<main><aside>' + aside + '</aside><section class="detail">' + detail + '</section></main>';

      document.querySelectorAll(".agent").forEach((el) => {
        el.onclick = () => selectAgent(el.getAttribute("data-id"));
      });
      document.querySelectorAll("[data-act]").forEach((el) => {
        el.onclick = () => actOnAgent(el.getAttribute("data-id"), el.getAttribute("data-act"));
      });
      const refreshBtn = document.getElementById("refresh");
      if (refreshBtn) refreshBtn.onclick = () => refreshAgents();
      const signOut = document.getElementById("signout");
      if (signOut) signOut.onclick = () => {
        state.token = "";
        localStorage.removeItem("claudeclaw_hub_token");
        render();
      };
    }

    function row(label, value) {
      return '<div class="row"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>';
    }

    if (state.token) refreshAgents();
    render();
    setInterval(() => { if (state.token) refreshAgents(); }, 5000);
  })();
  </script>
</body>
</html>`;
}
