import { chmod, readFile, rename, writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname, join, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * The bot-watch opt-in list: one session ID per line, `#` comments allowed.
 * Parsing matches bot-watch.lua: the ID is the first token before whitespace or `#`.
 */
export function lineId(line: string): string | null {
  const m = /^\s*([^\s#]+)/.exec(line);
  return m?.[1] ?? null;
}

export function parseWatched(content: string): string[] {
  const ids: string[] = [];
  for (const line of content.split("\n")) {
    const id = lineId(line);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function addWatched(content: string, id: string): string {
  if (parseWatched(content).includes(id)) return content;
  const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  return `${content}${sep}${id}\n`;
}

export function removeWatched(content: string, id: string): string {
  return content
    .split("\n")
    .filter((line) => lineId(line) !== id)
    .join("\n");
}

/**
 * One promise chain per file path, shared by every WatchFile instance in the process, so concurrent
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

export class WatchFile {
  constructor(readonly path: string) {}

  async read(): Promise<string> {
    try {
      return await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw e;
    }
  }

  async list(): Promise<string[]> {
    return parseWatched(await this.read());
  }

  /** Returns true if the file changed. */
  async add(id: string): Promise<boolean> {
    return this.update((c) => addWatched(c, id));
  }

  async remove(id: string): Promise<boolean> {
    return this.update((c) => removeWatched(c, id));
  }

  private update(fn: (content: string) => string): Promise<boolean> {
    return withLock(this.path, async () => {
      const before = await this.read();
      const after = fn(before);
      if (after === before) return false;
      await atomicWrite(this.path, after);
      return true;
    });
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
