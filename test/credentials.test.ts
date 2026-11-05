// T430: `rex-grokbot token` / `token --rotate` / `url` (fake launchctl and tailscale), the old rex-bot skill
// cleanup, and setup no longer warning about the webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tokenCommand, urlCommand } from "../src/credentials.js";
import { makePrompter } from "../src/prompt.js";
import { setup } from "../src/setup.js";
import { readSettings, setKey, writeSettings } from "../src/settings.js";
import { installSkills, uninstallSkills } from "../src/skills.js";
import { fakeCtx, tempDir } from "./helpers.js";

const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });
const SERVE_OURS = ok(JSON.stringify({ Web: { "mac.tail.ts.net:443": { Handlers: { "/rex-bridge": { Proxy: "http://127.0.0.1:7400" } } } } }));
const FAKE = "fake-token-for-tests-0123456789abcdefghijklmno";

async function withToken(f: Awaited<ReturnType<typeof fakeCtx>>) {
  await mkdir(f.ctx.paths.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(f.ctx.paths.tokenFile, FAKE + "\n", { mode: 0o600 });
}

test("token: exactly the token line on stdout; none yet → stderr + exit 1", async () => {
  const f = await fakeCtx(ok("{}"));
  assert.equal(await tokenCommand(f.ctx, false), 1);
  assert.deepEqual(f.out, ["rex-grokbot: no token yet; run rex-grokbot setup"]);
  await withToken(f);
  const lines: string[] = [];
  f.ctx.out = (s) => lines.push(s);
  f.ctx.err = (s) => lines.push(`ERR ${s}`);
  assert.equal(await tokenCommand(f.ctx, false), 0);
  assert.deepEqual(lines, [FAKE]);
  assert.deepEqual(f.launchctlCalls, [], "plain token never touches launchd");
});

test("token --rotate: new token in the file and on stdout; bridge loaded → kickstart -k; reminder on stderr", async () => {
  const f = await fakeCtx(ok("{}"));
  await withToken(f);
  const stdout: string[] = [];
  const stderr: string[] = [];
  f.ctx.out = (s) => stdout.push(s);
  f.ctx.err = (s) => stderr.push(s);
  f.ctx.launchctl = async (args) => {
    f.launchctlCalls.push(args);
    return args[0] === "print" ? ok("state = running\npid = 42\n") : ok();
  };
  assert.equal(await tokenCommand(f.ctx, true), 0);
  const now = (await readFile(f.ctx.paths.tokenFile, "utf8")).trim();
  assert.notEqual(now, FAKE);
  assert.match(now, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(stdout, [now]);
  assert.equal((await stat(f.ctx.paths.tokenFile)).mode & 0o777, 0o600);
  const kick = f.launchctlCalls.find((a) => a[0] === "kickstart");
  assert.ok(kick, "kickstarted the bridge");
  assert.equal(kick[1], "-k");
  assert.match(kick[2]!, /^gui\/\d+\/com\.rexbotbridge\.bridge$/);
  assert.match(stderr.join("\n"), /restarted com\.rexbotbridge\.bridge/);
  assert.match(stderr.join("\n"), /update the Authorization header of the rex connector in Grok Bot/);
  assert.ok(!stderr.join("\n").includes(now));
});

test("token --rotate: kickstart fails → launchctl's error + fix line on stderr, new token still printed, exit 0", async () => {
  const f = await fakeCtx(ok("{}"));
  await withToken(f);
  const stdout: string[] = [];
  const stderr: string[] = [];
  f.ctx.out = (s) => stdout.push(s);
  f.ctx.err = (s) => stderr.push(s);
  f.ctx.launchctl = async (args) => {
    f.launchctlCalls.push(args);
    if (args[0] === "print") return ok("state = running\npid = 42\n");
    return { stdout: "", stderr: "Could not kickstart service: Operation not permitted", code: 1 };
  };
  assert.equal(await tokenCommand(f.ctx, true), 0);
  const now = (await readFile(f.ctx.paths.tokenFile, "utf8")).trim();
  assert.notEqual(now, FAKE);
  assert.deepEqual(stdout, [now]);
  const err = stderr.join("\n");
  assert.match(err, /restarting com\.rexbotbridge\.bridge failed: Could not kickstart service: Operation not permitted\n {2}fix: rex-grokbot setup services/);
  assert.match(err, /update the Authorization header of the rex connector/);
  assert.ok(!err.includes(now));
});

test("token --rotate: bridge not loaded → no kickstart, still rotates", async () => {
  const f = await fakeCtx(ok("{}"));
  await withToken(f);
  assert.equal(await tokenCommand(f.ctx, true), 0);
  assert.ok(!f.launchctlCalls.some((a) => a[0] === "kickstart"));
  assert.notEqual((await readFile(f.ctx.paths.tokenFile, "utf8")).trim(), FAKE);
  assert.match(f.out.join("\n"), /isn't loaded, so nothing was restarted/);
});

test("url: prints only https://<dns>/rex-bridge/mcp; warns on stderr when Serve isn't mapped; exit 1 without Tailscale", async () => {
  const f = await fakeCtx(SERVE_OURS);
  const stdout: string[] = [];
  const stderr: string[] = [];
  f.ctx.out = (s) => stdout.push(s);
  f.ctx.err = (s) => stderr.push(s);
  assert.equal(await urlCommand(f.ctx), 0);
  assert.deepEqual([stdout, stderr], [["https://mac.tail.ts.net/rex-bridge/mcp"], []]);

  const g = await fakeCtx(ok("{}"));
  const gout: string[] = [];
  const gerr: string[] = [];
  g.ctx.out = (s) => gout.push(s);
  g.ctx.err = (s) => gerr.push(s);
  assert.equal(await urlCommand(g.ctx), 0);
  assert.deepEqual(gout, ["https://mac.tail.ts.net/rex-bridge/mcp"], "stdout stays just the URL");
  assert.equal(gerr.length, 1);
  assert.match(gerr[0]!, /^rex-grokbot: warning: Tailscale Serve doesn't map \/rex-bridge to the bridge yet\.\n {2}fix: rex-grokbot setup serve$/);

  // Serve status unreadable (target.kind === "unknown"): "couldn't confirm", fix points at doctor.
  const u = await fakeCtx({ stdout: "", stderr: "serve: permission denied", code: 1 });
  const uout: string[] = [];
  const uerr: string[] = [];
  u.ctx.out = (s) => uout.push(s);
  u.ctx.err = (s) => uerr.push(s);
  assert.equal(await urlCommand(u.ctx), 0);
  assert.deepEqual(uout, ["https://mac.tail.ts.net/rex-bridge/mcp"]);
  assert.equal(uerr.length, 1);
  assert.match(uerr[0]!, /^rex-grokbot: warning: couldn't confirm that Tailscale Serve maps \/rex-bridge to the bridge \(serve: permission denied\)\.\n {2}fix: rex-grokbot doctor$/);

  const h = await fakeCtx(ok("{}"));
  h.ctx.tailscale = async () => ({ stdout: "", stderr: "not running", code: 1 });
  assert.equal(await urlCommand(h.ctx), 1);
  assert.match(h.out.join("\n"), /Tailscale is not running[\s\S]*fix: start Tailscale/);
});

test("skills: the pre-0.4.0 rex-bot skill is removed only when it carries our marker", async () => {
  const home = await tempDir();
  const claude = join(home, ".claude");
  const agents = join(home, ".agents");
  const ours = "---\nname: rex-bot\nmetadata:\n  installed-by: rex-bot-bridge\n---\nold\n";
  const theirs = "---\nname: rex-bot\n---\nsomeone else's\n";
  await mkdir(join(claude, "skills/rex-bot"), { recursive: true });
  await writeFile(join(claude, "skills/rex-bot/SKILL.md"), ours);
  await mkdir(join(agents, "skills/rex-bot"), { recursive: true });
  await writeFile(join(agents, "skills/rex-bot/SKILL.md"), theirs);

  const r = await installSkills([claude, agents]);
  assert.deepEqual(r.installed, [join(claude, "skills/rex-grokbot/SKILL.md"), join(agents, "skills/rex-grokbot/SKILL.md")]);
  assert.deepEqual(r.legacyRemoved, [join(claude, "skills/rex-bot/SKILL.md")]);
  await assert.rejects(stat(join(claude, "skills/rex-bot")), "our old skill dir is gone");
  assert.equal(await readFile(join(agents, "skills/rex-bot/SKILL.md"), "utf8"), theirs, "someone else's rex-bot skill is kept");

  // uninstall also cleans an old one of ours left behind.
  await mkdir(join(claude, "skills/rex-bot"), { recursive: true });
  await writeFile(join(claude, "skills/rex-bot/SKILL.md"), ours);
  const removed = await uninstallSkills([claude, agents]);
  assert.deepEqual(removed.sort(), [
    join(agents, "skills/rex-grokbot/SKILL.md"),
    join(claude, "skills/rex-bot/SKILL.md"),
    join(claude, "skills/rex-grokbot/SKILL.md"),
  ].sort());
  assert.equal(await readFile(join(agents, "skills/rex-bot/SKILL.md"), "utf8"), theirs);
});

test("setup on a fresh install has no webhook warning; a configured one still shows ✅", async () => {
  const f = await fakeCtx(ok("{}"));
  const flags = { yes: true, mode: "watched" as const, services: false, serve: false, skills: false, rexConfig: false };
  await setup(f.ctx, flags, makePrompter(true));
  const out = f.out.join("\n");
  assert.ok(!/webhook not set/i.test(out), out);
  assert.ok(!/Webhook configured/.test(out));
  assert.match(out, /2\. Add the routine's webhook: rex-grokbot setup webhook/);
});

test("setup re-run with a configured webhook shows ✅ Webhook configured", async () => {
  const f = await fakeCtx(ok("{}"));
  const flags = { yes: true, mode: "watched" as const, services: false, serve: false, skills: false, rexConfig: false };
  await setup(f.ctx, flags, makePrompter(true));
  const s = await readSettings(f.ctx.paths.configFile);
  await writeSettings(f.ctx.paths.configFile, setKey(s, "webhook.url", "https://hooks.example.test/fake"));
  f.out.length = 0;
  assert.equal(await setup(f.ctx, { ...flags, mode: undefined }, makePrompter(true)), 0, f.out.join("\n"));
  const out = f.out.join("\n");
  assert.match(out, /✅ Webhook configured \(change it: rex-grokbot setup webhook\)/);
  assert.ok(!/webhook not set/i.test(out));
  assert.ok(!out.includes("hooks.example.test"), "the webhook URL is never printed");
});
