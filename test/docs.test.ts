// T435: placeholders like <token> or <session…> in prose vanish on GitHub (they render as HTML tags).
// Outside fenced blocks and inline code they must be backticked or escaped (&lt;…&gt;).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** Bare <…> left in the prose of a Markdown file (code, comments, <br> and autolinks are fine). */
export function barePlaceholders(md: string): string[] {
  const prose = md
    .replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "") // fenced blocks (also indented in lists)
    .replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "")
    .replace(/(`+)[\s\S]*?\1/g, "") // inline code
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/g, "")
    .replace(/<https?:\/\/[^>\s]+>/g, "");
  return [...prose.matchAll(/<[^>\n]*>/g)].map((m) => m[0]);
}

test("the checker finds bare placeholders and ignores code, comments, <br> and autolinks", () => {
  assert.deepEqual(barePlaceholders("Paste <token> here and `<key>` there"), ["<token>"]);
  assert.deepEqual(barePlaceholders("a\n```sh\nx <id>\n```\nb <https://x.y/z> <br> <!-- c -->"), []);
  assert.deepEqual(barePlaceholders("  ```text\n  headers: <token>\n  ```\n"), []);
  assert.deepEqual(barePlaceholders("| cell (https://<mac>.ts.net) |"), ["<mac>"]);
  assert.deepEqual(barePlaceholders("escaped &lt;mac&gt; is fine"), []);
});

for (const file of ["README.md", "docs/grok-bot.md", "templates/SKILL.md", "CHANGELOG.md"]) {
  test(`${file}: no bare <…> placeholders in prose`, async () => {
    assert.deepEqual(barePlaceholders(await readFile(join(ROOT, file), "utf8")), []);
  });
}

test("docs/grok-bot.md names the connector Rex (capital R)", async () => {
  const guide = await readFile(join(ROOT, "docs/grok-bot.md"), "utf8");
  assert.match(guide, /\| Name \| `Rex` \|/);
  assert.doesNotMatch(guide, /`rex` connector|connector `rex`|remove `rex`|the rex connector/);
});
