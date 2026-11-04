import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { bearer, ensureToken, readToken, tokenMatches } from "../src/token.js";
import { redactArgs } from "../src/audit.js";
import { tempDir } from "./helpers.js";

test("ensureToken creates a 43-char base64url token with mode 600, then reuses it", async () => {
  const path = join(await tempDir(), "sub", "token");
  const a = await ensureToken(path);
  assert.equal(a.created, true);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const b = await ensureToken(path);
  assert.equal(b.created, false);
  assert.equal(b.token, a.token);
  const c = await ensureToken(path, true);
  assert.notEqual(c.token, a.token);
  assert.equal(await readToken(path), c.token);
});

test("ensureToken tightens an existing token file to 600", async () => {
  const path = join(await tempDir(), "token");
  await writeFile(path, "abc\n");
  await chmod(path, 0o644);
  await ensureToken(path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("tokenMatches and bearer parsing", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abd", "abc"), false);
  assert.equal(tokenMatches("", "abc"), false);
  assert.equal(bearer("Bearer xyz"), "xyz");
  assert.equal(bearer("bearer xyz"), "xyz");
  assert.equal(bearer("Basic xyz"), null);
  assert.equal(bearer(undefined), null);
});

test("audit redaction truncates long strings to 200 chars", () => {
  const r = redactArgs({ text: "x".repeat(500), block_id: "block:1", n: 3 });
  assert.equal((r.text as string).startsWith("x".repeat(200)), true);
  assert.ok((r.text as string).length < 220);
  assert.equal(r.block_id, "block:1");
  assert.equal(r.n, 3);
});
