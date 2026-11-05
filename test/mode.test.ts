import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TOOL_NAMES } from "../src/tools.js";
import { B1, B3, FakeRex, S1, S2, call, connect, startBridge } from "./helpers.js";

const NEW_SESSION = "session:01a1a7e9-0000-7000-8000-000000000009";

/**
 * One row per tool: args aimed at the watched session S1 (block B1) and at the unwatched S2 (block B3).
 * `unwatched` is the expected outcome in watched mode; in full mode everything is allowed.
 */
const CASES: { tool: (typeof TOOL_NAMES)[number]; watched: Record<string, unknown>; other: Record<string, unknown>; unwatched: "allowed" | "refused" }[] = [
  { tool: "list_agents", watched: {}, other: { session: S2 }, unwatched: "allowed" },
  { tool: "list_watched", watched: {}, other: {}, unwatched: "allowed" },
  { tool: "bridge_status", watched: {}, other: {}, unwatched: "allowed" },
  { tool: "read_pane", watched: { block_id: B1 }, other: { block_id: B3 }, unwatched: "refused" },
  { tool: "send_message", watched: { block_id: B1, text: "hi" }, other: { block_id: B3, text: "hi" }, unwatched: "refused" },
  { tool: "send_keys", watched: { block_id: B1, keys: ["enter"] }, other: { block_id: B3, keys: ["enter"] }, unwatched: "refused" },
  { tool: "wait_for_status", watched: { block_id: B1, timeout_s: 1 }, other: { block_id: B3, timeout_s: 1 }, unwatched: "refused" },
  { tool: "close_pane", watched: { block_id: B1 }, other: { block_id: B3 }, unwatched: "refused" },
  { tool: "close_session", watched: { session_id: S1 }, other: { session_id: S2 }, unwatched: "refused" },
  {
    tool: "spawn_agent",
    watched: { agent: "shell", cwd: "/tmp", session_id: S1, watch: false },
    other: { agent: "shell", cwd: "/tmp", session_id: S2, watch: false },
    unwatched: "refused",
  },
  { tool: "unwatch_session", watched: { session_id: S1 }, other: { session_id: S2 }, unwatched: "allowed" },
];

test("every tool has a gating case", () => {
  const covered = new Set([...CASES.map((c) => c.tool), "watch_session"]);
  assert.deepEqual([...covered].sort(), [...TOOL_NAMES].sort());
});

for (const c of CASES) {
  test(`watched mode: ${c.tool} on a watched session is allowed, on an unwatched one ${c.unwatched}`, async () => {
    const b = await startBridge(new FakeRex(), "watched");
    try {
      const client = await connect(b.url);
      const ok = await call(client, c.tool, c.watched);
      assert.equal(ok.isError, false, `${c.tool} watched: ${ok.text}`);
      const other = await call(client, c.tool, c.other);
      if (c.unwatched === "refused") {
        assert.equal(other.isError, true, `${c.tool} unwatched should be refused`);
        assert.match(other.text, /"watched" mode/);
        assert.match(other.text, /rex-bot watch add/);
      } else {
        assert.equal(other.isError, false, `${c.tool} unwatched: ${other.text}`);
      }
      await client.close();
    } finally {
      await b.close();
    }
  });

  test(`full mode: ${c.tool} works on any session`, async () => {
    const b = await startBridge(new FakeRex(), "full");
    try {
      const client = await connect(b.url);
      for (const args of [c.watched, c.other]) {
        const r = await call(client, c.tool, args);
        assert.equal(r.isError, false, `${c.tool}: ${r.text}`);
      }
      await client.close();
    } finally {
      await b.close();
    }
  });
}

test("watched mode: refused calls never reach rex for the side effect", async () => {
  const fake = new FakeRex();
  const b = await startBridge(fake, "watched");
  const client = await connect(b.url);
  await call(client, "send_message", { block_id: B3, text: "rm -rf ~" });
  await call(client, "close_session", { session_id: S2 });
  assert.equal(fake.pastes().length, 0);
  assert.equal(fake.calls.filter((c) => c.args[0] === "session" && c.args[1] === "kill").length, 0);
  await client.close();
  await b.close();
});

test("watched mode: a watched session id cannot be paired with a block from an unwatched session", async () => {
  const b = await startBridge(new FakeRex(), "watched");
  const client = await connect(b.url);
  const r = await call(client, "send_message", { block_id: B3, session_id: S1, text: "hi" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not in session/);
  await client.close();
  await b.close();
});

test("watched mode: watch_session is refused (only the human opts in); full mode allows it", async () => {
  for (const mode of ["watched", "full"] as const) {
    const b = await startBridge(new FakeRex(), mode);
    const client = await connect(b.url);
    const r = await call(client, "watch_session", { session_id: S2 });
    assert.equal(r.isError, mode === "watched", r.text);
    if (mode === "watched") assert.match(r.text, /only the human/);
    const file = await readFile(b.watchPath, "utf8");
    assert.equal(file.includes(S2), mode === "full");
    await client.close();
    await b.close();
  }
});

test("watched mode: spawn_agent into a new session auto-watches it even with watch=false", async () => {
  const b = await startBridge(new FakeRex(), "watched");
  const client = await connect(b.url);
  const r = await call(client, "spawn_agent", { agent: "shell", cwd: "/tmp", new_session_label: "fresh", watch: false });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.watched, true);
  assert.ok((await readFile(b.watchPath, "utf8")).includes(NEW_SESSION));
  await client.close();
  await b.close();
});

test("bridge_status reports the mode", async () => {
  const b = await startBridge(new FakeRex(), "watched");
  const client = await connect(b.url);
  assert.equal((await call(client, "bridge_status")).json.mode, "watched");
  await client.close();
  await b.close();
});
