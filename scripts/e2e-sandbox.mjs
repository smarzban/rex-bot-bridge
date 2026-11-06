#!/usr/bin/env node
// Sandbox end-to-end check: real Rex, real Node, no launchd, no Tailscale changes.
//
//   node scripts/e2e-sandbox.mjs   (runs npm run build itself)
//
// HOME and XDG_CONFIG_HOME point at a temp dir, so setup's init.lua, skills, config and logs land there.
// Creates two Rex sessions labelled `e2e-sandbox-*`, and kills only those. Never touches the real
// ~/.config, the real init.lua, launchd, or tailscale serve.
import { spawn, execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, writeFile, readdir, stat, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "dist/cli/rex-grokbot.js");
const PORT = Number(process.env.E2E_PORT || 7412);
const REX = process.env.REX_BIN || "rex";

let failures = 0;
const check = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${what}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 0. build: dist/cli/*.js must be executable straight out of `npm run build` ----
// Checked here, before npm (pack/install) touches them: npm sets the bit itself on install, so only this
// catches a build script that lost its chmod.
{
  const b = await run("npm", ["run", "build", "--loglevel=error"], { cwd: ROOT, timeout: 180_000 }).then(() => true, (e) => (console.log(e.stdout, e.stderr), false));
  check(b, "npm run build");
  for (const f of ["dist/cli/rex-grokbot.js"]) {
    const m = ((await stat(join(ROOT, f)).catch(() => null))?.mode ?? 0) & 0o777;
    check((m & 0o111) !== 0, `after npm run build, ${f} is executable (mode ${m.toString(8)})`);
  }
}

// ---- sandbox ----
const SB = await mkdtemp(join(tmpdir(), "rex-grokbot-sandbox-"));
const env = { ...process.env, HOME: SB, XDG_CONFIG_HOME: join(SB, ".config") };
// Like launchd: no Rex pane context. rex finds its server socket via HOME, which is the sandbox here, so
// point it at the real server explicitly (what the generated plists do when setup knows REX_SERVER).
const REAL_SOCK = `unix://${encodeURI(join(homedir(), "Library/Application Support/rex/server.sock"))}`;
for (const k of ["REX_CONFIG", "REX_GROKBOT_DIR", "REX_SESSION", "REX_BLOCK"]) delete env[k];
env.REX_SERVER = process.env.REX_SERVER || REAL_SOCK;
await mkdir(join(SB, ".config/rex"), { recursive: true });
await mkdir(join(SB, ".claude"));
await mkdir(join(SB, ".agents"));
const userInit = '-- the user\'s own config\nlocal e2e_marker = true\n';
await writeFile(join(SB, ".config/rex/init.lua"), userInit);
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
  const token = (await readFile(join(SB, ".config/rex-grokbot-bridge/token"), "utf8")).trim();
  check(!setupRes.stdout.includes(token) && !setupRes.stderr.includes(token), "setup output never shows the token");
  check(setupRes.stdout.trimEnd().endsWith("3. Check everything: rex-grokbot doctor --test-webhook"), "setup ends with the Next block");
  const hook = await cli(["setup", "webhook", "--url", SINK_URL, "--key-file", keyFile, "--yes"]);
  console.log(hook.stdout.trim());
  check(hook.code === 0 && hook.stdout.includes("Test sent: HTTP 200"), `setup webhook saved and test-posted (exit ${hook.code}) ${hook.stderr.trim()}`);
  check(!(hook.stdout + hook.stderr).includes(KEY) && !(hook.stdout + hook.stderr).includes("e2e-sink-path"), "setup webhook output never shows the webhook URL/key");
  check(!!(await waitFor((r) => r.body?.event === "doctor_test" && r.auth === `Bearer ${KEY}`, 3000)), "sink got the setup webhook test post with Bearer <key>");
  check(!/webhook not set/i.test(setupRes.stdout + setupRes.stderr), "setup no longer warns that the webhook isn't set");
  const tk = await cli(["token"]);
  check(tk.code === 0 && tk.stdout === `${token}\n` && tk.stderr === "", "token prints exactly the token line");
  const gb = await cli(["grokbot"]);
  check(gb.code === 2 && !gb.stdout.includes(token), "the grokbot command is gone");
  const stateDir = join(SB, ".config/rex-grokbot-bridge");
  check(((await stat(stateDir)).mode & 0o777) === 0o700, "state dir is 700");
  for (const f of ["token", "config.json"]) check(((await stat(join(stateDir, f))).mode & 0o777) === 0o600, `${f} is 600`);
  const initAfter = await readFile(join(SB, ".config/rex/init.lua"), "utf8");
  check(initAfter.startsWith(userInit) && initAfter.includes("-- >>> rex-grokbot-bridge >>>") && initAfter.includes(join(ROOT, "lua/rex-grokbot-actions.lua")), "init.lua got the marked dofile block, user code kept");
  check((await readdir(join(SB, ".config/rex/rex-grokbot-backups"))).length === 1, "init.lua backed up next to init.lua");
  // T435: the palette (and the watchlist.lua it loads) passes `rex config check`, via the sandbox init.lua.
  const cfg = await run(REX, ["config", "check", "--json", join(SB, ".config/rex/init.lua")], { env }).then((r) => r.stdout, (e) => e.stdout ?? "");
  const cfgJson = JSON.parse(cfg.slice(cfg.search(/^\{/m)) || "{}");
  const actionNames = (cfgJson.actions ?? []).map((a) => (typeof a === "string" ? a : a.name)).sort().join(",");
  check((cfgJson.diagnostics ?? []).length === 0, `rex config check of the sandbox init.lua: no complaints ${JSON.stringify(cfgJson.diagnostics ?? [])}`);
  check(actionNames === "bot_watch_list,bot_watch_pane_toggle,bot_watch_toggle", `palette actions: ${actionNames}`);
  for (const root of [".claude", ".agents"]) {
    const skill = await readFile(join(SB, root, "skills/rex-grokbot/SKILL.md"), "utf8").catch(() => "");
    check(skill.includes("installed-by: rex-grokbot-bridge"), `skill installed in ${root}`);
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
  // launchd isn't sandboxed by HOME: if this Mac already runs the real services, doctor (rightly) sees them.
  for (const [id, label] of [["service_bridge", "com.rexgrokbotbridge.bridge"], ["service_watch", "com.rexgrokbotbridge.watch"]]) {
    const realLoaded = await run("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`]).then(() => true, () => false);
    if (realLoaded) check(level[id] === "ok" || level[id] === "fail", `doctor ${id}: this Mac's real ${label} is loaded, so doctor reports it (${level[id]})`);
    else check(level[id] === "warn", `doctor ${id} skipped (warn)`);
  }
  check(level.serve === "warn", "doctor serve skipped (warn)");
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

  // T431: no OAuth discovery on the bridge's origin; /mcp is a plain bearer check.
  const B = `http://127.0.0.1:${PORT}`;
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource", "/.well-known/openid-configuration"]) {
    const r = await fetch(B + path);
    const body = await r.text();
    check(r.status === 404 && body === '{"error":"not found"}' && !r.headers.get("www-authenticate"), `GET ${path} → ${r.status} ${body}`);
  }
  const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
  const mcpPost = (auth) =>
    fetch(`${B}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
      body: initBody,
    });
  const noTok = await mcpPost();
  check(noTok.status === 401 && noTok.headers.get("www-authenticate") === 'Bearer realm="rex-grokbot-bridge"', `POST /mcp without a token → ${noTok.status} (WWW-Authenticate: ${noTok.headers.get("www-authenticate")})`);
  check((await mcpPost("Bearer wrong-token")).status === 401, "POST /mcp with a wrong token → 401");
  const withTok = await mcpPost(`Bearer ${token}`);
  check(withTok.status === 200, `POST /mcp with the sandbox token → ${withTok.status}`);
  const sp443 = await cli(["config", "set", "servePort", "443"]);
  check(sp443.code === 1 && /own origin/.test(sp443.stderr), `config set servePort 443 refused: ${sp443.stderr.trim()}`);
  check((await cli(["config", "get", "servePort"])).stdout.trim() === "8443", "servePort defaults to 8443");
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
  await writeFile(join(stateDir, "watched"), "", { mode: 0o644 }); // a loosened file: watch add must make it 600 again
  await chmod(join(stateDir, "watched"), 0o644);
  const add = await cli(["watch", "add", watchedS.session_id]);
  check(add.stdout.startsWith("watching"), `rex-grokbot watch add: ${add.stdout.trim()}`);
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
  check(say.code === 0 && /sent/.test(say.stderr), `rex-grokbot say: ${say.stderr.trim()}`);
  const msg = await waitFor((r) => r.body?.event === "agent_message", 3000);
  check(msg?.body.text === "hello from the sandbox" && msg.body.rex_session === watchedS.session_id, "sink got agent_message");
  const notifyLog = await readFile(join(SB, "Library/Logs/rex-grokbot-bridge/notify.log"), "utf8").catch(() => "");
  check(notifyLog.includes("http=200") && !notifyLog.includes(KEY) && !notifyLog.includes("e2e-sink-path"), "notify.log has status codes only");

  // Unwatched during the watcher's debounce: nothing is sent.
  const t0 = Date.now();
  await run(REX, ["send", "-s", watchedS.session_id, "-b", watchedS.block_id, "--", "printf '\\033]7501;state=blocked:app=e2e-debounce\\033\\\\'\n"]);
  const rm = await cli(["watch", "remove", watchedS.session_id]);
  check(rm.stdout.startsWith("no longer watching") && Date.now() - t0 < 2500, `unwatched within the 3s debounce (${Date.now() - t0}ms): ${rm.stdout.trim()}`);
  await sleep(6000);
  check(!received.some((r) => r.body?.app === "e2e-debounce"), "no agent_status after the session was unwatched mid-debounce");

  // ---- 4b. pane-level watch (T435): one session, two panes, only pane A watched ----
  const paneS = await mk(`e2e-sandbox-${tag}-panes`);
  const sid = paneS.session_id;
  const paneA = paneS.block_id;
  const runB = await run(REX, ["run", "-s", sid, "-c", SB, "--focus=false", "--json", "--", process.env.SHELL || "/bin/zsh", "-l"]);
  const paneB = JSON.parse(runB.stdout).block_ids?.[0];
  check(!!paneB && paneB !== paneA, `second pane (another window) in the same session: ${paneB}`);
  const addA = await cli(["watch", "add", paneA]);
  check(addA.stdout.startsWith("watching pane"), `watch add <pane A>: ${addA.stdout.trim()}`);
  const wl = await cli(["watch", "list"], { env: { REX_SERVER: env.REX_SERVER } });
  console.log(wl.stdout.trim());
  check(new RegExp(`^pane +${paneA}`, "m").test(wl.stdout) && !wl.stdout.includes(sid) && !wl.stdout.includes(paneB), "watch list: pane A only");
  await sleep(1500); // let the shells start
  const osc = (block, app, state = "done") => run(REX, ["send", "-s", sid, "-b", block, "--", `printf '\\033]7501;state=${state}:app=${app}\\033\\\\'\n`]);
  await osc(paneA, "e2e-paneA");
  await osc(paneB, "e2e-paneB");
  const gotA = await waitFor((r) => r.body?.event === "agent_status" && r.body.app === "e2e-paneA", 20_000);
  check(gotA?.body.rex_block === paneA && gotA?.body.rex_session === sid, "OSC 7501 done in watched pane A reached the sink");
  await sleep(5000);
  check(!received.some((r) => r.body?.app === "e2e-paneB"), "OSC 7501 done in pane B (same session, not watched) did not");

  const sayB = await cli(["say", "from pane B"], { env: { REX_SESSION: sid, REX_BLOCK: paneB } });
  check(sayB.code === 0 && /not sent: this pane isn't watched/.test(sayB.stderr), `say from pane B: exit ${sayB.code}, ${sayB.stderr.trim()}`);
  const sayA = await cli(["say", "from pane A"], { env: { REX_SESSION: sid, REX_BLOCK: paneA } });
  check(sayA.code === 0 && /rex-grokbot: sent/.test(sayA.stderr), `say from pane A: ${sayA.stderr.trim()}`);
  check(!!(await waitFor((r) => r.body?.event === "agent_message" && r.body.text === "from pane A", 3000)), "sink got pane A's message");
  check(!received.some((r) => r.body?.text === "from pane B"), "sink never got pane B's message");
  const sayOut = await cli(["say", "from outside rex"]);
  check(sayOut.code === 0 && /not sent: not running inside a Rex pane/.test(sayOut.stderr), `say outside Rex: ${sayOut.stderr.trim()}`);

  const readB = await tool("read_pane", { block_id: paneB });
  check(readB.isError && readB.text.includes(`pane ${paneB}`) && /This Pane/.test(readB.text), `read_pane on pane B refused: ${readB.text.slice(0, 110)}…`);
  const readA = await tool("read_pane", { block_id: paneA });
  check(!readA.isError, `read_pane on pane A allowed ${readA.isError ? readA.text : ""}`);
  const closeS = await tool("close_session", { session_id: sid });
  check(closeS.isError && /A watched pane alone/.test(closeS.text), "close_session refused with only a pane watched");
  const spawnS = await tool("spawn_agent", { agent: "shell", cwd: SB, session_id: sid });
  check(spawnS.isError, "spawn_agent into that session refused with only a pane watched");
  const lw = JSON.parse((await tool("list_watched", {})).text);
  check(lw.panes.includes(paneA) && !lw.sessions.includes(sid), "list_watched: pane A under panes");

  // Now watch the whole session: pane B is allowed too.
  check((await cli(["watch", "add", sid])).stdout.startsWith("watching session"), "watch add <session>");
  const readB2 = await tool("read_pane", { block_id: paneB });
  check(!readB2.isError, `read_pane on pane B allowed once the session is watched ${readB2.isError ? readB2.text : ""}`);
  const sayB2 = await cli(["say", "from pane B again"], { env: { REX_SESSION: sid, REX_BLOCK: paneB } });
  check(/rex-grokbot: sent/.test(sayB2.stderr) && !!(await waitFor((r) => r.body?.text === "from pane B again", 3000)), "say from pane B sent once the session is watched");
  // The watcher only fires on a state change: B is already done, so go through working first.
  await osc(paneB, "e2e-paneB2", "working");
  await sleep(1000);
  await osc(paneB, "e2e-paneB2");
  check(!!(await waitFor((r) => r.body?.event === "agent_status" && r.body.app === "e2e-paneB2", 20_000)), "OSC 7501 done in pane B reaches the sink once the session is watched");
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
  check(!(await stat(join(SB, root, "skills/rex-grokbot")).catch(() => null)), `skill removed from ${root}`);
}
check(!!(await stat(join(SB, ".config/rex-grokbot-bridge/token")).catch(() => null)), "state dir kept without --purge");
check(!/Services stopped/.test(un.stdout), "uninstall did not touch launchd (no plists in the sandbox)");
const purge = await cli(["uninstall", "--yes", "--purge"]);
check(purge.code === 0 && !(await stat(join(SB, ".config/rex-grokbot-bridge")).catch(() => null)), "uninstall --purge deletes the state dir");
check((await readdir(join(SB, ".config/rex/rex-grokbot-backups")).catch(() => [])).length >= 2, "uninstall --purge keeps the init.lua backups");

// ---- 7. package: a copy of the repo with NO dist → npm pack (prepare must build it) → install → run ----
{
  const pkgVersion = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;
  const copy = join(SB, "repo-copy");
  const packDir = join(SB, "pack");
  const prefix = join(SB, "npm-prefix");
  await mkdir(packDir);
  // The files git would ship (tracked + untracked, not ignored): no dist/, no node_modules/.
  const files = (await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT })).stdout.split("\0").filter(Boolean);
  for (const f of files) {
    if (!(await stat(join(ROOT, f)).catch(() => null))?.isFile()) continue; // deleted in the work tree
    await mkdir(dirname(join(copy, f)), { recursive: true });
    await copyFile(join(ROOT, f), join(copy, f));
  }
  await symlink(join(ROOT, "node_modules"), join(copy, "node_modules"));
  check(!(await stat(join(copy, "dist")).catch(() => null)), "repo copy has no dist/ before npm pack");
  // Only this sandbox: never the real global prefix.
  const npmEnv = { ...process.env, npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix };
  delete npmEnv.npm_config_global;
  const packed = await run("npm", ["pack", "--pack-destination", packDir, "--loglevel=error"], { cwd: copy, env: npmEnv, timeout: 180_000 }).then(
    (r) => r.stdout.trim().split("\n").pop(),
    (e) => (console.log(e.stderr), null),
  );
  check(!!packed && !!(await stat(join(copy, "dist/cli/rex-grokbot.js")).catch(() => null)), `npm pack ran prepare (built dist/) and produced ${packed}`);
  for (const f of ["dist/cli/rex-grokbot.js"]) {
    const m = ((await stat(join(copy, f)).catch(() => null))?.mode ?? 0) & 0o777;
    check((m & 0o111) !== 0, `prepare's build left ${f} executable (mode ${m.toString(8)})`);
  }
  const listing = await run("tar", ["-tvzf", join(packDir, packed ?? "missing.tgz")]).then((r) => r.stdout, () => "");
  check(/^-rwx.* package\/dist\/cli\/rex-grokbot\.js$/m.test(listing), "the tarball has dist/cli/rex-grokbot.js with its exec bit");
  const inst = await run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", join(packDir, packed ?? "missing.tgz")], { env: npmEnv, timeout: 180_000 }).then(
    () => true,
    (e) => (console.log(e.stderr), false),
  );
  check(inst, `npm i -g --prefix <sandbox> ${packed}`);
  const bin = join(prefix, "bin/rex-grokbot");
  const ver = await run(bin, ["--version"]).then((r) => r.stdout.trim(), (e) => `error: ${e.message}`);
  check(ver === pkgVersion, `<prefix>/bin/rex-grokbot --version prints ${ver} (package.json ${pkgVersion})`);
  const binHelp = await run(bin, ["--help"]).then((r) => r.stdout, () => "");
  check(/^usage: rex-grokbot /.test(binHelp) && /^ {2}token /m.test(binHelp) && /^ {2}url /m.test(binHelp), "<prefix>/bin/rex-grokbot --help lists token and url");
  check((await readdir(join(prefix, "bin"))).join(",") === "rex-grokbot", "rex-grokbot is the only bin installed");
  const tokHome = await mkdtemp(join(SB, "tokhome-"));
  const noTok = await run(bin, ["token"], { env: { ...env, HOME: tokHome, XDG_CONFIG_HOME: join(tokHome, ".config") } }).then((r) => ({ code: 0, ...r }), (e) => e);
  check(noTok.code === 1 && /no token yet; run rex-grokbot setup/.test(noTok.stderr), "<prefix>/bin/rex-grokbot token (sandbox HOME, no token) exits 1 with the setup hint");
  await mkdir(join(tokHome, ".config/rex-grokbot-bridge"), { recursive: true, mode: 0o700 });
  await writeFile(join(tokHome, ".config/rex-grokbot-bridge/token"), "fake-e2e-token-not-a-secret\n", { mode: 0o600 });
  const binTok = await run(bin, ["token"], { env: { ...env, HOME: tokHome, XDG_CONFIG_HOME: join(tokHome, ".config") } }).then((r) => r.stdout, () => "");
  check(binTok === "fake-e2e-token-not-a-secret\n", "<prefix>/bin/rex-grokbot token (sandbox HOME) prints exactly the token line");
}

sink.close();
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"} (sandbox ${SB})`);
process.exit(failures ? 1 : 0);
