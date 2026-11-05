import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Runner } from "./rex.js";

export const BLOCK_START = "-- >>> rex-bot-bridge >>>";
export const BLOCK_END = "-- <<< rex-bot-bridge <<<";

/** Lua double-quoted string literal. */
export function luaString(s: string): string {
  if (/[\n\r\0]/.test(s)) throw new Error(`path contains a control character: ${JSON.stringify(s)}`);
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderBlock(actionsPath: string): string {
  return `${BLOCK_START}\ndofile(${luaString(actionsPath)})\n${BLOCK_END}\n`;
}

function blockRange(content: string): { start: number; end: number } | null {
  const start = content.indexOf(BLOCK_START);
  if (start < 0) return null;
  const endMarker = content.indexOf(BLOCK_END, start);
  if (endMarker < 0) throw new Error(`init.lua has "${BLOCK_START}" without "${BLOCK_END}"; fix it by hand`);
  let end = endMarker + BLOCK_END.length;
  if (content[end] === "\n") end++;
  return { start, end };
}

export function hasBlock(content: string): boolean {
  return blockRange(content) !== null;
}

/** Replaces our marked block in place, or appends it (separated by a blank line). */
export function upsertBlock(content: string, block: string): string {
  const r = blockRange(content);
  if (r) return content.slice(0, r.start) + block + content.slice(r.end);
  if (!content) return block;
  const sep = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + block;
}

export function removeBlock(content: string): string {
  const r = blockRange(content);
  if (!r) return content;
  let before = content.slice(0, r.start);
  const after = content.slice(r.end);
  // Drop the blank line upsertBlock added in front of the block.
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  return before + after;
}

/** True if the file defines the v1 actions outside our block (e.g. pasted inline). */
export function hasLegacyInline(content: string): boolean {
  const r = blockRange(content);
  const outside = r ? content.slice(0, r.start) + content.slice(r.end) : content;
  return /name\s*=\s*["'](bot_watch_toggle|bot_watch_list)["']/.test(outside);
}

async function readRaw(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export interface RexConfigOptions {
  initPath: string;
  backupsDir: string;
  rex: Runner;
  now?: () => Date;
}

export type RexConfigResult =
  | { status: "installed" | "unchanged" | "removed" | "absent"; backup?: string }
  | { status: "legacy-inline" }
  | { status: "check-failed"; backup?: string; detail: string };

async function backup(opts: RexConfigOptions, content: Buffer): Promise<string> {
  await mkdir(opts.backupsDir, { recursive: true, mode: 0o700 });
  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const path = join(opts.backupsDir, `${basename(opts.initPath)}.${stamp}`);
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

/** `rex config check <path>`; returns null when it passes, else the complaint text. */
export async function checkConfig(rex: Runner, path: string): Promise<string | null> {
  const r = await rex(["config", "check", path], { timeoutMs: 15_000 });
  if (r.code === 0) return null;
  const lines = (r.stdout + "\n" + r.stderr).split("\n").filter((l) => /error|Error/.test(l));
  return lines.join("\n").trim() || `rex config check exited ${r.code}`;
}

/**
 * Writes `content` to init.lua, runs `rex config check`, and puts the old file back (byte for byte, or
 * deletes it if there was none) when the check fails, or when writing or checking throws (timeout,
 * spawn failure, output overflow). A throw is re-raised after the restore.
 */
async function writeChecked(
  opts: RexConfigOptions,
  before: Buffer | null,
  content: string,
  ok: "installed" | "removed",
): Promise<RexConfigResult> {
  const bak = before !== null ? await backup(opts, before) : undefined;
  const restore = async () => {
    if (before !== null) await writeFile(opts.initPath, before);
    else await unlink(opts.initPath).catch(() => {});
  };
  let complaint: string | null;
  try {
    await mkdir(dirname(opts.initPath), { recursive: true });
    await writeFile(opts.initPath, content);
    complaint = await checkConfig(opts.rex, opts.initPath);
  } catch (e) {
    await restore();
    throw new Error(`could not validate ${opts.initPath} (${(e as Error).message}); restored the previous file`);
  }
  if (complaint === null) return { status: ok, backup: bak };
  await restore();
  return { status: "check-failed", backup: bak, detail: complaint };
}

/** Adds (or refreshes) the marked block that loads our actions file. */
export async function installBlock(opts: RexConfigOptions & { actionsPath: string }): Promise<RexConfigResult> {
  const raw = await readRaw(opts.initPath);
  const current = raw?.toString("utf8") ?? "";
  if (hasLegacyInline(current)) return { status: "legacy-inline" };
  const next = upsertBlock(current, renderBlock(opts.actionsPath));
  if (raw !== null && next === current) return { status: "unchanged" };
  return writeChecked(opts, raw, next, "installed");
}

export async function uninstallBlock(opts: RexConfigOptions): Promise<RexConfigResult> {
  const raw = await readRaw(opts.initPath);
  const before = raw?.toString("utf8") ?? null;
  if (raw === null || before === null || !hasBlock(before)) return { status: "absent" };
  return writeChecked(opts, raw, removeBlock(before), "removed");
}

/** Doctor: is our block there and pointing at an existing file? */
export async function inspectBlock(initPath: string): Promise<{ present: boolean; actionsPath?: string; legacy: boolean }> {
  const content = (await readOrNull(initPath)) ?? "";
  const r = blockRange(content);
  const m = r ? /dofile\("((?:[^"\\]|\\.)*)"\)/.exec(content.slice(r.start, r.end)) : null;
  return {
    present: !!r,
    actionsPath: m?.[1]?.replace(/\\(.)/g, "$1"),
    legacy: hasLegacyInline(content),
  };
}
