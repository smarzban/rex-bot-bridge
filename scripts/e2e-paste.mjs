#!/usr/bin/env node
// Live check that send_message delivers a long prompt intact to a real Claude Code TUI.
// usage: REX_BRIDGE_TOKEN_FILE=... node scripts/e2e-paste.mjs [http://127.0.0.1:7400]
// Creates one session `bridge-paste-e2e` in a fresh empty temp dir, runs `claude` there, and kills the session.
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] || "http://127.0.0.1:7400";
const token = readFileSync(
  process.env.REX_BRIDGE_TOKEN_FILE || join(homedir(), ".config/rex-grokbot-bridge/token"),
  "utf8",
).trim();
const client = new Client({ name: "e2e-paste", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const callTool = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (label, v) => console.log(`\n### ${label}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`);
let failures = 0;
const check = (cond, what) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${what}`);
  if (!cond) failures++;
};

// ~2000-char prompt ending with the required instruction. Markers at the start and middle, plus a word
// count close to the real one, prove the whole prompt arrived, not just its tail.
const filler = Array.from(
  { length: 18 },
  (_, i) => `Sentence ${i + 1} is filler text that pads this message so it is long enough to test paste delivery.`,
);
filler.splice(0, 0, "The opening marker word is ALPHA-HEAD.");
filler.splice(10, 0, "The middle marker word is BRAVO-MID.");
const body = filler.join(" ");
const tail = "Reply with exactly: PASTE-OK <the number of words in this message>";
const prompt = `${body} ${tail}`;
const words = prompt.split(/\s+/).filter(Boolean).length;
log("prompt", `${prompt.length} chars, ${words} words (whitespace-separated)`);

const cwd = mkdtempSync(join(tmpdir(), "bridge-paste-e2e-"));
let session;
try {
  const spawned = await callTool("spawn_agent", {
    agent: "claude",
    cwd,
    new_session_label: "bridge-paste-e2e",
    label: "claude",
    watch: false,
  });
  session = spawned.session_id;
  const block = spawned.block_id;
  log("spawn_agent claude (new session bridge-paste-e2e)", spawned);

  // Wait for the TUI. Answer the folder-trust prompt once, only in this session: the cursor starts on
  // "No, exit", so move down to "Yes, I trust this folder" and confirm.
  let ready = false;
  let trusted = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(1000);
    const p = await callTool("read_pane", { block_id: block, session_id: session, lines: 25 });
    if (!trusted && /Yes, I trust this folder/.test(p.text) && /Enter to confirm/.test(p.text)) {
      log("folder-trust prompt", p.text);
      log("send_keys ['down','enter'] (trust, this session only)", await callTool("send_keys", { block_id: block, session_id: session, keys: ["down", "enter"] }));
      trusted = true;
      continue;
    }
    const st = await callTool("list_agents", { session });
    const status = st.sessions[0]?.panes.find((x) => x.block_id === block)?.status;
    if (status?.app === "claude-code" && status.state !== "working") ready = true;
    else if (/\? for shortcuts/.test(p.text)) ready = true;
  }
  await sleep(1000);
  check(ready, "claude TUI is ready");

  log("send_message (~2000 chars)", await callTool("send_message", { block_id: block, session_id: session, text: prompt }));
  // Wait until it starts working, then until it is done.
  await callTool("wait_for_status", { block_id: block, session_id: session, states: ["working"], timeout_s: 30 }).catch(() => {});
  const waited = await callTool("wait_for_status", { block_id: block, session_id: session, states: ["done", "blocked", "error"], timeout_s: 240 });
  log("wait_for_status [done]", waited);
  check(waited.timed_out === false && waited.status?.state === "done", "wait_for_status returned done");

  const pane = await callTool("read_pane", { block_id: block, session_id: session, lines: 400 });
  log("read_pane (last 400 lines)", pane.text);
  const reply = pane.text.split("Reply with exactly").at(-1) ?? "";
  const m = /PASTE-OK\s+(\d+)/.exec(reply);
  check(!!m, "reply contains PASTE-OK <n>");
  // Claude Code collapses a long pasted message on screen, so the pane only shows its end. The exact
  // text Claude received is in its own session log (~/.claude/projects/<cwd with non-alnum -> '->/*.jsonl).
  const projDir = join(homedir(), ".claude/projects", realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"));
  const received = readdirSync(projDir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(projDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.type === "user")
    .map((e) => (typeof e.message.content === "string" ? e.message.content : JSON.stringify(e.message.content)));
  const got = received.find((t) => t.includes("ALPHA-HEAD")) ?? "";
  log(
    "user message in Claude's session log",
    `${got.length} chars; starts ${JSON.stringify(got.slice(0, 70))}; ends ${JSON.stringify(got.slice(-70))}`,
  );
  check(got.includes(prompt), "Claude's session log contains the exact full prompt (start, middle and end)");
  if (m) {
    const n = Number(m[1]);
    log("word count", `claude said ${n}; whitespace count is ${words}; tail sentence alone is ${tail.split(/\s+/).length}`);
    check(Math.abs(n - words) <= words * 0.15, "word count is within 15% of the full prompt (not just the tail)");
  }
} finally {
  if (session) {
    log("close_session", await callTool("close_session", { session_id: session }));
    const after = await callTool("list_agents");
    check(!after.sessions.some((s) => s.session_id === session), "bridge-paste-e2e is gone");
  }
  await client.close();
}
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);
