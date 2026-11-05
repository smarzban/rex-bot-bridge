// T429 FR1-D: `rex-bot setup <part>` through the real CLI (sandbox HOME, stub rex/tailscale on REX_BIN /
// TAILSCALE_BIN that log their calls) runs only that part. `skills` is an alias of `skill`.
// `setup services` isn't run here: the CLI always uses the real /bin/launchctl (unit-tested with a fake
// launchctl in setup-parts.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childEnv, tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");

async function sandbox() {
  const home = await tempDir();
  const log = join(home, "calls.log");
  await mkdir(join(home, ".config/rex"), { recursive: true });
  await mkdir(join(home, ".claude"));
  await writeFile(join(home, ".config/rex/init.lua"), "-- mine\n");
  const rex = join(home, "fake-rex");
  await writeFile(
    rex,
    `#!/bin/sh\necho "rex $*" >> '${log}'\ncase "$1 $2 $3" in\n  "api call server.version") echo '{"api_revision":10}' ;;\n  "ls --json "*) echo '{"sessions":[]}' ;;\nesac\nexit 0\n`,
  );
  const ts = join(home, "fake-tailscale");
  await writeFile(
    ts,
    `#!/bin/sh\necho "tailscale $*" >> '${log}'\ncase "$1 $2" in\n  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"mac.tail.ts.net."}}' ;;\n  "serve status") echo '{}' ;;\nesac\nexit 0\n`,
  );
  await chmod(rex, 0o755);
  await chmod(ts, 0o755);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src/cli/rex-bot.ts"), "setup", ...args, "--yes"], {
      cwd: ROOT,
      env: childEnv({ HOME: home, REX_BIN: rex, TAILSCALE_BIN: ts }),
      encoding: "utf8",
    });
  const state = async () => ({
    init: await readFile(join(home, ".config/rex/init.lua"), "utf8"),
    skill: existsSync(join(home, ".claude/skills/rex-bot/SKILL.md")),
    config: existsSync(join(home, ".config/rex-bot-bridge/config.json")),
    calls: (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
  });
  return { home, run, state };
}

test("T429 FR1-D cli: setup skill and setup skills install only the skill", async () => {
  for (const part of ["skill", "skills"]) {
    const sb = await sandbox();
    const r = sb.run(part);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /^2\. Agent skill$/m);
    const st = await sb.state();
    assert.deepEqual([st.skill, st.init, st.config], [true, "-- mine\n", false], part);
    assert.deepEqual(st.calls, [], `${part}: no rex or tailscale calls`);
  }
});

test("T429 FR1-D cli: setup rex adds only the init.lua block", async () => {
  const sb = await sandbox();
  const r = sb.run("rex");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const st = await sb.state();
  assert.match(st.init, /rex-bot-bridge >>>/);
  assert.deepEqual([st.skill, st.config], [false, false]);
  assert.ok(st.calls.every((c) => c.startsWith("rex ")), "no tailscale calls");
  assert.ok(!st.calls.some((c) => c === "rex config reload"), "sandbox HOME: never reloads the real Rex");
});

test("T429 FR1-D cli: setup serve runs only tailscale serve", async () => {
  const sb = await sandbox();
  const r = sb.run("serve");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const st = await sb.state();
  assert.deepEqual([st.skill, st.init], [false, "-- mine\n"]);
  assert.ok(st.calls.includes("tailscale serve --bg --https=443 --set-path /rex-bridge http://127.0.0.1:7400"), st.calls.join("\n"));
  assert.ok(!st.calls.some((c) => c.startsWith("rex ")), "no rex calls");
});

test("T429 FR1-D cli: an unknown part is a usage error and changes nothing", async () => {
  const sb = await sandbox();
  const r = sb.run("everything");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown setup part: everything/);
  const st = await sb.state();
  assert.deepEqual([st.skill, st.init, st.config, st.calls], [false, "-- mine\n", false, []]);
});
