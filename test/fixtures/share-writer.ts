// A separate writer process for the share-lock tests: `share-writer.ts <file> <prefix> <n>` adds n distinct
// block ids `block:<prefix>-<i>`, then removes the odd ones, each as its own ShareFile update (its own lock).
import { ShareFile } from "../../src/share.js";

const [file, prefix, n] = process.argv.slice(2);
const share = new ShareFile(file!, { timeoutMs: 30_000 });
const ids = Array.from({ length: Number(n) }, (_, i) => `block:${prefix}-${i}`);
for (const id of ids) await share.add(id);
for (const [i, id] of ids.entries()) if (i % 2 === 1) await share.remove(id);
