import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addWatched, parseWatched, removeWatched, WatchFile } from "../src/watch.js";
import { tempDir } from "./helpers.js";

const A = "session:aaaa0000-0000";
const B = "session:bbbb0000-0000";

test("parse matches bot-watch.lua: first token, comments and blanks ignored", () => {
  const content = `# header comment\n\n  ${A}   # inline note\n#${B}\n${B}\n${A}\n`;
  assert.deepEqual(parseWatched(content), [A, B]);
});

test("add is idempotent and handles a missing trailing newline", () => {
  assert.equal(addWatched("", A), `${A}\n`);
  assert.equal(addWatched("# c", A), `# c\n${A}\n`);
  assert.equal(addWatched(`${A}\n`, A), `${A}\n`);
});

test("remove keeps comments and other ids", () => {
  const content = `# keep me\n${A} # note\n${B}\n`;
  assert.equal(removeWatched(content, A), `# keep me\n${B}\n`);
  assert.equal(removeWatched(content, "session:none"), content);
});

test("file round-trip with comments leaves the file byte-identical and keeps its mode", async () => {
  const dir = await tempDir();
  const path = join(dir, "sessions");
  const original = `# opted-in sessions\n# one per line\n\n${B}  # coordinator\n`;
  await writeFile(path, original);
  await chmod(path, 0o640);
  const w = new WatchFile(path);

  assert.equal(await w.add(A), true);
  assert.deepEqual(await w.list(), [B, A]);
  assert.equal(await w.add(A), false);
  assert.equal(await w.remove(A), true);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(dir), ["sessions"], "no temp files left behind");
});

test("concurrent adds/removes from separate instances never lose an update", async () => {
  const dir = await tempDir();
  const path = join(dir, "sessions");
  const header = "# keep this comment\n";
  await writeFile(path, header);
  const ids = Array.from({ length: 25 }, (_, i) => `session:0000-${String(i).padStart(4, "0")}`);
  // A fresh WatchFile per call, like the per-request MCP servers.
  const results = await Promise.all(ids.map((id) => new WatchFile(path).add(id)));
  assert.ok(results.every((r) => r === true));
  assert.deepEqual((await new WatchFile(path).list()).sort(), [...ids].sort());

  const toRemove = ids.filter((_, i) => i % 2 === 0);
  await Promise.all([
    ...toRemove.map((id) => new WatchFile(path).remove(id)),
    new WatchFile(join(dir, ".", "sessions")).add("session:extra-0000"),
  ]);
  const left = await new WatchFile(path).list();
  assert.deepEqual(left.sort(), [...ids.filter((_, i) => i % 2 === 1), "session:extra-0000"].sort());
  assert.ok((await readFile(path, "utf8")).startsWith(header));
  assert.deepEqual(await readdir(dir), ["sessions"], "no temp files left behind");
});

test("a failed update does not block later ones", async () => {
  const dir = await tempDir();
  const path = join(dir, "sessions");
  await writeFile(path, "");
  const w = new WatchFile(path);
  await chmod(dir, 0o500); // read-only dir: temp file creation fails
  await assert.rejects(w.add(A));
  await chmod(dir, 0o700);
  assert.equal(await w.add(B), true);
  assert.deepEqual(await w.list(), [B]);
});

test("empty file round-trip stays empty; missing file reads as empty", async () => {
  const dir = await tempDir();
  const path = join(dir, "sessions");
  const w = new WatchFile(path);
  assert.deepEqual(await w.list(), []);
  await writeFile(path, "");
  await w.add(A);
  await w.remove(A);
  assert.equal(await readFile(path, "utf8"), "");
});
