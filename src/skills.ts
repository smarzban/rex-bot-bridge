import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "./paths.js";

export const SKILL_MARKER = "installed-by: rex-bot-bridge";

/** The skill's directory name. Before 0.4.0 it was "rex-bot" (LEGACY_SKILL_NAME). */
export const SKILL_NAME = "rex-grokbot";
export const LEGACY_SKILL_NAME = "rex-bot";

function skillFile(root: string, name = SKILL_NAME): string {
  return join(root, "skills", name, "SKILL.md");
}

/** Removes `<root>/skills/<name>/SKILL.md` (and the dir, if then empty) only when it carries our marker. */
async function removeOurs(root: string, name: string): Promise<string | null> {
  const file = skillFile(root, name);
  if (!(await readOrNull(file))?.includes(SKILL_MARKER)) return null;
  await rm(file, { force: true });
  await rmdir(join(root, "skills", name)).catch(() => {}); // only if now empty
  return file;
}

/** Removes the pre-0.4.0 "rex-bot" skill we installed (only with our marker; someone else's is kept). */
export async function removeLegacySkills(roots: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const root of roots) {
    const f = await removeOurs(root, LEGACY_SKILL_NAME);
    if (f) removed.push(f);
  }
  return removed;
}

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}

async function readOrNull(p: string): Promise<string | null> {
  return readFile(p, "utf8").catch(() => null);
}

/**
 * Installs the rex-grokbot skill under each root that exists (~/.claude, ~/.agents). A SKILL.md we did not
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
      skipped.push({ path: file, reason: "a rex-grokbot skill not written by rex-bot-bridge is already there" });
      continue;
    }
    await mkdir(join(root, "skills", SKILL_NAME), { recursive: true });
    await writeFile(file, content);
    installed.push(file);
  }
  return { installed, skipped, legacyRemoved: await removeLegacySkills(roots) };
}

/** Removes only skills carrying our marker: the current one and the pre-0.4.0 "rex-bot" one. */
export async function uninstallSkills(roots: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const root of roots) {
    const f = await removeOurs(root, SKILL_NAME);
    if (f) removed.push(f);
  }
  return [...removed, ...(await removeLegacySkills(roots))];
}

export async function skillsPresent(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) if ((await readOrNull(skillFile(root)))?.includes(SKILL_MARKER)) out.push(skillFile(root));
  return out;
}
