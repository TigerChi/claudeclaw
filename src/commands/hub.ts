import { openSync } from "fs";
import { startHubServer } from "../hub/server";
import {
  HUB_LOG_FILE,
  cleanupHubPid,
  ensureHubDir,
  readHubConfig,
  readHubPid,
  readHubPort,
  writeHubPid,
  writeHubConfig,
} from "../hub/paths";
import { hasAuth, initAuth, rotateAuth } from "../hub/auth";
import { listAgents, findAgentById, findAgentByPath } from "../hub/registry";
import { spawnDetachedDaemon } from "../hub/spawn";
import { stopByPath } from "./stop";

function printUsage() {
  console.error(
    `Usage: claudeclaw hub <subcommand> [options]
  init                       Generate a Bearer token (printed once)
  start [--detach] [--host H] [--port P]   Start the hub daemon
  stop                       Stop the hub daemon
  status                     Show hub status
  token --rotate             Generate a new token (revokes old)
  restart <agent-id|path>    Restart a project daemon
`
  );
}

async function cmdInit(args: string[]) {
  const force = args.includes("--force");
  if (!force && (await hasAuth())) {
    console.error("Auth already initialized. Use `claudeclaw hub token --rotate` to replace.");
    process.exit(1);
  }
  const token = force ? await rotateAuth() : await initAuth();
  console.log("ClaudeClaw Hub auth initialized.");
  console.log("");
  console.log("  Bearer token (copy now — you won't see this again):");
  console.log("");
  console.log("    " + token);
  console.log("");
  console.log("  Use header `Authorization: Bearer <token>` for /api/* requests.");
}

async function cmdToken(args: string[]) {
  if (!args.includes("--rotate")) {
    console.error("Usage: claudeclaw hub token --rotate");
    process.exit(1);
  }
  const token = await rotateAuth();
  console.log("Token rotated. New token (copy now):");
  console.log("");
  console.log("  " + token);
}

async function cmdStart(args: string[]) {
  let detachFlag = false;
  let host: string | null = null;
  let port: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--detach") detachFlag = true;
    else if (a === "--host") {
      host = String(args[++i] ?? "");
    } else if (a === "--port") {
      const p = Number(args[++i]);
      if (!Number.isFinite(p) || p <= 0 || p > 65535) {
        console.error("`--port` must be a valid TCP port (1-65535).");
        process.exit(1);
      }
      port = p;
    }
  }

  await ensureHubDir();
  const cfg = await readHubConfig();
  const finalHost = host ?? cfg.host;
  const finalPort = port ?? cfg.port;

  // Persist explicit overrides for next run
  if (host !== null || port !== null) {
    await writeHubConfig({ host: finalHost, port: finalPort });
  }

  if (finalHost !== "127.0.0.1" && finalHost !== "::1" && finalHost !== "localhost") {
    if (!(await hasAuth())) {
      console.error(
        "Refusing to bind non-loopback host without auth configured. Run `claudeclaw hub init` first."
      );
      process.exit(1);
    }
    console.warn(
      `Warning: hub is binding ${finalHost}. Bearer token alone is NOT confidential over plain HTTP.\n` +
        `         Front the hub with TLS (caddy, nginx, traefik) before exposing it remotely.`
    );
  }

  if (detachFlag && process.env.CLAUDECLAW_HUB_DETACHED !== "1") {
    const logFd = openSync(HUB_LOG_FILE, "a");
    const childArgs = process.argv.slice(1).filter((a) => a !== "--detach");
    const proc = Bun.spawn([process.execPath, ...childArgs], {
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      env: { ...process.env, CLAUDECLAW_HUB_DETACHED: "1" },
    });
    proc.unref();
    console.log(`ClaudeClaw Hub started in background (PID ${proc.pid})`);
    console.log(`  Logs: ${HUB_LOG_FILE}`);
    console.log(`  URL:  http://${finalHost}:${finalPort}`);
    process.exit(0);
  }

  const existing = await readHubPid();
  if (existing) {
    console.error(`Hub already running (PID ${existing}). Use \`claudeclaw hub stop\` first.`);
    process.exit(1);
  }

  const handle = startHubServer({ host: finalHost, port: finalPort });
  await writeHubPid(process.pid, handle.port);

  const shutdown = async () => {
    handle.stop();
    await cleanupHubPid();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`ClaudeClaw Hub listening on http://${handle.host}:${handle.port}`);
  console.log(`  PID: ${process.pid}`);
  console.log(`  Auth: ${(await hasAuth()) ? "configured" : "NOT CONFIGURED — run `claudeclaw hub init`"}`);
}

async function cmdStop() {
  const pid = await readHubPid();
  if (!pid) {
    console.log("Hub is not running.");
    await cleanupHubPid();
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped hub (PID ${pid}).`);
  } catch {
    console.log(`Hub process ${pid} already dead.`);
  }
  await cleanupHubPid();
}

async function cmdStatus() {
  const pid = await readHubPid();
  const port = await readHubPort();
  const cfg = await readHubConfig();
  if (pid) {
    console.log(`\x1b[32m● Hub running\x1b[0m (PID ${pid}) on http://${cfg.host}:${port ?? cfg.port}`);
  } else {
    console.log("\x1b[31m○ Hub is not running\x1b[0m");
  }
  console.log(`  Auth: ${(await hasAuth()) ? "configured" : "not configured"}`);
  console.log("");
  const agents = await listAgents();
  console.log(`Discovered agents (${agents.length}):`);
  for (const a of agents) {
    const dot = a.alive ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m";
    const sub = a.alive ? `PID ${a.pid}` + (a.web ? ` :${a.web.port}` : "") : "stopped";
    console.log(`  ${dot} ${a.path} — ${sub}`);
  }
}

async function cmdRestart(args: string[]) {
  if (args.length === 0) {
    console.error("Usage: claudeclaw hub restart <agent-id|path>");
    process.exit(1);
  }
  const target = args[0];
  let agent = await findAgentById(target);
  if (!agent) agent = await findAgentByPath(target);
  if (!agent) {
    console.error(`Agent not found: ${target}`);
    process.exit(1);
  }
  if (agent.alive) {
    console.log(`Stopping PID ${agent.pid}...`);
    const r = await stopByPath(agent.path, 4000);
    if (!r.ok && r.reason !== "already-dead") {
      console.error(`Stop failed: ${r.reason ?? "unknown"}`);
      process.exit(1);
    }
  }
  const spawned = await spawnDetachedDaemon(agent.path);
  console.log(`Spawned detached daemon (PID ${spawned.pid})`);
  console.log(`  Logs: ${spawned.logPath}`);
}

export async function hub(args: string[]) {
  const sub = args[0];
  if (!sub) {
    printUsage();
    process.exit(1);
  }
  const rest = args.slice(1);
  switch (sub) {
    case "init":
      return cmdInit(rest);
    case "start":
      return cmdStart(rest);
    case "stop":
      return cmdStop();
    case "status":
      return cmdStatus();
    case "token":
      return cmdToken(rest);
    case "restart":
      return cmdRestart(rest);
    default:
      printUsage();
      process.exit(1);
  }
}

