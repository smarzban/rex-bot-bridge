import { resolvePaths, type Paths } from "./paths.js";
import { readSettings, type Mode } from "./settings.js";

/** Runtime config for the bridge server: config.json, then env overrides (used by tests and launchd). */
export interface Config {
  host: string;
  port: number;
  paths: Paths;
  tokenFile: string;
  sharedFile: string;
  heartbeatFile: string;
  auditLog: string;
  rexBin: string;
  /** Read per request so `rex-grokbot config set mode …` applies without a restart. */
  getMode: () => Promise<Mode>;
}

export function parsePort(v: string | number, name = "port"): number {
  const port = Number(v);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a port number, got ${v}`);
  return port;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const paths = resolvePaths(env);
  const s = await readSettings(paths.configFile);
  const envMode = env.REX_BRIDGE_MODE;
  if (envMode && envMode !== "shared" && envMode !== "all") {
    throw new Error(`REX_BRIDGE_MODE must be shared or all, got ${envMode}`);
  }
  return {
    host: env.REX_BRIDGE_HOST || s.host,
    port: env.REX_BRIDGE_PORT ? parsePort(env.REX_BRIDGE_PORT, "REX_BRIDGE_PORT") : s.port,
    paths,
    tokenFile: paths.tokenFile,
    sharedFile: paths.sharedFile,
    heartbeatFile: paths.heartbeatFile,
    auditLog: paths.auditLog,
    rexBin: env.REX_BIN || "rex",
    getMode: async () => (envMode as Mode | undefined) ?? (await readSettings(paths.configFile)).mode,
  };
}
