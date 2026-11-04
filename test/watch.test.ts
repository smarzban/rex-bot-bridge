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
