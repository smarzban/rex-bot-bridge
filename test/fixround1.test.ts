// Hardening from review fix round 1 (K1-K9): watch-list races, Tailscale Serve safety, init.lua rollback,
// file modes, fail-closed mode wiring, and setup/uninstall behaviour through a fake ctx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { Ops } from "../src/ops.js";
import { resolvePaths } from "../src/paths.js";
import { makePrompter, scriptedPrompter, type Prompter } from "../src/prompt.js";
import { Rex, type RunResult, type Runner } from "../src/rex.js";
import { installBlock, uninstallBlock, renderBlock } from "../src/rexconfig.js";
import { buildServeOps } from "../src/serve.js";
import { writeSettings, DEFAULTS, type Mode } from "../src/settings.js";
import { setup, type SetupFlags } from "../src/setup.js";
import { serveTarget } from "../src/tailscale.js";
import { ensureToken } from "../src/token.js";
import { uninstall } from "../src/uninstall.js";
import { runDoctor } from "../src/doctor.js";
import { readSettings } from "../src/settings.js";
import { WatchFile } from "../src/watch.js";
import { B1, B3, fakeCtx, FakeRex, S1, S2, tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", code: 0 });

function makeOps(dir: string, rex: Runner, mode: () => Promise<Mode>, extra: Partial<ConstructorParameters<typeof Ops>[0]> = {}) {
  return new Ops({
    rex: new Rex(rex),
    watch: new WatchFile(join(dir, "watched")),
    heartbeatFile: join(dir, "heartbeat"),
    auditLogPath: join(dir, "audit.log"),
    mode,
    sleep: async () => {},
    pollMs: 1000,
    ...extra,
  });
}

// ---------- K1: spawn_agent never re-adds an existing session in watched mode ----------

test("K1 watched mode: unwatching during an in-flight spawn into an existing session sticks", async () => {
  const dir = await tempDir();
  const fake = new FakeRex();
  let gate: { release: () => void; barrier: Promise<void>; reached: () => void; atRun: Promise<void> };
  const newGate = () => {
    const g = {} as typeof gate;
    g.barrier = new Promise<void>((r) => (g.release = r));
    g.atRun = new Promise<void>((r) => (g.reached = r));
    gate = g;
  };
  const runner: Runner = async (args, opts) => {
    if (args[0] === "run") {
      gate.reached();
      await gate.barrier;
    }
    return fake.runner(args, opts);
  };
  const ops = makeOps(dir, runner, async () => "watched");
  const watch = new WatchFile(join(dir, "watched"));
  await watch.add(S1);
  for (const w of [true, false]) {
    newGate();
    const p = ops.spawnAgent({ agent: "shell", cwd: dir, session_id: S1, watch: w });
    await gate!.atRun;
    await watch.remove(S1); // the human unwatches while rex run is in flight
    gate!.release();
    const r = await p;
    assert.equal(r.watched, false, `watch=${w}`);
    assert.deepEqual(await watch.list(), [], `watch=${w}: session must stay unwatched`);
    await watch.add(S1);
  }
});

test("K1: a new session is auto-watched in watched mode; full mode keeps watch=true adding", async () => {
  const dir = await tempDir();
  const watch = new WatchFile(join(dir, "watched"));
  const watched = makeOps(dir, new FakeRex().runner, async () => "watched");
  const n = await watched.spawnAgent({ agent: "shell", cwd: dir, new_session_label: "x", watch: false });
  assert.equal(n.watched, true);
  assert.deepEqual(await watch.list(), [n.session_id]);

  const full = makeOps(dir, new FakeRex().runner, async () => "full");
  const r = await full.spawnAgent({ agent: "shell", cwd: dir, session_id: S2, watch: true });
  assert.equal(r.watched, true);
  assert.ok((await watch.list()).includes(S2));
  await watch.remove(S2);
  const r2 = await full.spawnAgent({ agent: "shell", cwd: dir, session_id: S2, watch: false });
  assert.equal(r2.watched, false);
  assert.ok(!(await watch.list()).includes(S2));
});

// ---------- K5: serve wiring fails closed ----------

test("K5: serve's Ops follow config.json mode=watched and refuse an unwatched block", async () => {
  const home = await tempDir();
  const paths = resolvePaths({ HOME: home });
  await writeSettings(paths.configFile, { ...DEFAULTS, mode: "watched" });
  const cfg = await loadConfig({ HOME: home });
  const fake = new FakeRex();
  const ops = buildServeOps(cfg, fake.runner);
  await assert.rejects(
    ops.sendMessage({ block_id: B3, session_id: S2, text: "rm -rf ~", submit: true, require_idle: false }),
    /"watched" mode/,
  );
  await assert.rejects(ops.sendMessage({ block_id: B3, text: "x", submit: true, require_idle: false }), /"watched" mode/);
  assert.equal(fake.pastes().length, 0);
  assert.equal(fake.callsOf("send-key").length, 0);

  // No config.json at all: still watched (the default), never full.
  const bare = buildServeOps(await loadConfig({ HOME: await tempDir() }), fake.runner);
  await assert.rejects(bare.sendKeys(B3, S2, ["enter"]), /"watched" mode/);
});

// ---------- K6: wait_for_status rechecks access before each poll ----------

test("K6: wait_for_status stops once the session is unwatched mid-wait", async () => {
  const dir = await tempDir();
  const fake = new FakeRex();
  fake.state = "working";
  const watch = new WatchFile(join(dir, "watched"));
  await watch.add(S1);
  let polls = 0;
  const ops = makeOps(dir, fake.runner, async () => "watched", {
    sleep: async () => {
      polls++;
      if (polls === 2) await watch.remove(S1);
    },
  });
  await assert.rejects(ops.waitForStatus(B1, S1, ["done"], 60), /"watched" mode and session .* is not watched/);
  const statusCalls = fake.calls.filter((c) => c.args[0] === "block" && c.args.at(-1) !== "process" && c.args[1] === "call");
  assert.equal(statusCalls.length, 2, "no poll after revocation");
});

test("K6: wait_for_status stops when the mode switches to watched mid-wait", async () => {
  const dir = await tempDir();
  let mode: Mode = "full";
  const ops = makeOps(dir, new FakeRex().runner, async () => mode, {
    sleep: async () => {
      mode = "watched";
    },
  });
  await assert.rejects(ops.waitForStatus(B3, S2, ["done"], 60), /"watched" mode/);
});

// ---------- K3: init.lua rollback when the check runner rejects ----------

const rejecting: Runner = async () => {
  throw new Error("rex timed out after 15000ms");
};

test("K3: a rejecting `rex config check` restores init.lua byte for byte and rethrows", async () => {
  const dir = await tempDir();
  const initPath = join(dir, "rex/init.lua");
  await mkdir(join(dir, "rex"));
  const original = Buffer.from([0x2d, 0x2d, 0x20, 0xff, 0xfe, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x0a]); // not valid UTF-8
  await writeFile(initPath, original);
  await assert.rejects(
    installBlock({ initPath, backupsDir: join(dir, "bak"), actionsPath: "/a.lua", rex: rejecting }),
    /timed out.*restored the previous file/,
  );
  assert.deepEqual(await readFile(initPath), original);

  // Removal path: same guarantee.
  const withBlock = Buffer.concat([original, Buffer.from("\n" + renderBlock("/a.lua"))]);
  await writeFile(initPath, withBlock);
  await assert.rejects(uninstallBlock({ initPath, backupsDir: join(dir, "bak"), rex: rejecting }), /restored/);
  assert.deepEqual(await readFile(initPath), withBlock);
});

test("K3: a rejecting check deletes an init.lua that did not exist before", async () => {
  const dir = await tempDir();
  const initPath = join(dir, "rex/init.lua");
  await assert.rejects(installBlock({ initPath, backupsDir: join(dir, "bak"), actionsPath: "/a.lua", rex: rejecting }));
  await assert.rejects(stat(initPath));
});

// ---------- K4: state files are 0600 from creation ----------

test("K4/R3: watched is created 0600 (even with umask 0) and a looser existing file is tightened on replace", async () => {
  const dir = await tempDir();
  const old = process.umask(0);
  try {
    const w = new WatchFile(join(dir, "state/watched"));
    await w.add(S1);
    assert.equal((await stat(w.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "state"))).mode & 0o777, 0o700);
    await w.add(S2);
    assert.equal((await stat(w.path)).mode & 0o777, 0o600);
    await chmod(w.path, 0o644); // as left by a pre-0.2.0 install
    await w.remove(S1);
    assert.equal((await stat(w.path)).mode & 0o777, 0o600, "tightened to 0600 on replace");
  } finally {
    process.umask(old);
  }
});

// ---------- K2 + K8: setup/uninstall through a fake ctx ----------

const FLAGS: SetupFlags = {
  yes: false,
  mode: "watched",
  services: false,
  serve: true,
  skills: false,
  rexConfig: false,
  showToken: false,
};

/** Records every confirm() question with its default. */
function recording(p: Prompter) {
  const asked: { q: string; def: boolean }[] = [];
  const wrapped: Prompter = {
    ...p,
    interactive: p.interactive,
    confirm: (q, def) => {
      asked.push({ q, def });
      return p.confirm(q, def);
    },
  };
  return { p: wrapped, asked };
}

const status = (handler: unknown) => ok(JSON.stringify({ Web: { "mac.tail.ts.net:443": { Handlers: { "/rex-bridge": handler } } } }));
const isServeRun = (a: string[]) => a[0] === "serve" && a.includes("--set-path") && !a.includes("off");
const isServeOff = (a: string[]) => a[0] === "serve" && a.includes("off");

test("K2: serveTarget is tri-state: absent / occupied (any handler) / unknown", async () => {
  const r = (res: RunResult | Error): Runner => async () => {
    if (res instanceof Error) throw res;
    return res;
  };
  assert.deepEqual(await serveTarget(r(ok("{}")), "/rex-bridge"), { kind: "absent" });
  assert.deepEqual(await serveTarget(r(ok("")), "/rex-bridge"), { kind: "absent" });
  assert.deepEqual(await serveTarget(r(status({ Proxy: "http://127.0.0.1:7400/" })), "/other"), { kind: "absent" });
  assert.deepEqual(await serveTarget(r(status({ Proxy: "http://127.0.0.1:7400/" })), "/rex-bridge"), {
    kind: "occupied",
    target: "http://127.0.0.1:7400",
  });
  assert.deepEqual(await serveTarget(r(status({ Path: "/srv/www" })), "/rex-bridge"), { kind: "occupied", target: "files at /srv/www" });
  assert.deepEqual(await serveTarget(r(status({ Text: "hi" })), "/rex-bridge"), { kind: "occupied", target: "a static text response" });
  assert.equal((await serveTarget(r(status({ Redirect: "x" })), "/rex-bridge")).kind, "occupied");
  assert.equal((await serveTarget(r({ stdout: "", stderr: "boom", code: 1 }), "/rex-bridge")).kind, "unknown");
  assert.equal((await serveTarget(r(ok("not json")), "/rex-bridge")).kind, "unknown");
  assert.equal((await serveTarget(r(new Error("spawn ENOENT")), "/rex-bridge")).kind, "unknown");
});

test("K2 setup: an absent mapping is offered with default yes and applied", async () => {
  const f = await fakeCtx(ok("{}"));
  const { p, asked } = recording(scriptedPrompter());
  assert.equal(await setup(f.ctx, { ...FLAGS }, p), 0);
  assert.deepEqual(asked.find((a) => a.q.includes("Run it now"))?.def, true);
  assert.equal(f.tsCalls.filter(isServeRun).length, 1);
});

for (const [name, st] of [
  ["a different proxy", status({ Proxy: "http://127.0.0.1:9999" })],
  ["a file handler", status({ Path: "/srv/www" })],
  ["a text handler", status({ Text: "hello" })],
  ["an unknown handler", status({ Redirect: "https://x" })],
  ["failed status", { stdout: "", stderr: "tailscaled not responding", code: 1 }],
  ["unparsable status", ok("<html>")],
  ["a rejecting runner", new Error("timed out")],
] as [string, RunResult | Error][]) {
  test(`K2 setup: ${name} is never replaced by default (interactive or --yes)`, async () => {
    const f = await fakeCtx(st);
    const { p, asked } = recording(scriptedPrompter());
    await setup(f.ctx, { ...FLAGS }, p);
    const q = asked.filter((a) => !a.q.includes("bearer token"));
    assert.equal(q.length, 1, JSON.stringify(asked));
    assert.equal(q[0]!.def, false, `default must be no: ${q[0]!.q}`);
    assert.equal(f.tsCalls.filter(isServeRun).length, 0);

    const y = await fakeCtx(st);
    await setup(y.ctx, { ...FLAGS, yes: true }, makePrompter(true));
    assert.equal(y.tsCalls.filter(isServeRun).length, 0, "--yes must not overwrite");

    // An explicit yes does replace it.
    const e = await fakeCtx(st);
    await setup(e.ctx, { ...FLAGS }, scriptedPrompter({ "Replace it": true, anyway: true }));
    assert.equal(e.tsCalls.filter(isServeRun).length, 1);
  });
}

test("K2 setup: our own mapping is left alone without asking", async () => {
  const f = await fakeCtx(status({ Proxy: "http://127.0.0.1:7400" }));
  const { p, asked } = recording(scriptedPrompter());
  await setup(f.ctx, { ...FLAGS }, p);
  assert.equal(asked.filter((a) => !a.q.includes("bearer token")).length, 0);
  assert.equal(f.tsCalls.filter(isServeRun).length, 0);
  assert.ok(f.out.some((l) => l.includes("already maps")));
});

test("K8 setup: the token is printed only with --show-token or an explicit yes", async () => {
  const run = async (flags: Partial<SetupFlags>, p: Prompter) => {
    const f = await fakeCtx(ok("{}"));
    const { token } = await ensureToken(f.ctx.paths.tokenFile);
    await setup(f.ctx, { ...FLAGS, serve: false, ...flags }, p);
    return f.out.join("\n").includes(token);
  };
  assert.equal(await run({}, scriptedPrompter()), false, "interactive default is no");
  assert.equal(await run({ yes: true }, makePrompter(true)), false, "--yes never shows it");
  assert.equal(await run({}, scriptedPrompter({ "bearer token": false })), false);
  assert.equal(await run({}, scriptedPrompter({ "bearer token": true })), true);
  assert.equal(await run({ showToken: true }, makePrompter(true)), true);
});

test("K8 uninstall: state dir kept without --purge, deleted with it", async () => {
  const f = await fakeCtx(ok("{}"));
  await ensureToken(f.ctx.paths.tokenFile);
  assert.equal(await uninstall(f.ctx, { yes: true, purge: false, serveOff: false }, makePrompter(true)), 0);
  assert.ok((await stat(f.ctx.paths.tokenFile)).isFile());
  assert.equal(await uninstall(f.ctx, { yes: true, purge: true, serveOff: false }, makePrompter(true)), 0);
  await assert.rejects(stat(f.ctx.paths.stateDir));
});

test("K8 uninstall: `tailscale serve off` only for our own mapping, and only when asked", async () => {
  const ours = status({ Proxy: "http://127.0.0.1:7400" });
  const foreign = status({ Proxy: "http://127.0.0.1:9999" });
  const offCalls = async (st: RunResult | Error, flags: { yes: boolean; serveOff: boolean }, p: Prompter) => {
    const f = await fakeCtx(st);
    await writeSettings(f.ctx.paths.configFile, { ...DEFAULTS });
    await uninstall(f.ctx, { ...flags, purge: false }, p);
    return f.tsCalls.filter(isServeOff).length;
  };
  assert.equal(await offCalls(foreign, { yes: true, serveOff: true }, makePrompter(true)), 0, "foreign target, --serve-off");
  assert.equal(await offCalls(foreign, { yes: false, serveOff: false }, scriptedPrompter({ "Tailscale Serve": true })), 0);
  assert.equal(await offCalls(new Error("timeout"), { yes: true, serveOff: true }, makePrompter(true)), 0, "unknown status");
  assert.equal(await offCalls(ours, { yes: true, serveOff: false }, makePrompter(true)), 0, "--yes without --serve-off");
  assert.equal(await offCalls(ours, { yes: false, serveOff: false }, scriptedPrompter()), 0, "interactive default is no");
  assert.equal(await offCalls(ours, { yes: true, serveOff: true }, makePrompter(true)), 1);
  assert.equal(await offCalls(ours, { yes: false, serveOff: false }, scriptedPrompter({ "Remove the Tailscale Serve": true })), 1);
});

// ---------- Fix round 2 ----------

test("R1 setup: the v1 list is imported once; an unwatched session stays unwatched on re-run", async () => {
  const f = await fakeCtx(ok("{}"));
  const legacy = f.ctx.paths.legacyWatchedFile;
  await mkdir(join(legacy, ".."), { recursive: true });
  await writeFile(legacy, `# v1\n${S1}\n${S2}\n`);
  const flags = { ...FLAGS, serve: false };
  assert.equal(await setup(f.ctx, flags, makePrompter(true)), 0);
  const watch = new WatchFile(f.ctx.paths.watchedFile);
  assert.deepEqual(await watch.list(), [S1, S2]);
  assert.ok((await readSettings(f.ctx.paths.configFile)).migratedV1At, "marker recorded");

  await watch.remove(S1); // the human unwatches it in v2
  assert.equal(await setup(f.ctx, flags, makePrompter(true)), 0);
  assert.deepEqual(await watch.list(), [S2], "re-run must not re-import");
  // Even with the v2 list deleted, the recorded import is not repeated.
  await writeFile(f.ctx.paths.watchedFile, "");
  await setup(f.ctx, flags, makePrompter(true));
  assert.deepEqual(await watch.list(), []);
});

test("R1 setup: an existing v2 watched file blocks the v1 import even without a marker", async () => {
  const f = await fakeCtx(ok("{}"));
  await mkdir(join(f.ctx.paths.legacyWatchedFile, ".."), { recursive: true });
  await writeFile(f.ctx.paths.legacyWatchedFile, `${S1}\n`);
  await mkdir(f.ctx.paths.stateDir, { recursive: true });
  await writeFile(f.ctx.paths.watchedFile, `${S2}\n`);
  await setup(f.ctx, { ...FLAGS, serve: false }, makePrompter(true));
  assert.deepEqual(await new WatchFile(f.ctx.paths.watchedFile).list(), [S2]);
  assert.ok((await readSettings(f.ctx.paths.configFile)).migratedV1At);
});

test("R3 doctor: warns when watched/heartbeat/token/config.json are not 0600", async () => {
  const f = await fakeCtx(ok("{}"));
  const p = f.ctx.paths;
  await ensureToken(p.tokenFile);
  await writeSettings(p.configFile, { ...DEFAULTS });
  await writeFile(p.watchedFile, `${S1}\n`, { mode: 0o600 });
  await writeFile(p.heartbeatFile, new Date().toISOString() + "\n", { mode: 0o600 });
  await chmod(p.watchedFile, 0o600);
  await chmod(p.heartbeatFile, 0o600);
  const level = async () => (await runDoctor(f.ctx, { testWebhook: false })).find((c) => c.id === "file_modes");
  assert.equal((await level())?.level, "ok");
  await chmod(p.watchedFile, 0o644);
  await chmod(p.heartbeatFile, 0o644);
  const c = await level();
  assert.equal(c?.level, "warn");
  assert.match(c!.detail, /watched \(644\).*heartbeat \(644\)/);
  assert.ok(!c!.detail.includes("token"), "token and config.json are still 600");
  assert.match(c!.fix ?? "", /^chmod 600 '.*watched' '.*heartbeat'$/);
});
