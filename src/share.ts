import { chmod, readFile, rename, writeFile, mkdir, unlink, rmdir, stat } from "node:fs/promises";
import { dirname, join, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * The bot-watch share list: one entry per line, `#` comments allowed. An entry is a session
 * (`session:<uuid>`: every pane in it) or a single pane (`block:<uuid>`: only that pane).
 * Parsing matches lua/sharelist.lua: the entry is the first token before whitespace or `#`, and a
 * token that isn't `session:…` or `block:…` is ignored.
 */
export function lineId(line: string): string | null {
  const m = /^\s*([^\s#]+)/.exec(line);
  return m?.[1] ?? null;
}

export type ShareKind = "session" | "pane";

/** The kind of a watch entry, or null for anything else (junk lines are ignored everywhere). */
export function entryKind(id: string): ShareKind | null {
  if (/^session:\S+$/.test(id)) return "session";
  if (/^block:\S+$/.test(id)) return "pane";
  return null;
}

export function parseShared(content: string): string[] {
  const ids: string[] = [];
  for (const line of content.split("\n")) {
    const id = lineId(line);
    if (id && entryKind(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** True when the pane is shared itself or its session is. Either id may be missing. */
export function covers(ids: readonly string[], sessionId?: string | null, blockId?: string | null): boolean {
  return (!!sessionId && ids.includes(sessionId)) || (!!blockId && ids.includes(blockId));
}

export function addShared(content: string, id: string): string {
  if (parseShared(content).includes(id)) return content;
  const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  return `${content}${sep}${id}\n`;
}

export function removeShared(content: string, id: string): string {
  return content
    .split("\n")
    .filter((line) => lineId(line) !== id)
    .join("\n");
}

/**
 * One promise chain per file path, shared by every ShareFile instance in the process, so concurrent
 * read/modify/write updates (parallel tool calls, each with its own MCP server) never lose an edit.
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const path = resolve(file);
  const prev = locks.get(path) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  locks.set(path, tail);
  void tail.then(() => {
    if (locks.get(path) === tail) locks.delete(path);
  });
  return run;
}

export interface LockOptions {
  /** Give up after this long waiting for another writer (default 3000ms). */
  timeoutMs?: number;
  /** A lock directory older than this is a crashed writer's; break it (default 10000ms). */
  staleMs?: number;
  /** Wait between attempts (default 40ms). */
  retryMs?: number;
}

/** The lock lua/rex-grokbot-actions.lua takes too: `<list file>.lock`, a directory (mkdir is atomic). */
export function lockPath(file: string): string {
  return `${resolve(file)}.lock`;
}

/**
 * Cross-process lock around a read/modify/write of the share list. The bridge, the CLI and the Rex palette
 * (Lua) all write the file; each holds `<file>.lock` (a directory) for the whole update. A lock older than
 * `staleMs` is removed (a crashed writer must not block forever). After `timeoutMs` this throws and the
 * file is untouched. The lock is removed when `fn` settles, also when it throws.
 */
export async function withShareLock<T>(file: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const { timeoutMs = 3000, staleMs = 10_000, retryMs = 40 } = opts;
  const lock = lockPath(file);
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = await stat(lock).catch(() => null);
    if (st && Date.now() - st.mtimeMs > staleMs) {
      await rmdir(lock).catch(() => {});
      continue;
    }
    if (!st) continue; // released between our mkdir and stat
    if (Date.now() >= deadline) throw new Error(`share list is locked by another writer; try again (lock: ${lock})`);
    await new Promise((r) => setTimeout(r, retryMs));
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

export class ShareFile {
  constructor(
    readonly path: string,
    private readonly lockOpts: LockOptions = {},
  ) {}

  async read(): Promise<string> {
    try {
      return await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    }
  }

  /** Every entry, sessions and panes, in file order. */
  async list(): Promise<string[]> {
    return parseShared(await this.read());
  }

  async sessions(): Promise<string[]> {
    return (await this.list()).filter((id) => entryKind(id) === "session");
  }

  async panes(): Promise<string[]> {
    return (await this.list()).filter((id) => entryKind(id) === "pane");
  }

  /** True when the pane or its session is on the list. */
  async covers(sessionId?: string | null, blockId?: string | null): Promise<boolean> {
    return covers(await this.list(), sessionId, blockId);
  }

  /** Returns true if the file changed. */
  async add(id: string): Promise<boolean> {
    return this.update((c) => addShared(c, id));
  }

  async remove(id: string): Promise<boolean> {
    return this.update((c) => removeShared(c, id));
  }

  private update(fn: (content: string) => string): Promise<boolean> {
    // The in-process chain first (no self-contention), then the cross-process lock for the whole update.
    return withLock(this.path, () =>
      withShareLock(
        this.path,
        async () => {
          const before = await this.read();
          const after = fn(before);
          if (after === before) return false;
          await atomicWrite(this.path, after);
          return true;
        },
        this.lockOpts,
      ),
    );
  }
}

/**
 * Write to a temp file in the same directory, then rename over the target. The result always has
 * `mode` (default 0600), even when replacing a looser file from an older install. The temp file has
 * its final mode before any content is written.
 */
export async function atomicWrite(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, "", { mode, flag: "wx" });
    await chmod(tmp, mode); // writeFile's mode is filtered by the umask
    await writeFile(tmp, content);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
