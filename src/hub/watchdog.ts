import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HUB_DIR } from "./paths";
import { listAgents, type AgentRecord } from "./registry";
import { spawnDetachedDaemon } from "./spawn";
import { stopByPath } from "../commands/stop";

/**
 * Hub-side Slack watchdog.
 *
 * The daemon heals a dead socket on its own (ping timeout → reconnect). This
 * covers what it can't: a daemon that is wedged (event loop blocked, so the
 * ping tick and health file both stop), or one stuck reconnecting for a long
 * time. Either way the fix is a full restart, which only an outside process
 * can do.
 *
 * Every decision — restart, deferral, suppression — is appended to
 * ~/.claude/claudeclaw/hub/auto-restart.jsonl so the mechanism can be reviewed
 * after it has run for a while.
 */

const CHECK_INTERVAL_MS = 60_000;
/** Daemon refreshes slack-health.json every 30s; 3 min of silence = wedged. */
const STALE_AFTER_MS = 3 * 60_000;
/** Reconnecting this long (not counting too_many_websockets) = give up waiting. */
const RECONNECTING_LIMIT_MS = 15 * 60_000;
/** Let an in-flight Claude run finish, but not forever. */
const BUSY_MAX_DEFER_MS = 30 * 60_000;
/** Don't judge a daemon that just started. */
const STARTUP_GRACE_MS = 3 * 60_000;
const MAX_RESTARTS_PER_HOUR = 2;

export const AUTO_RESTART_LOG = join(HUB_DIR, "auto-restart.jsonl");

interface SlackHealth {
  state?: string;
  since?: number;
  detail?: string | null;
  updatedAt?: number;
  pingEnabled?: boolean;
  busy?: boolean;
}

const restartHistory = new Map<string, number[]>();
const deferSince = new Map<string, number>();
const suppressedLogged = new Set<string>();

async function logEvent(event: Record<string, unknown>): Promise<void> {
  try {
    await appendFile(AUTO_RESTART_LOG, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
  } catch { /* logging must never stop the watchdog */ }
}

async function readHealth(agentPath: string): Promise<SlackHealth | null> {
  try {
    return JSON.parse(await readFile(join(agentPath, ".claude", "claudeclaw", "slack-health.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** Why this agent needs a restart, or null if it is fine (or not judgeable). */
export function diagnose(agent: AgentRecord, h: SlackHealth | null, now: number): string | null {
  if (!agent.alive || !h || !h.pingEnabled) return null; // old build or Slack not configured
  if (agent.startedAt && now - agent.startedAt < STARTUP_GRACE_MS) return null;
  if (h.state === "stopped" || h.state === "auth-error") return null; // restart won't fix config

  if (h.updatedAt && now - h.updatedAt > STALE_AFTER_MS) {
    return `daemon-unresponsive (health not updated for ${Math.round((now - h.updatedAt) / 1000)}s)`;
  }
  if (h.state === "reconnecting" && h.detail !== "too_many_websockets"
      && h.since && now - h.since > RECONNECTING_LIMIT_MS) {
    return `slack-reconnecting for ${Math.round((now - h.since) / 60_000)}min (${h.detail ?? "no detail"})`;
  }
  return null;
}

async function checkOnce(): Promise<void> {
  const now = Date.now();
  const agents = await listAgents();

  for (const agent of agents) {
    const h = await readHealth(agent.path);
    const reason = diagnose(agent, h, now);
    if (!reason) {
      deferSince.delete(agent.id);
      suppressedLogged.delete(agent.id);
      continue;
    }

    // A wedged daemon can't be busy in any useful sense; only defer for the
    // reconnecting case, where the daemon is alive and may be mid-reply.
    const wedged = reason.startsWith("daemon-unresponsive");
    if (!wedged && h?.busy) {
      const since = deferSince.get(agent.id) ?? now;
      if (!deferSince.has(agent.id)) {
        deferSince.set(agent.id, now);
        await logEvent({ type: "deferred-busy", agent: agent.path, reason });
      }
      if (now - since < BUSY_MAX_DEFER_MS) continue;
    }

    const history = (restartHistory.get(agent.id) ?? []).filter((t) => now - t < 60 * 60_000);
    if (history.length >= MAX_RESTARTS_PER_HOUR) {
      if (!suppressedLogged.has(agent.id)) {
        suppressedLogged.add(agent.id);
        await logEvent({ type: "suppressed", agent: agent.path, reason, restartsLastHour: history.length });
        console.error(`[watchdog] ${agent.path}: ${reason} — already restarted ${history.length}x this hour, leaving it alone`);
      }
      continue;
    }

    console.error(`[watchdog] ${agent.path}: ${reason} — restarting`);
    const stopped = await stopByPath(agent.path, 4000);
    let pid: number | undefined;
    let error: string | undefined;
    if (stopped.ok || stopped.reason === "already-dead") {
      try { pid = (await spawnDetachedDaemon(agent.path)).pid; } catch (e) { error = String(e); }
    } else {
      error = `stop failed: ${stopped.reason ?? "unknown"}`;
    }
    history.push(now);
    restartHistory.set(agent.id, history);
    deferSince.delete(agent.id);
    await logEvent({
      type: "auto-restart", agent: agent.path, reason,
      oldPid: agent.pid, newPid: pid ?? null, ok: !error, error: error ?? null,
    });
  }
}

export function startSlackWatchdog(): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await checkOnce(); } catch (e) { console.error(`[watchdog] check failed: ${e}`); }
    finally { running = false; }
  }, CHECK_INTERVAL_MS);
  console.log(`  Slack watchdog: every ${CHECK_INTERVAL_MS / 1000}s, log ${AUTO_RESTART_LOG}`);
  return () => clearInterval(timer);
}
