// Regenerates README.md's command table from the CLI help text: npm run docs:commands
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readmeCommands } from "../src/cli/help.js";

const file = join(import.meta.dirname, "../README.md");
const readme = readFileSync(file, "utf8");
const re = /(<!-- commands:start[^>]*-->\n)[\s\S]*?(<!-- commands:end -->)/;
if (!re.test(readme)) throw new Error("README.md has no <!-- commands:start --> … <!-- commands:end --> markers");
writeFileSync(file, readme.replace(re, (_, a: string, b: string) => a + readmeCommands() + "\n" + b));
console.log("README.md command table updated");
