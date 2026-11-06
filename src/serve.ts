import type { Config } from "./config.js";
import { Ops } from "./ops.js";
import { Rex, spawnRunner, type Runner } from "./rex.js";
import { ShareFile } from "./share.js";

/** The Ops the `serve` command runs, wired to config.json's mode (read per call). */
export function buildServeOps(cfg: Config, runner: Runner = spawnRunner(cfg.rexBin)): Ops {
  return new Ops({
    rex: new Rex(runner),
    shares: new ShareFile(cfg.sharedFile),
    heartbeatFile: cfg.heartbeatFile,
    auditLogPath: cfg.auditLog,
    mode: cfg.getMode,
  });
}
