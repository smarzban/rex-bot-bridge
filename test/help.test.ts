// T429: tsk-style help. Every command has a page; all the ways to ask for it work; README stays in sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { commandHelp, HELP, readmeCommands, TOP_HELP } from "../src/cli/help.js";
import { childEnv, tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const home = await tempDir();
const cli = (args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src/cli/rex-grokbot.ts"), ...args], {
    cwd: ROOT,
    env: childEnv({ HOME: home }),
    encoding: "utf8",
  });

test("T429 help: top-level help is grouped, names every command, and points at per-command help", () => {
  for (const g of ["Setup", "Check", "Settings", "Sharing", "For agents", "Services"]) assert.match(TOP_HELP, new RegExp(`^${g}$`, "m"));
  for (const c of Object.keys(HELP)) assert.match(TOP_HELP, new RegExp(`^  ${c} `, "m"), c);
  assert.match(TOP_HELP, /Run `rex-grokbot help <command>` or `rex-grokbot <command> --help`/);
  assert.match(TOP_HELP, /docs\/grok-bot\.md/);
});

test("T429 help: --help, -h and help all print the top-level help, exit 0", () => {
  for (const a of [["--help"], ["-h"], ["help"]]) {
    const r = cli(a);
    assert.equal(r.status, 0, a.join(" "));
    assert.equal(r.stdout, TOP_HELP + "\n");
  }
});

test("T429 help: every command's page has usage, Examples and Exit, via help <cmd>, <cmd> --help and <cmd> -h", () => {
  for (const name of Object.keys(HELP)) {
    const page = commandHelp(name)!;
    assert.match(page, /^usage: rex-grokbot /, name);
    assert.match(page, /\nExamples:\n {2}rex-grokbot /, name);
    assert.match(page, /\nExit:\n {2}\S/, name);
    const words = name.split(" ");
    for (const args of [["help", ...words], [...words, "--help"], [...words, "-h"]]) {
      const r = cli(args);
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      assert.equal(r.stdout, page + "\n", args.join(" "));
    }
  }
});

test("T429 help: setup parts share setup's page; setup webhook has its own", () => {
  assert.equal(cli(["setup", "services", "--help"]).stdout, commandHelp("setup") + "\n");
  assert.notEqual(commandHelp("setup webhook"), commandHelp("setup"));
  assert.match(commandHelp("setup")!, /\nParts\n/);
  assert.match(commandHelp("setup webhook")!, /--key-file FILE/);
});

test("T429 help: unknown command / flag → one short error with a --help hint, exit 2", () => {
  const u = cli(["frobnicate"]);
  assert.equal(u.status, 2);
  assert.equal(u.stderr, "rex-grokbot: unknown command: frobnicate\nRun `rex-grokbot --help` for usage.\n");
  const f = cli(["doctor", "--nope"]);
  assert.equal(f.status, 2);
  assert.match(f.stderr, /^rex-grokbot: Unknown option '--nope'.*\nRun `rex-grokbot doctor --help` for usage\.\n$/);
  assert.equal(cli(["help", "frobnicate"]).status, 2);
  assert.equal(cli([]).status, 2, "bare rex-grokbot: help on stderr, exit 2");
});

test("T429 help: README's command table is generated from the help text", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  const m = /<!-- commands:start[^>]*-->\n([\s\S]*?)\n<!-- commands:end -->/.exec(readme);
  assert.ok(m, "README has the commands markers");
  assert.equal(m[1], readmeCommands(), "README is stale: run npm run docs:commands");
});
