import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AuditLog } from "../audit.js";
import { loadConfig } from "../config.js";
import { makeCtx } from "../context.js";
import { formatChecks, runDoctor } from "../doctor.js";
import { grokbotText } from "../grokbot.js";
import { describe, enrich, postWebhook } from "../notify.js";
import { Ops } from "../ops.js";
import { makePrompter } from "../prompt.js";
import { Rex, spawnRunner } from "../rex.js";
import { createBridgeHttpServer } from "../server.js";
import { ensurePrivateDir, getKey, isKey, KEYS, MODES, readSettings, SECRET_KEYS, setKey, writeSettings, type Mode } from "../settings.js";
import { setup } from "../setup.js";
import { tailscaleStatus } from "../tailscale.js";
import { ensureToken, readToken } from "../token.js";
import { SESSION_ID } from "../tools.js";
import { uninstall } from "../uninstall.js";
import { WatchFile } from "../watch.js";

export const USAGE = `rex-bot: let a coordinator bot (Grok Bot over Tailscale) see and drive your Rex agents.

Install and check:
  rex-bot setup [--yes] [--mode watched|full] [--webhook-url URL] [--webhook-key-file FILE]
                [--webhook-header NAME] [--no-services] [--no-serve] [--no-skills] [--no-rex-config]
                [--show-token]
  rex-bot doctor [--json] [--test-webhook]
  rex-bot uninstall [--yes] [--purge] [--serve-off]
  rex-bot grokbot [--show-token]      print the Grok Bot setup text again

Settings (~/.config/rex-bot-bridge):
  rex-bot config get <key> [--show]   keys: ${KEYS.join(", ")}
  rex-bot config set <key> <value>    value "-" reads it from stdin (keeps secrets out of shell history)
  rex-bot token [--rotate] [--show]   create (or rotate) the bridge's bearer token
  rex-bot watch add|remove <session>  opt a Rex session in or out
  rex-bot watch list

For agents inside Rex:
  rex-bot say "message"               send a message to the coordinator
  rex-bot whoami                      print this pane's REX_SESSION and REX_BLOCK

Services (run by launchd; also fine by hand):
  rex-bot serve                       the MCP server (127.0.0.1:7400 by default)
  rex-bot watch                       the status watcher (rex do --all lua/bot-watch.lua)
  rex-bot notify                      internal: POST the JSON on stdin to the webhook`;

const BOOL_FLAGS = [
  "yes",
  "json",
  "show",
  "rotate",
  "purge",
  "serve-off",
  "show-token",
  "test-webhook",
  "no-services",
  "no-serve",
  "no-skills",
  "no-rex-config",
  "help",
] as const;

function parse(argv: string[]) {
  const options: Record<string, { type: "boolean" | "string"; short?: string }> = {};
  for (const f of BOOL_FLAGS) options[f] = { type: "boolean" };
  for (const f of ["mode", "webhook-url", "webhook-key-file", "webhook-header"]) options[f] = { type: "string" };
  options.yes!.short = "y";
  options.help!.short = "h";
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  return { flags: values as Record<string, string | boolean | undefined>, pos: positionals };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function serve(): Promise<number> {
  const cfg = await loadConfig();
  if (!(await readToken(cfg.tokenFile))) {
    console.error(`no token at ${cfg.tokenFile}; run \`rex-bot token\` (or \`rex-bot setup\`) first`);
    return 1;
  }
  const audit = new AuditLog(cfg.auditLog);
  const ops = new Ops({
    rex: new Rex(spawnRunner(cfg.rexBin)),
    watch: new WatchFile(cfg.watchedFile),
    heartbeatFile: cfg.heartbeatFile,
    auditLogPath: cfg.auditLog,
    mode: cfg.getMode,
  });
  const server = createBridgeHttpServer({ ops, audit, getToken: () => readToken(cfg.tokenFile) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  console.log(`rex-bot-bridge listening on http://${cfg.host}:${cfg.port}/mcp (mode ${await cfg.getMode()}, audit: ${cfg.auditLog})`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise<number>(() => {}); // runs until signalled
}

/** Runs lua/bot-watch.lua under `rex do --all`, with the paths it needs in env. */
async function runWatcher(): Promise<number> {
  const ctx = makeCtx();
  if (!ctx.rexBin) {
    console.error("rex not found on PATH (or set REX_BIN)");
    return 1;
  }
  if (!existsSync(ctx.cli)) {
    console.error(`${ctx.cli} is missing; build the package first (npm run build)`);
    return 1;
  }
  await ensurePrivateDir(ctx.paths.stateDir);
  const script = join(ctx.pkgRoot, "lua/bot-watch.lua");
  const child = spawn(ctx.rexBin, ["do", "--all", script], {
    stdio: "inherit",
    env: { ...process.env, REX_BOT_DIR: ctx.paths.stateDir, REX_BOT_NODE: ctx.node, REX_BOT_CLI: ctx.cli },
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
  return new Promise((resolve) => {
    child.on("error", (e) => {
      console.error(`failed to start rex: ${e.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function watchCmd(pos: string[]): Promise<number> {
  const [sub, id] = pos;
  if (!sub) return runWatcher();
  const ctx = makeCtx();
  const watch = new WatchFile(ctx.paths.watchedFile);
  if (sub === "list") {
    for (const s of await watch.list()) console.log(s);
    return 0;
  }
  if (sub === "add" || sub === "remove") {
    if (!id || !SESSION_ID.safeParse(id).success) {
      console.error(`usage: rex-bot watch ${sub} session:<id>   (full id: see \`rex ls --json\` or \`rex-bot whoami\`)`);
      return 2;
    }
    await ensurePrivateDir(ctx.paths.stateDir);
    const changed = sub === "add" ? await watch.add(id) : await watch.remove(id);
    console.log(`${changed ? (sub === "add" ? "watching" : "no longer watching") : sub === "add" ? "already watching" : "was not watching"} ${id}`);
    return 0;
  }
  console.error("usage: rex-bot watch [add|remove <session> | list]");
  return 2;
}

async function configCmd(pos: string[], show: boolean): Promise<number> {
  const [sub, key, value] = pos;
  const ctx = makeCtx();
  if ((sub !== "get" && sub !== "set") || !key || !isKey(key)) {
    console.error(`usage: rex-bot config get|set <key> [value]\nkeys: ${KEYS.join(", ")}`);
    return 2;
  }
  const s = await readSettings(ctx.paths.configFile);
  if (sub === "get") {
    const v = getKey(s, key);
    if (v === undefined) console.log("(not set)");
    else if (SECRET_KEYS.includes(key) && !show) console.log("(set; hidden, add --show to print)");
    else console.log(String(v));
    return 0;
  }
  if (value === undefined) {
    console.error(`usage: rex-bot config set ${key} <value>   ("-" reads the value from stdin, "" clears it)`);
    return 2;
  }
  const v = value === "-" ? (await readStdin()).trim() : value;
  await writeSettings(ctx.paths.configFile, setKey(s, key, v));
  console.log(`${key} ${v ? "set" : "cleared"}`);
  if (key === "port" || key === "host") console.log("Restart the bridge (re-run `rex-bot setup`) for this to take effect.");
  return 0;
}

async function notifyCmd(): Promise<number> {
  const ctx = makeCtx();
  const raw = await readStdin();
  let payload: Record<string, unknown>;
  try {
    const j = JSON.parse(raw) as unknown;
    payload = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : { data: j };
  } catch {
    payload = { event: "message", text: raw };
  }
  const s = await readSettings(ctx.paths.configFile);
  const r = await postWebhook(s.webhook, enrich(payload), { logFile: ctx.paths.notifyLog });
  console.log(describe(r));
  return r.ok ? 0 : 1;
}

async function sayCmd(text: string): Promise<number> {
  if (!text) {
    console.error('usage: rex-bot say "message"');
    return 2;
  }
  const ctx = makeCtx();
  const s = await readSettings(ctx.paths.configFile).catch(() => null);
  if (!s?.webhook.url) {
    console.error("rex-bot: no webhook configured (rex-bot config set webhook.url …); message not sent");
    return 0;
  }
  const payload = {
    event: "agent_message",
    text,
    rex_session: process.env.REX_SESSION ?? null,
    rex_block: process.env.REX_BLOCK ?? null,
    cwd: process.cwd(),
    host: hostname(),
    timestamp: new Date().toISOString(),
    source: "rex",
  };
  const r = await postWebhook(s.webhook, enrich(payload), { logFile: ctx.paths.notifyLog });
  console.error(r.ok ? "rex-bot: sent" : `rex-bot: message not delivered (${describe(r)})`);
  return 0;
}

async function tokenCmd(rotate: boolean, show: boolean): Promise<number> {
  const ctx = makeCtx();
  await ensurePrivateDir(ctx.paths.stateDir);
  const { token, created } = await ensureToken(ctx.paths.tokenFile, rotate);
  console.log(`${created ? (rotate ? "rotated" : "created") : "exists"}: ${ctx.paths.tokenFile}`);
  if (show) console.log(token);
  return 0;
}

async function grokbotCmd(showToken: boolean): Promise<number> {
  const ctx = makeCtx();
  const s = await readSettings(ctx.paths.configFile);
  const ts = await tailscaleStatus(ctx.tailscale);
  const token = showToken ? await readToken(ctx.paths.tokenFile) : null;
  if (showToken && !token) {
    console.error(`no token at ${ctx.paths.tokenFile}; run \`rex-bot setup\` first`);
    return 1;
  }
  console.log(grokbotText({ dnsName: ts.dnsName, servePath: s.servePath, token, webhookConfigured: !!s.webhook.url }));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    (cmd ? console.log : console.error)(USAGE);
    return cmd ? 0 : 2;
  }
  // `say` takes free text (which may contain things that look like flags): no option parsing.
  if (cmd === "say") return sayCmd(rest.join(" ").trim());
  if (cmd === "whoami") {
    console.log(`REX_SESSION=${process.env.REX_SESSION ?? ""}`);
    console.log(`REX_BLOCK=${process.env.REX_BLOCK ?? ""}`);
    if (!process.env.REX_SESSION) {
      console.error("rex-bot: not running inside a Rex pane");
      return 1;
    }
    return 0;
  }

  const { flags, pos } = parse(rest);
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  switch (cmd) {
    case "serve":
      return serve();
    case "watch":
      return watchCmd(pos);
    case "token":
      return tokenCmd(!!flags.rotate, !!flags.show);
    case "config":
      return configCmd(pos, !!flags.show);
    case "notify":
      return notifyCmd();
    case "grokbot":
      return grokbotCmd(!!flags["show-token"]);
    case "setup": {
      const mode = flags.mode as string | undefined;
      if (mode && !MODES.includes(mode as Mode)) {
        console.error(`--mode must be one of ${MODES.join(", ")}`);
        return 2;
      }
      return setup(
        makeCtx(),
        {
          yes: !!flags.yes,
          mode: mode as Mode | undefined,
          webhookUrl: flags["webhook-url"] as string | undefined,
          webhookKeyFile: flags["webhook-key-file"] as string | undefined,
          webhookHeader: flags["webhook-header"] as string | undefined,
          services: !flags["no-services"],
          serve: !flags["no-serve"],
          skills: !flags["no-skills"],
          rexConfig: !flags["no-rex-config"],
          showToken: !!flags["show-token"],
        },
        makePrompter(!!flags.yes),
      );
    }
    case "doctor": {
      const checks = await runDoctor(makeCtx(), { testWebhook: !!flags["test-webhook"] });
      const ok = !checks.some((c) => c.level === "fail");
      if (flags.json) console.log(JSON.stringify({ ok, checks }, null, 2));
      else console.log(formatChecks(checks) + `\n\n${ok ? "No failures." : "Some checks failed (❌); see the fix lines."}`);
      return ok ? 0 : 1;
    }
    case "uninstall":
      return uninstall(
        makeCtx(),
        { yes: !!flags.yes, purge: !!flags.purge, serveOff: !!flags["serve-off"] },
        makePrompter(!!flags.yes),
      );
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

export function run(argv: string[]): void {
  main(argv).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`rex-bot: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
