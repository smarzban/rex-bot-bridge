// T428/T429: real-terminal tests for the prompts. python3's pty module gives the real makePrompter a
// real tty (test/pty/drive.py), driving the real setup() / setupWebhook() against fakes in a temp HOME
// (test/pty/harness.ts). PTY_CAPTURE_DIR=<dir> saves each screen capture (for the PR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { readSettings } from "../src/settings.js";
import { resolvePaths } from "../src/paths.js";
import { HEADER_QUESTION, KEY_QUESTION } from "../src/webhook.js";
import { childEnv, tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const skip = hasPython ? false : "python3 not found: the pty tests need python3 (its pty module drives a real terminal)";
const exec = promisify(execFile);

interface PtyResult {
  output: string;
  code: number | null;
  echo: boolean;
  icanon: boolean;
  error: string | null;
}

/** Async (not spawnSync) so a webhook sink in this process can answer while the harness runs. */
async function drive(mode: "setup" | "webhook", steps: [string, string][], home?: string, capture?: string): Promise<PtyResult & { home: string }> {
  home ??= await tempDir();
  const cfg = {
    cmd: [process.execPath, "--import", "tsx", join(ROOT, "test/pty/harness.ts"), mode],
    env: childEnv({ HOME: home, TERM: "xterm-256color" }),
    cwd: ROOT,
    steps,
    timeout: 30,
  };
  const r = await exec("python3", ["-I", join(ROOT, "test/pty/drive.py"), JSON.stringify(cfg)], { encoding: "utf8", timeout: 90_000 });
  const res = JSON.parse(r.stdout) as PtyResult;
  if (capture && process.env.PTY_CAPTURE_DIR) await writeFile(join(process.env.PTY_CAPTURE_DIR, `${capture}.txt`), res.output);
  return { ...res, home };
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const MODE: [string, string] = ["Mode (watched/full)", "\r"];

async function sink(status: number) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(status).end("ok"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/pty-sink-path`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("T429 pty: setup asks only the mode, prints numbered sections and ends with the Next block", { skip }, async () => {
  const r = await drive("setup", [MODE], undefined, "setup");
  assert.equal(r.error, null, r.output);
  assert.equal(r.code, 0, r.output);
  assert.ok(!/webhook url|webhook key|bearer token/i.test(r.output), "no webhook or token questions");
  assert.ok(!/webhook not set/i.test(r.output), "no webhook warning on a fresh install");
  assert.match(r.output, /6\. Agent skill/);
  assert.match(r.output, /Next\r?\n {2}1\. Set up Grok Bot: https:\/\/github\.com\/smarzban\/rex-grokbot-bridge\/blob\/main\/docs\/grok-bot\.md/);
  assert.match(r.output, /3\. Check everything: rex-grokbot doctor --test-webhook\s*$/);
});

test("T429 pty: setup webhook — key questions visible, typed and pasted keys never shown, test post 200, echo restored", { skip }, async () => {
  const s = await sink(200);
  try {
    const r = await drive(
      "webhook",
      [
        ["Webhook URL", `${s.url}\r`],
        ["Webhook key", "test-key-123\r"], // gitleaks:allow (fake test key)
        ["Header name for the key", "X-Webhook-Key: pasted-key-456\r"], // gitleaks:allow (fake test key)
        ["Send a test now?", "\r"],
      ],
      undefined,
      "setup-webhook",
    );
    assert.equal(r.error, null, r.output);
    assert.equal(r.code, 0, r.output);
    for (const q of [KEY_QUESTION, HEADER_QUESTION]) {
      const at = r.output.indexOf(q);
      assert.ok(at >= 0, `question shown: ${q}`);
      const rest = r.output.slice(at + q.length, r.output.indexOf("\n", at));
      assert.ok(!rest.includes("\x1b"), `no escape sequence after the question: ${JSON.stringify(rest)}`);
    }
    assert.equal(count(r.output, "test-key-123"), 0, "typed key never echoed");
    assert.equal(count(r.output, "pasted-key-456"), 0, "pasted header-line key never echoed");
    assert.equal(count(r.output, s.url), 1, "the URL appears only where it was typed (terminal echo), never in our output");
    assert.match(r.output, /key sent as X-Webhook-Key: <key>/);
    assert.match(r.output, /✅ Test sent: HTTP 200/);
    assert.ok(r.echo && r.icanon, "terminal echo/canonical mode restored after the hidden prompts");
    const st = await readSettings(resolvePaths({ HOME: r.home }).configFile);
    assert.deepEqual([st.webhook.url, st.webhook.header, st.webhook.key], [s.url, "X-Webhook-Key", "pasted-key-456"]); // gitleaks:allow (fake test key)

    // Re-run: Enter everywhere keeps everything, still never shown.
    const again = await drive(
      "webhook",
      [
        ["Webhook URL", "\r"],
        ["Webhook key", "\r"],
        ["Header name for the key", "\r"],
        ["Send a test now?", "n\r"],
      ],
      r.home,
      "setup-webhook-rerun",
    );
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /\(set; Enter keeps it\)/);
    assert.equal(count(again.output, s.url) + count(again.output, "pasted-key-456"), 0);
    const st2 = await readSettings(resolvePaths({ HOME: r.home }).configFile);
    assert.deepEqual([st2.webhook.url, st2.webhook.header, st2.webhook.key], [s.url, "X-Webhook-Key", "pasted-key-456"]); // gitleaks:allow (fake test key)
  } finally {
    await s.close();
  }
});

test("T428 pty: Ctrl-C at the hidden key prompt exits 130 and leaves echo on", { skip }, async () => {
  const r = await drive("webhook", [["Webhook URL", "https://hooks.example.test/pty\r"], ["Webhook key", "half-typed-999"], ["", "\x03"]]);
  assert.equal(r.error, null, r.output);
  assert.equal(r.code, 130, r.output);
  assert.ok(r.echo && r.icanon, "terminal echo/canonical mode restored after Ctrl-C");
  assert.equal(count(r.output, "half-typed-999"), 0);
});

test("T428 pty: three bad mode answers warn, use the default, and setup still writes config.json", { skip }, async () => {
  const r = await drive("setup", [
    ["Mode (watched/full)", "nope\r"],
    ["Mode (watched/full)", "nah\r"],
    ["Mode (watched/full)", "never\r"],
  ]);
  assert.equal(r.error, null, r.output);
  assert.equal(r.code, 0, r.output);
  assert.equal(count(r.output, "Please answer one of"), 2);
  assert.match(r.output, /No valid answer after 3 tries; using watched/);
  assert.equal((await readSettings(resolvePaths({ HOME: r.home }).configFile)).mode, "watched");
});
