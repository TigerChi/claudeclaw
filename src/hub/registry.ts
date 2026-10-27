import { join } from "path";
import { readFile, writeFile } from "fs/promises";
import { listRegisteredDaemons, agentIdForPath } from "../daemon-registry";

export interface LinePairingInfo {
  code: string;
  webhookPath: string;
  webhookPort: number;
}

export interface AgentRecord {
  id: string;
  path: string;
  pid: number | null;
  alive: boolean;
  web: { host: string; port: number } | null;
  startedAt: number | null;
  lastStateAt: number | null;
  linePairing: LinePairingInfo | null;
  /** Plugin source — "v1" (legacy default) or "v3" (tmux engine). */
  version: string;
  /** LLM model from the agent's settings.json — null = Claude Code default. */
  model: string | null;
  /** Per-invocation Claude timeout (ms) from settings.json — null = runner default (15 min). */
  sessionTimeoutMs: number | null;
}

export { agentIdForPath };

interface ParsedState {
  startedAt: number | null;
  web: { host: string; port: number } | null;
}

async function readAgentSettings(
  projectPath: string,
): Promise<{ linePairing: LinePairingInfo | null; model: string | null; sessionTimeoutMs: number | null }> {
  const settingsFile = join(projectPath, ".claude", "claudeclaw", "settings.json");
  try {
    const raw = await readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    const model =
      typeof parsed?.model === "string" && parsed.model.trim() ? parsed.model.trim() : null;
    const sessionTimeoutMs =
      Number.isFinite(parsed?.sessionTimeoutMs) && Number(parsed.sessionTimeoutMs) > 0
        ? Number(parsed.sessionTimeoutMs)
        : null;
    const line = parsed?.line;
    const pairing = line?.pairing;
    const linePairing =
      pairing?.enabled && typeof pairing.code === "string" && pairing.code
        ? {
            code: pairing.code,
            webhookPath: typeof line.webhookPath === "string" ? line.webhookPath : "",
            webhookPort: Number.isFinite(line.webhookPort) ? Number(line.webhookPort) : 0,
          }
        : null;
    return { linePairing, model, sessionTimeoutMs };
  } catch {
    return { linePairing: null, model: null, sessionTimeoutMs: null };
  }
}

async function readState(projectPath: string): Promise<ParsedState> {
  const stateFile = join(projectPath, ".claude", "claudeclaw", "state.json");
  try {
    const raw = await readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw);
    const startedAt =
      typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)
        ? parsed.startedAt
        : null;
    const web =
      parsed.web && typeof parsed.web.host === "string" && Number.isFinite(parsed.web.port)
        ? { host: String(parsed.web.host), port: Number(parsed.web.port) }
        : null;
    return { startedAt, web };
  } catch {
    return { startedAt: null, web: null };
  }
}

/**
 * Enumerate all known agent daemons from the global daemon registry, marking
 * each as alive/dead based on whether its PID is still running. The registry
 * is populated by daemons themselves on start and cleared on clean shutdown,
 * so it always reflects real cwd paths (no lossy directory-name decoding).
 *
 * Stale entries (registered but pid dead — e.g. crashed daemon) are kept in
 * the result with alive=false so the dashboard can show a "start" action.
 */
export async function listAgents(): Promise<AgentRecord[]> {
  const daemons = await listRegisteredDaemons();
  const results: AgentRecord[] = [];

  for (const d of daemons) {
    let alive = false;
    try {
      process.kill(d.pid, 0);
      alive = true;
    } catch {}

    const [state, settings] = await Promise.all([readState(d.path), readAgentSettings(d.path)]);
    results.push({
      id: agentIdForPath(d.path),
      path: d.path,
      pid: alive ? d.pid : null,
      alive,
      web: state.web,
      startedAt: d.startedAt || state.startedAt,
      lastStateAt: state.startedAt,
      linePairing: settings.linePairing,
      version: d.version ?? "v1",
      model: settings.model,
      sessionTimeoutMs: settings.sessionTimeoutMs,
    });
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

export async function findAgentById(id: string): Promise<AgentRecord | null> {
  const all = await listAgents();
  return all.find((a) => a.id === id) ?? null;
}

export async function findAgentByPath(path: string): Promise<AgentRecord | null> {
  const all = await listAgents();
  return all.find((a) => a.path === path) ?? null;
}

/** Set (or clear, with null) the agent's sessionTimeoutMs in its settings.json.
 *  Reads the raw JSON and rewrites only this field so every other setting is
 *  preserved exactly as written. The daemon's 30s hot-reload loop picks the
 *  change up without a restart; it applies from the next Claude invocation. */
export async function setAgentSessionTimeout(
  projectPath: string,
  sessionTimeoutMs: number | null,
): Promise<void> {
  const settingsFile = join(projectPath, ".claude", "claudeclaw", "settings.json");
  const raw = JSON.parse(await readFile(settingsFile, "utf-8"));
  if (sessionTimeoutMs == null) delete raw.sessionTimeoutMs;
  else raw.sessionTimeoutMs = sessionTimeoutMs;
  await writeFile(settingsFile, JSON.stringify(raw, null, 2) + "\n");
}
