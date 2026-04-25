import { join } from "path";
import { readFile } from "fs/promises";
import { listRegisteredDaemons, agentIdForPath } from "../daemon-registry";

export interface AgentRecord {
  id: string;
  path: string;
  pid: number | null;
  alive: boolean;
  web: { host: string; port: number } | null;
  startedAt: number | null;
  lastStateAt: number | null;
}

export { agentIdForPath };

interface ParsedState {
  startedAt: number | null;
  web: { host: string; port: number } | null;
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

    const state = await readState(d.path);
    results.push({
      id: agentIdForPath(d.path),
      path: d.path,
      pid: alive ? d.pid : null,
      alive,
      web: state.web,
      startedAt: d.startedAt || state.startedAt,
      lastStateAt: state.startedAt,
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
