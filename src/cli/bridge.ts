#!/usr/bin/env node
// Compatibility alias from v1: `rex-bot-bridge serve` and `rex-bot-bridge token [--rotate] [--show]`.
import { run } from "./main.js";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "serve";
if (cmd === "serve" || cmd === "token") run([cmd, ...argv.slice(1)]);
else {
  console.error(`usage:
  rex-bot-bridge serve                     start the MCP server (same as \`rex-bot serve\`)
  rex-bot-bridge token [--rotate] [--show] create or rotate the bearer token (same as \`rex-bot token\`)
Everything else lives in \`rex-bot\` (rex-bot --help).`);
  process.exit(cmd === "-h" || cmd === "--help" ? 0 : 2);
}
