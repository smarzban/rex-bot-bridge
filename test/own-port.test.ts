// T431: the bridge gets its own tailnet HTTPS origin (https://<mac>:8443), never a path on the shared :443,
// so another app's /.well-known OAuth metadata can't hijack the connector. Stub tailscale throughout; nothing
// here runs the real `tailscale serve`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runDoctor } from "../src/doctor.js";
import { makePrompter, scriptedPrompter as scripted, type Prompter } from "../src/prompt.js";
import type { RunResult } from "../src/rex.js";
import { DEFAULTS, readSettings, writeSettings } from "../src/settings.js";
import { setup, type SetupFlags } from "../src/setup.js";
import { uninstall } from "../src/uninstall.js";
import { urlCommand } from "../src/credentials.js";
import { fakeCtx } from "./helpers.js";

/** scriptedPrompter that also records every confirm (question and default). */
function scriptedPrompter(answers: Record<string, boolean> = {}) {
  const inner = scripted(answers);
  const asked: { q: string; def: boolean }[] = [];
  const p: Prompter & { asked: typeof asked } = {
    ...inner,
    asked,
    confirm: (q, def) => {
      asked.push({ q, def });
      return inner.confirm(q, def);
    },
  };
  return p;
}
async function writeRawConfig(file: string, raw: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(raw));
}

const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", code: 0 });
const FLAGS: SetupFlags = { yes: false, services: false, serve: true, skills: false, rexConfig: false };
const OURS = { Proxy: "http://127.0.0.1:7400" };
const T3 = { Proxy: "http://127.0.0.1:3773" };

/** A `tailscale serve status --json` with the given :443 and :8443 handlers. */
function serveStatus(on443: Record<string, unknown> | null, on8443: Record<string, unknown> | null, tcp: Record<string, unknown> = {}): RunResult {
  const Web: Record<string, unknown> = {};
  const TCP: Record<string, unknown> = { ...tcp };
  if (on443) {
    Web["mac.tail.ts.net:443"] = { Handlers: on443 };
    TCP["443"] = { HTTPS: true };
  }
  if (on8443) {
    Web["mac.tail.ts.net:8443"] = { Handlers: on8443 };
    TCP["8443"] = { HTTPS: true };
  }
  return ok(JSON.stringify({ TCP, Web }));
}
/** What this Mac looked like on 2026-11-05: T3 Code owns `/` on :443, our legacy path beside it. */
const LEGACY_LIVE = serveStatus({ "/": T3, "/rex-bridge": OURS }, null);

const MAP = ["serve", "--bg", "--https=8443", "http://127.0.0.1:7400"];
const PORT_OFF = ["serve", "--https=8443", "off"];
const LEGACY_OFF = ["serve", "--https=443", "--set-path", "/rex-bridge", "off"];
const changes = (calls: string[][]) => calls.filter((a) => a[0] === "serve" && a[1] !== "status");

/**
 * A fetch that answers like our bridge's /healthz. Only the exact URL doctor must probe,
 * `<origin>/.well-known/oauth-authorization-server`, gets `wellKnown` (404 by default); any other
 * `.well-known` URL gets 200 with OAuth metadata, so probing a mistyped path makes doctor fail.
 * Every URL fetched is recorded in `.urls`.
 */
function bridgeFetch(origin = "https://mac.tail.ts.net:8443", wellKnown = 404): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const oauthJson = () => new Response(JSON.stringify({ issuer: "https://mac.tail.ts.net", authorization_endpoint: "https://mac.tail.ts.net/authorize" }), { status: 200 });
  const f = (async (url: string | URL) => {
    const u = String(url);
    urls.push(u);
    if (u === `${origin}/healthz`) return new Response(JSON.stringify({ ok: true, rex_reachable: true, watcher_heartbeat_age_s: 3 }), { status: 200 });
    if (u === `${origin}/.well-known/oauth-authorization-server`)
      return wellKnown === 404 ? new Response(JSON.stringify({ error: "not found" }), { status: 404 }) : new Response(oauthJson().body, { status: wellKnown });
    if (u.includes("/.well-known/")) return oauthJson();
    throw new Error(`unexpected fetch ${u}`);
  }) as unknown as typeof fetch & { urls: string[] };
  f.urls = urls;
  return f;
}

// ---------- setup serve ----------

test("T431 setup serve: a fresh install maps the whole port 8443 (no --set-path, nothing on :443)", async () => {
  const f = await fakeCtx(ok("{}"));
  assert.equal(await setup(f.ctx, { ...FLAGS, yes: true }, makePrompter(true), "serve"), 0);
  assert.deepEqual(changes(f.tsCalls), [MAP]);
  assert.ok(!f.tsCalls.flat().includes("--set-path"));
  const out = f.out.join("\n");
  assert.match(out, /tailscale serve --bg --https=8443 http:\/\/127\.0\.0\.1:7400/);
  assert.match(out, /✅ https:\/\/mac\.tail\.ts\.net:8443 → http:\/\/127\.0\.0\.1:7400/);
  assert.match(out, /Connector URL: https:\/\/mac\.tail\.ts\.net:8443\/mcp/);
});

test("T431 setup serve: servePort from config.json is used", async () => {
  const f = await fakeCtx(ok("{}"));
  await writeSettings(f.ctx.paths.configFile, { ...DEFAULTS, servePort: 10000 });
  await setup(f.ctx, { ...FLAGS, yes: true }, makePrompter(true), "serve");
  assert.deepEqual(changes(f.tsCalls), [["serve", "--bg", "--https=10000", "http://127.0.0.1:7400"]]);
});

test("T431 setup serve: our port mapping already there → nothing asked, nothing run", async () => {
  const f = await fakeCtx(serveStatus(null, { "/": OURS }));
  const p = scriptedPrompter();
  await setup(f.ctx, FLAGS, p, "serve");
  assert.deepEqual(p.asked, []);
  assert.deepEqual(changes(f.tsCalls), []);
  assert.match(f.out.join("\n"), /Already maps https:\/\/mac\.tail\.ts\.net:8443 → http:\/\/127\.0\.0\.1:7400/);
});

test("T431 setup serve: another app at / on 8443 → asks (default no); --yes refuses; an explicit yes replaces only /", async () => {
  const st = serveStatus(null, { "/": T3 });
  const f = await fakeCtx(st);
  const p = scriptedPrompter();
  await setup(f.ctx, FLAGS, p, "serve");
  assert.equal(p.asked.length, 1, JSON.stringify(p.asked));
  assert.equal(p.asked[0]!.def, false);
  assert.match(p.asked[0]!.q, /Replace it with http:\/\/127\.0\.0\.1:7400/);
  assert.deepEqual(changes(f.tsCalls), [], "interactive default is no");
  assert.match(f.out.join("\n"), /port 8443 is already in use: https:\/\/mac\.tail\.ts\.net:8443\/ → http:\/\/127\.0\.0\.1:3773[\s\S]*fix: pick another port: rex-grokbot config set servePort <port>/);

  const y = await fakeCtx(st);
  await setup(y.ctx, { ...FLAGS, yes: true }, makePrompter(true), "serve");
  assert.deepEqual(changes(y.tsCalls), [], "--yes never replaces");

  const e = await fakeCtx(st);
  await setup(e.ctx, FLAGS, scriptedPrompter({ "Replace it": true }), "serve");
  assert.deepEqual(changes(e.tsCalls), [MAP], "the mapping command replaces `/`; nothing is turned off");
});

for (const [name, st] of [
  ["our / plus another path on 8443", serveStatus(null, { "/": OURS, "/other": T3 })],
  ["another app's path only on 8443", serveStatus(null, { "/app": T3 })],
  ["a raw TCP forward on 8443", serveStatus(null, null, { "8443": { TCPForward: "127.0.0.1:22" } })],
  ["our target over plain HTTP on 8443", ok(JSON.stringify({ TCP: { "8443": { HTTP: true } }, Web: { "mac.tail.ts.net:8443": { Handlers: { "/": OURS } } } }))],
] as [string, RunResult][]) {
  test(`T431 setup serve: ${name} → not offered at all (interactive or --yes); points at another servePort`, async () => {
    for (const [flags, p] of [
      [FLAGS, scriptedPrompter({ "Replace it": true, anyway: true })],
      [{ ...FLAGS, yes: true }, makePrompter(true)],
    ] as [SetupFlags, Prompter][]) {
      const f = await fakeCtx(st);
      assert.equal(await setup(f.ctx, flags, p, "serve"), 0);
      assert.deepEqual(changes(f.tsCalls), []);
      assert.match(f.out.join("\n"), /port 8443 is already in use: .*Setup won't change it\.\n {6}fix: pick another port: rex-grokbot config set servePort <port>/);
    }
  });
}

// ---------- migration from the ≤ 0.4 /rex-bridge path on :443 ----------

test("T431 migration: once the new origin answers, setup removes only our /rex-bridge path on :443", async () => {
  const f = await fakeCtx(LEGACY_LIVE);
  f.ctx.fetch = bridgeFetch();
  assert.equal(await setup(f.ctx, { ...FLAGS, yes: true }, makePrompter(true), "serve"), 0);
  assert.deepEqual(changes(f.tsCalls), [MAP, LEGACY_OFF]);
  // Never `/` on 443, never a whole-port off of 443.
  assert.ok(!changes(f.tsCalls).some((a) => a.includes("--https=443") && !a.includes("--set-path")));
  const out = f.out.join("\n");
  assert.match(out, /old mapping https:\/\/mac\.tail\.ts\.net\/rex-bridge → http:\/\/127\.0\.0\.1:7400 \(0\.4 and earlier\)/);
  assert.match(out, /✅ Removed the old mapping https:\/\/mac\.tail\.ts\.net\/rex-bridge/);
  assert.match(out, /connector URL changed: set the rex connector in Grok Bot to https:\/\/mac\.tail\.ts\.net:8443\/mcp/);
});

test("T431 migration: interactive asks with default yes; a no keeps it and prints the off command", async () => {
  const f = await fakeCtx(serveStatus({ "/": T3, "/rex-bridge": OURS }, { "/": OURS }));
  f.ctx.fetch = bridgeFetch();
  const p = scriptedPrompter({ "Remove the old": false });
  await setup(f.ctx, FLAGS, p, "serve");
  const q = p.asked.find((a) => a.q.includes("Remove the old /rex-bridge mapping on port 443"));
  assert.ok(q, JSON.stringify(p.asked));
  assert.deepEqual(changes(f.tsCalls), []);
  assert.match(f.out.join("\n"), /Old mapping left in place\.\n {6}fix: tailscale serve --https=443 --set-path \/rex-bridge off/);

  const d = await fakeCtx(serveStatus({ "/": T3, "/rex-bridge": OURS }, { "/": OURS }));
  d.ctx.fetch = bridgeFetch();
  const dp = scriptedPrompter();
  await setup(d.ctx, FLAGS, dp, "serve");
  assert.equal(dp.asked.find((a) => a.q.includes("Remove the old"))?.def, true);
  assert.deepEqual(changes(d.tsCalls), [LEGACY_OFF], "the default answer removes it");
});

test("T431 migration: the new origin not answering → legacy path kept, fix line printed", async () => {
  const f = await fakeCtx(LEGACY_LIVE); // fakeCtx's fetch throws: no network
  await setup(f.ctx, { ...FLAGS, yes: true }, makePrompter(true), "serve");
  assert.deepEqual(changes(f.tsCalls), [MAP]);
  assert.match(f.out.join("\n"), /Kept it for now: https:\/\/mac\.tail\.ts\.net:8443\/healthz didn't answer[\s\S]*tailscale serve --https=443 --set-path \/rex-bridge off/);
});

test("T431 migration: a foreign /rex-bridge on :443, or none, is never touched or mentioned", async () => {
  for (const st of [serveStatus({ "/": T3, "/rex-bridge": { Proxy: "http://127.0.0.1:9999" } }, null), serveStatus({ "/": T3 }, null)]) {
    const f = await fakeCtx(st);
    f.ctx.fetch = bridgeFetch();
    await setup(f.ctx, { ...FLAGS, yes: true }, makePrompter(true), "serve");
    assert.deepEqual(changes(f.tsCalls), [MAP]);
    assert.ok(!/old mapping/i.test(f.out.join("\n")));
  }
});

test("T431 migration: a custom legacy servePath from an old config.json is the one removed", async () => {
  const f = await fakeCtx(serveStatus({ "/": T3, "/bridge": OURS }, null));
  f.ctx.fetch = bridgeFetch();
  await writeRawConfig(f.ctx.paths.configFile, { mode: "watched", port: 7400, servePath: "/bridge" });
  await setup(f.ctx, { ...FLAGS, yes: true }, makePrompter(true), "serve");
  assert.deepEqual(changes(f.tsCalls), [MAP, ["serve", "--https=443", "--set-path", "/bridge", "off"]]);
});

test("T431 settings: an old config.json keeps servePath for migration; a bad servePort falls back to 8443", async () => {
  const f = await fakeCtx(ok("{}"));
  await writeRawConfig(f.ctx.paths.configFile, { mode: "full", servePath: "/rex-bridge", servePort: 443 });
  const s = await readSettings(f.ctx.paths.configFile);
  assert.deepEqual([s.servePath, s.servePort, s.mode], ["/rex-bridge", 8443, "full"]);
});

// ---------- uninstall ----------

test("T431 uninstall --serve-off: removes our port mapping and our legacy path; never / or foreign", async () => {
  const run = async (st: RunResult, flags = { yes: true, serveOff: true }, p = makePrompter(true)) => {
    const f = await fakeCtx(st);
    await uninstall(f.ctx, { ...flags, purge: false }, p);
    return { calls: changes(f.tsCalls), out: f.out.join("\n") };
  };
  assert.deepEqual((await run(serveStatus({ "/": T3, "/rex-bridge": OURS }, { "/": OURS }))).calls, [PORT_OFF, LEGACY_OFF]);
  assert.deepEqual((await run(serveStatus({ "/": T3, "/rex-bridge": { Proxy: "http://127.0.0.1:9999" } }, { "/": OURS }))).calls, [PORT_OFF]);
  assert.deepEqual((await run(serveStatus({ "/": T3 }, { "/": T3 }))).calls, [], "foreign port and no legacy");
  assert.deepEqual((await run(serveStatus({ "/": OURS }, null))).calls, [], "`/` on 443 is never ours to remove");

  const kept = await run(serveStatus({ "/rex-bridge": OURS }, { "/": OURS }), { yes: true, serveOff: false });
  assert.deepEqual(kept.calls, [], "--yes without --serve-off");
  assert.match(kept.out, /Tailscale Serve port 8443 left in place\. Remove it with: tailscale serve --https=8443 off/);
  assert.match(kept.out, /\/rex-bridge on port 443 \(0\.4 and earlier\) left in place\. Remove it with: tailscale serve --https=443 --set-path \/rex-bridge off/);

  const asked = await run(serveStatus(null, { "/": OURS }), { yes: false, serveOff: false }, scriptedPrompter({ "Remove the Tailscale Serve mapping port 8443": true }));
  assert.deepEqual(asked.calls, [PORT_OFF]);
});

// ---------- url ----------

test("T431 url: https://<mac>:<servePort>/mcp", async () => {
  const f = await fakeCtx(serveStatus(null, { "/": OURS }));
  const out: string[] = [];
  const err: string[] = [];
  f.ctx.out = (s) => out.push(s);
  f.ctx.err = (s) => err.push(s);
  assert.equal(await urlCommand(f.ctx), 0);
  assert.deepEqual([out, err], [["https://mac.tail.ts.net:8443/mcp"], []]);

  const g = await fakeCtx(serveStatus({ "/rex-bridge": OURS }, null)); // only the legacy mapping
  const gout: string[] = [];
  const gerr: string[] = [];
  g.ctx.out = (s) => gout.push(s);
  g.ctx.err = (s) => gerr.push(s);
  await writeSettings(g.ctx.paths.configFile, { ...DEFAULTS, servePort: 10000 });
  assert.equal(await urlCommand(g.ctx), 0);
  assert.deepEqual(gout, ["https://mac.tail.ts.net:10000/mcp"]);
  assert.match(gerr.join("\n"), /doesn't map port 10000 to the bridge yet/);
});

// ---------- doctor ----------

const check = async (st: RunResult, f2?: typeof fetch) => {
  const f = await fakeCtx(st);
  if (f2) f.ctx.fetch = f2;
  const checks = await runDoctor(f.ctx, { testWebhook: false });
  return (id: string) => checks.find((c) => c.id === id);
};

test("T431 bridgeFetch stub: only the exact probe path is 404; any other .well-known URL serves OAuth JSON", async () => {
  const f = bridgeFetch();
  assert.equal((await f("https://mac.tail.ts.net:8443/.well-known/oauth-authorization-server")).status, 404);
  for (const u of [
    "https://mac.tail.ts.net:8443/.well-known/oauth-authorisation-server",
    "https://mac.tail.ts.net:8443/.well-known/oauth-protected-resource",
    "https://mac.tail.ts.net:8443/.well-known/oauth-authorization-server/mcp",
    "https://mac.tail.ts.net/.well-known/oauth-authorization-server",
  ]) {
    const r = await f(u);
    assert.equal(r.status, 200, u);
    assert.ok((await r.json()).authorization_endpoint, u);
  }
});

test("T431 doctor: port mapping, tailnet healthz and no OAuth metadata on our origin → all ok", async () => {
  const fetchStub = bridgeFetch();
  const c = await check(serveStatus({ "/": T3 }, { "/": OURS }), fetchStub);
  assert.deepEqual(
    fetchStub.urls.filter((u) => u.includes("/.well-known/")),
    ["https://mac.tail.ts.net:8443/.well-known/oauth-authorization-server"],
    "doctor probes exactly this URL",
  );
  assert.equal(c("serve")?.level, "ok");
  assert.match(c("serve")!.detail, /https:\/\/mac\.tail\.ts\.net:8443 → http:\/\/127\.0\.0\.1:7400/);
  assert.equal(c("bridge_tailnet")?.level, "ok");
  assert.equal(c("oauth_discovery")?.level, "ok");
  assert.match(c("oauth_discovery")!.detail, /oauth-authorization-server → 404/);
  assert.equal(c("serve_legacy"), undefined, "no legacy mapping, no warning");
});

test("T431 doctor: OAuth metadata answering on our origin is a failure", async () => {
  const c = await check(serveStatus(null, { "/": OURS }), bridgeFetch(undefined, 200));
  assert.equal(c("oauth_discovery")?.level, "fail");
  assert.match(c("oauth_discovery")!.detail, /answered HTTP 200 \(expected 404\)/);
});

test("T431 doctor: our leftover /rex-bridge on :443 is ⚠️ with the exact off command; a foreign one is ignored", async () => {
  const c = await check(LEGACY_LIVE);
  assert.equal(c("serve_legacy")?.level, "warn");
  assert.equal(c("serve_legacy")?.fix, "tailscale serve --https=443 --set-path /rex-bridge off");
  assert.equal(c("serve")?.level, "fail", "the port isn't mapped yet");
  assert.equal(c("serve")?.fix, "tailscale serve --bg --https=8443 http://127.0.0.1:7400");

  const d = await check(serveStatus({ "/": T3, "/rex-bridge": { Proxy: "http://127.0.0.1:9999" } }, { "/": OURS }));
  assert.equal(d("serve_legacy"), undefined);
});

test("T431 doctor: another app on our port → fail, fix is to pick another servePort", async () => {
  const c = await check(serveStatus(null, { "/": T3 }));
  assert.equal(c("serve")?.level, "fail");
  assert.match(c("serve")!.detail, /port 8443 → http:\/\/127\.0\.0\.1:3773 \(expected only http:\/\/127\.0\.0\.1:7400\)/);
  assert.match(c("serve")!.fix!, /rex-grokbot config set servePort/);
  assert.equal(c("oauth_discovery"), undefined);
});
