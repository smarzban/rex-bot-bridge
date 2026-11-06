#!/usr/bin/env node
// Release helpers for .github/workflows/release.yml (run from the repo root, on the tag's checkout).
//
//   node scripts/release.mjs check <tag> [<main-ref>]   tag must be v + package.json's version, and its
//                                                       commit must be on <main-ref> (default origin/main);
//                                                       prints the version
//   node scripts/release.mjs notes <version>            prints that version's CHANGELOG.md section; fails
//                                                       when there is none
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function check(tag, mainRef = "origin/main") {
  if (!tag) fail("usage: release.mjs check <tag> [<main-ref>]");
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version ${version} is not X.Y.Z`);
  if (tag !== `v${version}`) fail(`tag ${tag} does not match package.json version ${version} (expected v${version})`);
  let commit;
  try {
    commit = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
  } catch {
    fail(`tag ${tag} not found in this checkout`);
  }
  try {
    git("rev-parse", "--verify", `${mainRef}^{commit}`);
  } catch {
    fail(`${mainRef} not found (fetch it: actions/checkout needs fetch-depth: 0)`);
  }
  try {
    git("merge-base", "--is-ancestor", commit, mainRef);
  } catch {
    fail(`tag ${tag} (${commit.slice(0, 12)}) is not on ${mainRef}: release only from merged commits`);
  }
  process.stdout.write(`${version}\n`);
}

function notes(version) {
  if (!version) fail("usage: release.mjs notes <version>");
  const lines = readFileSync("CHANGELOG.md", "utf8").split("\n");
  const esc = version.replace(/\./g, "\\.");
  const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${esc}\\]?(\\s|$)`).test(l));
  if (start < 0) fail(`CHANGELOG.md has no "## ${version}" section`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) fail(`CHANGELOG.md's ${version} section is empty`);
  process.stdout.write(`${body}\n`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "check") check(...args);
else if (cmd === "notes") notes(...args);
else fail("usage: release.mjs check <tag> [<main-ref>] | notes <version>");
