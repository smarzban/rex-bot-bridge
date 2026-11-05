// T430 fix round 1 (F-1/F-4): `url` and `token --rotate` through the real CLI dispatch (the built
// dist/cli/rex-grokbot.js), with a sandbox HOME, a stub tailscale (TAILSCALE_BIN) and a stub launchctl
// (LAUNCHCTL_BIN). The real /bin/launchctl is never run, so this Mac's real services are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childEnv, tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist/cli/rex-grokbot.js");
const FAKE = "fake-cli-token-not-a-secret-0123456789abcdef";
const SERVE_OURS = JSON.stringify({ Web: { "mac.tail.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7400" } } } } });

/** `loaded`: whether the stub's `launchctl print` reports the bridge loaded. `kickstartFails`: exit 1 on kickstart. */
async function sandbox(o: { loaded: boolean; kickstartFails?: boolean; serveStatus?: string }) {
  assert.ok(existsSync(CLI), `${CLI} is missing: run npm run build first`);
  const home = await tempDir();
  const log = join(home, "launchctl.log");
  const launchctl = join(home, "fake-launchctl");
  await writeFile(
    launchctl,
    `#!/bin/sh\necho "$*" >> '${log}'\ncase "$1" in\n` +
      `  print) ${o.loaded ? "printf 'state = running\\npid = 42\\n'; exit 0" : "echo 'Could not find service' >&2; exit 113"} ;;\n` +
      `  kickstart) ${o.kickstartFails ? "echo 'Could not kickstart service: Operation not permitted' >&2; exit 1" : "exit 0"} ;;\n` +
      `esac\nexit 0\n`,
  );
  const ts = join(home, "fake-tailscale");
  await writeFile(
    ts,
    `#!/bin/sh\ncase "$1 $2" in\n  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"mac.tail.ts.net."}}' ;;\n` +
      `  "serve status") echo '${o.serveStatus ?? SERVE_OURS}' ;;\nesac\nexit 0\n`,
  );
  await chmod(launchctl, 0o755);
  await chmod(ts, 0o755);
  const dir = join(home, ".config/rex-grokbot-bridge");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "token"), FAKE + "\n", { mode: 0o600 });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: childEnv({ HOME: home, TAILSCALE_BIN: ts, LAUNCHCTL_BIN: launchctl }),
      encoding: "utf8",
    });
  return {
    run,
    token: async () => (await readFile(join(dir, "token"), "utf8")).trim(),
    calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
  };
}

test("CLI url: stdout is only the connector URL; no warning when Serve maps it", async () => {
  const sb = await sandbox({ loaded: false });
  const r = sb.run("url");
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, "https://mac.tail.ts.net:8443/mcp\n", ""]);
});

test("CLI url: Serve not mapped → same stdout, warning + fix line on stderr", async () => {
  const sb = await sandbox({ loaded: false, serveStatus: "{}" });
  const r = sb.run("url");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "https://mac.tail.ts.net:8443/mcp\n");
  assert.equal(r.stderr, "rex-grokbot: warning: Tailscale Serve doesn't map port 8443 to the bridge yet.\n  fix: rex-grokbot setup serve\n");
});

test("CLI token --rotate, bridge loaded: new token in the file and alone on stdout; stub launchctl kickstarted -k", async () => {
  const sb = await sandbox({ loaded: true });
  const r = sb.run("token", "--rotate");
  assert.equal(r.status, 0, r.stderr);
  const now = await sb.token();
  assert.notEqual(now, FAKE);
  assert.match(now, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.stdout, `${now}\n`);
  assert.ok(!r.stderr.includes(now));
  assert.match(r.stderr, /restarted com\.rexgrokbotbridge\.bridge/);
  assert.match(r.stderr, /update the Authorization header of the rex connector in Grok Bot/);
  const calls = await sb.calls();
  assert.ok(calls.some((c) => /^print gui\/\d+\/com\.rexgrokbotbridge\.bridge$/.test(c)), calls.join("\n"));
  assert.ok(calls.some((c) => /^kickstart -k gui\/\d+\/com\.rexgrokbotbridge\.bridge$/.test(c)), calls.join("\n"));
});

test("CLI token --rotate, bridge not loaded: rotates, no kickstart", async () => {
  const sb = await sandbox({ loaded: false });
  const r = sb.run("token", "--rotate");
  assert.equal(r.status, 0, r.stderr);
  const now = await sb.token();
  assert.notEqual(now, FAKE);
  assert.equal(r.stdout, `${now}\n`);
  assert.ok(!(await sb.calls()).some((c) => c.startsWith("kickstart")));
});

test("CLI token --rotate, kickstart fails: launchctl's error + fix line on stderr, new token printed, exit 0", async () => {
  const sb = await sandbox({ loaded: true, kickstartFails: true });
  const r = sb.run("token", "--rotate");
  assert.equal(r.status, 0);
  const now = await sb.token();
  assert.notEqual(now, FAKE);
  assert.equal(r.stdout, `${now}\n`);
  assert.match(r.stderr, /restarting com\.rexgrokbotbridge\.bridge failed: Could not kickstart service: Operation not permitted\n {2}fix: rex-grokbot setup services/);
  assert.ok(!r.stderr.includes(now));
});
