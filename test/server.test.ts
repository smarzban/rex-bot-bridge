import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TOOL_NAMES } from "../src/tools.js";
import { agentArgv } from "../src/ops.js";
import { B1, B2, S1, TOKEN, FakeRex, call, connect, startBridge } from "./helpers.js";

let bridge: Awaited<ReturnType<typeof startBridge>>;
before(async () => {
  bridge = await startBridge();
});
after(async () => bridge.close());

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});
const post = (headers: Record<string, string>) =>
  fetch(bridge.url + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: initBody,
  });

test("auth: missing token -> 401", async () => {
  const r = await post({});
  assert.equal(r.status, 401);
});

test("auth: wrong token -> 401", async () => {
  assert.equal((await post({ authorization: "Bearer nope" })).status, 401);
  assert.equal((await post({ authorization: `Basic ${TOKEN}` })).status, 401);
});

test("auth: good token -> 200", async () => {
  const r = await post({ authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200);
});

test("auth: a path prefix in front of /mcp (a proxy that adds one) works too", async () => {
  const r = await fetch(bridge.url + "/rex-bridge/mcp", { method: "POST", body: initBody });
  assert.equal(r.status, 401);
});

test("T431 auth: the 401 on /mcp is a plain Bearer challenge with no resource_metadata", async () => {
  const r = await post({});
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("www-authenticate"), 'Bearer realm="rex-grokbot-bridge"');
  assert.deepEqual(await r.json(), { error: "unauthorized" });
});

test("T431 .well-known: every OAuth discovery path is a JSON 404 (never 401, never metadata)", async () => {
  const paths = [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/openid-configuration",
    "/.well-known/anything/healthz",
    "/rex-bridge/.well-known/oauth-protected-resource/mcp",
  ];
  for (const path of paths) {
    for (const method of ["GET", "POST", "OPTIONS"]) {
      const r = await fetch(bridge.url + path, { method, headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.equal(r.headers.get("content-type"), "application/json");
      assert.equal(r.headers.get("www-authenticate"), null, `${method} ${path}`);
      assert.deepEqual(await r.json(), { error: "not found" });
    }
  }
  // The SDK's fallback endpoints when no metadata is found are plain 404s too.
  for (const path of ["/authorize", "/token", "/register", "/"]) {
    assert.equal((await fetch(bridge.url + path, { method: "POST" })).status, 404, path);
  }
});

test("healthz needs no auth and returns only ok/rex_reachable/heartbeat", async () => {
  const r = await fetch(bridge.url + "/healthz");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(Object.keys(body).sort(), ["ok", "rex_reachable", "watcher_heartbeat_age_s"]);
  assert.equal(body.rex_reachable, true);
});

test("healthz caches the rex probe for 5s and coalesces concurrent hits into one subprocess", async () => {
  const b = await startBridge();
  try {
    const probes = () => b.fake.calls.filter((c) => c.args[2] === "server.version").length;
    const burst = await Promise.all(Array.from({ length: 20 }, () => fetch(b.url + "/healthz").then((r) => r.json())));
    assert.ok(burst.every((h) => h.rex_reachable === true));
    assert.equal(probes(), 1, "20 concurrent hits -> 1 rex call");
    b.clock.t += 4_000;
    await fetch(b.url + "/healthz");
    assert.equal(probes(), 1, "still cached at 4s");
    b.clock.t += 2_000;
    await fetch(b.url + "/healthz");
    assert.equal(probes(), 2, "re-probed after 5s");
  } finally {
    await b.close();
  }
});

test("unknown path -> 404", async () => {
  assert.equal((await fetch(bridge.url + "/other")).status, 404);
});

test("tools/list returns every tool", async () => {
  const client = await connect(bridge.url);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  await client.close();
});

test("list_agents reports panes, process name (argv0 not version), status and watched flag", async () => {
  const client = await connect(bridge.url);
  const r = await call(client, "list_agents");
  assert.equal(r.isError, false, r.text);
  const s = r.json.sessions[0];
  assert.equal(s.session_id, S1);
  assert.equal(s.watched, true);
  assert.equal(s.panes[0].process.name, "claude");
  assert.equal(s.panes[0].window_label, "main");
  assert.equal(s.panes[0].status.state, "idle");
  assert.equal(s.panes[1].status, null);
  await client.close();
});

test("arg validation rejects bad ids, keys, line counts and spawn combos", async () => {
  const client = await connect(bridge.url);
  const bad: [string, Record<string, unknown>][] = [
    ["read_pane", { block_id: "--help" }],
    ["read_pane", { block_id: B1, lines: 5000 }],
    ["read_pane", { block_id: B1, lines: 0 }],
    ["send_keys", { block_id: B1, keys: ["enter; rm -rf /"] }],
    ["send_keys", { block_id: B1, keys: [] }],
    ["send_message", { block_id: B1, text: "" }],
    ["close_session", { session_id: "work" }],
    ["wait_for_status", { block_id: B1, timeout_s: 601 }],
    ["wait_for_status", { block_id: B1, states: ["sleeping"] }],
    ["spawn_agent", { agent: "vim", cwd: "/tmp", new_session_label: "x" }],
    ["spawn_agent", { agent: "shell", cwd: "/tmp" }],
    ["spawn_agent", { agent: "shell", cwd: "/tmp", session_id: S1, new_session_label: "x" }],
    ["spawn_agent", { agent: "custom", cwd: "/tmp", new_session_label: "x" }],
    ["spawn_agent", { agent: "claude", cwd: "/tmp", new_session_label: "x", command: ["sh"] }],
    ["spawn_agent", { agent: "claude", cwd: "relative/dir", new_session_label: "x" }],
    ["spawn_agent", { agent: "claude", cwd: "/definitely/not/here", new_session_label: "x" }],
    ["spawn_agent", { agent: "claude", cwd: "/tmp", new_session_label: "--evil" }],
  ];
  for (const [name, args] of bad) {
    const r = await call(client, name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} should fail: ${r.text}`);
  }
  assert.equal(bridge.fake.callsOf("new").length + bridge.fake.callsOf("run").length, 0, "nothing spawned");
  assert.equal(bridge.fake.callsOf("send-key").length, 0);
  await client.close();
});

test("send_keys accepts Rex key names", async () => {
  const client = await connect(bridge.url);
  const r = await call(client, "send_keys", { block_id: B1, keys: ["escape", "ctrl+c", "1", "enter", "[KeyQ]"] });
  assert.equal(r.isError, false, r.text);
  const sent = bridge.fake.callsOf("send-key").at(-1)!.args;
  assert.deepEqual(sent.slice(sent.indexOf("--") + 1), ["escape", "ctrl+c", "1", "enter", "[KeyQ]"]);
  await client.close();
});

test("send_message: delivers the exact text as one paste event (JSON on stdin), then enter", async () => {
  const client = await connect(bridge.url);
  const text = "--not-a-flag\nline two with \"quotes\" and $(subshell)\nhéllo 世界 🎉\n\tindented " + "x".repeat(3000);
  const before = bridge.fake.pastes().length;
  const r = await call(client, "send_message", { block_id: B2, text });
  assert.equal(r.isError, false, r.text);
  const pastes = bridge.fake.pastes();
  assert.equal(pastes.length, before + 1);
  assert.deepEqual(pastes.at(-1), { session_id: S1, block_id: B2, event: { type: "paste", payload: { text } } });
  const pasteCall = bridge.fake.calls.findLast((c) => c.args[2] === "block.event")!;
  assert.deepEqual(pasteCall.args, ["api", "call", "block.event", "-"], "text is never in argv");
  // enter comes after the paste
  const iPaste = bridge.fake.calls.lastIndexOf(pasteCall);
  const enter = bridge.fake.calls.slice(iPaste + 1).find((c) => c.args[0] === "send-key")!;
  assert.deepEqual(enter.args, ["send-key", "-s", S1, "-b", B2, "--", "enter"]);
  assert.equal(bridge.fake.callsOf("send").length, 0, "raw keystroke `rex send` is not used");
  await client.close();
});

test("send_message submit=false pastes without enter", async () => {
  const client = await connect(bridge.url);
  const keysBefore = bridge.fake.callsOf("send-key").length;
  const r = await call(client, "send_message", { block_id: B2, session_id: S1, text: "draft", submit: false });
  assert.equal(r.isError, false, r.text);
  assert.equal(bridge.fake.pastes().at(-1)!.event.payload.text, "draft");
  assert.equal(bridge.fake.callsOf("send-key").length, keysBefore);
  await client.close();
});

test("send_message require_idle refuses while working, allows when idle", async () => {
  const client = await connect(bridge.url);
  const sendsBefore = bridge.fake.pastes().length;
  bridge.fake.state = "working";
  const refused = await call(client, "send_message", { block_id: B1, session_id: S1, text: "hi", require_idle: true });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /refused: pane .* is working/);
  assert.equal(bridge.fake.pastes().length, sendsBefore, "nothing sent");
  bridge.fake.state = "idle";
  const ok = await call(client, "send_message", { block_id: B1, session_id: S1, text: "hi", require_idle: true });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(bridge.fake.pastes().length, sendsBefore + 1);
  await client.close();
});

test("read_pane returns the tail", async () => {
  const client = await connect(bridge.url);
  const r = await call(client, "read_pane", { block_id: B1, lines: 3 });
  assert.equal(r.json.text, "line 198\nline 199\nline 200");
  assert.equal(r.json.total_lines, 200);
  await client.close();
});

test("read_pane on unknown block gives a clear error", async () => {
  const client = await connect(bridge.url);
  const r = await call(client, "read_pane", { block_id: "block:01a1a7e9-ffff-7000-8000-ffffffffffff" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not found in any session/);
  await client.close();
});

test("wait_for_status returns once a target state is reached, or times out", async () => {
  const client = await connect(bridge.url);
  bridge.fake.statusSequence = ["working", "working", "done"];
  const r = await call(client, "wait_for_status", { block_id: B1, session_id: S1, timeout_s: 5 });
  assert.equal(r.json.timed_out, false);
  assert.equal(r.json.status.state, "done");
  bridge.fake.state = "working";
  const startClock = bridge.clock.t;
  const wallStart = Date.now();
  const t = await call(client, "wait_for_status", { block_id: B1, session_id: S1, timeout_s: 600 });
  assert.equal(t.json.timed_out, true);
  assert.equal(t.json.status.state, "working", "last record seen is returned");
  assert.equal(bridge.clock.t - startClock, 600_000, "waited exactly the timeout on the fake clock");
  assert.ok(Date.now() - wallStart < 2000, "no real waiting");
  bridge.fake.state = "idle";
  await client.close();
});

test("spawn_agent maps agents to argv and adds to watch list", async () => {
  const client = await connect(bridge.url);
  const r = await call(client, "spawn_agent", {
    agent: "claude",
    cwd: "/tmp",
    prompt: "fix the tests",
    new_session_label: "job",
    label: "worker",
  });
  assert.equal(r.isError, false, r.text);
  const nw = bridge.fake.callsOf("new").at(-1)!.args;
  assert.deepEqual(nw, ["new", "job", "-c", "/tmp", "--json", "--keep-open", "--", "claude", "fix the tests"]);
  assert.ok(bridge.fake.calls.some((c) => c.args[1] === "rename" && c.args.at(-1) === "worker"));
  assert.match(await readFile(bridge.watchPath, "utf8"), new RegExp(r.json.session_id));

  const shell = await call(client, "spawn_agent", { agent: "shell", cwd: "/tmp", session_id: S1, watch: false });
  assert.equal(shell.isError, false, shell.text);
  const run = bridge.fake.callsOf("run").at(-1)!.args;
  assert.deepEqual(run.slice(0, 7), ["run", "-s", S1, "-c", "/tmp", "--focus=false", "--keep-open"]);
  assert.equal(run.at(-1), "-l");
  await client.close();
});

test("agentArgv mapping", () => {
  assert.deepEqual(agentArgv("codex", "do x"), ["codex", "do x"]);
  assert.deepEqual(agentArgv("pi"), ["pi"]);
  assert.deepEqual(agentArgv("grok", "go"), ["grok", "go"]);
  assert.deepEqual(agentArgv("shell"), []);
  assert.deepEqual(agentArgv("custom", undefined, ["htop"]), ["htop"]);
  assert.throws(() => agentArgv("claude", "-p hack"));
});

test("watch/unwatch/list_watched round-trip preserves the file", async () => {
  const client = await connect(bridge.url);
  const before = await readFile(bridge.watchPath, "utf8");
  const id = "session:01a1a7e9-0000-7000-8000-0000000000ee";
  assert.equal((await call(client, "watch_session", { session_id: id })).json.changed, true);
  assert.ok((await call(client, "list_watched")).json.watched.includes(id));
  assert.equal((await call(client, "unwatch_session", { session_id: id })).json.changed, true);
  assert.equal(await readFile(bridge.watchPath, "utf8"), before);
  await client.close();
});

test("audit log records calls, truncates text, never contains the token", async () => {
  const client = await connect(bridge.url);
  await call(client, "send_message", { block_id: B2, session_id: S1, text: "y".repeat(1000) });
  await client.close();
  const log = await readFile(bridge.auditPath, "utf8");
  assert.ok(!log.includes(TOKEN));
  const last = JSON.parse(log.trim().split("\n").at(-1)!);
  assert.equal(last.tool, "send_message");
  assert.equal(last.ok, true);
  assert.ok(last.args.text.length < 220);
  assert.equal(typeof last.duration_ms, "number");
  assert.ok(last.timestamp);
});

test("audit log records failed calls with ok=false and the error", async () => {
  const client = await connect(bridge.url);
  const missing = "block:01a1a7e9-ffff-7000-8000-fffffffffff0";
  const r = await call(client, "close_pane", { block_id: missing });
  assert.equal(r.isError, true);
  await client.close();
  const last = JSON.parse((await readFile(bridge.auditPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(last.tool, "close_pane");
  assert.equal(last.ok, false);
  assert.match(last.error, /not found in any session/);
  assert.equal(last.args.block_id, missing);
});

test("audit log truncates array args (custom command argv)", async () => {
  const client = await connect(bridge.url);
  const command = ["sh", "-c", "z".repeat(1000), ...Array.from({ length: 30 }, (_, i) => `a${i}`)];
  const r = await call(client, "spawn_agent", { agent: "custom", cwd: "/tmp", session_id: S1, command, watch: false });
  assert.equal(r.isError, false, r.text);
  await client.close();
  const last = JSON.parse((await readFile(bridge.auditPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(last.tool, "spawn_agent");
  assert.equal(last.args.command.length, 21, "20 items + overflow marker");
  assert.ok(last.args.command[2].length < 220);
  assert.match(last.args.command[20], /\+13 more/);
  // the real call still got the full argv
  assert.equal(bridge.fake.callsOf("run").at(-1)!.args.at(-1), "a29");
});

test("a failing rex call surfaces as a tool error with rex's message", async () => {
  const fake = new FakeRex();
  const orig = fake.runner;
  fake.runner = async (args, opts) =>
    args[0] === "capture" ? { stdout: "", stderr: "Error: terminal is gone\nmore detail", code: 2 } : orig(args, opts);
  const b = await startBridge(fake);
  try {
    const client = await connect(b.url);
    const r = await call(client, "read_pane", { block_id: B1, session_id: S1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /rex capture -s failed: Error: terminal is gone$/);
    await client.close();
  } finally {
    await b.close();
  }
});
