// T427: the cross-process lock on the share list (src/share.ts withShareLock). Writers in different processes
// never lose an edit; a held lock makes a writer wait; a stale lock is broken; a fresh lock past the timeout
// fails clearly and leaves the file alone; the lock is gone after every write, also after a thrown error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rmdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lockPath, parseShared, ShareFile, withShareLock } from "../src/share.js";
import { tempDir } from "./helpers.js";
import { survivors, writerProcess } from "./fixtures/writers.js";

const A = "block:01a1a7e9-0000-7000-8000-0000000000a1";
const S1 = "session:01a1a7e9-0000-7000-8000-000000000001";

test("T427 lock: two writer processes, many concurrent adds/removes, no lost edits", async () => {
  const home = await tempDir();
  const file = join(home, "shared");
  await writeFile(file, `# keep me\n${S1}\n`);
  const N = 40;
  await Promise.all([writerProcess(file, "p1", N, home), writerProcess(file, "p2", N, home)]);
  const ids = parseShared(await readFile(file, "utf8"));
  assert.deepEqual(new Set(ids), new Set([S1, ...survivors("p1", N), ...survivors("p2", N)]));
  assert.equal(ids.length, 1 + N); // no duplicates either
  assert.match(await readFile(file, "utf8"), /^# keep me\n/);
  assert.ok(!existsSync(lockPath(file)), "lock removed");
});

test("T427 lock: a held lock makes a writer wait, then it succeeds once released", async () => {
  const dir = await tempDir();
  const file = join(dir, "shared");
  await mkdir(lockPath(file));
  const started = Date.now();
  setTimeout(() => void rmdir(lockPath(file)), 300);
  assert.equal(await new ShareFile(file).add(A), true);
  assert.ok(Date.now() - started >= 250, "waited for the holder");
  assert.deepEqual(parseShared(await readFile(file, "utf8")), [A]);
  assert.ok(!existsSync(lockPath(file)));
});

test("T427 lock: a stale lock (mtime older than 10s) is broken", async () => {
  const dir = await tempDir();
  const file = join(dir, "shared");
  await mkdir(lockPath(file));
  const old = new Date(Date.now() - 11_000);
  await utimes(lockPath(file), old, old);
  const started = Date.now();
  assert.equal(await new ShareFile(file).add(A), true);
  assert.ok(Date.now() - started < 1000, "didn't wait out the timeout");
  assert.deepEqual(parseShared(await readFile(file, "utf8")), [A]);
  assert.ok(!existsSync(lockPath(file)));
});

test("T427 lock: a fresh lock held past the timeout is a clear error and the file is unchanged", async () => {
  const dir = await tempDir();
  const file = join(dir, "shared");
  await writeFile(file, `${S1}\n`);
  await mkdir(lockPath(file));
  await assert.rejects(new ShareFile(file, { timeoutMs: 300 }).add(A), (e: Error) => {
    assert.match(e.message, /share list is locked by another writer; try again/);
    assert.ok(e.message.includes(lockPath(file)), e.message);
    return true;
  });
  assert.equal(await readFile(file, "utf8"), `${S1}\n`);
  assert.ok(existsSync(lockPath(file)), "someone else's lock is left alone");
});

test("T427 lock: default timeout is about 3s", async () => {
  const dir = await tempDir();
  const file = join(dir, "shared");
  await mkdir(lockPath(file));
  const started = Date.now();
  await assert.rejects(new ShareFile(file).add(A), /locked by another writer/);
  const took = Date.now() - started;
  assert.ok(took >= 2900 && took < 6000, `took ${took}ms`);
});

test("T427 lock: removed after each write, after a no-op, and after a thrown error", async () => {
  const dir = await tempDir();
  const file = join(dir, "shared");
  const share = new ShareFile(file);
  await share.add(A);
  assert.ok(!existsSync(lockPath(file)));
  assert.equal(await share.add(A), false); // no change
  assert.ok(!existsSync(lockPath(file)));
  await share.remove(A);
  assert.ok(!existsSync(lockPath(file)));
  await assert.rejects(
    withShareLock(file, async () => {
      assert.ok(existsSync(lockPath(file)), "held while fn runs");
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.ok(!existsSync(lockPath(file)), "removed after a throw");
});

test("T427 lock: the list's directory is created if missing (fresh install)", async () => {
  const dir = await tempDir();
  const file = join(dir, "not-yet/shared");
  assert.equal(await new ShareFile(file).add(A), true);
  assert.deepEqual(parseShared(await readFile(file, "utf8")), [A]);
});
