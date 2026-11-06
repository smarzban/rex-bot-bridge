// T427: the palette's toggle (lua/rex-grokbot-actions.lua) takes the same lock as src/share.ts: it waits for a
// held lock, fails cleanly when the lock stays held, breaks a stale one, and always releases its own. And Node
// writers and the palette hammering the same file lose no edits. The actions file is loaded offline under
// `rex config check` with the real rex.exec (mkdir/stat/sleep/chmod) and a stub for the rest (no alerts, no
// server). Skipped when rex isn't on PATH. Every run uses a temp HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rmdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findRex } from "../src/context.js";
import { lockPath, parseShared } from "../src/share.js";
import { childEnv, tempDir } from "./helpers.js";
import { survivors, writerProcess } from "./fixtures/writers.js";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const REX = findRex(process.env);
const skip = REX ? false : "rex not on PATH";
const S1 = "session:01a1a7e9-0000-7000-8000-000000000001";
const A = "block:01a1a7e9-0000-7000-8000-0000000000a1";

const lstr = (s: string) => JSON.stringify(s);

async function home() {
  const h = await tempDir();
  const dir = join(h, ".config/rex-grokbot-bridge");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return { home: h, file: join(dir, "shared") };
}

/**
 * Loads the palette actions with HOME=home, then calls the "Bot: Share / Unshare This Pane" action once per id
 * (in order). Each call's outcome ("ok" or "err <message>") is a line of the result. Alerts are stubbed.
 */
async function toggle(h: string, ids: string[]): Promise<string[]> {
  const dir = await tempDir();
  const out = join(dir, "out.txt");
  const harness = `
local real = rex.exec
local actions = {}
rex = {
  exec = setmetatable({ start = function() end }, { __call = function(_, argv, opts) return real(argv, opts) end }),
  action = function(a) actions[a.name] = a end,
  call = function() return { sessions = {} } end,
  session = { list_blocks = function() return { blocks = {} } end },
}
dofile(${lstr(join(ROOT, "lua/rex-grokbot-actions.lua"))})
local f = assert(io.open(${lstr(out)}, "w"))
for _, id in ipairs({ ${ids.map(lstr).join(", ")} }) do
  local ok, err = pcall(actions.bot_share_pane_toggle.run, { block_id = id }, {})
  f:write(ok and "ok" or ("err " .. tostring(err)), "\\n")
end
f:close()
`;
  const file = join(dir, "harness.lua");
  await writeFile(file, harness);
  const r = await run(REX!, ["--autostart=false", "config", "check", "--json", file], {
    env: childEnv({ HOME: h }),
    timeout: 120_000,
  }).catch((e: { stdout: string; stderr: string }) => e);
  const idx = r.stdout.search(/^\{/m);
  assert.ok(idx >= 0, `rex config check gave no report: ${r.stdout} ${r.stderr}`);
  const rep = JSON.parse(r.stdout.slice(idx)) as { diagnostics?: unknown[] };
  assert.deepEqual(rep.diagnostics ?? [], [], `lua complained: ${r.stdout} ${r.stderr}`);
  return (await readFile(out, "utf8")).split("\n").filter(Boolean);
}

test("T427 lua: the toggle adds/removes and leaves no lock or temp file behind", { skip }, async () => {
  const { home: h, file } = await home();
  await writeFile(file, `# mine\n${S1}\n`);
  assert.deepEqual(await toggle(h, [A]), ["ok"]);
  assert.equal(await readFile(file, "utf8"), `# mine\n${S1}\n${A}\n`);
  assert.deepEqual(await toggle(h, [A]), ["ok"]);
  assert.equal(await readFile(file, "utf8"), `# mine\n${S1}\n`);
  assert.ok(!existsSync(lockPath(file)), "lock released");
  assert.deepEqual((await readdir(join(h, ".config/rex-grokbot-bridge"))).sort(), ["shared"]);
});

test("T427 lua: the toggle waits for a held lock, then writes and releases", { skip }, async () => {
  const { home: h, file } = await home();
  await writeFile(file, `${S1}\n`);
  await mkdir(lockPath(file));
  const started = Date.now();
  setTimeout(() => void rmdir(lockPath(file)), 800);
  assert.deepEqual(await toggle(h, [A]), ["ok"]);
  assert.ok(Date.now() - started >= 800, "waited for the holder");
  assert.deepEqual(parseShared(await readFile(file, "utf8")), [S1, A]);
  assert.ok(!existsSync(lockPath(file)));
});

test("T427 lua: a lock held past ~3s fails cleanly, file unchanged, the holder's lock left alone", { skip }, async () => {
  const { home: h, file } = await home();
  await writeFile(file, `${S1}\n`);
  await mkdir(lockPath(file));
  const [res] = await toggle(h, [A]);
  assert.match(res!, /^err share list is locked by another writer; try again/);
  assert.ok(res!.includes(lockPath(file)), res!);
  assert.equal(await readFile(file, "utf8"), `${S1}\n`);
  assert.ok(existsSync(lockPath(file)));
});

test("T427 lua: a stale lock (older than 10s) is broken", { skip }, async () => {
  const { home: h, file } = await home();
  await mkdir(lockPath(file));
  const old = new Date(Date.now() - 20_000);
  await utimes(lockPath(file), old, old);
  assert.deepEqual(await toggle(h, [A]), ["ok"]);
  assert.deepEqual(parseShared(await readFile(file, "utf8")), [A]);
  assert.ok(!existsSync(lockPath(file)));
});

test("T427 lua: no setup yet (no config dir) fails at once with the setup hint", { skip }, async () => {
  const h = await tempDir();
  const started = Date.now();
  const [res] = await toggle(h, [A]);
  assert.match(res!, /^err cannot write .*run `rex-grokbot setup` first/);
  assert.ok(Date.now() - started < 2500, "didn't spin for the lock timeout");
});

test("T427 cross-language: Node writers and the palette toggle on one file lose no edits", { skip }, async () => {
  const { home: h, file } = await home();
  await writeFile(file, `# keep me\n${S1}\n`);
  const N = 40;
  const K = 30;
  // The palette adds lua-0..K-1, then toggles the odd ones off again.
  const luaIds = Array.from({ length: K }, (_, i) => `block:lua-${i}`);
  const luaRun = [...luaIds, ...luaIds.filter((_, i) => i % 2 === 1)];
  const [luaRes] = await Promise.all([toggle(h, luaRun), writerProcess(file, "n1", N, h), writerProcess(file, "n2", N, h)]);
  assert.deepEqual(luaRes, luaRun.map(() => "ok"));
  const ids = parseShared(await readFile(file, "utf8"));
  assert.deepEqual(new Set(ids), new Set([S1, ...survivors("n1", N), ...survivors("n2", N), ...survivors("lua", K)]));
  assert.equal(ids.length, 1 + N + K / 2);
  assert.ok(!existsSync(lockPath(file)));
});
