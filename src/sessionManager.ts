import { join } from "path";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SESSIONS_FILE = join(HEARTBEAT_DIR, "sessions.json");

export interface ThreadSession {
  sessionId: string;
  threadId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
  /** Set when the turn threshold is reached. The compact itself is deferred
   *  until the thread goes idle — see runPendingCompactions() in runner.ts. */
  pendingCompact?: boolean;
}

interface SessionsData {
  threads: Record<string, ThreadSession>;
}

let sessionsCache: SessionsData | null = null;

async function loadSessions(): Promise<SessionsData> {
  if (sessionsCache) return sessionsCache;
  try {
    sessionsCache = await Bun.file(SESSIONS_FILE).json();
    return sessionsCache!;
  } catch {
    sessionsCache = { threads: {} };
    return sessionsCache;
  }
}

async function saveSessions(data: SessionsData): Promise<void> {
  sessionsCache = data;
  await Bun.write(SESSIONS_FILE, JSON.stringify(data, null, 2) + "\n");
}

/** Get session for a thread. Returns null if no session exists yet. */
export async function getThreadSession(
  threadId: string,
): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return null;

  if (typeof session.turnCount !== "number") session.turnCount = 0;
  if (typeof session.compactWarned !== "boolean") session.compactWarned = false;

  session.lastUsedAt = new Date().toISOString();
  await saveSessions(data);

  return {
    sessionId: session.sessionId,
    turnCount: session.turnCount,
    compactWarned: session.compactWarned,
  };
}

/** Create a new thread session after Claude outputs a session_id. */
export async function createThreadSession(threadId: string, sessionId: string): Promise<void> {
  const data = await loadSessions();
  data.threads[threadId] = {
    sessionId,
    threadId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    turnCount: 0,
    compactWarned: false,
  };
  await saveSessions(data);
}

/** Remove a thread session (e.g., on thread delete/archive). */
export async function removeThreadSession(threadId: string): Promise<void> {
  const data = await loadSessions();
  if (!data.threads[threadId]) return;
  delete data.threads[threadId];
  await saveSessions(data);
}

/** Increment turn counter for a thread session. */
export async function incrementThreadTurn(threadId: string): Promise<number> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return 0;
  if (typeof session.turnCount !== "number") session.turnCount = 0;
  session.turnCount += 1;
  await saveSessions(data);
  return session.turnCount;
}

/** Zero a thread's turn counter after a compact, so the next auto-compact is
 *  another full interval away rather than firing on every subsequent turn.
 *  Also clears the warning flag: post-compact the context is small again, so a
 *  fresh warning is meaningful when it next grows. */
export async function resetThreadTurnCount(threadId: string): Promise<void> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return;
  session.turnCount = 0;
  session.compactWarned = false;
  session.pendingCompact = false;
  await saveSessions(data);
}

/** Flag a thread as due for compaction on its next idle window. */
export async function markThreadPendingCompact(threadId: string): Promise<void> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session || session.pendingCompact) return;
  session.pendingCompact = true;
  await saveSessions(data);
}

/** Threads flagged for compaction whose last activity is older than `idleMs`.
 *  Reads straight from disk so a daemon-side sweep sees writes from any run. */
export async function listThreadsDueForCompact(idleMs: number): Promise<ThreadSession[]> {
  const data = await loadSessions();
  const cutoff = Date.now() - idleMs;
  return Object.values(data.threads).filter((t) => {
    if (!t.pendingCompact) return false;
    const last = Date.parse(t.lastUsedAt);
    return Number.isFinite(last) && last <= cutoff;
  });
}

/** Mark compact warning sent for a thread session. */
export async function markThreadCompactWarned(threadId: string): Promise<void> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return;
  session.compactWarned = true;
  await saveSessions(data);
}

/** List all active thread sessions. */
export async function listThreadSessions(): Promise<ThreadSession[]> {
  const data = await loadSessions();
  return Object.values(data.threads);
}

/** Peek at a thread session without updating lastUsedAt. */
export async function peekThreadSession(threadId: string): Promise<ThreadSession | null> {
  const data = await loadSessions();
  return data.threads[threadId] ?? null;
}
