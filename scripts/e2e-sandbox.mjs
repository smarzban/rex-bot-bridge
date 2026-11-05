#!/usr/bin/env node
// Sandbox end-to-end check: real Rex, real Node, no launchd, no Tailscale changes.
//
//   npm run build && node scripts/e2e-sandbox.mjs
//
// HOME and XDG_CONFIG_HOME point at a temp dir, so setup's init.lua, skills, config and logs land there.
// Creates two Rex sessions labelled `e2e-sandbox-*`, and kills only those. Never touches the real
// ~/.config, the real init.lua, launchd, or tailscale serve.
import { spawn, execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist/cli/rex-bot.js");
const PORT = Number(process.env.E2E_PORT || 7412);
const REX = process.env.REX_BIN || "rex";

let failures = 0;
const check = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${what}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- sandbox ----
const SB = await mkdtemp(join(tmpdir(), "rex-bot-sandbox-"));
const env = { ...process.env, HOME: SB, XDG_CONFIG_HOME: join(SB, ".config") };
// Like launchd: no Rex pane context. rex finds its server socket via HOME, which is the sandbox here, so
// point it at the real server explicitly (what the generated plists do when setup knows REX_SERVER).
const REAL_SOCK = `unix://${encodeURI(join(homedir(), "Library/Application Support/rex/server.sock"))}`;
for (const k of ["REX_CONFIG", "REX_BOT_DIR", "REX_SESSION", "REX_BLOCK"]) delete env[k];
env.REX_SERVER = process.env.REX_SERVER || REAL_SOCK;
await mkdir(join(SB, ".config/rex"), { recursive: true });
await mkdir(join(SB, ".claude"));
await mkdir(join(SB, ".agents"));
const userInit = '-- the user\'s own config\nlocal e2e_marker = true\n';
await writeFile(join(SB, ".config/rex/init.lua"), userInit);
// A v1 opt-in list to migrate.
await mkdir(join(SB, ".config/rex/bot-watch"), { recursive: true });
const V1_ID = "session:00000000-0000-7000-8000-00000000e2e1";
await writeFile(join(SB, ".config/rex/bot-watch/sessions"), `# v1\n${V1_ID}\n`);
console.log(`sandbox: ${SB}`);

const cli = (args, opts = {}) =>
  run(process.execPath, [CLI, ...args], { env: { ...env, ...(opts.env ?? {}) }, timeout: 60_000 }).then(
    (r) => ({ ...r, code: 0 }),
    (e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 }),
  );

// ---- webhook sink ----
const received = [];
const sink = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    } catch {
      received.push({ auth: req.headers.authorization, body });
    }
    res.writeHead(200).end("ok");
  });
});
await new Promise((r) => sink.listen(0, "127.0.0.1", r));
const SINK_URL = `http://127.0.0.1:${sink.address().port}/hook/e2e-sink-path`;
const KEY = "e2e-webhook-key-" + Math.random().toString(36).slice(2);
const keyFile = join(SB, "webhook-key");
await writeFile(keyFile, KEY + "\n", { mode: 0o600 });
const waitFor = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = received.find(pred);
    if (hit) return hit;
    await sleep(250);
  }
  return null;
};

const children = [];
const sessions = [];
let client;
try {
  // ---- 1. setup ----
  const setupRes = await cli([
    "setup", "--yes", "--no-services", "--no-serve", "--mode", "watched",
  ]);
  console.log(setupRes.stdout.trim());
  check(setupRes.code === 0, `setup exit ${setupRes.code} ${setupRes.stderr.trim()}`);
  const token = (await readFile(join(SB, ".config/rex-bot-bridge/token"), "utf8")).trim();
  check(!setupRes.stdout.includes(token) && !setupRes.stderr.includes(token), "setup output never shows the token");
  check(setupRes.stdout.trimEnd().endsWith("3. Check everything: rex-bot doctor --test-webhook"), "setup ends with the Next block");
  const hook = await cli(["setup", "webhook", "--url", SINK_URL, "--key-file", keyFile, "--yes"]);
  console.log(hook.stdout.trim());
  check(hook.code === 0 && hook.stdout.includes("Test sent: HTTP 200"), `setup webhook saved and test-posted (exit ${hook.code}) ${hook.stderr.trim()}`);
  check(!(hook.stdout + hook.stderr).includes(KEY) && !(hook.stdout + hook.stderr).includes("e2e-sink-path"), "setup webhook output never shows the webhook URL/key");
  check(!!(await waitFor((r) => r.body?.event === "doctor_test" && r.auth === `Bearer ${KEY}`, 3000)), "sink got the setup webhook test post with Bearer <key>");
  const gb = await cli(["grokbot"]);
  check(gb.stdout.includes("<TOKEN>") && gb.stdout.includes("rex-bot grokbot --show-token") && gb.stdout.includes("docs/grok-bot.md") && !gb.stdout.includes(token), "grokbot prints the connector message with a token placeholder and the guide link");
  const stateDir = join(SB, ".config/rex-bot-bridge");
  check(((await stat(stateDir)).mode & 0o777) === 0o700, "state dir is 700");
  for (const f of ["token", "config.json"]) check(((await stat(join(stateDir, f))).mode & 0o777) === 0o600, `${f} is 600`);
  const initAfter = await readFile(join(SB, ".config/rex/init.lua"), "utf8");
  check(initAfter.startsWith(userInit) && initAfter.includes("-- >>> rex-bot-bridge >>>") && initAfter.includes(join(ROOT, "lua/rex-bot-actions.lua")), "init.lua got the marked dofile block, user code kept");
  check((await readdir(join(SB, ".config/rex/rex-bot-backups"))).length === 1, "init.lua backed up next to init.lua");
  check((await readFile(join(stateDir, "watched"), "utf8")).includes(V1_ID), "v1 opt-in list migrated");
  for (const root of [".claude", ".agents"]) {
    const skill = await readFile(join(SB, root, "skills/rex-bot/SKILL.md"), "utf8").catch(() => "");
    check(skill.includes("installed-by: rex-bot-bridge"), `skill installed in ${root}`);
  }
  check((await cli(["config", "set", "port", String(PORT)])).code === 0, `port set to ${PORT}`);
  const rerun = await cli(["setup", "--yes", "--no-services", "--no-serve", "--no-skills"]);
  check(rerun.code === 0 && rerun.stdout.includes("already in") && rerun.stdout.includes("Mode: watched (kept)"), "setup re-run is idempotent and keeps the mode");

  // ---- 2. doctor (nothing running yet) ----
  const doc = await cli(["doctor", "--json"]);
  const report = JSON.parse(doc.stdout);
  const level = Object.fromEntries(report.checks.map((c) => [c.id, c.level]));
  console.log(report.checks.map((c) => `  ${c.level.padEnd(4)} ${c.id}: ${c.detail}`).join("\n"));
  for (const id of ["node", "rex", "rex_server", "token", "mode", "rex_actions", "webhook", "skills", "tailscale"]) {
    check(level[id] === "ok", `doctor ${id} ok`);
  }
  for (const id of ["service_bridge", "service_watch", "serve"]) check(level[id] === "warn", `doctor ${id} skipped (warn)`);
  check(report.checks.every((c) => c.level !== "fail") && doc.code === 0, `doctor: no failures (exit ${doc.code})`);

  // ---- 3. bridge + watcher by hand ----
  for (const sub of ["serve", "watch"]) {
    const child = spawn(process.execPath, [CLI, sub], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => process.stdout.write(`[${sub}] ${d}`));
    child.stderr.on("data", (d) => process.stdout.write(`[${sub}!] ${d}`));
    children.push(child);
  }
  let health = null;
  for (let i = 0; i < 40 && !health; i++) {
    await sleep(250);
    health = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json()).catch(() => null);
  }
  check(health?.ok === true && health.rex_reachable === true, `bridge /healthz on ${PORT}: ${JSON.stringify(health)}`);
  let hb = null;
  for (let i = 0; i < 40 && !hb; i++) {
    await sleep(250);
    hb = await readFile(join(stateDir, "heartbeat"), "utf8").catch(() => null);
  }
  check(!!hb, "watcher wrote its heartbeat in the sandbox");
  const hbMode = (await stat(join(stateDir, "heartbeat")).catch(() => null))?.mode & 0o777;
  check(hbMode === 0o600, `heartbeat is 0600 (got ${hbMode?.toString(8)})`);

  const doc2 = JSON.parse((await cli(["doctor", "--json", "--test-webhook"])).stdout);
  const l2 = Object.fromEntries(doc2.checks.map((c) => [c.id, c.level]));
  check(l2.bridge_local === "ok" && l2.watcher === "ok", "doctor sees the running bridge and watcher");
  check(l2.webhook_test === "ok", "doctor --test-webhook got HTTP 200");
  check(!!(await waitFor((r) => r.body?.event === "doctor_test", 3000)), "sink got doctor_test");

  // ---- 4. test sessions ----
  const mk = async (label) => {
    const r = await run(REX, ["new", label, "-c", SB, "--json"]);
    const j = JSON.parse(r.stdout);
    const s = { session_id: j.session_id, block_id: j.initial_windows[0].block_ids[0] };
    sessions.push(s.session_id);
    return s;
  };
  const tag = Math.random().toString(36).slice(2, 7);
  const watchedS = await mk(`e2e-sandbox-${tag}-watched`);
  const otherS = await mk(`e2e-sandbox-${tag}-other`);
  await chmod(join(stateDir, "watched"), 0o644); // as a pre-0.2.0 install would have left it
  const add = await cli(["watch", "add", watchedS.session_id]);
  check(add.stdout.startsWith("watching"), `rex-bot watch add: ${add.stdout.trim()}`);
  const wMode = (await stat(join(stateDir, "watched")).catch(() => null))?.mode & 0o777;
  check(wMode === 0o600, `watched tightened from 0644 to 0600 on write (got ${wMode?.toString(8)})`);
  await sleep(1500); // let the shells start

  client = new Client({ name: "e2e-sandbox", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const tool = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content.map((c) => c.text).join("\n") };
  };

  // Gating
  const status = JSON.parse((await tool("bridge_status", {})).text);
  check(status.mode === "watched", "bridge_status mode=watched");
  const refused = await tool("send_message", { block_id: otherS.block_id, text: "echo should-not-run" });
  check(refused.isError && /"watched" mode/.test(refused.text), `send_message to unwatched session refused: ${refused.text.slice(0, 90)}…`);
  const readRefused = await tool("read_pane", { block_id: otherS.block_id });
  check(readRefused.isError, "read_pane of unwatched session refused");
  const watchRefused = await tool("watch_session", { session_id: otherS.session_id });
  check(watchRefused.isError, "watch_session refused in watched mode");

  // OSC 7501 done in the watched session, sent through the bridge (allowed there).
  const sent = await tool("send_message", { block_id: watchedS.block_id, text: "printf '\\033]7501;state=done:app=e2e\\033\\\\'" });
  check(!sent.isError, `send_message to watched session allowed ${sent.isError ? sent.text : ""}`);
  const st = await waitFor((r) => r.body?.event === "agent_status" && r.body.rex_session === watchedS.session_id, 20_000);
  check(!!st, "sink got agent_status from the watcher");
  if (st) {
    check(st.body.state === "done" && st.body.app === "e2e" && st.body.rex_block === watchedS.block_id, `agent_status payload: state=${st.body.state} app=${st.body.app}`);
    check(st.auth === `Bearer ${KEY}`, "webhook got Authorization: Bearer <key>");
    check(st.body.source === "rex" && !!st.body.host && !!st.body.timestamp, "payload enriched with source/host/timestamp");
  }
  // The unwatched session must stay silent.
  const otherSend = await run(REX, ["send", "-s", otherS.session_id, "-b", otherS.block_id, "--", "printf '\\033]7501;state=done:app=e2e-other\\033\\\\'\n"]).then(() => 0, (e) => e.code ?? 1);
  check(otherSend === 0, "OSC 7501 done sent into the unwatched session too");
  await sleep(5000);
  check(!received.some((r) => r.body?.rex_session === otherS.session_id), "no agent_status for the unwatched session");

  // say
  const say = await cli(["say", "hello from the sandbox"], { env: { REX_SESSION: watchedS.session_id, REX_BLOCK: watchedS.block_id } });
  check(say.code === 0 && /sent/.test(say.stderr), `rex-bot say: ${say.stderr.trim()}`);
  const msg = await waitFor((r) => r.body?.event === "agent_message", 3000);
  check(msg?.body.text === "hello from the sandbox" && msg.body.rex_session === watchedS.session_id, "sink got agent_message");
  const notifyLog = await readFile(join(SB, "Library/Logs/rex-bot-bridge/notify.log"), "utf8").catch(() => "");
  check(notifyLog.includes("http=200") && !notifyLog.includes(KEY) && !notifyLog.includes("e2e-sink-path"), "notify.log has status codes only");

  // Unwatched during the watcher's debounce: nothing is sent.
  const t0 = Date.now();
  await run(REX, ["send", "-s", watchedS.session_id, "-b", watchedS.block_id, "--", "printf '\\033]7501;state=blocked:app=e2e-debounce\\033\\\\'\n"]);
  const rm = await cli(["watch", "remove", watchedS.session_id]);
  check(rm.stdout.startsWith("no longer watching") && Date.now() - t0 < 2500, `unwatched within the 3s debounce (${Date.now() - t0}ms): ${rm.stdout.trim()}`);
  await sleep(6000);
  check(!received.some((r) => r.body?.app === "e2e-debounce"), "no agent_status after the session was unwatched mid-debounce");
} catch (e) {
  failures++;
  console.log(`FAIL: ${e.stack || e}`);
} finally {
  await client?.close().catch(() => {});
  for (const c of children) c.kill("SIGTERM");
  for (const s of sessions) await run(REX, ["session", "kill", s]).catch(() => {});
  await sleep(500);
}

// ---- 5. plists (written to the sandbox, linted, never bootstrapped) ----
{
  const { renderPlist, serviceSpecs } = await import(join(ROOT, "dist/launchd.js"));
  const { resolvePaths } = await import(join(ROOT, "dist/paths.js"));
  const rexBin = (await run("/bin/sh", ["-c", "command -v rex"])).stdout.trim();
  const specs = serviceSpecs({ paths: resolvePaths(env), node: process.execPath, cli: CLI, rexBin, pkgRoot: ROOT });
  for (const spec of Object.values(specs)) {
    const file = join(SB, "Library/LaunchAgents", `${spec.label}.plist.lint`);
    await mkdir(join(SB, "Library/LaunchAgents"), { recursive: true });
    await writeFile(file, await renderPlist(spec));
    const lint = await run("/usr/bin/plutil", ["-lint", file]).then((r) => r.stdout.trim(), (e) => e.stdout || String(e));
    check(lint.endsWith("OK"), `plutil -lint ${spec.label}: ${lint.split(": ").pop()}`);
  }
}

// ---- 6. uninstall ----
const un = await cli(["uninstall", "--yes"]);
console.log(un.stdout.trim());
check(un.code === 0, `uninstall exit ${un.code}`);
check((await readFile(join(SB, ".config/rex/init.lua"), "utf8")) === userInit, "init.lua restored to the user's original");
for (const root of [".claude", ".agents"]) {
  check(!(await stat(join(SB, root, "skills/rex-bot")).catch(() => null)), `skill removed from ${root}`);
}
check(!!(await stat(join(SB, ".config/rex-bot-bridge/token")).catch(() => null)), "state dir kept without --purge");
check(!/Services stopped/.test(un.stdout), "uninstall did not touch launchd (no plists in the sandbox)");
const purge = await cli(["uninstall", "--yes", "--purge"]);
check(purge.code === 0 && !(await stat(join(SB, ".config/rex-bot-bridge")).catch(() => null)), "uninstall --purge deletes the state dir");
check((await readdir(join(SB, ".config/rex/rex-bot-backups")).catch(() => [])).length >= 2, "uninstall --purge keeps the init.lua backups");

// ---- 7. package: npm pack → global install into a temp prefix → the bin runs ----
{
  const pkgVersion = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const packDir = join(SB, "pack");
  const prefix = join(SB, "npm-prefix");
  await mkdir(packDir);
  // Only this sandbox: never the real global prefix.
  const npmEnv = { ...process.env, npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix };
  delete npmEnv.npm_config_global;
  const packed = await run("npm", ["pack", "--pack-destination", packDir, "--loglevel=error"], { cwd: ROOT, env: npmEnv, timeout: 180_000 }).then(
    (r) => r.stdout.trim().split("\n").pop(),
    (e) => (console.log(e.stderr), null),
  );
  check(!!packed, `npm pack produced ${packed}`);
  const inst = await run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", join(packDir, packed ?? "missing.tgz")], { env: npmEnv, timeout: 180_000 }).then(
    () => true,
    (e) => (console.log(e.stderr), false),
  );
  check(inst, `npm i -g --prefix <sandbox> ${packed}`);
  const bin = join(prefix, "bin/rex-bot");
  const mode = (await stat(bin).catch(() => null))?.mode ?? 0;
  check((mode & 0o111) !== 0, `installed bin is executable (mode ${(mode & 0o777).toString(8)})`);
  const ver = await run(bin, ["--version"]).then((r) => r.stdout.trim(), (e) => `error: ${e.message}`);
  check(ver === pkgVersion, `<prefix>/bin/rex-bot --version prints ${ver} (package.json ${pkgVersion})`);
}

sink.close();
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"} (sandbox ${SB})`);
process.exit(failures ? 1 : 0);
