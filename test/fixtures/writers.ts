// Spawns test/fixtures/share-writer.ts as separate node processes (shared by the Node and Lua lock tests).
import { spawn } from "node:child_process";
import { join } from "node:path";
import { childEnv } from "../helpers.js";

const ROOT = join(import.meta.dirname, "../..");

/** Runs test/fixtures/share-writer.ts in its own node process. */
export function writerProcess(file: string, prefix: string, n: number, home: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--import", "tsx", join(ROOT, "test/fixtures/share-writer.ts"), file, prefix, String(n)], {
      cwd: ROOT,
      env: childEnv({ HOME: home }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rej);
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`writer ${prefix} exited ${code}: ${err}`))));
  });
}

/** What a writer leaves behind: its even-numbered ids. */
export const survivors = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `block:${prefix}-${i}`).filter((_, i) => i % 2 === 0);


/** Runs test/fixtures/share-breaker.ts: waits for <go>, then adds <id> under the lock, exiting 3 on overlap. */
export function breakerProcess(file: string, id: string, go: string, home: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--import", "tsx", join(ROOT, "test/fixtures/share-breaker.ts"), file, id, go], {
      cwd: ROOT,
      env: childEnv({ HOME: home }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", rej);
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`breaker ${id} exited ${code}: ${err}`))));
  });
}
