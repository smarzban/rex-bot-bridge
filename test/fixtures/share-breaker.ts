// A separate process for the stale-lock break test: `share-breaker.ts <file> <id> <go>` waits until <go>
// exists (so every breaker starts at the same moment), then adds <id> under withShareLock. While it holds the
// lock it owns `<file>.holder` (created exclusively): if another process holds the lock at the same time, the
// exclusive create fails and this process exits 3.
import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { addShared, atomicWrite, withShareLock } from "../../src/share.js";

const [file, id, go] = process.argv.slice(2) as [string, string, string];
while (!existsSync(go)) await new Promise((r) => setTimeout(r, 1));
await withShareLock(
  file,
  async () => {
    try {
      await writeFile(`${file}.holder`, id, { flag: "wx" });
    } catch {
      console.error(`two holders at once (${id})`);
      process.exit(3);
    }
    const before = await readFile(file, "utf8").catch(() => "");
    await new Promise((r) => setTimeout(r, 5)); // widen the window a lost edit would need
    await atomicWrite(file, addShared(before, id));
    await unlink(`${file}.holder`);
  },
  { timeoutMs: 30_000 },
);
