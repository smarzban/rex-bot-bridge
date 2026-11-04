import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "./paths.js";

export const SKILL_MARKER = "installed-by: rex-bot-bridge";

function skillFile(root: string): string {
  return join(root, "skills/rex-bot/SKILL.md");
}

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}

async function readOrNull(p: string): Promise<string | null> {
  return readFile(p, "utf8").catch(() => null);
}

/**
 * Installs the rex-bot skill under each root that exists (~/.claude, ~/.agents). A SKILL.md we did not
 * write (no marker) is left alone and reported.
 */
export async function installSkills(roots: string[], template = join(packageRoot(), "templates/SKILL.md")) {
  const content = await readFile(template, "utf8");
  const installed: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const root of roots) {
    const file = skillFile(root);
    if (!(await isDir(root))) {
      skipped.push({ path: file, reason: `${root} does not exist` });
      continue;
    }
    const existing = await readOrNull(file);
    if (existing !== null && !existing.includes(SKILL_MARKER)) {
      skipped.push({ path: file, reason: "a rex-bot skill not written by rex-bot-bridge is already there" });
      continue;
    }
    await mkdir(join(root, "skills/rex-bot"), { recursive: true });
    await writeFile(file, content);
    installed.push(file);
  }
  return { installed, skipped };
}

/** Removes only skills carrying our marker. */
export async function uninstallSkills(roots: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const root of roots) {
    const file = skillFile(root);
    const existing = await readOrNull(file);
    if (existing?.includes(SKILL_MARKER)) {
      await rm(file, { force: true });
      await rmdir(join(root, "skills/rex-bot")).catch(() => {}); // only if now empty
      removed.push(file);
    }
  }
  return removed;
}

export async function skillsPresent(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) if ((await readOrNull(skillFile(root)))?.includes(SKILL_MARKER)) out.push(skillFile(root));
  return out;
}
