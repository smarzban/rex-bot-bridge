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
const bridgeCli = join(import.meta.dirname, "../src/cli/bridge.ts");
const rexBotCli = join(import.meta.dirname, "../src/cli/rex-bot.ts");

test("resolvePaths: state under ~/.config/rex-bot-bridge, init.lua via REX_CONFIG > XDG > ~/.config", () => {
  const p = resolvePaths({ HOME: "/h" });
  assert.equal(p.stateDir, "/h/.config/rex-bot-bridge");
  assert.equal(p.tokenFile, "/h/.config/rex-bot-bridge/token");
  assert.equal(p.watchedFile, "/h/.config/rex-bot-bridge/watched");
  assert.equal(p.heartbeatFile, "/h/.config/rex-bot-bridge/heartbeat");
  assert.equal(p.configFile, "/h/.config/rex-bot-bridge/config.json");
  assert.equal(p.logsDir, "/h/Library/Logs/rex-bot-bridge");
  assert.equal(p.auditLog, "/h/.local/state/rex-bot-bridge/audit.log");
  assert.equal(p.rexInitLua, "/h/.config/rex/init.lua");
  assert.equal(p.legacyWatchedFile, "/h/.config/rex/bot-watch/sessions");
  assert.equal(resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "/x" }).rexInitLua, "/x/rex/init.lua");
  assert.equal(resolvePaths({ HOME: "/h", XDG_CONFIG_HOME: "/x", REX_CONFIG: "/r.lua" }).rexInitLua, "/r.lua");
  assert.equal(resolvePaths({ HOME: "/h", REX_BOT_DIR: "/s" }).watchedFile, "/s/watched");
});

test("loadConfig: defaults, config.json, then env overrides; mode re-read per call", async () => {
  const home = await tempDir();
  const c = await loadConfig({ HOME: home });
  assert.deepEqual([c.host, c.port, c.rexBin, await c.getMode()], ["127.0.0.1", 7400, "rex", "watched"]);
  // Generic HOST/PORT are ignored.
  const g = await loadConfig({ HOME: home, HOST: "0.0.0.0", PORT: "80" });
  assert.deepEqual([g.host, g.port], ["127.0.0.1", 7400]);

  await mkdir(join(home, ".config/rex-bot-bridge"), { recursive: true });
  const cfgFile = join(home, ".config/rex-bot-bridge/config.json");
  await writeFile(cfgFile, JSON.stringify({ port: 7411, mode: "full" }));
  const f = await loadConfig({ HOME: home });
  assert.equal(f.port, 7411);
  assert.equal(await f.getMode(), "full");
  await writeFile(cfgFile, JSON.stringify({ port: 7411, mode: "watched" }));
  assert.equal(await f.getMode(), "watched", "mode is read per call");

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

test("token: prints only the path; the token only with --show; dir 700 + file 600", async () => {
  const home = await tempDir();
  const env = { HOME: home };
  const file = join(home, ".config/rex-bot-bridge/token");

  const created = await cli(bridgeCli, ["token"], env);
  const token = (await readFile(file, "utf8")).trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.stdout, `created: ${file}\n`);
  assert.ok(!created.stdout.includes(token) && !created.stderr.includes(token));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, ".config/rex-bot-bridge"))).mode & 0o777, 0o700);

  assert.equal((await cli(rexBotCli, ["token"], env)).stdout, `exists: ${file}\n`);
  assert.equal((await cli(rexBotCli, ["token", "--show"], env)).stdout, `exists: ${file}\n${token}\n`);

  const rotated = await cli(bridgeCli, ["token", "--rotate"], env);
  const newToken = (await readFile(file, "utf8")).trim();
  assert.notEqual(newToken, token);
  assert.equal(rotated.stdout, `rotated: ${file}\n`);
  assert.ok(!rotated.stdout.includes(newToken));
});

test("serve refuses to start without a token", async () => {
  const home = await tempDir();
  const r = await cli(bridgeCli, ["serve"], { HOME: home, REX_BRIDGE_PORT: "1" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no token at .*\.config\/rex-bot-bridge\/token/);
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
  assert.equal((await cli(rexBotCli, ["config", "get", "mode"], env)).stdout, "watched\n");
  assert.equal((await cli(rexBotCli, ["config", "set", "mode", "bogus"], env)).code, 1);
  const cfg = join(home, ".config/rex-bot-bridge/config.json");
  assert.equal((await stat(cfg)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(cfg, "utf8")).webhook.key, "sekrit-key-xyz");
});

test("watch add/remove/list validates ids and edits the watched file", async () => {
  const home = await tempDir();
  const env = { HOME: home };
  const id = "session:01a1a7e9-0000-7000-8000-000000000001";
  assert.equal((await cli(rexBotCli, ["watch", "add", "nope"], env)).code, 2);
  assert.equal((await cli(rexBotCli, ["watch", "add", id], env)).stdout, `watching ${id}\n`);
  assert.equal((await cli(rexBotCli, ["watch", "add", id], env)).stdout, `already watching ${id}\n`);
  assert.equal((await cli(rexBotCli, ["watch", "list"], env)).stdout, `${id}\n`);
  assert.equal((await cli(rexBotCli, ["watch", "remove", id], env)).stdout, `no longer watching ${id}\n`);
  assert.equal((await cli(rexBotCli, ["watch", "list"], env)).stdout, "");
});

test("say exits 0 with a clear message when no webhook is configured", async () => {
  const home = await tempDir();
  const r = await cli(rexBotCli, ["say", "hello"], { HOME: home });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /no webhook configured/);
});

test("--help lists the subcommands", async () => {
  const r = await cli(rexBotCli, ["--help"], {});
  for (const c of ["setup", "doctor", "uninstall", "serve", "watch", "token", "config", "say", "whoami", "notify", "grokbot"]) {
    assert.match(r.stdout, new RegExp(`rex-bot ${c}`));
  }
});

test("CLI subprocesses get a scratch env: inherited REX_*/XDG/token overrides never leak in", async () => {
  const env = childEnv({ HOME: "/tmp/x" });
  for (const k of Object.keys(env)) assert.ok(["PATH", "HOME", "TMPDIR"].includes(k), `unexpected ${k}`);
  const home = await tempDir();
  const saved = { ...process.env };
  process.env.REX_BRIDGE_TOKEN_FILE = join(home, "leaked-token");
  process.env.XDG_CONFIG_HOME = join(home, "leaked-xdg");
  process.env.REX_BOT_DIR = join(home, "leaked-dir");
  try {
    const r = await cli(rexBotCli, ["token", "--rotate"], { HOME: home });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `rotated: ${join(home, ".config/rex-bot-bridge/token")}\n`);
    await assert.rejects(stat(join(home, "leaked-token")));
  } finally {
    for (const k of ["REX_BRIDGE_TOKEN_FILE", "XDG_CONFIG_HOME", "REX_BOT_DIR"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
