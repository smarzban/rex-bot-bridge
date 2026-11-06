// Regenerates the command table in docs/reference.md from the CLI help text: npm run docs:commands
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readmeCommands } from "../src/cli/help.js";

const file = join(import.meta.dirname, "../docs/reference.md");
const doc = readFileSync(file, "utf8");
const re = /(<!-- commands:start[^>]*-->\n)[\s\S]*?(<!-- commands:end -->)/;
if (!re.test(doc)) throw new Error("docs/reference.md has no <!-- commands:start --> … <!-- commands:end --> markers");
writeFileSync(file, doc.replace(re, (_, a: string, b: string) => a + readmeCommands() + "\n" + b));
console.log("docs/reference.md command table updated");
