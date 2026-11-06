// T455: every relative link (and #anchor) in the published Markdown resolves, and llms.txt's raw GitHub URLs
// point at files that exist in this repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const RAW = "https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/";
const BLOB = "https://github.com/smarzban/rex-grokbot-bridge/blob/main/";

const FILES = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CHANGELOG.md",
  ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
  ...readdirSync(join(ROOT, ".github/ISSUE_TEMPLATE")).filter((f) => f.endsWith(".md")).map((f) => `.github/ISSUE_TEMPLATE/${f}`),
  ".github/pull_request_template.md",
];

/** Markdown with fenced blocks, inline code and HTML comments removed (links there aren't links). */
function prose(md: string): string {
  return md
    .replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "")
    .replace(/(`+)[\s\S]*?\1/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** GitHub's heading anchors: lowercase, drop punctuation (keep letters, digits, space, - and _), spaces → -, dedupe -1, -2. */
export function anchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  const noFences = md.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
  for (const m of noFences.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const text = m[1]!
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*~]/g, "");
    const base = text.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

function links(md: string): string[] {
  return [...prose(md).matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]!);
}

/** Problems with one link target from `file`, or [] if it resolves. */
function check(file: string, target: string): string[] {
  let t = target;
  if (t.startsWith(RAW)) t = "/" + t.slice(RAW.length);
  else if (t.startsWith(BLOB)) t = "/" + t.slice(BLOB.length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return []; // other absolute URLs: not checked offline
  const [path = "", anchor] = t.split("#");
  const abs = path === "" ? join(ROOT, file) : path.startsWith("/") ? join(ROOT, path) : normalize(join(ROOT, dirname(file), path));
  if (relative(ROOT, abs).startsWith("..")) return [`${file}: ${target} leaves the repo`];
  if (!existsSync(abs)) return [`${file}: ${target} → missing ${relative(ROOT, abs)}`];
  if (anchor && statSync(abs).isFile() && abs.endsWith(".md") && !anchors(readFileSync(abs, "utf8")).has(anchor)) {
    return [`${file}: ${target} → no heading #${anchor} in ${relative(ROOT, abs)}`];
  }
  return [];
}

test("anchors follow GitHub's slugs", () => {
  const a = anchors("# What `rex-grokbot setup` does\n## Is this safe?\n## Tailscale Serve and the port\n## Files\n## Files\n```\n# not a heading\n```");
  assert.deepEqual([...a], ["what-rex-grokbot-setup-does", "is-this-safe", "tailscale-serve-and-the-port", "files", "files-1"]);
});

test("the link checker catches a missing file and a missing anchor", () => {
  assert.deepEqual(check("README.md", "docs/nope.md"), ["README.md: docs/nope.md → missing docs/nope.md"]);
  assert.equal(check("README.md", "docs/setup.md#nope").length, 1);
  assert.deepEqual(check("README.md", "docs/setup.md#upgrading"), []);
  assert.deepEqual(check("docs/setup.md", "../README.md#quickstart"), []);
  assert.deepEqual(check("README.md", "https://example.com/x"), []);
  assert.equal(check("README.md", `${RAW}docs/missing.md`).length, 1);
});

for (const file of FILES) {
  test(`${file}: every relative link and anchor resolves`, () => {
    const md = readFileSync(join(ROOT, file), "utf8");
    assert.deepEqual(links(md).flatMap((l) => check(file, l)), []);
  });
}

test("llms.txt: every link points at a file in this repo", () => {
  const txt = readFileSync(join(ROOT, "llms.txt"), "utf8");
  const found = links(txt);
  assert.ok(found.length >= 6, "llms.txt lists the docs");
  for (const l of found) assert.ok(l.startsWith(RAW), `${l} is a raw GitHub URL`);
  assert.deepEqual(found.flatMap((l) => check("llms.txt", l)), []);
  for (const f of FILES.filter((f) => f.startsWith("docs/"))) {
    assert.ok(found.includes(RAW + f), `llms.txt links ${f}`);
  }
});
