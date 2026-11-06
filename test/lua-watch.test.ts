// T435: the Lua side of the watch list. lua/watchlist.lua must agree with src/watch.ts, and the watcher
// (lua/bot-watch.lua) must notify when the event's pane OR its session is watched, and only then.
// The Lua runs offline under `rex config check` (it loads a file with this rex binary's Lua, no server),
// with a stub `rex` table for the watcher. Skipped when rex isn't on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findRex } from "../src/context.js";
import { covers, parseWatched } from "../src/watch.js";
import { childEnv, tempDir } from "./helpers.js";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const REX = findRex(process.env);
const skip = REX ? false : "rex not on PATH";

const S1 = "session:01a1a7e9-0000-7000-8000-000000000001";
const S2 = "session:01a1a7e9-0000-7000-8000-000000000002";
const A = "block:01a1a7e9-0000-7000-8000-0000000000a1";
const B = "block:01a1a7e9-0000-7000-8000-0000000000b2";

const lstr = (s: string) => JSON.stringify(s); // a JSON string literal is a valid Lua string literal here (ASCII, \n, \")

/** Loads a Lua file the way init.lua is loaded, offline. Fails the test on any load complaint. */
async function checkLua(dir: string, body: string): Promise<void> {
  const file = join(dir, "harness.lua");
  await writeFile(file, body);
  const home = await tempDir();
  const r = await run(REX!, ["--autostart=false", "config", "check", "--json", file], {
    env: childEnv({ HOME: home, REX_GROKBOT_CLI: "/nonexistent/cli.js", REX_GROKBOT_DIR: dir }),
  }).catch((e: { stdout: string; stderr: string }) => e);
  // The watcher prints log lines while it loads; the report is the JSON object after them.
  const out = JSON.parse(r.stdout.slice(r.stdout.search(/^\{/m))) as { diagnostics?: { severity: string; message: string }[] };
  assert.deepEqual(out.diagnostics ?? [], [], `lua complained: ${r.stdout} ${r.stderr}`);
}

const FILES = [
  `${S1}\n`,
  `# only pane A\n  ${A}   # note\n`,
  `${B}\n`,
  "",
  `junk\nwindow:01a1\n#${S1}\nx${A} # not an entry\nsession:\nblock:\n`,
  `${S2}\n${A}\n${A}\n`,
];
const ASKS: [string, string][] = [
  [S1, A],
  [S1, B],
  [S2, A],
  [S2, B],
];

test("lua/watchlist.lua parses and decides exactly like src/watch.ts", { skip }, async () => {
  const dir = await tempDir();
  const out = join(dir, "out.txt");
  const lines: string[] = [
    `local WL = dofile(${lstr(join(ROOT, "lua/watchlist.lua"))})`,
    `local f = assert(io.open(${lstr(out)}, "w"))`,
  ];
  FILES.forEach((content, i) => {
    lines.push(`do local ids = WL.parse(${lstr(content)}); f:write("parse ${i} ", table.concat(ids, ","), "\\n")`);
    for (const [s, b] of ASKS) lines.push(`  f:write("covers ${i} ${s} ${b} ", tostring(WL.covers(ids, ${lstr(s)}, ${lstr(b)})), "\\n")`);
    lines.push("end");
  });
  lines.push("f:close()");
  await checkLua(dir, lines.join("\n") + "\n");

  const expected: string[] = [];
  FILES.forEach((content, i) => {
    const ids = parseWatched(content);
    expected.push(`parse ${i} ${ids.join(",")}`);
    for (const [s, b] of ASKS) expected.push(`covers ${i} ${s} ${b} ${covers(ids, s, b)}`);
  });
  assert.deepEqual((await readFile(out, "utf8")).trimEnd().split("\n"), expected);
  // The TS side, spelled out: junk is ignored, both kinds parse.
  assert.deepEqual(parseWatched(FILES[4]!), []);
  assert.deepEqual(parseWatched(`${S1}\n${A}\njunk\n`), [S1, A]);
});

/**
 * Runs bot-watch.lua's status handler against a stub `rex`: one status event per case (pane + session),
 * then fires the debounce timer and records whether the watcher sent the webhook.
 */
async function watcherDecisions(watched: string, events: [string, string][], unwatchBeforeTimer = false) {
  const dir = await tempDir();
  await writeFile(join(dir, "watched"), watched);
  const out = join(dir, "out.txt");
  const harness = `
local handlers, timers, sent = {}, {}, {}
local timer = function(fn) local t = { fn = fn }; function t:cancel() self.fn = nil end; timers[#timers + 1] = t; return t end
local exec = setmetatable({ start = function() end }, { __call = function(_, argv, opts)
  if argv[1] == "/bin/chmod" then return { code = 0 } end
  sent[#sent + 1] = opts and opts.stdin or "?"
  return { code = 0, stdout = "HTTP 200" }
end })
rex = {
  on = function(name, fn) handlers[name] = fn end,
  every = function() end,
  after = function(_, fn) return timer(fn) end,
  exec = exec,
  call = function() return { sessions = {} } end,
  session = { list_blocks = function() return { blocks = {} } end },
  block = { call = function() return nil end },
  json = { encode = function(t) return t.rex_block end },
}
dofile(${lstr(join(ROOT, "lua/bot-watch.lua"))})
local f = assert(io.open(${lstr(out)}, "w"))
local events = { ${events.map(([s, b]) => `{ ${lstr(s)}, ${lstr(b)} }`).join(", ")} }
for i, e in ipairs(events) do
  handlers["terminal.program_status_changed"]({ session_id = e[1], block_id = e[2] }, { id = "s" .. i, record = { state = "done", app = "t" } })
end
${unwatchBeforeTimer ? `do local w = assert(io.open(${lstr(join(dir, "watched"))}, "w")); w:write(""); w:close() end` : ""}
for _, t in ipairs(timers) do if t.fn then t.fn() end end
for _, b in ipairs(sent) do f:write(b, "\\n") end
f:close()
`;
  await checkLua(dir, harness);
  return (await readFile(out, "utf8")).split("\n").filter(Boolean);
}

test("watcher: a watched session notifies for every pane in it, not for other sessions", { skip }, async () => {
  const sent = await watcherDecisions(`${S1}\n`, [[S1, A], [S1, B], [S2, "block:01a1a7e9-0000-7000-8000-0000000000c3"]]);
  assert.deepEqual(sent, [A, B]);
});

test("watcher: a watched pane notifies for that pane only, not its sibling in the same session", { skip }, async () => {
  const sent = await watcherDecisions(`# pane only\n${A}  # note\n`, [[S1, A], [S1, B]]);
  assert.deepEqual(sent, [A]);
});

test("watcher: nothing watched (or only junk) notifies nothing", { skip }, async () => {
  assert.deepEqual(await watcherDecisions("", [[S1, A], [S1, B]]), []);
  assert.deepEqual(await watcherDecisions(`junk\n#${A}\n`, [[S1, A], [S1, B]]), []);
});

test("watcher: a pane unwatched during the debounce is not notified", { skip }, async () => {
  assert.deepEqual(await watcherDecisions(`${A}\n`, [[S1, A]], true), []);
});
