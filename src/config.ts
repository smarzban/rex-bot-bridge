import { homedir } from "node:os";
import { join } from "node:path";

/** Resolved paths and settings. Every path can be overridden by env (used by tests and launchd). */
export interface Config {
  host: string;
  port: number;
  tokenFile: string;
  watchSessionsFile: string;
  watchHeartbeatFile: string;
  auditLog: string;
  rexBin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME || homedir();
  const watchDir = env.REX_BOT_WATCH_DIR || join(home, ".config/rex/bot-watch");
  const port = Number(env.REX_BRIDGE_PORT || 7400);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`REX_BRIDGE_PORT must be a port number, got ${env.REX_BRIDGE_PORT}`);
  }
  return {
    host: env.REX_BRIDGE_HOST || "127.0.0.1",
    port,
    tokenFile: env.REX_BRIDGE_TOKEN_FILE || join(home, ".config/rex-bot-bridge/token"),
    watchSessionsFile: join(watchDir, "sessions"),
    watchHeartbeatFile: join(watchDir, "heartbeat"),
    auditLog: env.REX_BRIDGE_AUDIT_LOG || join(home, ".local/state/rex-bot-bridge/audit.log"),
    rexBin: env.REX_BIN || "rex",
  };
}
