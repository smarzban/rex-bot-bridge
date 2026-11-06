import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { packageVersion } from "../version.js";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AuditLog } from "../audit.js";
import { loadConfig } from "../config.js";
import { makeCtx } from "../context.js";
import { formatChecks, runDoctor } from "../doctor.js";
import { tokenCommand, urlCommand } from "../credentials.js";
import { describe, enrich, postWebhook } from "../notify.js";
import { makePrompter } from "../prompt.js";
import { buildServeOps } from "../serve.js";
import { createBridgeHttpServer } from "../server.js";
import { ensurePrivateDir, getKey, isKey, KEYS, MODES, readSettings, SECRET_KEYS, setKey, writeSettings, type Mode } from "../settings.js";
import { PARTS, setup, type Part } from "../setup.js";
import { setupWebhook } from "../webhook.js";
import { commandHelp, TOP_HELP } from "./help.js";
import { readToken } from "../token.js";
import { BLOCK_ID, SESSION_ID } from "../tools.js";
import { uninstall } from "../uninstall.js";
import { entryKind, ShareFile } from "../share.js";
import { Rex, spawnRunner } from "../rex.js";

const BOOL_FLAGS = [
  "yes",
  "json",
  "show",
  "rotate",
  "purge",
  "serve-off",
  "test-webhook",
  "no-services",
  "no-serve",
  "no-skills",
  "no-rex-config",
  "no-test",
  "help",
] as const;
const STRING_FLAGS = ["mode", "url", "key-file", "header"] as const;

function parse(argv: string[]) {
  const options: Record<string, { type: "boolean" | "string"; short?: string }> = {};
  for (const f of BOOL_FLAGS) options[f] = { type: "boolean" };
  for (const f of STRING_FLAGS) options[f] = { type: "string" };
  options.yes!.short = "y";
  options.help!.short = "h";
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  return { flags: values as Record<string, string | boolean | undefined>, pos: positionals };
}

/** A usage error: one line plus where to look. Exit 2. */
function usageError(msg: string, cmd?: string): number {
  console.error(`rex-grokbot: ${msg}\nRun \`rex-grokbot ${cmd ? `${cmd} ` : ""}--help\` for usage.`);
  return 2;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function serve(): Promise<number> {
  const cfg = await loadConfig();
  if (!(await readToken(cfg.tokenFile))) {
    console.error(`rex-grokbot: no token at ${cfg.tokenFile}; run \`rex-grokbot setup\` first`);
    return 1;
  }
  const audit = new AuditLog(cfg.auditLog);
  const ops = buildServeOps(cfg);
  const server = createBridgeHttpServer({ ops, audit, getToken: () => readToken(cfg.tokenFile) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });
  console.log(`rex-grokbot-bridge listening on http://${cfg.host}:${cfg.port}/mcp (mode ${await cfg.getMode()}, audit: ${cfg.auditLog})`);
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
    env: { ...process.env, REX_GROKBOT_DIR: ctx.paths.stateDir, REX_GROKBOT_NODE: ctx.node, REX_GROKBOT_CLI: ctx.cli },
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

/** Labels for `share list`, best effort: id -> "label" (or "(closed)"); empty when Rex can't be asked. */
async function shareLabels(rexBin: string | null, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rexBin || ids.length === 0) return out;
  try {
    // Only an already-running server: listing the share list must never start one.
    const run = spawnRunner(rexBin, 5_000);
    const rex = new Rex((args, opts) => run(["--autostart=false", ...args], opts));
    const sessions = await rex.sessions();
    const blocks = new Map<string, string>();
    for (const s of sessions) {
      out.set(s.session_id, s.label ?? "");
      if (!ids.some((id) => id.startsWith("block:"))) continue;
      for (const b of await rex.blocks(s.session_id).catch(() => [])) {
        blocks.set(b.block_id, `${b.label ?? ""}${s.label ? ` (in ${s.label})` : ""}`.trim());
      }
    }
    for (const [id, label] of blocks) out.set(id, label);
    for (const id of ids) if (!out.has(id)) out.set(id, "(closed)");
  } catch {
    out.clear();
  }
  return out;
}

async function watchCmd(pos: string[]): Promise<number> {
  if (pos.length === 0) return runWatcher();
  console.error("usage: rex-grokbot watch   (runs the status watcher; to share panes or sessions with the bot: rex-grokbot share add|remove|list)");
  return 2;
}

async function shareCmd(pos: string[]): Promise<number> {
  const [sub, id] = pos;
  const ctx = makeCtx();
  const shares = new ShareFile(ctx.paths.sharedFile);
  if (sub === "list") {
    const ids = await shares.list();
    const labels = await shareLabels(ctx.rexBin, ids);
    for (const s of ids) {
      const label = labels.get(s);
      console.log(`${(entryKind(s) ?? "?").padEnd(7)} ${s}${label ? `  ${label}` : ""}`);
    }
    return 0;
  }
  if (sub === "add" || sub === "remove") {
    if (!id || !(SESSION_ID.safeParse(id).success || BLOCK_ID.safeParse(id).success)) {
      console.error(
        `usage: rex-grokbot share ${sub} session:<id>|block:<id>   (a session covers every pane in it; a block only that pane; ids: \`rex-grokbot whoami\` or \`rex ls --json\`)`,
      );
      return 2;
    }
    await ensurePrivateDir(ctx.paths.stateDir);
    const changed = sub === "add" ? await shares.add(id) : await shares.remove(id);
    const what = `${entryKind(id) === "pane" ? "pane" : "session"} ${id}`;
    console.log(`${changed ? (sub === "add" ? "sharing" : "no longer sharing") : sub === "add" ? "already sharing" : "was not sharing"} ${what}`);
    return 0;
  }
  console.error("usage: rex-grokbot share [add|remove <session:…|block:…> | list]");
  return 2;
}

async function configCmd(pos: string[], show: boolean): Promise<number> {
  const [sub, key, value] = pos;
  const ctx = makeCtx();
  if ((sub !== "get" && sub !== "set") || !key || !isKey(key)) {
    console.error(`usage: rex-grokbot config get|set <key> [value]\nkeys: ${KEYS.join(", ")}`);
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
    console.error(`usage: rex-grokbot config set ${key} <value>   ("-" reads the value from stdin, "" clears it)`);
    return 2;
  }
  const v = value === "-" ? (await readStdin()).trim() : value;
  await writeSettings(ctx.paths.configFile, setKey(s, key, v));
  console.log(`${key} ${v ? "set" : "cleared"}`);
  if (key === "port" || key === "host") console.log("Restart the bridge for this to take effect: rex-grokbot setup services");
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
    // Like every other not-sent path: never fail the agent that called it.
    console.error('rex-grokbot: not sent: the message is empty (usage: rex-grokbot say "message")');
    return 0;
  }
  const ctx = makeCtx();
  // Only a shared pane (or a pane in a shared session) may message the bot.
  const block = process.env.REX_BLOCK || null;
  const session = process.env.REX_SESSION || null;
  if (!block) {
    console.error("rex-grokbot: not sent: not running inside a Rex pane");
    return 0;
  }
  const shared = await new ShareFile(ctx.paths.sharedFile).covers(session, block).catch(() => false);
  if (!shared) {
    console.error(
      "rex-grokbot: not sent: this pane isn't shared with the bot; the person can share it from the Rex palette " +
        "(Bot: Share / Unshare This Pane, or This Session)",
    );
    return 0;
  }
  const s = await readSettings(ctx.paths.configFile).catch(() => null);
  if (!s?.webhook.url) {
    console.error("rex-grokbot: no webhook configured (rex-grokbot setup webhook); message not sent");
    return 0;
  }
  const payload = {
    event: "agent_message",
    text,
    rex_session: session,
    rex_block: block,
    cwd: process.cwd(),
    host: hostname(),
    timestamp: new Date().toISOString(),
    source: "rex",
  };
  const r = await postWebhook(s.webhook, enrich(payload), { logFile: ctx.paths.notifyLog });
  console.error(r.ok ? "rex-grokbot: sent" : `rex-grokbot: message not delivered (${describe(r)})`);
  return 0;
}


/** Reads --key-file: a path, or "-" for stdin. */
async function readKeyFile(f: string): Promise<string> {
  return (f === "-" ? await readStdin() : await readFile(f, "utf8")).trim();
}

async function setupCmd(pos: string[], flags: Record<string, string | boolean | undefined>): Promise<number> {
  const [part, ...extra] = pos;
  if (extra.length) return usageError(`unexpected argument: ${extra[0]}`, "setup");
  if (part === "webhook") {
    for (const f of ["mode", "no-services", "no-serve", "no-skills", "no-rex-config"]) {
      if (flags[f] !== undefined) return usageError(`--${f} is not an option of setup webhook`, "setup webhook");
    }
    const keyFile = flags["key-file"] as string | undefined;
    let key: string | undefined;
    if (keyFile !== undefined) {
      try {
        key = await readKeyFile(keyFile);
      } catch (e) {
        console.error(`rex-grokbot: cannot read --key-file: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
        return 1;
      }
    }
    return setupWebhook(
      makeCtx(),
      { url: flags.url as string | undefined, key, header: flags.header as string | undefined, test: !flags["no-test"] },
      makePrompter(!!flags.yes),
    );
  }
  for (const f of ["url", "key-file", "header", "no-test"]) {
    if (flags[f] !== undefined) return usageError(`--${f} belongs to setup webhook: rex-grokbot setup webhook --${f} …`, "setup webhook");
  }
  const p = part === "skills" ? "skill" : part;
  if (p !== undefined && !(PARTS as readonly string[]).includes(p)) {
    return usageError(`unknown setup part: ${part} (parts: ${PARTS.join(", ")}, webhook)`, "setup");
  }
  const mode = flags.mode as string | undefined;
  if (mode && !MODES.includes(mode as Mode)) return usageError(`--mode must be one of ${MODES.join(", ")}`, "setup");
  return setup(
    makeCtx(),
    {
      yes: !!flags.yes,
      mode: mode as Mode | undefined,
      services: !flags["no-services"],
      serve: !flags["no-serve"],
      skills: !flags["no-skills"],
      rexConfig: !flags["no-rex-config"],
    },
    makePrompter(!!flags.yes),
    p as Part | undefined,
  );
}

/** "setup webhook" has its own help page; other setup parts share setup's. */
function helpName(cmd: string, pos: string[]): string {
  return cmd === "setup" && pos[0] === "webhook" ? "setup webhook" : cmd;
}

function printHelp(name: string): number {
  const h = commandHelp(name);
  if (!h) return usageError(`no help for unknown command: ${name}`);
  console.log(h);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    console.error(TOP_HELP);
    return 2;
  }
  if (cmd === "-h" || cmd === "--help") {
    console.log(TOP_HELP);
    return 0;
  }
  if (cmd === "help") {
    if (!rest.length) {
      console.log(TOP_HELP);
      return 0;
    }
    return printHelp(helpName(rest[0]!, rest.slice(1)));
  }
  if (cmd === "-v" || cmd === "--version" || cmd === "version") {
    console.log(packageVersion());
    return 0;
  }
  if (!commandHelp(cmd)) return usageError(`unknown command: ${cmd}`);
  // `say` takes free text (which may contain things that look like flags): no option parsing.
  if (cmd === "say") {
    if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) return printHelp("say");
    return sayCmd(rest.join(" ").trim());
  }

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(rest);
  } catch (e) {
    const name = rest.find((a) => !a.startsWith("-")) === "webhook" && cmd === "setup" ? "setup webhook" : cmd;
    return usageError((e as Error).message.split("\n")[0]!, name);
  }
  const { flags, pos } = parsed;
  if (flags.help) return printHelp(helpName(cmd, pos));
  switch (cmd) {
    case "whoami":
      console.log(`REX_SESSION=${process.env.REX_SESSION ?? ""}`);
      console.log(`REX_BLOCK=${process.env.REX_BLOCK ?? ""}`);
      if (!process.env.REX_SESSION) {
        console.error("rex-grokbot: not running inside a Rex pane");
        return 1;
      }
      return 0;
    case "serve":
      return serve();
    case "watch":
      return watchCmd(pos);
    case "share":
      return shareCmd(pos);
    case "token":
      if (flags.show) return usageError("token always prints the token; --show is gone", "token");
      if (pos.length) return usageError(`unexpected argument: ${pos[0]}`, "token");
      return tokenCommand(makeCtx(), !!flags.rotate);
    case "url":
      if (pos.length) return usageError(`unexpected argument: ${pos[0]}`, "url");
      return urlCommand(makeCtx());
    case "config":
      return configCmd(pos, !!flags.show);
    case "notify":
      return notifyCmd();
    case "setup":
      return setupCmd(pos, flags);
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
      return usageError(`unknown command: ${cmd}`);
  }
}

export function run(argv: string[]): void {
  main(argv).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`rex-grokbot: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
