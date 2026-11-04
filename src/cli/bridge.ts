#!/usr/bin/env node
import { AuditLog } from "../audit.js";
import { loadConfig } from "../config.js";
import { Ops } from "../ops.js";
import { Rex, spawnRunner } from "../rex.js";
import { createBridgeHttpServer } from "../server.js";
import { ensureToken, readToken } from "../token.js";
import { WatchFile } from "../watch.js";

const USAGE = `usage:
  rex-bot-bridge serve                    start the MCP server (127.0.0.1:7400 by default)
  rex-bot-bridge token [--rotate] [--show] create the bearer token if missing (prints its path;
                                          --show also prints the token, --rotate replaces it)`;

async function main(argv: string[]) {
  const cmd = argv[0] ?? "serve";
  const cfg = loadConfig();

  if (cmd === "token") {
    const rotate = argv.includes("--rotate");
    const { token, created } = await ensureToken(cfg.tokenFile, rotate);
    console.log(`${created ? (rotate ? "rotated" : "created") : "exists"}: ${cfg.tokenFile}`);
    if (argv.includes("--show")) console.log(token);
    return;
  }

  if (cmd === "serve") {
    if (!(await readToken(cfg.tokenFile))) {
      console.error(`no token at ${cfg.tokenFile}; run \`rex-bot-bridge token\` (or \`npm run token\`) first`);
      process.exit(1);
    }
    const audit = new AuditLog(cfg.auditLog);
    const ops = new Ops({
      rex: new Rex(spawnRunner(cfg.rexBin)),
      watch: new WatchFile(cfg.watchSessionsFile),
      heartbeatFile: cfg.watchHeartbeatFile,
      auditLogPath: cfg.auditLog,
    });
    const server = createBridgeHttpServer({ ops, audit, getToken: () => readToken(cfg.tokenFile) });
    server.listen(cfg.port, cfg.host, () => {
      console.log(`rex-bot-bridge listening on http://${cfg.host}:${cfg.port}/mcp (audit: ${cfg.auditLog})`);
    });
    const stop = () => server.close(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  console.error(USAGE);
  process.exit(cmd === "-h" || cmd === "--help" ? 0 : 2);
}

main(process.argv.slice(2)).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
