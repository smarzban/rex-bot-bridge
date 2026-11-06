#!/usr/bin/env node
// Live end-to-end check against real Rex through a running bridge.
// usage: REX_BRIDGE_TOKEN_FILE=... node scripts/e2e.mjs [http://127.0.0.1:7400]
// Creates one session labelled `bridge-e2e`, exercises the tools on it, and kills it. Touches nothing else.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] || "http://127.0.0.1:7400";
const tokenFile = process.env.REX_BRIDGE_TOKEN_FILE || join(homedir(), ".config/rex-grokbot-bridge/token");
const token = readFileSync(tokenFile, "utf8").trim();
const sharedFile = join(process.env.REX_GROKBOT_DIR || join(homedir(), ".config/rex-grokbot-bridge"), "shared");
const readShared = () => {
  try {
    return readFileSync(sharedFile, "utf8");
  } catch {
    return null;
  }
};

const log = (label, v) => console.log(`\n### ${label}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);
let failures = 0;
const check = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${what}`);
  if (!cond) failures++;
};

// a. auth
const init = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
});
const hdrs = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const noTok = await fetch(base + "/mcp", { method: "POST", headers: hdrs, body: init });
check(noTok.status === 401, `no token -> ${noTok.status}`);
const badTok = await fetch(base + "/mcp", { method: "POST", headers: { ...hdrs, authorization: "Bearer wrong" }, body: init });
check(badTok.status === 401, `wrong token -> ${badTok.status}`);
log("GET /healthz", await (await fetch(base + "/healthz")).json());

const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const { tools } = await client.listTools();
log("tools/list", tools.map((t) => t.name).join(", "));
check(tools.length === 12, `good token -> tools/list returned ${tools.length} tools`);

const callTool = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (block, needle, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    const p = await callTool("read_pane", { block_id: block, lines: 20 });
    if (p.text.includes(needle)) return p;
    await sleep(250);
  }
  return callTool("read_pane", { block_id: block, lines: 20 });
};

log("bridge_status", await callTool("bridge_status"));

const sharedBefore = readShared();
let session;
try {
  // b. spawn shell in a new session, send, read
  const spawned = await callTool("spawn_agent", {
    agent: "shell",
    cwd: "/tmp",
    new_session_label: "bridge-e2e",
    label: "e2e-shell",
    share: false,
  });
  session = spawned.session_id;
  const block = spawned.block_id;
  log("spawn_agent shell (new session bridge-e2e)", spawned);

  const listed = await callTool("list_agents", { session: session });
  log("list_agents (bridge-e2e only)", listed);
  check(listed.sessions[0]?.session_label === "bridge-e2e", "list_agents shows bridge-e2e");

  await sleep(800); // let the login shell draw its prompt
  log("send_message echo hello-bridge (session_id omitted -> resolved)", await callTool("send_message", { block_id: block, text: "echo hello-bridge" }));
  const pane = await waitFor(block, "hello-bridge\n");
  log("read_pane", pane.text);
  check(/^hello-bridge$/m.test(pane.text), "read_pane shows hello-bridge output line");

  // c. OSC 7501 status + wait_for_status
  await callTool("send_message", { block_id: block, session_id: session, text: "printf '\\033]7501;state=done:app=e2e\\033\\\\'" });
  const waited = await callTool("wait_for_status", { block_id: block, states: ["done"], timeout_s: 20 });
  log("wait_for_status [done]", waited);
  check(waited.timed_out === false && waited.status?.state === "done" && waited.status?.app === "e2e", "wait_for_status returned state done");

  // send_keys
  log("send_keys ['ctrl+c']", await callTool("send_keys", { block_id: block, keys: ["ctrl+c"] }));

  // extra: new tab in the same session (rex run path), then close_pane
  const tab = await callTool("spawn_agent", {
    agent: "custom",
    cwd: "/tmp",
    session_id: session,
    label: "e2e-tab",
    command: ["sh", "-c", "echo tab-ok; exec sleep 300"],
    share: false,
  });
  log("spawn_agent custom (new tab in bridge-e2e)", tab);
  const tabPane = await waitFor(tab.block_id, "tab-ok");
  check(tabPane.text.includes("tab-ok"), "custom tab output readable");
  log("close_pane", await callTool("close_pane", { block_id: tab.block_id }));
  const panesLeft = (await callTool("list_agents", { session })).sessions[0].panes.map((p) => p.block_id);
  check(!panesLeft.includes(tab.block_id) && panesLeft.includes(block), "close_pane closed only the tab");

  // d. watch round-trip
  log("share_session", await callTool("share_session", { session_id: session }));
  const lw = await callTool("list_shared");
  log("list_shared", lw);
  check(lw.sessions.includes(session), "list_shared includes bridge-e2e");
  log("unshare_session", await callTool("unshare_session", { session_id: session }));
  check(!(await callTool("list_shared")).sessions.includes(session), "unshared");
  check(readShared() === sharedBefore, "real shared file is byte-identical to before");
} finally {
  // e. cleanup
  if (session) {
    log("close_session", await callTool("close_session", { session_id: session }));
    const after = await callTool("list_agents");
    check(!after.sessions.some((s) => s.session_id === session), "bridge-e2e is gone");
    log("sessions remaining", after.sessions.map((s) => s.session_label).join(", "));
  }
  check(readShared() === sharedBefore, "real shared file unchanged at end");
  await client.close();
}
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);
