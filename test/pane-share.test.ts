// T435: the share list holds sessions and panes. Gating in shared mode, `say` gating, and parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { TOOL_NAMES } from "../src/tools.js";
import { covers, entryKind, parseShared } from "../src/share.js";
import { B1, B2, FakeRex, S1, call, childEnv, connect, startBridge, tempDir } from "./helpers.js";

type Tool = (typeof TOOL_NAMES)[number];
type State = "session" | "pane" | "sibling" | "nothing";
/** What is on the share list. The target is always pane B1 in session S1; B2 is B1's sibling in S1. */
const STATES: Record<State, string[]> = { session: [S1], pane: [B1], sibling: [B2], nothing: [] };

/** Block-scoped: the pane or its session. Session-scoped: the session only. */
const BLOCK: Record<State, boolean> = { session: true, pane: true, sibling: false, nothing: false };
const SESSION: Record<State, boolean> = { session: true, pane: false, sibling: false, nothing: false };
const ALWAYS: Record<State, boolean> = { session: true, pane: true, sibling: true, nothing: true };
const NEVER: Record<State, boolean> = { session: false, pane: false, sibling: false, nothing: false };

const MATRIX: { tool: Tool; args: Record<string, unknown>; allowed: Record<State, boolean>; scope: "pane" | "session" | "bot-watch" | "none" }[] = [
  { tool: "read_pane", args: { block_id: B1 }, allowed: BLOCK, scope: "pane" },
  { tool: "send_message", args: { block_id: B1, text: "hi" }, allowed: BLOCK, scope: "pane" },
  { tool: "send_keys", args: { block_id: B1, keys: ["enter"] }, allowed: BLOCK, scope: "pane" },
  { tool: "wait_for_status", args: { block_id: B1, timeout_s: 1 }, allowed: BLOCK, scope: "pane" },
  { tool: "close_pane", args: { block_id: B1 }, allowed: BLOCK, scope: "pane" },
  { tool: "close_session", args: { session_id: S1 }, allowed: SESSION, scope: "session" },
  { tool: "spawn_agent", args: { agent: "shell", cwd: "/tmp", session_id: S1, share: false }, allowed: SESSION, scope: "session" },
  { tool: "share_session", args: { session_id: S1 }, allowed: NEVER, scope: "bot-watch" },
  { tool: "share_pane", args: { block_id: B1 }, allowed: NEVER, scope: "bot-watch" },
  { tool: "unshare_session", args: { session_id: S1 }, allowed: ALWAYS, scope: "none" },
  { tool: "unshare_pane", args: { block_id: B1 }, allowed: ALWAYS, scope: "none" },
  { tool: "list_agents", args: {}, allowed: ALWAYS, scope: "none" },
  { tool: "list_shared", args: {}, allowed: ALWAYS, scope: "none" },
  { tool: "bridge_status", args: {}, allowed: ALWAYS, scope: "none" },
];

test("the gating matrix covers every tool", () => {
  assert.deepEqual(MATRIX.map((m) => m.tool).sort(), [...TOOL_NAMES].sort());
});

for (const m of MATRIX) {
  for (const state of Object.keys(STATES) as State[]) {
    const expect = m.allowed[state] ? "allowed" : "refused";
    test(`shared mode, ${state === "sibling" ? "only another pane in the session" : state === "pane" ? "only the pane" : state} shared: ${m.tool} ${expect}`, async () => {
      const fake = new FakeRex();
      fake.state = "done"; // wait_for_status settles at once
      const b = await startBridge(fake, "shared", STATES[state]);
      try {
        const client = await connect(b.url);
        const r = await call(client, m.tool, m.args);
        await client.close();
        assert.equal(r.isError, !m.allowed[state], `${m.tool}: ${r.text}`);
        if (r.isError) {
          assert.match(r.text, /isn't shared/);
          assert.match(r.text, /rex-grokbot share add/);
          if (m.scope === "pane") {
            assert.match(r.text, new RegExp(`pane ${B1} isn't shared with the bot \\(nor is its session ${S1}\\)`));
            assert.match(r.text, /Bot: Share \/ Unshare This Pane/);
          }
          if (m.scope === "session") {
            assert.match(r.text, new RegExp(`session ${S1} isn't shared with the bot`));
            assert.match(r.text, /A shared pane alone does not allow session-level actions/);
          }
          if (m.scope === "bot-watch") {
            const id = m.tool === "share_pane" ? B1 : S1;
            assert.match(r.text, /only the person shares/);
            assert.ok(r.text.includes(`rex-grokbot share add ${id}`), `names the real id: ${r.text}`);
            assert.ok(!r.text.includes("<block_id|session_id>"), r.text);
            assert.match(r.text, m.tool === "share_pane" ? /This Pane/ : /This Session/);
          }
        }
      } finally {
        await b.close();
      }
    });
  }

  test(`all mode, nothing shared: ${m.tool} allowed`, async () => {
    const fake = new FakeRex();
    fake.state = "done";
    const b = await startBridge(fake, "all", []);
    try {
      const client = await connect(b.url);
      const r = await call(client, m.tool, m.args);
      await client.close();
      assert.equal(r.isError, false, `${m.tool}: ${r.text}`);
    } finally {
      await b.close();
    }
  });
}

test("shared mode, only the pane shared: refused session actions never reach rex", async () => {
  const fake = new FakeRex();
  const b = await startBridge(fake, "shared", [B1]);
  const client = await connect(b.url);
  await call(client, "close_session", { session_id: S1 });
  await call(client, "spawn_agent", { agent: "shell", cwd: "/tmp", session_id: S1 });
  await call(client, "send_keys", { block_id: B2, keys: ["enter"] });
  assert.equal(fake.calls.filter((c) => c.args[0] === "session" && c.args[1] === "kill").length, 0);
  assert.equal(fake.callsOf("run").length, 0);
  assert.equal(fake.callsOf("send-key").length, 0);
  await client.close();
  await b.close();
});

test("list_agents marks a shared pane, list_shared and bridge_status report both kinds", async () => {
  const b = await startBridge(new FakeRex(), "shared", [B1]);
  const client = await connect(b.url);
  const s1 = (await call(client, "list_agents", { session: S1 })).json.sessions[0];
  assert.equal(s1.shared, false, "the session itself is not shared");
  assert.deepEqual(
    s1.panes.map((p: { block_id: string; shared: boolean }) => [p.block_id, p.shared]),
    [[B1, true], [B2, false]],
  );
  assert.deepEqual((await call(client, "list_shared")).json.panes, [B1]);
  assert.deepEqual((await call(client, "list_shared")).json.sessions, []);
  const st = (await call(client, "bridge_status")).json;
  assert.equal(st.shared_sessions, 0);
  assert.equal(st.shared_panes, 1);
  await client.close();
  await b.close();
});

test("close_pane and close_session drop their entries from the share list", async () => {
  const b = await startBridge(new FakeRex(), "all", [S1, B1, B2]);
  const client = await connect(b.url);
  assert.equal((await call(client, "close_pane", { block_id: B1 })).json.removed_from_share_list, true);
  assert.deepEqual(parseShared(await readFile(b.watchPath, "utf8")), [S1, B2]);
  assert.equal((await call(client, "close_session", { session_id: S1 })).json.removed_from_share_list, true);
  assert.deepEqual(parseShared(await readFile(b.watchPath, "utf8")), []);
  await client.close();
  await b.close();
});

test("shared mode: unshare_pane works, share_pane is refused and leaves the file alone", async () => {
  const b = await startBridge(new FakeRex(), "shared", [B1]);
  const client = await connect(b.url);
  const before = await readFile(b.watchPath, "utf8");
  assert.equal((await call(client, "share_pane", { block_id: B2 })).isError, true);
  assert.equal(await readFile(b.watchPath, "utf8"), before);
  assert.equal((await call(client, "unshare_pane", { block_id: B1 })).json.changed, true);
  assert.deepEqual(parseShared(await readFile(b.watchPath, "utf8")), []);
  await client.close();
  await b.close();
});

// ---------- parsing ----------

test("shared file: sessions and panes parse, junk lines are ignored", () => {
  const content = [
    "# the share list",
    "",
    `  ${S1}   # a whole session`,
    `${B1}# a pane, comment glued on`,
    "junk-without-prefix",
    "window:01a1a7e9-0000",
    "session:",
    "block:",
    `#${B2}`,
    `${B1}`,
  ].join("\n");
  assert.deepEqual(parseShared(content), [S1, B1]);
  assert.equal(entryKind(S1), "session");
  assert.equal(entryKind(B1), "pane");
  assert.equal(entryKind("window:x"), null);
  assert.equal(covers([S1], S1, B2), true, "a shared session covers every pane");
  assert.equal(covers([B1], S1, B1), true, "a shared pane covers itself");
  assert.equal(covers([B1], S1, B2), false, "…but not its sibling");
  assert.equal(covers([B1], null, null), false);
});

// ---------- say ----------

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../src/cli/rex-grokbot.ts");

async function sink() {
  const got: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push(body);
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, close: () => server.close() };
}

async function say(home: string, rexEnv: Record<string, string>, words = ["hello", "bot"]) {
  return run(process.execPath, ["--import", "tsx", CLI, "say", ...words], { env: childEnv({ HOME: home, ...rexEnv }) }).then(
    (r) => ({ ...r, code: 0 }),
    (e: { stdout: string; stderr: string; code: number }) => e,
  );
}

const PANE_ENV = { REX_SESSION: S1, REX_BLOCK: B1 };
const SAY_CASES: { name: string; shared: string; env: Record<string, string>; sent: boolean; stderr: RegExp }[] = [
  { name: "the pane is shared", shared: `${B1}\n`, env: PANE_ENV, sent: true, stderr: /rex-grokbot: sent/ },
  { name: "its session is shared", shared: `${S1}\n`, env: PANE_ENV, sent: true, stderr: /rex-grokbot: sent/ },
  { name: "only another pane is shared", shared: `${B2}\n`, env: PANE_ENV, sent: false, stderr: /not sent: this pane isn't shared with the bot; the person can share it from the Rex palette/ },
  { name: "nothing is shared", shared: "", env: PANE_ENV, sent: false, stderr: /not sent: this pane isn't shared/ },
  { name: "no REX env (outside Rex)", shared: `${S1}\n${B1}\n`, env: {}, sent: false, stderr: /not sent: not running inside a Rex pane/ },
  { name: "REX_SESSION but no REX_BLOCK", shared: `${S1}\n`, env: { REX_SESSION: S1 }, sent: false, stderr: /not sent: not running inside a Rex pane/ },
];

for (const c of SAY_CASES) {
  test(`say: ${c.name} → ${c.sent ? "sent" : "not sent"}, exit 0`, async () => {
    const s = await sink();
    try {
      const home = await tempDir();
      const state = join(home, ".config/rex-grokbot-bridge");
      await mkdir(state, { recursive: true });
      await writeFile(join(state, "config.json"), JSON.stringify({ webhook: { url: s.url } }));
      await writeFile(join(state, "shared"), c.shared);
      const r = await say(home, c.env);
      assert.equal(r.code, 0, "say never fails the caller");
      assert.match(r.stderr, c.stderr);
      assert.equal(r.stderr.trim().split("\n").length, 1, "one stderr line");
      assert.equal(s.got.length, c.sent ? 1 : 0);
      if (c.sent) {
        const body = JSON.parse(s.got[0]!);
        assert.equal(body.event, "agent_message");
        assert.equal(body.text, "hello bot");
        assert.equal(body.rex_block, B1);
        assert.equal(body.rex_session, S1);
      }
    } finally {
      s.close();
    }
  });
}

for (const words of [[], [""], ["   "], ["  ", "\t"]]) {
  test(`say: empty/whitespace message ${JSON.stringify(words)} → not sent, exit 0`, async () => {
    const s = await sink();
    try {
      const home = await tempDir();
      const state = join(home, ".config/rex-grokbot-bridge");
      await mkdir(state, { recursive: true });
      await writeFile(join(state, "config.json"), JSON.stringify({ webhook: { url: s.url } }));
      await writeFile(join(state, "shared"), `${B1}\n`);
      const r = await say(home, PANE_ENV, words);
      assert.equal(r.code, 0, "say never fails the caller");
      assert.match(r.stderr, /^rex-grokbot: not sent: the message is empty/);
      assert.equal(r.stderr.trim().split("\n").length, 1, "one stderr line");
      assert.equal(s.got.length, 0);
    } finally {
      s.close();
    }
  });
}
