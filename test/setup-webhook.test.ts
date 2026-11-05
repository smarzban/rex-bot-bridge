// T428/T429: `rex-bot setup webhook` (forgiving prompts, flags, Enter keeps saved values, test post),
// and bare `rex-bot setup` never asking for the webhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makePrompter, scriptedPrompter } from "../src/prompt.js";
import { DEFAULTS, readSettings, writeSettings } from "../src/settings.js";
import { setup, type SetupFlags } from "../src/setup.js";
import {
  HEADER_QUESTION,
  KEY_QUESTION,
  parseHeaderAnswer,
  parseKeyAnswer,
  setupWebhook,
  TEST_QUESTION,
  validWebhookUrl,
  type WebhookFlags,
} from "../src/webhook.js";
import { childEnv, fakeCtx, tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const URL_Q = "Webhook URL";
const KEY_Q = "Webhook key";
const HEADER_Q = "Header name";
const URL = "https://hooks.example.test/secret-path-abc";
const NO_TEST: WebhookFlags = { test: false };

async function run(answers: Record<string, string | string[] | boolean>, flags: WebhookFlags = NO_TEST, home?: string) {
  const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 }, home);
  const p = scriptedPrompter(answers);
  const code = await setupWebhook(f.ctx, flags, p);
  const s = await readSettings(f.ctx.paths.configFile);
  return { code, s, out: f.out.join("\n"), f, p };
}

function assertNoSecrets(out: string, ...secrets: string[]) {
  for (const x of secrets) assert.ok(!out.includes(x), `output must not contain ${x.slice(0, 3)}…`);
}

// ---------- parsing ----------

test("T428 parse: key answers lose Bearer, and any pasted `Name: value` line gives header + key", () => {
  assert.deepEqual(parseKeyAnswer("Bearer Z"), { key: "Z" });
  assert.deepEqual(parseKeyAnswer("  bearer   Z "), { key: "Z" });
  assert.deepEqual(parseKeyAnswer("Authorization: Bearer Z"), { header: "Authorization", key: "Z" });
  assert.deepEqual(parseKeyAnswer("X-Webhook-Key: Y"), { header: "X-Webhook-Key", key: "Y" });
  assert.deepEqual(parseKeyAnswer("plain-key"), { key: "plain-key" });
  assert.deepEqual(parseKeyAnswer("X-Key: abc:def"), { header: "X-Key", key: "abc:def" });
  assert.deepEqual(parseKeyAnswer("Authorization: Bearer a:b"), { header: "Authorization", key: "a:b" });
  assert.deepEqual(parseKeyAnswer("abc:def"), { key: "abc:def" });
  assert.deepEqual(parseKeyAnswer(""), { key: "" });
});

test("T428 parse: `Authorization:` with no space is still a header line; a bare `abc:def` stays a key", () => {
  assert.deepEqual(parseKeyAnswer("Authorization:Bearer x"), { header: "Authorization", key: "x" });
  assert.deepEqual(parseKeyAnswer("authorization:x"), { header: "authorization", key: "x" });
  assert.deepEqual(parseKeyAnswer("X-Key:abc"), { key: "X-Key:abc" }, "no-space form is only special for Authorization");
});

test("T428 parse: a header line with an empty value is an error, not a key", () => {
  for (const a of ["X-Key: ", "X-Key:", "Authorization: Bearer ", "Authorization:"]) assert.ok("error" in parseKeyAnswer(a), a);
});

test("T429 parse: a bare `Bearer` is an error (re-asked), not \"no key\"", () => {
  for (const a of ["Bearer", " bearer ", "BEARER"]) assert.ok("error" in parseKeyAnswer(a), a);
});

test("T428 parse: header answers accept a name or a pasted full header line", () => {
  assert.deepEqual(parseHeaderAnswer("", "k"), { header: "Authorization", key: "k" });
  assert.deepEqual(parseHeaderAnswer("X-Webhook-Key", "k"), { header: "X-Webhook-Key", key: "k" });
  assert.deepEqual(parseHeaderAnswer("Authorization: Bearer X", "k"), { header: "Authorization", key: "X" });
  assert.deepEqual(parseHeaderAnswer("X-Webhook-Key: Y", "k"), { header: "X-Webhook-Key", key: "Y" });
  assert.deepEqual(parseHeaderAnswer("X-Webhook-Key:", "k"), { header: "X-Webhook-Key", key: "k" });
  assert.ok("error" in parseHeaderAnswer("not a header", "k"));
  assert.ok(!JSON.stringify(parseHeaderAnswer("bad header secret-val", "k")).includes("secret-val"), "reason never echoes the answer");
});

test("T429 url: https anywhere, http only to this Mac", () => {
  for (const u of ["https://h/x", "https://host:8443/x", "http://127.0.0.1:9/x", "http://localhost/x"]) assert.ok(validWebhookUrl(u), u);
  for (const u of ["http://hooks.example.test/x", "ftp://x", "hooks.example.test", "https://"]) assert.ok(!validWebhookUrl(u), u);
});

// ---------- bare setup ----------

const SETUP_FLAGS: SetupFlags = { yes: false, services: false, serve: false, skills: false, rexConfig: false };

test("T429 setup: bare setup never asks a webhook question, interactive or not, and ends with Next", async () => {
  for (const p of [scriptedPrompter(), makePrompter(true)]) {
    const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
    const asked: string[] = [];
    const ask = p.ask.bind(p);
    p.ask = (q, o) => (asked.push(q), ask(q, o));
    const confirm = p.confirm.bind(p);
    p.confirm = (q, d) => (asked.push(q), confirm(q, d));
    assert.equal(await setup(f.ctx, { ...SETUP_FLAGS }, p), 0);
    assert.ok(!asked.some((q) => /webhook|key|header|token/i.test(q)), JSON.stringify(asked));
    const out = f.out.join("\n");
    assert.ok(out.trimEnd().endsWith("3. Check everything: rex-bot doctor --test-webhook"), out);
    assert.ok(out.includes("2. Add the routine's webhook: rex-bot setup webhook"));
  }
});

// ---------- interactive ----------

test("T428 webhook: `Authorization:Bearer x` in the key answer → header Authorization, key x, no header question", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "Authorization:Bearer x-secret-1" });
  assert.equal(r.code, 0);
  assert.deepEqual([r.s.webhook.url, r.s.webhook.header, r.s.webhook.key], [URL, undefined, "x-secret-1"]);
  assert.ok(!r.p.asked.some((a) => a.q === HEADER_QUESTION));
  assertNoSecrets(r.out, URL, "x-secret-1");
});

test("T428 webhook: `X-Key: ` is re-asked with the reason, then a good answer is used", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: ["X-Key: ", "X-Key: k-secret-2"] });
  assert.deepEqual([r.s.webhook.header, r.s.webhook.key], ["X-Key", "k-secret-2"]);
  assert.equal(r.p.asked.filter((a) => a.q === KEY_QUESTION).length, 2);
  assert.match(r.out, /no key after the colon\. Try again\./);
});

test("T429 webhook: a bare `Bearer` key answer is re-asked", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: ["Bearer", "k-secret-b"], [HEADER_Q]: "" });
  assert.equal(r.s.webhook.key, "k-secret-b");
  assert.equal(r.p.asked.filter((a) => a.q === KEY_QUESTION).length, 2);
  assert.match(r.out, /just "Bearer" with no key/);
});

test("T429 webhook: three bad key answers save nothing and exit 1", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "X-Key: " });
  assert.equal(r.code, 1);
  assert.equal(r.s.webhook.url, undefined);
  assert.match(r.out, /No valid webhook key after 3 tries; nothing saved/);
});

test("T428 webhook: a pasted `Authorization: Bearer X` header line → header Authorization, key X", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "first-key-111", [HEADER_Q]: "Authorization: Bearer X-secret-222" });
  assert.equal(r.code, 0);
  assert.equal(r.s.webhook.header, undefined);
  assert.equal(r.s.webhook.key, "X-secret-222");
  assertNoSecrets(r.out, URL, "first-key-111", "X-secret-222");
});

test("T428 webhook: key and header asked with secret:true; header name shown, value never", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "k-secret-666", [HEADER_Q]: "X-Webhook-Key: v-secret-777" });
  assert.equal(r.p.asked.find((a) => a.q === KEY_QUESTION)?.opts.secret, true);
  assert.equal(r.p.asked.find((a) => a.q === HEADER_QUESTION)?.opts.secret, true);
  assert.equal(r.p.asked.find((a) => a.q.includes(URL_Q))?.opts.secret, undefined);
  assert.match(r.out, /key sent as X-Webhook-Key: <key>/);
  assertNoSecrets(r.out, URL, "k-secret-666", "v-secret-777");
  assert.deepEqual([r.s.webhook.header, r.s.webhook.key], ["X-Webhook-Key", "v-secret-777"]);
});

test("T428 webhook: an invalid header 3x falls back to Authorization and still saves", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "k-secret-555", [HEADER_Q]: "not a header" });
  assert.equal(r.code, 0);
  assert.deepEqual([r.s.webhook.url, r.s.webhook.key, r.s.webhook.header], [URL, "k-secret-555", undefined]);
  assert.equal(r.out.match(/isn't a header name/g)?.length, 3);
  assertNoSecrets(r.out, URL, "k-secret-555");
});

test("T428 webhook: a non-https URL is re-asked, then accepted; three bad ones save nothing", async () => {
  const r = await run({ [URL_Q]: ["http://hooks.example.test/x", "hooks.example.test", URL], [KEY_Q]: "" });
  assert.equal(r.s.webhook.url, URL);
  assert.equal(r.out.match(/must start with https:\/\//g)?.length, 2);
  assertNoSecrets(r.out, URL, "hooks.example.test");
  const bad = await run({ [URL_Q]: "ftp://nope" });
  assert.equal(bad.code, 1);
  assert.equal(bad.s.webhook.url, undefined);
});

test("T428 webhook: no key → no header question; Enter on the URL with nothing saved saves nothing", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "" });
  assert.ok(!r.p.asked.some((a) => a.q.includes(HEADER_Q)));
  assert.equal(r.s.webhook.key, undefined);
  const skip = await run({ [URL_Q]: "" });
  assert.equal(skip.code, 0);
  assert.equal(skip.s.webhook.url, undefined);
  assert.match(skip.out, /nothing saved/);
});

test("T429 webhook: on a re-run Enter keeps the saved URL, key and header, and never shows them", async () => {
  const home = await tempDir();
  const first = await run({ [URL_Q]: URL, [KEY_Q]: "keep-secret-1", [HEADER_Q]: "X-Webhook-Key" }, NO_TEST, home);
  assert.equal(first.s.webhook.header, "X-Webhook-Key");
  const again = await run({}, NO_TEST, home); // every answer is Enter
  assert.deepEqual([again.s.webhook.url, again.s.webhook.key, again.s.webhook.header], [URL, "keep-secret-1", "X-Webhook-Key"]);
  assert.ok(again.p.asked.some((a) => a.q.includes(URL_Q) && a.q.includes("(set; Enter keeps it)")));
  assert.ok(again.p.asked.some((a) => a.q.includes(KEY_Q) && a.q.includes("set; Enter keeps it")));
  assert.ok(again.p.asked.every((a) => a.opts.def === undefined), "saved values are never passed as a shown default");
  assertNoSecrets(again.out + JSON.stringify(again.p.asked), URL, "keep-secret-1");
  // Replacing only the key keeps the URL.
  const k = await run({ [KEY_Q]: "new-secret-2", [HEADER_Q]: "" }, NO_TEST, home);
  assert.deepEqual([k.s.webhook.url, k.s.webhook.key, k.s.webhook.header], [URL, "new-secret-2", "X-Webhook-Key"]);
});

// ---------- flags ----------

test("T429 webhook flags: --url/--key-file/--header with --yes, no questions", async () => {
  const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
  const code = await setupWebhook(f.ctx, { url: URL, key: "Bearer flag-secret-1", header: "X-Hook", test: false }, makePrompter(true));
  assert.equal(code, 0);
  const s = await readSettings(f.ctx.paths.configFile);
  assert.deepEqual([s.webhook.url, s.webhook.key, s.webhook.header], [URL, "flag-secret-1", "X-Hook"]);
  assertNoSecrets(f.out.join("\n"), URL, "flag-secret-1");
});

test("T429 webhook flags: usage errors exit 2 and save nothing", async () => {
  for (const flags of [
    { url: "http://hooks.example.test/x", test: false },
    { url: URL, key: "X-Key: ", test: false },
    { url: URL, header: "Bad Header", test: false },
    { test: false }, // --yes with nothing saved and no --url
  ] as WebhookFlags[]) {
    const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
    assert.equal(await setupWebhook(f.ctx, flags, makePrompter(true)), 2, JSON.stringify(flags));
    assert.equal((await readSettings(f.ctx.paths.configFile)).webhook.url, undefined);
    assert.match(f.out.join("\n"), /rex-bot setup webhook --help/);
  }
});

test("T429 webhook flags: --yes with only --url keeps the saved key and header", async () => {
  const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
  await writeSettings(f.ctx.paths.configFile, { ...DEFAULTS, webhook: { url: "https://old.example.test/x", key: "old-secret", header: "X-K" } });
  await setupWebhook(f.ctx, { url: URL, test: false }, makePrompter(true));
  const s = await readSettings(f.ctx.paths.configFile);
  assert.deepEqual([s.webhook.url, s.webhook.key, s.webhook.header], [URL, "old-secret", "X-K"]);
});

test("T429 cli: setup webhook --key-file - reads stdin; webhook flags on bare setup are a usage error", async () => {
  const home = await tempDir();
  const cli = (args: string[], input?: string) =>
    spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src/cli/rex-bot.ts"), ...args], {
      cwd: ROOT,
      env: childEnv({ HOME: home }),
      encoding: "utf8",
      input,
    });
  const r = cli(["setup", "webhook", "--url", URL, "--key-file", "-", "--yes", "--no-test"], "X-Webhook-Key: stdin-secret-1\n");
  assert.equal(r.status, 0, r.stderr);
  assertNoSecrets(r.stdout + r.stderr, URL, "stdin-secret-1");
  const cfg = JSON.parse(await readFile(join(home, ".config/rex-bot-bridge/config.json"), "utf8"));
  assert.deepEqual([cfg.webhook.key, cfg.webhook.header], ["stdin-secret-1", "X-Webhook-Key"]);

  const keyFile = join(home, "k");
  await writeFile(keyFile, "file-secret-2\n");
  assert.equal(cli(["setup", "webhook", "--key-file", keyFile, "--yes", "--no-test"]).status, 0);
  assert.equal(JSON.parse(await readFile(join(home, ".config/rex-bot-bridge/config.json"), "utf8")).webhook.key, "file-secret-2");

  for (const args of [["setup", "--webhook-url", URL], ["setup", "--url", URL], ["setup", "webhook", "--mode", "full"], ["setup", "nope"]]) {
    const u = cli(args);
    assert.equal(u.status, 2, args.join(" "));
    assert.match(u.stderr, /--help/);
    assertNoSecrets(u.stdout + u.stderr, URL);
  }
});

// ---------- test post ----------

async function sink(handler: (status: (n: number) => void) => void | "hang") {
  const got: { auth?: string; xk?: string; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ auth: req.headers.authorization, xk: req.headers["x-webhook-key"] as string | undefined, body });
      handler((n) => res.writeHead(n).end("x"));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/sink-secret-path`;
  return { url, got, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

async function postTest(status: number | "hang", answers: Record<string, string | boolean> = {}) {
  const s = await sink((reply) => (status === "hang" ? undefined : reply(status)));
  try {
    const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
    f.ctx.fetch = fetch;
    const p = scriptedPrompter({ [URL_Q]: s.url, [KEY_Q]: "post-secret-9", [HEADER_Q]: "", ...answers });
    const code = await setupWebhook(f.ctx, { test: true }, p, { timeoutMs: 300 });
    return { code, out: f.out.join("\n"), got: s.got, url: s.url, p };
  } finally {
    await s.close();
  }
}

test("T429 webhook test post: 200 → ✅ and exit 0; the routine got Bearer <key>", async () => {
  const r = await postTest(200);
  assert.equal(r.code, 0);
  assert.match(r.out, /✅ Test sent: HTTP 200/);
  assert.equal(r.got.length, 1);
  assert.equal(r.got[0]!.auth, "Bearer post-secret-9");
  assert.equal(JSON.parse(r.got[0]!.body).event, "doctor_test");
  assertNoSecrets(r.out, r.url, "sink-secret-path", "post-secret-9");
});

test("T429 webhook test post: 401 → ❌ with a key/header fix, exit 1", async () => {
  const r = await postTest(401);
  assert.equal(r.code, 1);
  assert.match(r.out, /❌ Test failed: HTTP 401\n\s+fix: The routine refused the key/);
  assertNoSecrets(r.out, r.url, "sink-secret-path", "post-secret-9");
});

test("T429 webhook test post: 404 → URL fix; timeout → network fix", async () => {
  const nf = await postTest(404);
  assert.match(nf.out, /HTTP 404\n\s+fix: Nothing at that URL/);
  const to = await postTest("hang");
  assert.equal(to.code, 1);
  assert.match(to.out, /❌ Test failed: timeout\n\s+fix: No answer within 5s/);
  assertNoSecrets(to.out, to.url, "post-secret-9");
});

test("T429 webhook test post: answering no to the test question sends nothing", async () => {
  const r = await postTest(200, { [TEST_QUESTION]: false });
  assert.equal(r.code, 0);
  assert.equal(r.got.length, 0);
  assert.match(r.out, /rex-bot doctor --test-webhook/);
});

test("T428 cli: `rex-bot --version` / `-v` exit 0 and print exactly the package.json version", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
  for (const flag of ["--version", "-v"]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src/cli/rex-bot.ts"), flag], {
      cwd: ROOT,
      env: childEnv({ HOME: await tempDir() }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${pkg.version}\n`);
  }
});

test("T429 FR1-E: setup webhook writes only webhook.* — a mode change during the prompts survives", async () => {
  const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
  await writeSettings(f.ctx.paths.configFile, { ...DEFAULTS, mode: "watched", port: 7400 });
  const p = scriptedPrompter({ [URL_Q]: URL, [HEADER_Q]: "" });
  const ask = p.ask.bind(p);
  p.ask = async (q, o) => {
    // While the key question is open, someone runs `rex-bot config set mode full` / `port 7411`.
    if (q.includes(KEY_Q)) await writeSettings(f.ctx.paths.configFile, { ...DEFAULTS, mode: "full", port: 7411 });
    return q.includes(KEY_Q) ? "k-secret-e" : ask(q, o);
  };
  assert.equal(await setupWebhook(f.ctx, NO_TEST, p), 0);
  const s = await readSettings(f.ctx.paths.configFile);
  assert.deepEqual([s.mode, s.port, s.webhook.url, s.webhook.key], ["full", 7411, URL, "k-secret-e"]);
});
