// T457: scripts/release.mjs, the guards release.yml runs before publishing. Each test builds a throwaway git
// repo (main + a side branch) in a temp folder; nothing touches this checkout or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts/release.mjs");

const CHANGELOG = `# Changelog

## 1.2.3 — 2026-11-06

- **New thing.** It works.
- Another line.

## 1.2.2 — 2026-11-01

- Older.
`;

async function repo(version = "1.2.3") {
  const dir = await tempDir();
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version }));
  await writeFile(join(dir, "CHANGELOG.md"), CHANGELOG);
  git("add", ".");
  git("commit", "-qm", "release");
  git("tag", "-a", `v${version}`, "-m", `v${version}`);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { dir, git, run };
}

test("T457 release check: tag = v + package.json version, on main → prints the version", async () => {
  const r = (await repo()).run("check", "v1.2.3", "main");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "1.2.3\n");
});

test("T457 release check: a tag that doesn't match package.json fails", async () => {
  const rp = await repo();
  rp.git("tag", "-a", "v1.2.4", "-m", "v1.2.4");
  for (const tag of ["v1.2.4", "1.2.3", "v1.2.3-rc.1"]) {
    const r = rp.run("check", tag, "main");
    assert.equal(r.status, 1, tag);
    assert.match(r.stderr, new RegExp(`tag ${tag.replace(/\./g, "\\.")} does not match package\\.json version 1\\.2\\.3`));
    assert.equal(r.stdout, "");
  }
});

test("T457 release check: a tag whose commit is not on main fails", async () => {
  const rp = await repo();
  rp.git("tag", "-d", "v1.2.3");
  rp.git("checkout", "-q", "-b", "side");
  await writeFile(join(rp.dir, "x.txt"), "unmerged");
  rp.git("add", ".");
  rp.git("commit", "-qm", "unmerged");
  rp.git("tag", "-a", "v1.2.3", "-m", "v1.2.3");
  const r = rp.run("check", "v1.2.3", "main");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tag v1\.2\.3 \([0-9a-f]{12}\) is not on main: release only from merged commits/);
});

test("T457 release check: a missing tag or main ref fails clearly", async () => {
  const rp = await repo();
  rp.git("tag", "-d", "v1.2.3");
  let r = rp.run("check", "v1.2.3", "main");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tag v1\.2\.3 not found/);
  rp.git("tag", "-a", "v1.2.3", "-m", "v1.2.3");
  r = rp.run("check", "v1.2.3"); // default origin/main: no remote here
  assert.equal(r.status, 1);
  assert.match(r.stderr, /origin\/main not found \(fetch it: actions\/checkout needs fetch-depth: 0\)/);
});

test("T457 release check: a non X.Y.Z package.json version fails", async () => {
  const r = (await repo("1.2.3-beta.1")).run("check", "v1.2.3-beta.1", "main");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /package\.json version 1\.2\.3-beta\.1 is not X\.Y\.Z/);
});

test("T457 release notes: prints exactly that version's CHANGELOG section", async () => {
  const rp = await repo();
  const r = rp.run("notes", "1.2.3");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "- **New thing.** It works.\n- Another line.\n");
  const old = rp.run("notes", "1.2.2");
  assert.equal(old.stdout, "- Older.\n");
});

test("T457 release notes: a missing section fails (a forgotten CHANGELOG entry stops the release)", async () => {
  const r = (await repo()).run("notes", "1.2.30");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHANGELOG\.md has no "## 1\.2\.30" section/);
});

test("T457 release notes: this repo's CHANGELOG has a section for package.json's version", async () => {
  const { version } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const r = spawnSync(process.execPath, [SCRIPT, "notes", version], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim().length > 0);
});
