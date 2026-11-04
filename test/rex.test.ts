// Tests the real spawnRunner (the one cli/bridge.ts wires in), using node in place of the rex binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Rex, RexError, spawnRunner } from "../src/rex.js";

const node = process.execPath;
const run = spawnRunner(node);

test("stdin input reaches the child intact (multibyte too)", async () => {
  const text = "--not-a-flag\nhéllo 世界 🎉\nline 3";
  const r = await run(["-e", "process.stdin.pipe(process.stdout)"], { input: text });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, text);
});

test("argv is passed literally, never through a shell", async () => {
  const args = ["$(echo pwned)", "; ls", "a b", "'q'", "`id`", "*"];
  const r = await run(["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args]);
  assert.deepEqual(JSON.parse(r.stdout), args);
});

test("multibyte characters split across chunks are decoded correctly", async () => {
  const script = `
    const b = Buffer.from("🎉世");
    process.stdout.write(b.subarray(0, 2));
    setTimeout(() => process.stdout.write(b.subarray(2, 5)), 30);
    setTimeout(() => process.stdout.write(b.subarray(5)), 60);
  `;
  const r = await run(["-e", script]);
  assert.equal(r.stdout, "🎉世");
  assert.ok(!r.stdout.includes("�"));
});

test("timeout kills a hung child and rejects with 'timed out'", async () => {
  const started = Date.now();
  // The child announces readiness on stderr, then hangs forever.
  await assert.rejects(
    run(["-e", "process.stderr.write('ready'); setInterval(() => {}, 1000)"], { timeoutMs: 300 }),
    (e: unknown) => e instanceof RexError && /timed out/.test(e.message) && e.stderr === "ready",
  );
  assert.ok(Date.now() - started < 5000, "did not wait for the child to finish on its own");
});

test("output over the cap kills the child and rejects", async () => {
  const capped = spawnRunner(node, 10_000, 1000);
  await assert.rejects(
    capped(["-e", "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)"]),
    /output exceeded 1000 bytes/,
  );
});

test("a binary that cannot start rejects with a clear error", async () => {
  await assert.rejects(spawnRunner("/nonexistent/rex")(["ls"]), /failed to start rex/);
});

test("Rex.exec turns a nonzero exit into RexError with rex's first stderr line", async () => {
  const rex = new Rex(run);
  await assert.rejects(
    rex.exec(["-e", "console.error('Error: block target \"x\" not found\\nUsage: ...'); process.exit(3)"]),
    (e: unknown) =>
      e instanceof RexError && e.code === 3 && e.notFound && /failed: Error: block target "x" not found$/.test(e.message),
  );
});

test("Rex.json rejects malformed JSON", async () => {
  const rex = new Rex(run);
  await assert.rejects(rex.json(["-e", "process.stdout.write('{not json')"]), /invalid JSON/);
});
