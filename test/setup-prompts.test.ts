// T428: forgiving interactive webhook prompts in `rex-bot setup` (pasted header lines, re-asks, never abort).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { makePrompter, scriptedPrompter } from "../src/prompt.js";
import { readSettings } from "../src/settings.js";
import { HEADER_QUESTION, KEY_QUESTION, parseHeaderAnswer, parseKeyAnswer, setup, type SetupFlags } from "../src/setup.js";
import { childEnv, fakeCtx, tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");

const FLAGS: SetupFlags = {
  yes: false,
  services: false,
  serve: false,
  skills: false,
  rexConfig: false,
  showToken: false,
};
const URL_Q = "Webhook URL";
const KEY_Q = "Webhook key";
const HEADER_Q = "Header name";
const URL = "https://hooks.example.test/secret-path-abc";

async function run(answers: Record<string, string | string[] | boolean>) {
  const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
  const code = await setup(f.ctx, { ...FLAGS }, scriptedPrompter(answers));
  const s = await readSettings(f.ctx.paths.configFile);
  return { code, s, out: f.out.join("\n"), f };
}

function assertNoSecrets(out: string, ...secrets: string[]) {
  for (const x of secrets) assert.ok(!out.includes(x), `output must not contain ${x.slice(0, 3)}…`);
}

test("T428 parse: key answers lose Bearer, and any pasted `Name: value` line gives header + key", () => {
  assert.deepEqual(parseKeyAnswer("Bearer Z"), { key: "Z" });
  assert.deepEqual(parseKeyAnswer("  bearer   Z "), { key: "Z" });
  assert.deepEqual(parseKeyAnswer("Authorization: Bearer Z"), { header: "Authorization", key: "Z" });
  assert.deepEqual(parseKeyAnswer("X-Webhook-Key: Y"), { header: "X-Webhook-Key", key: "Y" });
  assert.deepEqual(parseKeyAnswer("plain-key"), { key: "plain-key" });
  // F: everything after the first colon (and Bearer) is the key; a bare `a:b` key stays a key.
  assert.deepEqual(parseKeyAnswer("X-Key: abc:def"), { header: "X-Key", key: "abc:def" });
  assert.deepEqual(parseKeyAnswer("Authorization: Bearer a:b"), { header: "Authorization", key: "a:b" });
  assert.deepEqual(parseKeyAnswer("abc:def"), { key: "abc:def" });
});

test("T428 parse: header answers accept a name or a pasted full header line", () => {
  assert.deepEqual(parseHeaderAnswer("", "k"), { header: "Authorization", key: "k" });
  assert.deepEqual(parseHeaderAnswer("X-Webhook-Key", "k"), { header: "X-Webhook-Key", key: "k" });
  assert.deepEqual(parseHeaderAnswer("Authorization: Bearer X", "k"), { header: "Authorization", key: "X" });
  assert.deepEqual(parseHeaderAnswer("X-Webhook-Key: Y", "k"), { header: "X-Webhook-Key", key: "Y" });
  assert.deepEqual(parseHeaderAnswer("X-Webhook-Key:", "k"), { header: "X-Webhook-Key", key: "k" });
  assert.deepEqual(parseHeaderAnswer("X-Key: abc:def", "k"), { header: "X-Key", key: "abc:def" });
  assert.deepEqual(parseHeaderAnswer("Authorization: Bearer a:b", "k"), { header: "Authorization", key: "a:b" });
  assert.ok("error" in parseHeaderAnswer("not a header", "k"));
  assert.ok(!JSON.stringify(parseHeaderAnswer("bad header secret-val", "k")).includes("secret-val"), "reason never echoes the answer");
});

test("T428 setup: a pasted `Authorization: Bearer X` header line → header Authorization, key X", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "first-key-111", [HEADER_Q]: "Authorization: Bearer X-secret-222" });
  assert.equal(r.code, 0);
  assert.equal(r.s.webhook.url, URL);
  assert.equal(r.s.webhook.header ?? "Authorization", "Authorization");
  assert.equal(r.s.webhook.key, "X-secret-222");
  assertNoSecrets(r.out, URL, "first-key-111", "X-secret-222");
});

test("T428 setup: a pasted `X-Webhook-Key: Y` line → header X-Webhook-Key, key Y", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "Y-secret-333", [HEADER_Q]: "X-Webhook-Key: Y-secret-333" });
  assert.equal(r.s.webhook.header, "X-Webhook-Key");
  assert.equal(r.s.webhook.key, "Y-secret-333");
  assertNoSecrets(r.out, URL, "Y-secret-333");
});

test("T428 setup: a key answer `Bearer Z` stores Z; Enter on the header keeps Authorization", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "Bearer Z-secret-444", [HEADER_Q]: "" });
  assert.equal(r.s.webhook.key, "Z-secret-444");
  assert.equal(r.s.webhook.header, undefined);
  assertNoSecrets(r.out, URL, "Z-secret-444");
});

test("T428 setup: an invalid header 3x warns, keeps going, and still writes config.json", async () => {
  const r = await run({ [URL_Q]: URL, [KEY_Q]: "k-secret-555", [HEADER_Q]: "not a header" });
  assert.equal(r.code, 0);
  assert.ok((await stat(r.f.ctx.paths.configFile)).isFile());
  assert.equal(r.s.webhook.url, URL);
  assert.equal(r.s.webhook.key, "k-secret-555");
  assert.equal(r.s.webhook.header, undefined);
  assert.match(r.out, /No valid header name after 3 tries/);
  assert.equal(r.out.match(/isn't a header name/g)?.length, 3);
  assert.ok(r.out.includes("Grok Bot"), "setup ran to the end");
  assertNoSecrets(r.out, URL, "k-secret-555");
});

test("T428 setup: a non-https URL is re-asked, then accepted", async () => {
  const r = await run({ [URL_Q]: ["http://hooks.example.test/x", "hooks.example.test", URL], [KEY_Q]: "" });
  assert.equal(r.code, 0);
  assert.equal(r.s.webhook.url, URL);
  assert.equal(r.s.webhook.key, undefined);
  assert.equal(r.out.match(/must start with https:\/\//g)?.length, 2);
  assertNoSecrets(r.out, URL, "hooks.example.test");
});

test("T428 setup: three bad URLs skip the webhook and setup still completes", async () => {
  const r = await run({ [URL_Q]: "ftp://nope", [KEY_Q]: "never-asked" });
  assert.equal(r.code, 0);
  assert.equal(r.s.webhook.url, undefined);
  assert.equal(r.s.webhook.key, undefined);
  assert.match(r.out, /No valid webhook URL after 3 tries/);
  assert.ok((await stat(r.f.ctx.paths.configFile)).isFile());
});

test("T428 setup: no key → no header question", async () => {
  const asked: string[] = [];
  const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
  const p = scriptedPrompter({ [URL_Q]: URL, [KEY_Q]: "" });
  const ask = p.ask.bind(p);
  p.ask = (q, o) => (asked.push(q), ask(q, o));
  await setup(f.ctx, { ...FLAGS }, p);
  assert.ok(!asked.some((q) => q.includes(HEADER_Q)));
});

test("T428 setup: the v1 'full powers' hint is gone; mode defaults to watched", async () => {
  for (const p of [scriptedPrompter(), makePrompter(true)]) {
    const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
    await mkdir(dirname(f.ctx.paths.legacyWatchedFile), { recursive: true });
    await writeFile(f.ctx.paths.legacyWatchedFile, "# v1\n");
    assert.equal(await setup(f.ctx, { ...FLAGS }, p), 0);
    const out = f.out.join("\n");
    assert.ok(!out.includes("full powers"), out);
    assert.equal((await readSettings(f.ctx.paths.configFile)).mode, "watched");
  }
});

test("T428 setup: the key and header questions are asked with secret:true; header name echoed, value never", async () => {
  const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
  const p = scriptedPrompter({ [URL_Q]: URL, [KEY_Q]: "k-secret-666", [HEADER_Q]: "X-Webhook-Key: v-secret-777" });
  await setup(f.ctx, { ...FLAGS }, p);
  assert.equal(p.asked.find((a) => a.q === KEY_QUESTION)?.opts.secret, true);
  assert.equal(p.asked.find((a) => a.q === HEADER_QUESTION)?.opts.secret, true);
  assert.equal(p.asked.find((a) => a.q.includes(URL_Q))?.opts.secret, undefined);
  const out = f.out.join("\n");
  assert.match(out, /Header: X-Webhook-Key/);
  assertNoSecrets(out, URL, "k-secret-666", "v-secret-777");
  const s = await readSettings(f.ctx.paths.configFile);
  assert.deepEqual([s.webhook.header, s.webhook.key], ["X-Webhook-Key", "v-secret-777"]);
});

test("T428 setup: a `Name: value` line in the key answer sets the header and skips the header question", async () => {
  const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 });
  const p = scriptedPrompter({ [URL_Q]: URL, [KEY_Q]: "X-Key: abc:def" });
  await setup(f.ctx, { ...FLAGS }, p);
  assert.ok(!p.asked.some((a) => a.q === HEADER_QUESTION), "header question skipped");
  const s = await readSettings(f.ctx.paths.configFile);
  assert.deepEqual([s.webhook.header, s.webhook.key], ["X-Key", "abc:def"]);
  assert.match(f.out.join("\n"), /Header: X-Key/);
  assertNoSecrets(f.out.join("\n"), "abc:def");
});

test("T428 setup: a URL with a port is accepted", async () => {
  const r = await run({ [URL_Q]: "https://host:8443/x", [KEY_Q]: "" });
  assert.equal(r.s.webhook.url, "https://host:8443/x");
});

test("T428 cli: `rex-bot --version` / `-v` exit 0 and print exactly the package.json version", async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
  for (const flag of ["--version", "-v"]) {
    const home = await tempDir();
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src/cli/rex-bot.ts"), flag], {
      cwd: ROOT,
      env: childEnv({ HOME: home }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${pkg.version}\n`);
  }
});
