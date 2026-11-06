import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TOOL_NAMES } from "../src/tools.js";
import { B1, B3, FakeRex, S1, S2, call, connect, startBridge } from "./helpers.js";

const NEW_SESSION = "session:01a1a7e9-0000-7000-8000-000000000009";

/**
 * One row per tool: args aimed at the shared session S1 (block B1) and at the unshared S2 (block B3).
 * `unshared` is the expected outcome in shared mode; in all mode everything is allowed.
 */
const CASES: { tool: (typeof TOOL_NAMES)[number]; shared: Record<string, unknown>; other: Record<string, unknown>; unshared: "allowed" | "refused" }[] = [
  { tool: "list_agents", shared: {}, other: { session: S2 }, unshared: "allowed" },
  { tool: "list_shared", shared: {}, other: {}, unshared: "allowed" },
  { tool: "bridge_status", shared: {}, other: {}, unshared: "allowed" },
  { tool: "read_pane", shared: { block_id: B1 }, other: { block_id: B3 }, unshared: "refused" },
  { tool: "send_message", shared: { block_id: B1, text: "hi" }, other: { block_id: B3, text: "hi" }, unshared: "refused" },
  { tool: "send_keys", shared: { block_id: B1, keys: ["enter"] }, other: { block_id: B3, keys: ["enter"] }, unshared: "refused" },
  { tool: "wait_for_status", shared: { block_id: B1, timeout_s: 1 }, other: { block_id: B3, timeout_s: 1 }, unshared: "refused" },
  { tool: "close_pane", shared: { block_id: B1 }, other: { block_id: B3 }, unshared: "refused" },
  { tool: "close_session", shared: { session_id: S1 }, other: { session_id: S2 }, unshared: "refused" },
  {
    tool: "spawn_agent",
    shared: { agent: "shell", cwd: "/tmp", session_id: S1, share: false },
    other: { agent: "shell", cwd: "/tmp", session_id: S2, share: false },
    unshared: "refused",
  },
  { tool: "unshare_session", shared: { session_id: S1 }, other: { session_id: S2 }, unshared: "allowed" },
];

test("every tool has a gating case", () => {
  const covered = new Set([...CASES.map((c) => c.tool), "share_session", "share_pane", "unshare_pane"]);
  assert.deepEqual([...covered].sort(), [...TOOL_NAMES].sort());
});

for (const c of CASES) {
  test(`shared mode: ${c.tool} on a shared session is allowed, on an unshared one ${c.unshared}`, async () => {
    const b = await startBridge(new FakeRex(), "shared");
    try {
      const client = await connect(b.url);
      const ok = await call(client, c.tool, c.shared);
      assert.equal(ok.isError, false, `${c.tool} shared: ${ok.text}`);
      const other = await call(client, c.tool, c.other);
      if (c.unshared === "refused") {
        assert.equal(other.isError, true, `${c.tool} unshared should be refused`);
        assert.match(other.text, /isn't shared with the bot/);
        assert.match(other.text, /rex-grokbot share add/);
      } else {
        assert.equal(other.isError, false, `${c.tool} unshared: ${other.text}`);
      }
      await client.close();
    } finally {
      await b.close();
    }
  });

  test(`all mode: ${c.tool} works on any session`, async () => {
    const b = await startBridge(new FakeRex(), "all");
    try {
      const client = await connect(b.url);
      for (const args of [c.shared, c.other]) {
        const r = await call(client, c.tool, args);
        assert.equal(r.isError, false, `${c.tool}: ${r.text}`);
      }
      await client.close();
    } finally {
      await b.close();
    }
  });
}

test("shared mode: refused calls never reach rex for the side effect", async () => {
  const fake = new FakeRex();
  const b = await startBridge(fake, "shared");
  const client = await connect(b.url);
  await call(client, "send_message", { block_id: B3, text: "rm -rf ~" });
  await call(client, "close_session", { session_id: S2 });
  assert.equal(fake.pastes().length, 0);
  assert.equal(fake.calls.filter((c) => c.args[0] === "session" && c.args[1] === "kill").length, 0);
  await client.close();
  await b.close();
});

test("shared mode: a shared session id cannot be paired with a block from an unshared session", async () => {
  const b = await startBridge(new FakeRex(), "shared");
  const client = await connect(b.url);
  const r = await call(client, "send_message", { block_id: B3, session_id: S1, text: "hi" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not in session/);
  await client.close();
  await b.close();
});

test("shared mode: share_session is refused (only the person shares); all mode allows it", async () => {
  for (const mode of ["shared", "all"] as const) {
    const b = await startBridge(new FakeRex(), mode);
    const client = await connect(b.url);
    const r = await call(client, "share_session", { session_id: S2 });
    assert.equal(r.isError, mode === "shared", r.text);
    if (mode === "shared") assert.match(r.text, /only the person shares/);
    const file = await readFile(b.watchPath, "utf8");
    assert.equal(file.includes(S2), mode === "all");
    await client.close();
    await b.close();
  }
});

test("shared mode: spawn_agent into a new session auto-watches it even with share=false", async () => {
  const b = await startBridge(new FakeRex(), "shared");
  const client = await connect(b.url);
  const r = await call(client, "spawn_agent", { agent: "shell", cwd: "/tmp", new_session_label: "fresh", share: false });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.shared, true);
  assert.ok((await readFile(b.watchPath, "utf8")).includes(NEW_SESSION));
  await client.close();
  await b.close();
});

test("bridge_status reports the mode", async () => {
  const b = await startBridge(new FakeRex(), "shared");
  const client = await connect(b.url);
  assert.equal((await call(client, "bridge_status")).json.mode, "shared");
  await client.close();
  await b.close();
});
