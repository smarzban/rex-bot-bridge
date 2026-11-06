import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.js";
import { resolvePaths } from "../src/paths.js";
import { childEnv, tempDir } from "./helpers.js";

const run = promisify(execFile);
const rexBotCli = join(import.meta.dirname, "../src/cli/rex-grokbot.ts");

test("resolvePaths: state under ~/.config/rex-grokbot-bridge, init.lua via REX_CONFIG > XDG > ~/.config", () => {
  const p = resolvePaths({ HOME: "/h" });
  assert.equal(p.stateDir, "/h/.config/rex-grokbot-bridge");
  assert.equal(p.tokenFile, "/h/.config/rex-grokbot-bridge/token");
  assert.equal(p.sharedFile, "/h/.config/rex-grokbot-bridge/shared");
  assert.equal(p.heartbeatFile, "/h/.config/rex-grokbot-bridge/heartbeat");
  assert.equal(p.configFile, "/h/.config/rex-grokbot-bridge/config.json");
  assert.equal(p.logsDir, "/h/Library/Logs/rex-grokbot-bridge");
  assert.equal(p.auditLog, "/h/.local/state/rex-grokbot-bridge/audit.log");
  assert.equal(p.rexInitLua, "/h/.config/rex/init.lua");
  assert.equal(resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "/x" }).rexInitLua, "/x/rex/init.lua");
  assert.equal(resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "/x", REX_CONFIG: "/r.lua" }).rexInitLua, "/r.lua");
  assert.equal(resolvePaths({ HOME: "/h", REX_GROKBOT_DIR: "/s" }).sharedFile, "/s/shared");
});

test("loadConfig: defaults, config.json, then env overrides; mode re-read per call", async () => {
  const home = await tempDir();
  const c = await loadConfig({ HOME: home });
  assert.deepEqual([c.host, c.port, c.rexBin, await c.getMode()], ["127.0.0.1", 7400, "rex", "shared"]);
  // Generic HOST/PORT are ignored.
  const g = await loadConfig({ HOME: home, HOST: "0.0.0.0", PORT: "80" });
  assert.deepEqual([g.host, g.port], ["127.0.0.1", 7400]);

  await mkdir(join(home, ".config/rex-grokbot-bridge"), { recursive: true });
  const cfgFile = join(home, ".config/rex-grokbot-bridge/config.json");
  await writeFile(cfgFile, JSON.stringify({ port: 7411, mode: "all" }));
  const f = await loadConfig({ HOME: home });
  assert.equal(f.port, 7411);
  assert.equal(await f.getMode(), "all");
  await writeFile(cfgFile, JSON.stringify({ port: 7411, mode: "shared" }));
  assert.equal(await f.getMode(), "shared", "mode is read per call");

  const e = await loadConfig({ HOME: home, REX_BRIDGE_HOST: "100.64.0.1", REX_BRIDGE_PORT: "8123", REX_BIN: "/opt/rex" });
  assert.deepEqual([e.host, e.port, e.rexBin], ["100.64.0.1", 8123, "/opt/rex"]);
  for (const p of ["abc", "0", "70000", "80.5"]) {
    await assert.rejects(loadConfig({ HOME: home, REX_BRIDGE_PORT: p }), /REX_BRIDGE_PORT/);
  }
});

async function cli(file: string, args: string[], env: Record<string, string>, input?: string) {
  const home = env.HOME ?? (await tempDir());
  const p = run(process.execPath, ["--import", "tsx", file, ...args], { env: childEnv({ ...env, HOME: home }) });
  if (input !== undefined) {
    p.child.stdin?.end(input);
  }
  return p.then(
    (r) => ({ ...r, code: 0 }),
    (e: { stdout: string; stderr: string; code: number }) => e,
  );
}

test("token: no token yet → stderr hint, exit 1, nothing on stdout, no file created", async () => {
  const home = await tempDir();
  const r = await cli(rexBotCli, ["token"], { HOME: home });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "rex-grokbot: no token yet; run rex-grokbot setup\n");
  await assert.rejects(stat(join(home, ".config/rex-grokbot-bridge/token")));
});

test("token: prints exactly the token line and nothing else; --show is gone", async () => {
  const home = await tempDir();
  const dir = join(home, ".config/rex-grokbot-bridge");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const fake = "fake-test-token-0123456789abcdefghijklmnopqrstu";
  await writeFile(join(dir, "token"), fake + "\n", { mode: 0o600 });
  const r = await cli(rexBotCli, ["token"], { HOME: home });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, `${fake}\n`, ""]);
  const s = await cli(rexBotCli, ["token", "--show"], { HOME: home });
  assert.equal(s.code, 2);
  assert.equal(s.stdout, "");
});

test("serve refuses to start without a token", async () => {
  const home = await tempDir();
  const r = await cli(rexBotCli, ["serve"], { HOME: home, REX_BRIDGE_PORT: "1" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no token at .*\.config\/rex-grokbot-bridge\/token/);
});

test("config set/get: secrets hidden unless --show, config.json is 600, stdin values", async () => {
  const home = await tempDir();
  const env = { HOME: home };
  const url = "https://hooks.example.test/secret-path-123";
  assert.equal((await cli(rexBotCli, ["config", "set", "webhook.url", url], env)).stdout, "webhook.url set\n");
  const k = await cli(rexBotCli, ["config", "set", "webhook.key", "-"], env, "sekrit-key-xyz\n");
  assert.equal(k.code, 0);
  const got = await cli(rexBotCli, ["config", "get", "webhook.url"], env);
  assert.ok(!got.stdout.includes(url));
  assert.match(got.stdout, /hidden/);
  assert.equal((await cli(rexBotCli, ["config", "get", "webhook.key", "--show"], env)).stdout, "sekrit-key-xyz\n");
  assert.equal((await cli(rexBotCli, ["config", "get", "mode"], env)).stdout, "shared\n");
  assert.equal((await cli(rexBotCli, ["config", "set", "mode", "bogus"], env)).code, 1);
  const cfg = join(home, ".config/rex-grokbot-bridge/config.json");
  assert.equal((await stat(cfg)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(cfg, "utf8")).webhook.key, "sekrit-key-xyz");
});

test("watch add/remove/list validates ids and edits the shared file", async () => {
  const home = await tempDir();
  // No rex binary: `share list` shows no labels and never reaches a Rex server.
  const env = { HOME: home, REX_BIN: join(home, "no-rex") };
  const id = "session:01a1a7e9-0000-7000-8000-000000000001";
  const pane = "block:01a1a7e9-0000-7000-8000-0000000000b1";
  assert.equal((await cli(rexBotCli, ["share", "add", "nope"], env)).code, 2);
  assert.equal((await cli(rexBotCli, ["share", "add", "window:01a1a7e9-0000"], env)).code, 2);
  assert.equal((await cli(rexBotCli, ["share", "add", id], env)).stdout, `sharing session ${id}\n`);
  assert.equal((await cli(rexBotCli, ["share", "add", id], env)).stdout, `already sharing session ${id}\n`);
  assert.equal((await cli(rexBotCli, ["share", "add", pane], env)).stdout, `sharing pane ${pane}\n`);
  assert.equal((await cli(rexBotCli, ["share", "list"], env)).stdout, `session ${id}\npane    ${pane}\n`);
  assert.equal((await cli(rexBotCli, ["share", "remove", id], env)).stdout, `no longer sharing session ${id}\n`);
  assert.equal((await cli(rexBotCli, ["share", "remove", pane], env)).stdout, `no longer sharing pane ${pane}\n`);
  assert.equal((await cli(rexBotCli, ["share", "list"], env)).stdout, "");
});

test("say exits 0 with a clear message when no webhook is configured", async () => {
  const home = await tempDir();
  const sid = "session:01a1a7e9-0000-7000-8000-000000000001";
  await mkdir(join(home, ".config/rex-grokbot-bridge"), { recursive: true });
  await writeFile(join(home, ".config/rex-grokbot-bridge/shared"), `${sid}\n`);
  const r = await cli(rexBotCli, ["say", "hello"], { HOME: home, REX_SESSION: sid, REX_BLOCK: "block:01a1a7e9-0000-7000-8000-0000000000b1" });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /no webhook configured/);
});

test("--help lists the subcommands", async () => {
  const r = await cli(rexBotCli, ["--help"], {});
  for (const c of ["setup", "doctor", "uninstall", "serve", "watch", "token", "url", "config", "say", "whoami", "notify"]) {
    assert.match(r.stdout, new RegExp(`^  ${c} `, "m"));
  }
  assert.ok(!/^ {2}grokbot /m.test(r.stdout), "grokbot is gone");
});

test("CLI subprocesses get a scratch env: inherited REX_*/XDG/token overrides never leak in", async () => {
  const env = childEnv({ HOME: "/tmp/x" });
  for (const k of Object.keys(env)) assert.ok(["PATH", "HOME", "TMPDIR"].includes(k), `unexpected ${k}`);
  const home = await tempDir();
  const saved = { ...process.env };
  process.env.REX_BRIDGE_TOKEN_FILE = join(home, "leaked-token");
  process.env.XDG_CONFIG_HOME = join(home, "leaked-xdg");
  process.env.REX_GROKBOT_DIR = join(home, "leaked-dir");
  try {
    // Plain `token`, never --rotate here: the CLI uses the real launchctl, and --rotate would restart this
    // Mac's real bridge service (rotation is covered with a fake launchctl in credentials.test.ts).
    await mkdir(join(home, ".config/rex-grokbot-bridge"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".config/rex-grokbot-bridge/token"), "fake-scratch-env-token\n", { mode: 0o600 });
    const r = await cli(rexBotCli, ["token"], { HOME: home });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "fake-scratch-env-token\n");
    await assert.rejects(stat(join(home, "leaked-token")));
  } finally {
    for (const k of ["REX_BRIDGE_TOKEN_FILE", "XDG_CONFIG_HOME", "REX_GROKBOT_DIR"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("T435: `watch` only runs the watcher; sharing is `share add|remove|list` (no alias)", async () => {
  const home = await tempDir();
  const env = { HOME: home, REX_BIN: join(home, "no-rex") };
  const r = await cli(rexBotCli, ["watch", "add", "session:01a1a7e9-0000-7000-8000-000000000001"], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /rex-grokbot share add\|remove\|list/);
  assert.equal((await cli(rexBotCli, ["share", "list"], env)).code, 0);
});
