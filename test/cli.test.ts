import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.js";
import { tempDir } from "./helpers.js";

const run = promisify(execFile);
const bridgeCli = join(import.meta.dirname, "../src/cli/bridge.ts");

test("loadConfig defaults to 127.0.0.1:7400 and paths under HOME", () => {
  const c = loadConfig({ HOME: "/h" });
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 7400);
  assert.equal(c.tokenFile, "/h/.config/rex-bot-bridge/token");
  assert.equal(c.watchSessionsFile, "/h/.config/rex/bot-watch/sessions");
  assert.equal(c.watchHeartbeatFile, "/h/.config/rex/bot-watch/heartbeat");
  assert.equal(c.auditLog, "/h/.local/state/rex-bot-bridge/audit.log");
  assert.equal(c.rexBin, "rex");
});

test("loadConfig ignores generic HOST/PORT and honours the bridge env overrides", () => {
  assert.equal(loadConfig({ HOME: "/h", HOST: "0.0.0.0", PORT: "80" }).host, "127.0.0.1");
  assert.equal(loadConfig({ HOME: "/h", HOST: "0.0.0.0", PORT: "80" }).port, 7400);
  const c = loadConfig({
    HOME: "/h",
    REX_BRIDGE_HOST: "100.64.0.1",
    REX_BRIDGE_PORT: "8123",
    REX_BRIDGE_TOKEN_FILE: "/t/token",
    REX_BRIDGE_AUDIT_LOG: "/t/audit.log",
    REX_BOT_WATCH_DIR: "/w",
    REX_BIN: "/opt/rex",
  });
  assert.deepEqual(
    [c.host, c.port, c.tokenFile, c.auditLog, c.watchSessionsFile, c.rexBin],
    ["100.64.0.1", 8123, "/t/token", "/t/audit.log", "/w/sessions", "/opt/rex"],
  );
});

test("loadConfig rejects invalid ports", () => {
  for (const p of ["abc", "0", "70000", "80.5"]) {
    assert.throws(() => loadConfig({ HOME: "/h", REX_BRIDGE_PORT: p }), /REX_BRIDGE_PORT/);
  }
});

async function cli(args: string[], env: Record<string, string>) {
  return run(process.execPath, ["--import", "tsx", bridgeCli, ...args], {
    env: { ...process.env, ...env },
  }).catch((e: { stdout: string; stderr: string; code: number }) => e);
}

test("token CLI prints only the path; the token only with --show", async () => {
  const file = join(await tempDir(), "token");
  const env = { REX_BRIDGE_TOKEN_FILE: file };

  const created = await cli(["token"], env);
  const token = (await readFile(file, "utf8")).trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.stdout, `created: ${file}\n`);
  assert.ok(!created.stdout.includes(token) && !created.stderr.includes(token));

  const again = await cli(["token"], env);
  assert.equal(again.stdout, `exists: ${file}\n`);

  const shown = await cli(["token", "--show"], env);
  assert.equal(shown.stdout, `exists: ${file}\n${token}\n`);

  const rotated = await cli(["token", "--rotate"], env);
  const newToken = (await readFile(file, "utf8")).trim();
  assert.notEqual(newToken, token);
  assert.equal(rotated.stdout, `rotated: ${file}\n`);
  assert.ok(!rotated.stdout.includes(newToken));
});

test("serve refuses to start without a token", async () => {
  const file = join(await tempDir(), "missing-token");
  const r = (await cli(["serve"], { REX_BRIDGE_TOKEN_FILE: file, REX_BRIDGE_PORT: "1" })) as {
    code?: number;
    stderr: string;
  };
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no token at .*missing-token/);
});
