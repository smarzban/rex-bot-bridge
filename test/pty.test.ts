// T428: real-terminal tests for setup's prompts. python3's pty module gives the real makePrompter a
// real tty (test/pty/drive.py), driving the real setup() against fakes in a temp HOME (test/pty/harness.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readSettings } from "../src/settings.js";
import { resolvePaths } from "../src/paths.js";
import { HEADER_QUESTION, KEY_QUESTION } from "../src/setup.js";
import { childEnv, tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const skip = hasPython ? false : "python3 not found: the pty tests need python3 (its pty module drives a real terminal)";

interface PtyResult {
  output: string;
  code: number | null;
  echo: boolean;
  icanon: boolean;
  error: string | null;
}

async function drive(steps: [string, string][]): Promise<PtyResult & { home: string }> {
  const home = await tempDir();
  const cfg = {
    cmd: [process.execPath, "--import", "tsx", join(ROOT, "test/pty/harness.ts")],
    env: childEnv({ HOME: home, TERM: "xterm-256color" }),
    cwd: ROOT,
    steps,
    timeout: 30,
  };
  const r = spawnSync("python3", ["-I", join(ROOT, "test/pty/drive.py"), JSON.stringify(cfg)], { encoding: "utf8", timeout: 90_000 });
  assert.equal(r.status, 0, `drive.py failed: ${r.stderr}`);
  return { ...(JSON.parse(r.stdout) as PtyResult), home };
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const MODE: [string, string] = ["Mode (watched/full)", "\r"];
const URL: [string, string] = ["Webhook URL", "https://hooks.example.test/pty\r"];

test("T428 pty: key question visible, typed key and pasted header-line key never shown, echo restored", { skip }, async () => {
  const r = await drive([
    MODE,
    URL,
    ["Webhook key", "test-key-123\r"],
    ["Header name for the key", "X-Webhook-Key: pasted-key-456\r"],
    ["Show the bearer token", "\r"],
  ]);
  assert.equal(r.error, null, r.output);
  assert.equal(r.code, 0, r.output);
  // The question text reaches the screen and nothing clears it before the answer's newline
  // (the original bug: readline's line redraw wiped the question).
  for (const q of [KEY_QUESTION, HEADER_QUESTION]) {
    const at = r.output.indexOf(q);
    assert.ok(at >= 0, `question shown: ${q}`);
    const rest = r.output.slice(at + q.length, r.output.indexOf("\n", at));
    assert.ok(!rest.includes("\x1b"), `no escape sequence after the question: ${JSON.stringify(rest)}`);
  }
  assert.equal(count(r.output, "test-key-123"), 0, "typed key never echoed");
  assert.equal(count(r.output, "pasted-key-456"), 0, "pasted header-line key never echoed");
  assert.match(r.output, /Header: X-Webhook-Key/);
  assert.ok(r.echo && r.icanon, "terminal echo/canonical mode restored after the hidden prompts");
  const s = await readSettings(resolvePaths({ HOME: r.home }).configFile);
  assert.deepEqual([s.webhook.url, s.webhook.header, s.webhook.key], ["https://hooks.example.test/pty", "X-Webhook-Key", "pasted-key-456"]);
});

test("T428 pty: Ctrl-C at the hidden key prompt exits 130 and leaves echo on", { skip }, async () => {
  const r = await drive([MODE, URL, ["Webhook key", "half-typed-999"], ["", "\x03"]]);
  assert.equal(r.error, null, r.output);
  assert.equal(r.code, 130, r.output);
  assert.ok(r.echo && r.icanon, "terminal echo/canonical mode restored after Ctrl-C");
  assert.equal(count(r.output, "half-typed-999"), 0);
});

test("T428 pty: three bad mode answers warn, use the default, and setup still writes config.json", { skip }, async () => {
  const r = await drive([
    ["Mode (watched/full)", "nope\r"],
    ["Mode (watched/full)", "nah\r"],
    ["Mode (watched/full)", "never\r"],
    ["Webhook URL", "\r"],
    ["Show the bearer token", "\r"],
  ]);
  assert.equal(r.error, null, r.output);
  assert.equal(r.code, 0, r.output);
  assert.equal(count(r.output, "Please answer one of"), 2);
  assert.match(r.output, /No valid answer after 3 tries; using watched/);
  assert.equal((await readSettings(resolvePaths({ HOME: r.home }).configFile)).mode, "watched");
});
