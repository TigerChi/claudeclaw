import { homedir } from "os";
import { join } from "path";
import { readdir, readFile } from "fs/promises";
import { createHash } from "crypto";
import { checkPidAt } from "../pid";

export interface AgentRecord {
  id: string;
  path: string;
  pid: number | null;
  alive: boolean;
  web: { host: string; port: number } | null;
  startedAt: number | null;
  lastStateAt: number | null;
}

function decodeProjectDir(encoded: string): string {
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

export function agentIdForPath(path: string): string {
  return createHash("sha1").update(path).digest("hex").slice(0, 12);
}

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
 * Enumerate all known agent daemons by scanning ~/.claude/projects/ and
 * probing each project's daemon.pid + state.json.
 *
 * Includes dead/stale entries (alive=false) so the dashboard can show them
 * with a "start" action; callers can filter as needed.
 */
export async function listAgents(): Promise<AgentRecord[]> {
  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  const results: AgentRecord[] = [];
  for (const dir of dirs) {
    const projectPath = decodeProjectDir(dir);
    const pidFile = join(projectPath, ".claude", "claudeclaw", "daemon.pid");
    const pid = await checkPidAt(pidFile);
    const state = await readState(projectPath);
    if (pid === null && state.startedAt === null && state.web === null) continue;
    results.push({
      id: agentIdForPath(projectPath),
      path: projectPath,
      pid,
      alive: pid !== null,
      web: state.web,
      startedAt: state.startedAt,
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
