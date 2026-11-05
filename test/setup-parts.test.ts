// T429: `rex-bot setup <part>` runs only that part; launchd bootout→bootstrap race; numbered sections;
// `uninstall --purge` keeps the init.lua backups.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { installServices, LABELS } from "../src/launchd.js";
import { makePrompter, scriptedPrompter } from "../src/prompt.js";
import { runDoctor } from "../src/doctor.js";
import { resolvePaths } from "../src/paths.js";
import { DEFAULTS, readSettings, writeSettings } from "../src/settings.js";
import { NEXT_BLOCK, setup, type Part, type SetupFlags } from "../src/setup.js";
import { uninstall } from "../src/uninstall.js";
import type { Runner } from "../src/rex.js";
import { fakeCtx, tempDir } from "./helpers.js";

const ALL: SetupFlags = { yes: true, services: true, serve: true, skills: true, rexConfig: true };
const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });
const instant = async () => {};

/** A fake launchctl where services load fine; records calls. */
function goodLaunchctl(calls: string[][]): Runner {
  const loaded = new Set<string>();
  return async (args) => {
    calls.push(args);
    const target = args[1] ?? "";
    if (args[0] === "bootout") loaded.delete(target);
    if (args[0] === "bootstrap") loaded.add(`${args[1]}/${(args[2] ?? "").split("/").pop()!.replace(/\.plist$/, "")}`);
    if (args[0] === "print") return loaded.has(target) ? ok("state = running\npid = 1\n") : { stdout: "", stderr: "not found", code: 113 };
    return ok();
  };
}

async function partRun(part: Part) {
  const f = await fakeCtx(ok("{}"));
  f.ctx.sleep = instant;
  const calls: string[][] = [];
  f.ctx.launchctl = goodLaunchctl(calls);
  await mkdir(dirname(f.ctx.paths.rexInitLua), { recursive: true });
  await writeFile(f.ctx.paths.rexInitLua, "-- mine\n");
  for (const r of f.ctx.paths.skillRoots) await mkdir(r, { recursive: true });
  const code = await setup(f.ctx, { ...ALL }, makePrompter(true), part);
  const init = await readFile(f.ctx.paths.rexInitLua, "utf8");
  const skill = existsSync(`${f.ctx.paths.skillRoots[0]}/skills/rex-bot/SKILL.md`);
  const serveRuns = f.tsCalls.filter((a) => a[0] === "serve" && a.includes("--set-path")).length;
  const bootstraps = calls.filter((c) => c[0] === "bootstrap").length;
  return { code, out: f.out.join("\n"), init, skill, serveRuns, bootstraps, f };
}

test("T429 setup rex: only the init.lua block", async () => {
  const r = await partRun("rex");
  assert.equal(r.code, 0, r.out);
  assert.match(r.init, /rex-bot-bridge >>>/);
  assert.deepEqual([r.skill, r.serveRuns, r.bootstraps], [false, 0, 0]);
  assert.ok(!existsSync(r.f.ctx.paths.configFile), "no settings written");
  assert.match(r.out, /^1\. Checks$/m);
  assert.match(r.out, /^2\. Rex palette$/m);
  assert.ok(!r.out.includes("Next\n  1."), "a part run doesn't print the full Next block");
});

test("T429 setup skill: only the skill (no Rex, launchctl or tailscale calls)", async () => {
  const r = await partRun("skill");
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([r.skill, r.serveRuns, r.bootstraps], [true, 0, 0]);
  assert.equal(r.init, "-- mine\n");
  assert.equal(r.f.tsCalls.length, 0);
});

test("T429 setup services: only the services; clears the --no-services skip", async () => {
  const f0 = await fakeCtx(ok("{}"));
  const home = f0.ctx.paths.home;
  await writeSettings(resolvePaths({ HOME: home }).configFile, { ...DEFAULTS, skipped: { services: true, serve: true } });
  const f = await fakeCtx(ok("{}"), home);
  f.ctx.sleep = instant;
  const calls: string[][] = [];
  f.ctx.launchctl = goodLaunchctl(calls);
  assert.equal(await setup(f.ctx, { ...ALL }, makePrompter(true), "services"), 0, f.out.join("\n"));
  assert.equal(calls.filter((c) => c[0] === "bootstrap").length, 2);
  assert.equal(f.tsCalls.filter((a) => a[0] === "serve").length, 0);
  assert.ok(!existsSync(f.ctx.paths.rexInitLua));
  assert.deepEqual((await readSettings(f.ctx.paths.configFile)).skipped, { services: false, serve: true });
  assert.ok(existsSync(f.ctx.paths.tokenFile), "the bridge needs a token, so services creates one");
});

test("T429 setup serve: only Tailscale Serve", async () => {
  const r = await partRun("serve");
  assert.equal(r.code, 0, r.out);
  assert.deepEqual([r.skill, r.serveRuns, r.bootstraps], [false, 1, 0]);
  assert.equal(r.init, "-- mine\n");
});

test("T429 setup: numbered sections in order, then exactly the Next block", async () => {
  const f = await fakeCtx(ok("{}"));
  f.ctx.sleep = instant;
  f.ctx.launchctl = goodLaunchctl([]);
  assert.equal(await setup(f.ctx, { ...ALL, skills: false, rexConfig: false }, makePrompter(true)), 0);
  const out = f.out.join("\n");
  const heads = out.split("\n").filter((l) => /^\d\. /.test(l));
  assert.deepEqual(heads, ["1. Checks", "2. Settings", "3. Rex palette", "4. Services", "5. Tailscale Serve", "6. Agent skill"]);
  assert.ok(out.endsWith("\n" + NEXT_BLOCK), out);
  assert.equal(
    NEXT_BLOCK,
    `Next
  1. Set up Grok Bot: https://github.com/smarzban/rex-bot-bridge/blob/main/docs/grok-bot.md
     (or give your Grok Bot this address: https://raw.githubusercontent.com/smarzban/rex-bot-bridge/main/docs/grok-bot.md)
  2. Add the routine's webhook: rex-bot setup webhook
  3. Check everything: rex-bot doctor --test-webhook`,
  );
  assert.match(out, /⚠️ {2}Skipped \(--no-rex-config\)\.\n {6}fix: rex-bot setup rex/);
});

// ---------- launchd race ----------

/**
 * A launchctl like the real one: bootout returns at once but the label stays visible to `print` for a
 * few polls, and the first bootstrap of each label fails with launchd's I/O error.
 */
function racyLaunchctl(calls: string[][], failFirst = 1, lingerPolls = 3): Runner {
  const linger = new Map<string, number>();
  const fails = new Map<string, number>();
  return async (args) => {
    calls.push(args);
    if (args[0] === "bootout") linger.set(args[1]!, lingerPolls);
    if (args[0] === "print") {
      const n = linger.get(args[1]!) ?? 0;
      if (n > 0) {
        linger.set(args[1]!, n - 1);
        return ok("state = running\n");
      }
      return { stdout: "", stderr: "Could not find service", code: 113 };
    }
    if (args[0] === "bootstrap") {
      const n = (fails.get(args[2]!) ?? 0) + 1;
      fails.set(args[2]!, n);
      if (n <= failFirst) return { stdout: "", stderr: "Bootstrap failed: 5: Input/output error", code: 5 };
    }
    return ok();
  };
}

const svcCtx = async () => {
  const home = await tempDir();
  return { paths: resolvePaths({ HOME: home }), node: "/n", cli: "/c.js", rexBin: "/r/rex", pkgRoot: "/p" };
};

test("T429 launchd: waits for bootout to finish, retries a failed bootstrap, and loads both", async () => {
  const calls: string[][] = [];
  const slept: number[] = [];
  const res = await installServices(await svcCtx(), racyLaunchctl(calls), { sleep: async (ms) => void slept.push(ms) });
  assert.deepEqual(res.map((r) => [r.label, r.ok]), [
    [LABELS.bridge, true],
    [LABELS.watch, true],
  ]);
  const bridgeCalls = calls.slice(0, calls.findIndex((c) => c[0] === "bootout" && c[1]!.endsWith(LABELS.watch)));
  assert.deepEqual(bridgeCalls.map((c) => c[0]), ["bootout", "print", "print", "print", "print", "bootstrap", "bootstrap"]);
  assert.ok(slept.includes(500), "backs off before the retry");
});

test("T429 launchd: a service that never loads is reported with launchctl's message; the other still loads", async () => {
  const calls: string[][] = [];
  const always = racyLaunchctl(calls, 99, 0);
  const lc: Runner = async (args) => (args[0] === "bootstrap" && args[2]!.includes(LABELS.bridge) ? always(args) : args[0] === "bootstrap" ? ok() : always(args));
  const res = await installServices(await svcCtx(), lc, { sleep: instant });
  assert.deepEqual(res.map((r) => r.ok), [false, true]);
  assert.equal(res[0]!.error, "Bootstrap failed: 5: Input/output error");
  assert.equal(calls.filter((c) => c[0] === "bootstrap").length, 3, "three tries");
});

test("T429 setup services: a failed load names the service and gives the exact launchctl bootstrap line", async () => {
  const f = await fakeCtx(ok("{}"));
  f.ctx.sleep = instant;
  const base = racyLaunchctl([], 99, 0);
  f.ctx.launchctl = async (args) => (args[0] === "bootstrap" && args[2]!.includes(LABELS.watch) ? base(args) : args[0] === "bootstrap" ? ok() : base(args));
  assert.equal(await setup(f.ctx, { ...ALL }, makePrompter(true), "services"), 1);
  const out = f.out.join("\n");
  assert.match(out, new RegExp(`✅ ${LABELS.bridge} loaded`));
  assert.match(out, new RegExp(`❌ ${LABELS.watch} did not load: Bootstrap failed: 5: Input/output error\\n\\s+fix: launchctl bootstrap gui/\\$\\(id -u\\) '.*/Library/LaunchAgents/${LABELS.watch}\\.plist'`));
});

test("T429 doctor: fix lines are exact commands (not loaded → launchctl bootstrap; webhook → setup webhook)", async () => {
  const f = await fakeCtx(ok("{}"));
  await mkdir(f.ctx.paths.launchAgentsDir, { recursive: true });
  await writeFile(`${f.ctx.paths.launchAgentsDir}/${LABELS.bridge}.plist`, "<plist/>");
  const checks = await runDoctor(f.ctx, { testWebhook: false });
  const fix = (id: string) => checks.find((c) => c.id === id)?.fix;
  assert.match(fix("service_bridge")!, new RegExp(`^launchctl bootstrap gui/\\$\\(id -u\\) '.*${LABELS.bridge}\\.plist'$`));
  assert.equal(fix("service_watch"), "rex-bot setup services", "no plist yet → setup services");
  assert.equal(fix("webhook"), "rex-bot setup webhook");
  assert.equal(fix("rex_actions"), "rex-bot setup rex");
});

// ---------- uninstall --purge keeps init.lua backups ----------

test("T429 uninstall --purge: the init.lua backup it reports survives the purge", async () => {
  const f = await fakeCtx(ok("{}"));
  await mkdir(dirname(f.ctx.paths.rexInitLua), { recursive: true });
  await writeFile(f.ctx.paths.rexInitLua, "-- mine\n");
  await setup(f.ctx, { ...ALL, services: false, serve: false, skills: false }, scriptedPrompter(), "rex");
  f.out.length = 0;
  assert.equal(await uninstall(f.ctx, { yes: true, purge: true, serveOff: false }, makePrompter(true)), 0);
  const out = f.out.join("\n");
  const reported = /backup: ([^)]+)\)/.exec(out)?.[1];
  assert.ok(reported, out);
  assert.ok(existsSync(reported), "reported backup still exists after --purge");
  assert.ok(!existsSync(f.ctx.paths.stateDir), "state dir purged");
  assert.ok(!reported.startsWith(f.ctx.paths.stateDir));
  assert.ok((await readdir(f.ctx.paths.backupsDir)).length >= 2, "install and uninstall backups both kept");
  assert.match(out, /init\.lua backups kept in/);
});
