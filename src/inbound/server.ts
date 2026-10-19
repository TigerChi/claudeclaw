/**
 * Local inbound endpoint — lets another program on this machine hand a message
 * to this agent and get the reply back in the HTTP response.
 *
 *   POST http://127.0.0.1:<inbound.port>/inbound/<source>
 *   X-Bridge-Token: <token>        (or Authorization: Bearer <token>)
 *   GET  http://127.0.0.1:<inbound.port>/inbound/health   (no auth)
 *
 * Loopback only, fixed port (callers are configured with it). Every caller
 * holds its own token and may call only the sources it is allowed:
 *
 *   inbound.callers.<name>.sources   → token in _claude/.auth/inbound/<name>.token
 *   CLAUDECLAW_INBOUND_TOKEN (legacy) → caller "default", every source
 *
 * CLAUDECLAW_INBOUND_TOKEN is a DAEMON_ONLY_KEY, so the agent's own Claude
 * children never get it in their env.
 *
 * This layer knows nothing about any one sender: it authenticates, checks the
 * caller may use the source, bounds the body, and routes by the path segment
 * to a source adapter that turns the payload into a turn for the agent. Add a
 * sender by adding an entry to SOURCES.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAgentEnvRaw } from "../agent-env";
import { getSettings } from "../config";

export const TOKEN_ENV = "CLAUDECLAW_INBOUND_TOKEN";
const TOKEN_DIR = join(process.cwd(), "_claude", ".auth", "inbound");
const MAX_BODY_BYTES = 40 * 1024 * 1024; // room for a base64 attachment (message source)
/** Shorter tokens are refused: they are guessable by anything on this machine. */
const MIN_TOKEN_LENGTH = 16;

export interface InboundReply {
  status: number;
  body: unknown;
}

export interface InboundContext {
  /** Name of the authenticated caller ("default" for the legacy token). */
  caller: string;
  /** Aborts when the caller hangs up. */
  signal: AbortSignal;
}

export interface InboundSource {
  /** Whether this source is switched on in the current settings (hot-reloaded). */
  enabled(): boolean;
  /** Handle one authenticated payload. */
  handle(payload: unknown, ctx: InboundContext): Promise<InboundReply>;
}

const SOURCES: Record<string, () => Promise<InboundSource>> = {
  "agents-gateway": async () => (await import("./agents-gateway")).agentsGatewaySource,
  message: async () => (await import("./message")).messageSource,
};

interface Caller {
  name: string;
  digest: Buffer;
  /** null = every source */
  sources: Set<string> | null;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let callers: Caller[] = [];
let tokenValues: string[] = [];
let listeningPort = 0;

function log(msg: string): void {
  console.log(`[${new Date().toLocaleTimeString()}] [inbound] ${msg}`);
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** The legacy token as the daemon sees it — env first (hub spawn), else
 *  agent.env evaluated from the agent's own directory (the hub may have
 *  sourced it elsewhere and exported an empty value). */
function readLegacyToken(): string {
  return (process.env[TOKEN_ENV] || loadAgentEnvRaw(process.cwd())[TOKEN_ENV] || "").trim();
}

/** Every token currently accepted — sources use it to keep them out of replies. */
export function inboundTokenValues(): string[] {
  return tokenValues;
}

function loadCallers(): Caller[] {
  const out: Caller[] = [];
  const values: string[] = [];
  const add = (name: string, token: string, sources: string[] | undefined) => {
    if (token.length < MIN_TOKEN_LENGTH) {
      console.error(`[inbound] caller "${name}": token missing or shorter than ${MIN_TOKEN_LENGTH} chars — ignored`);
      return;
    }
    out.push({ name, digest: digest(token), sources: sources ? new Set(sources) : null });
    values.push(token);
  };
  const legacy = readLegacyToken();
  if (legacy) add("default", legacy, undefined);
  for (const [name, c] of Object.entries(getSettings().inbound.callers)) {
    const file = join(TOKEN_DIR, `${name}.token`);
    add(name, existsSync(file) ? readFileSync(file, "utf8").trim() : "", c.sources);
  }
  tokenValues = values;
  return out;
}

/** The caller whose token matches, or null. Compares digests: constant time
 *  per entry, and no token length leaks. */
function authenticate(req: Request): Caller | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const given = (req.headers.get("x-bridge-token") ?? bearer ?? "").trim();
  if (!given) return null;
  const d = digest(given);
  let match: Caller | null = null;
  for (const c of callers) if (timingSafeEqual(d, c.digest)) match = c;
  return match;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

async function route(req: Request, srv: ReturnType<typeof Bun.serve>): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/inbound/health") {
    const enabled: string[] = [];
    for (const [name, load] of Object.entries(SOURCES)) if ((await load()).enabled()) enabled.push(name);
    return json(200, { ok: true, sources: enabled });
  }
  const m = /^\/inbound\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  if (!m) return json(404, { error: "not_found" });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const caller = authenticate(req);
  if (!caller) return json(401, { error: "unauthorized" });

  const name = m[1]!;
  const load = SOURCES[name];
  const source = load ? await load() : null;
  if (!source || !source.enabled()) return json(404, { error: "unknown_source" });
  if (caller.sources && !caller.sources.has(name)) {
    log(`caller "${caller.name}" refused for source "${name}"`);
    return json(403, { error: "source_not_allowed" });
  }

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(400, { error: "bad_json" });
  }

  // Agent turns run for minutes; never let the server's idle timer cut them off.
  srv.timeout(req, 0);
  try {
    const r = await source.handle(payload, { caller: caller.name, signal: req.signal });
    return json(r.status, r.body);
  } catch (err) {
    console.error(`[inbound] ${name} handler crashed: ${err instanceof Error ? err.message : err}`);
    return json(500, { error: "internal_error" });
  }
}

/** Start listening. Returns false (and says why) when it cannot. */
export function startInbound(): boolean {
  const cfg = getSettings().inbound;
  if (server) return true;
  callers = loadCallers();
  if (callers.length === 0) {
    console.log(`  Inbound: enabled but no caller token (set ${TOKEN_ENV} via agent.env, or inbound.callers + _claude/.auth/inbound/<name>.token)`);
    return false;
  }
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: cfg.port,
      idleTimeout: 0,
      fetch: (req, srv) => route(req, srv),
    });
  } catch (err) {
    // Fixed port by design: a caller is configured with it, so do not drift to another.
    console.error(`[inbound] cannot listen on 127.0.0.1:${cfg.port}: ${err instanceof Error ? err.message : err}`);
    callers = [];
    return false;
  }
  listeningPort = cfg.port;
  const who = callers.map((c) => `${c.name}→${c.sources ? [...c.sources].join("+") || "none" : "all"}`).join(", ");
  log(`listening on http://127.0.0.1:${cfg.port}/inbound/<source> (callers: ${who})`);
  return true;
}

/** Stop listening. Open requests are dropped; callers (the bridge) retry. */
export function stopInbound(): void {
  if (!server) return;
  server.stop(true);
  server = null;
  callers = [];
  log(`stopped (port ${listeningPort})`);
  listeningPort = 0;
}

/** Port currently listened on, or 0. */
export function inboundPort(): number {
  return listeningPort;
}
