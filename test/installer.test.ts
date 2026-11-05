import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { renderPlist, serviceSpecs, xmlEscape } from "../src/launchd.js";
import { authHeaders, enrich, postWebhook } from "../src/notify.js";
import { resolvePaths } from "../src/paths.js";
import type { Runner } from "../src/rex.js";
import {
  BLOCK_END,
  BLOCK_START,
  hasLegacyInline,
  inspectBlock,
  installBlock,
  luaString,
  removeBlock,
  renderBlock,
  uninstallBlock,
  upsertBlock,
} from "../src/rexconfig.js";
import { readSettings, setKey, writeSettings, DEFAULTS } from "../src/settings.js";
import { migrateWatched } from "../src/setup.js";
import { installSkills, uninstallSkills, SKILL_MARKER } from "../src/skills.js";
import { serveTarget } from "../src/tailscale.js";
import { childEnv, tempDir } from "./helpers.js";

const execFileP = promisify(execFile);

// ---------- settings ----------

test("settings: write creates dir 700 and file 600; read merges defaults", async () => {
  const dir = join(await tempDir(), "state");
  const file = join(dir, "config.json");
  assert.deepEqual(await readSettings(file), DEFAULTS);
  await writeSettings(file, setKey(DEFAULTS, "mode", "full"));
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // A loosened file goes back to 600 on the next write.
  await chmod(file, 0o644);
  await writeSettings(file, setKey(await readSettings(file), "port", "7412"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const s = await readSettings(file);
  assert.equal(s.mode, "full");
  assert.equal(s.port, 7412);
  assert.equal(s.servePath, "/rex-bridge");
});

test("settings: setKey validates", () => {
  assert.throws(() => setKey(DEFAULTS, "mode", "admin"), /mode must be/);
  assert.throws(() => setKey(DEFAULTS, "port", "99999"), /port/);
  assert.throws(() => setKey(DEFAULTS, "webhook.url", "ftp://x"), /https/);
  assert.throws(() => setKey(DEFAULTS, "webhook.header", "Bad Header"), /header/);
  assert.throws(() => setKey(DEFAULTS, "servePath", "no-slash"), /servePath/);
  assert.equal(setKey(setKey(DEFAULTS, "webhook.key", "k"), "webhook.key", "").webhook.key, undefined);
});

// ---------- init.lua block ----------

const ACTIONS = "/Users/Some One/lib/node_modules/rex-bot-bridge/lua/rex-bot-actions.lua";

test("init.lua block: insert into empty/existing, replace in place, remove restores the original", () => {
  const block = renderBlock(ACTIONS);
  assert.equal(block, `${BLOCK_START}\ndofile("${ACTIONS}")\n${BLOCK_END}\n`);
  assert.equal(upsertBlock("", block), block);

  const user = 'rex.bind("cmd+k", "pane.split")\n';
  const withBlock = upsertBlock(user, block);
  assert.equal(withBlock, `${user}\n${block}`);
  assert.equal(removeBlock(withBlock), user);

  // Replace keeps surrounding user code byte-for-byte.
  const sandwich = `-- top\n${renderBlock("/old/path.lua")}-- bottom\n`;
  const replaced = upsertBlock(sandwich, block);
  assert.equal(replaced, `-- top\n${block}-- bottom\n`);
  assert.equal(upsertBlock(replaced, block), replaced, "idempotent");
  assert.equal(removeBlock(replaced), "-- top\n-- bottom\n");

  assert.throws(() => upsertBlock(`${BLOCK_START}\nno end`, block), /without/);
});

test("init.lua block: Lua string escaping and legacy inline detection", () => {
  assert.equal(luaString('/a "b"\\c'), '"/a \\"b\\"\\\\c"');
  assert.throws(() => luaString("/a\nb"), /control/);
  const legacy = 'rex.action{\n  name = "bot_watch_toggle",\n  title = "x",\n}\n';
  assert.equal(hasLegacyInline(legacy), true);
  assert.equal(hasLegacyInline(renderBlock(ACTIONS)), false);
  assert.equal(hasLegacyInline("-- nothing\n"), false);
});

/** Fake `rex config check`: fails when the file contains FAIL_MARK. Records calls. */
function fakeRex(calls: string[][] = []): Runner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "config" && args[1] === "check") {
      const content = await readFile(args[2]!, "utf8");
      return content.includes("FAIL_MARK")
        ? { stdout: "", stderr: "error init.lua:3: boom\nError: the configuration has errors\n", code: 1 }
        : { stdout: "actions: 2\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

test("init.lua install: backs up, writes, checks with `rex config check <path>`, idempotent, then removes", async () => {
  const dir = await tempDir();
  const initPath = join(dir, "rex/init.lua");
  const backupsDir = join(dir, "backups");
  await mkdir(join(dir, "rex"));
  const original = "-- my config\n";
  await writeFile(initPath, original);
  const calls: string[][] = [];
  const rex = fakeRex(calls);

  const r1 = await installBlock({ initPath, backupsDir, rex, actionsPath: ACTIONS });
  assert.equal(r1.status, "installed");
  assert.deepEqual(calls.at(-1), ["config", "check", initPath]);
  assert.ok("backup" in r1 && r1.backup);
  assert.equal(await readFile((r1 as { backup: string }).backup, "utf8"), original);
  assert.equal(await readFile(initPath, "utf8"), `${original}\n${renderBlock(ACTIONS)}`);
  assert.deepEqual(await inspectBlock(initPath), { present: true, actionsPath: ACTIONS, legacy: false });

  assert.equal((await installBlock({ initPath, backupsDir, rex, actionsPath: ACTIONS })).status, "unchanged");

  const r3 = await uninstallBlock({ initPath, backupsDir, rex });
  assert.equal(r3.status, "removed");
  assert.equal(await readFile(initPath, "utf8"), original);
  assert.equal((await uninstallBlock({ initPath, backupsDir, rex })).status, "absent");
  assert.equal((await readdir(backupsDir)).length >= 2, true);
});

test("init.lua install: restores the previous file when rex config check fails", async () => {
  const dir = await tempDir();
  const initPath = join(dir, "init.lua");
  // The fake check fails once FAIL_MARK is in the file, i.e. only after our edit (it is in the actions path).
  const good = "-- fine\n";
  await writeFile(initPath, good);
  const r = await installBlock({ initPath, backupsDir: join(dir, "b"), rex: fakeRex(), actionsPath: "/x/FAIL_MARK.lua" });
  assert.equal(r.status, "check-failed");
  assert.match((r as { detail: string }).detail, /boom/);
  assert.equal(await readFile(initPath, "utf8"), good, "previous file restored");
});

test("init.lua install: a missing init.lua is created, and deleted again if the check fails", async () => {
  const dir = await tempDir();
  const initPath = join(dir, "rex/init.lua");
  const ok = await installBlock({ initPath, backupsDir: join(dir, "b"), rex: fakeRex(), actionsPath: ACTIONS });
  assert.equal(ok.status, "installed");
  assert.equal(await readFile(initPath, "utf8"), renderBlock(ACTIONS));

  const initPath2 = join(dir, "rex2/init.lua");
  const bad = await installBlock({ initPath: initPath2, backupsDir: join(dir, "b"), rex: fakeRex(), actionsPath: "/FAIL_MARK" });
  assert.equal(bad.status, "check-failed");
  await assert.rejects(readFile(initPath2));
});

test("init.lua install: refuses to add the block when v1 actions are defined inline", async () => {
  const dir = await tempDir();
  const initPath = join(dir, "init.lua");
  const legacy = 'rex.action{ name = "bot_watch_list", title = "x", run = function() end }\n';
  await writeFile(initPath, legacy);
  const calls: string[][] = [];
  const r = await installBlock({ initPath, backupsDir: join(dir, "b"), rex: fakeRex(calls), actionsPath: ACTIONS });
  assert.equal(r.status, "legacy-inline");
  assert.equal(await readFile(initPath, "utf8"), legacy, "user code untouched");
  assert.equal(calls.length, 0);
});

// ---------- launchd ----------

test("plists: paths with spaces and XML specials are escaped and pass plutil -lint", async () => {
  const home = join(await tempDir(), "Some One & Co");
  const paths = resolvePaths({ HOME: home });
  const rexBin = "/Users/x/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex";
  const specs = serviceSpecs({
    paths,
    node: "/opt/node <22>/bin/node",
    cli: "/lib/node_modules/rex-bot-bridge/dist/cli/rex-grokbot.js",
    rexBin,
    pkgRoot: "/lib/node_modules/rex-bot-bridge",
    rexServer: "unix:///Users/x/Library/Application%20Support/rex/server.sock",
  });
  assert.equal(specs.watch.env.REX_SERVER, "unix:///Users/x/Library/Application%20Support/rex/server.sock");
  assert.deepEqual(specs.bridge.programArguments.slice(1), ["/lib/node_modules/rex-bot-bridge/dist/cli/rex-grokbot.js", "serve"]);
  assert.deepEqual(specs.watch.programArguments.slice(1), ["/lib/node_modules/rex-bot-bridge/dist/cli/rex-grokbot.js", "watch"]);
  assert.equal(specs.bridge.env.REX_BIN, rexBin);
  assert.ok(specs.bridge.env.PATH!.startsWith(rexBin.replace(/\/rex$/, "") + ":"));
  assert.equal(specs.watch.log, join(home, "Library/Logs/rex-bot-bridge/watch.log"));

  const outDir = await tempDir();
  for (const spec of Object.values(specs)) {
    const xml = await renderPlist(spec);
    assert.ok(xml.includes(`<string>${xmlEscape(rexBin)}</string>`));
    assert.ok(xml.includes("Some One &amp; Co"));
    assert.ok(xml.includes("/opt/node &lt;22&gt;/bin/node"));
    assert.ok(xml.includes("<key>KeepAlive</key>\n  <true/>"));
    assert.ok(xml.includes("<integer>15</integer>"));
    const file = join(outDir, `${spec.label}.plist`);
    await writeFile(file, xml);
    const lint = await execFileP("/usr/bin/plutil", ["-lint", file]);
    assert.match(lint.stdout, /OK/);
    const json = JSON.parse((await execFileP("/usr/bin/plutil", ["-convert", "json", "-o", "-", file])).stdout);
    assert.equal(json.EnvironmentVariables.REX_BIN, rexBin);
    assert.equal(json.ProgramArguments[0], "/opt/node <22>/bin/node");
    assert.equal(json.WorkingDirectory, "/lib/node_modules/rex-bot-bridge");
  }
});

// ---------- notify ----------

test("notify: auth header variants", () => {
  assert.deepEqual(authHeaders({ url: "u" }), {});
  assert.deepEqual(authHeaders({ url: "u", key: "k1" }), { Authorization: "Bearer k1" });
  assert.deepEqual(authHeaders({ url: "u", key: "k1", header: "Authorization" }), { Authorization: "Bearer k1" });
  assert.deepEqual(authHeaders({ url: "u", key: "k1", header: "X-Webhook-Key" }), { "X-Webhook-Key": "k1" });
});

test("notify: enrich adds source/host/timestamp and truncates long strings", () => {
  const e = enrich({ event: "x", text: "a".repeat(3000), source: "custom" });
  assert.equal(e.source, "custom");
  assert.ok(typeof e.host === "string" && typeof e.timestamp === "string");
  assert.equal((e.text as string).length, 2003);
});

async function sink() {
  const got: { headers: Record<string, unknown>; body: string }[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      res.writeHead(status).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    got,
    setStatus: (s: number) => (status = s),
    url: `http://127.0.0.1:${port}/hooks/SECRET-PATH-abc`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("notify: posts JSON with the right header; the log and result never contain the URL or key", async () => {
  const s = await sink();
  const log = join(await tempDir(), "notify.log");
  const KEY = "fixture-key-1"; // not a secret: test fixture
  try {
    const r1 = await postWebhook({ url: s.url, key: KEY }, { event: "agent_status" }, { logFile: log });
    assert.deepEqual(r1, { ok: true, status: 200 });
    assert.equal(s.got[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(s.got[0]!.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(s.got[0]!.body), { event: "agent_status" });

    const r2 = await postWebhook({ url: s.url, key: KEY, header: "X-Webhook-Key" }, { event: "e2" }, { logFile: log });
    assert.equal(r2.status, 200);
    assert.equal(s.got[1]!.headers["x-webhook-key"], KEY);
    assert.equal(s.got[1]!.headers.authorization, undefined);

    s.setStatus(500);
    const r3 = await postWebhook({ url: s.url, key: KEY }, { event: "e3" }, { logFile: log });
    assert.deepEqual(r3, { ok: false, status: 500 });

    const dead = await postWebhook({ url: "http://127.0.0.1:1/SECRET-PATH-abc", key: KEY }, { event: "e4" }, { logFile: log });
    assert.equal(dead.ok, false);
    assert.equal(dead.status, 0);

    const none = await postWebhook({}, { event: "e5" }, { logFile: log });
    assert.equal(none.reason, "not configured");

    const logText = await readFile(log, "utf8");
    assert.match(logText, /event=agent_status http=200/);
    assert.match(logText, /event=e3 http=500/);
    for (const text of [logText, JSON.stringify([r1, r2, r3, dead, none])]) {
      assert.ok(!text.includes("SECRET-PATH"), "URL leaked");
      assert.ok(!text.includes(KEY), "key leaked");
    }
  } finally {
    await s.close();
  }
});

test("notify/say CLI: stdout and stderr never contain the URL or key", async () => {
  const s = await sink();
  const home = await tempDir();
  const KEY = "fixture-key-2"; // not a secret: test fixture
  const cli = join(import.meta.dirname, "../src/cli/rex-grokbot.ts");
  const env = childEnv({ HOME: home, REX_SESSION: "session:test", REX_BLOCK: "block:test" });
  const runCli = (args: string[], input?: string) => {
    const p = execFileP(process.execPath, ["--import", "tsx", cli, ...args], { env });
    if (input !== undefined) p.child.stdin?.end(input);
    return p.then((r) => ({ ...r, code: 0 }), (e: { stdout: string; stderr: string; code: number }) => e);
  };
  try {
    await runCli(["config", "set", "webhook.url", s.url]);
    await runCli(["config", "set", "webhook.key", KEY]);
    const n = await runCli(["notify"], JSON.stringify({ event: "agent_status", state: "done" }));
    assert.equal(n.code, 0);
    assert.equal(n.stdout.trim(), "HTTP 200");
    const say = await runCli(["say", "PR", "#12", "ready"]);
    assert.equal(say.code, 0);
    assert.match(say.stderr, /sent/);
    const body = JSON.parse(s.got[1]!.body);
    assert.equal(body.event, "agent_message");
    assert.equal(body.text, "PR #12 ready");
    assert.equal(body.rex_session, "session:test");
    assert.equal(body.source, "rex");
    assert.ok(body.host && body.timestamp && body.cwd);
    s.setStatus(503);
    const failed = await runCli(["say", "x"]);
    assert.equal(failed.code, 0, "say never fails the caller");
    assert.match(failed.stderr, /HTTP 503/);
    for (const r of [n, say, failed]) {
      assert.ok(!(r.stdout + r.stderr).includes("SECRET-PATH"));
      assert.ok(!(r.stdout + r.stderr).includes(KEY));
    }
    const log = await readFile(join(home, "Library/Logs/rex-bot-bridge/notify.log"), "utf8");
    assert.ok(!log.includes("SECRET-PATH") && !log.includes(KEY));
  } finally {
    await s.close();
  }
});

// ---------- migration ----------

test("migration: imports v1 ids into watched, keeps existing entries, leaves the old file", async () => {
  const dir = await tempDir();
  const legacy = join(dir, "sessions");
  const watched = join(dir, "state/watched");
  const v1 = "# v1\nsession:aaaa0000-0001 # main\n\nsession:bbbb0000-0002\n";
  await writeFile(legacy, v1);
  await mkdir(join(dir, "state"));
  await writeFile(watched, "session:bbbb0000-0002\n");
  assert.deepEqual(await migrateWatched(legacy, watched), ["session:aaaa0000-0001"]);
  assert.equal(await readFile(watched, "utf8"), "session:bbbb0000-0002\nsession:aaaa0000-0001\n");
  assert.equal(await readFile(legacy, "utf8"), v1);
  assert.deepEqual(await migrateWatched(legacy, watched), [], "idempotent");
  assert.deepEqual(await migrateWatched(join(dir, "missing"), watched), []);
});

// ---------- skills ----------

test("skills: installed only under existing roots; uninstall removes only ours", async () => {
  const home = await tempDir();
  const claude = join(home, ".claude");
  const agents = join(home, ".agents");
  await mkdir(claude);
  const r = await installSkills([claude, agents]);
  assert.deepEqual(r.installed, [join(claude, "skills/rex-grokbot/SKILL.md")]);
  assert.equal(r.skipped.length, 1);
  assert.ok((await readFile(r.installed[0]!, "utf8")).includes(SKILL_MARKER));

  // Someone else's rex-grokbot skill is never overwritten or removed.
  await mkdir(join(agents, "skills/rex-grokbot"), { recursive: true });
  await writeFile(join(agents, "skills/rex-grokbot/SKILL.md"), "---\nname: rex-grokbot\n---\nmine\n");
  const r2 = await installSkills([claude, agents]);
  assert.equal(r2.skipped.find((s) => s.path.startsWith(agents))?.reason.includes("not written by"), true);
  assert.deepEqual(await uninstallSkills([claude, agents]), [join(claude, "skills/rex-grokbot/SKILL.md")]);
  assert.equal(await readFile(join(agents, "skills/rex-grokbot/SKILL.md"), "utf8"), "---\nname: rex-grokbot\n---\nmine\n");
  await assert.rejects(stat(join(claude, "skills/rex-grokbot")));
});

// ---------- tailscale ----------

test("tailscale: serveTarget reads the :443 handler for the path", async () => {
  const status = { Web: { "mac.tail.ts.net:443": { Handlers: { "/rex-bridge": { Proxy: "http://127.0.0.1:7400" } } } } };
  const ts: Runner = async () => ({ stdout: JSON.stringify(status), stderr: "", code: 0 });
  assert.deepEqual(await serveTarget(ts, "/rex-bridge"), { kind: "occupied", target: "http://127.0.0.1:7400" });
  assert.deepEqual(await serveTarget(ts, "/other"), { kind: "absent" });
  const empty: Runner = async () => ({ stdout: "{}", stderr: "", code: 0 });
  assert.deepEqual(await serveTarget(empty, "/rex-bridge"), { kind: "absent" });
});

test("launchd uninstall: only boots out services whose plist is in this HOME", async () => {
  const { uninstallServices, installServices, LABELS } = await import("../src/launchd.js");
  const home = await tempDir();
  const paths = resolvePaths({ HOME: home });
  const calls: string[][] = [];
  const launchctl: Runner = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "", code: args[0] === "print" ? 113 : 0 };
  };
  assert.deepEqual(await uninstallServices(paths, launchctl), []);
  assert.equal(calls.length, 0, "no launchctl calls without our plists");

  await installServices({ paths, node: "/n", cli: "/c.js", rexBin: "/r/rex", pkgRoot: "/p" }, launchctl, { sleep: async () => {} });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["bootout", "print", "bootstrap", "bootout", "print", "bootstrap"],
  );
  assert.equal(calls[2]![2], join(home, `Library/LaunchAgents/${LABELS.bridge}.plist`));
  calls.length = 0;
  assert.deepEqual(await uninstallServices(paths, launchctl), [LABELS.bridge, LABELS.watch]);
  assert.deepEqual(calls.map((c) => c[0]), ["bootout", "bootout"]);
  await assert.rejects(stat(join(home, `Library/LaunchAgents/${LABELS.bridge}.plist`)));
});
