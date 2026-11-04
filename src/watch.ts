import { readFile, rename, stat, writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
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

  private async update(fn: (content: string) => string): Promise<boolean> {
    const before = await this.read();
    const after = fn(before);
    if (after === before) return false;
    await atomicWrite(this.path, after);
    return true;
  }
}

/** Write to a temp file in the same directory, then rename over the target. Keeps the target's mode. */
export async function atomicWrite(path: string, content: string, defaultMode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode = defaultMode;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, content, { mode });
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
