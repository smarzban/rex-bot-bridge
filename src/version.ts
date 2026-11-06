import { readFileSync } from "node:fs";

/** The version in package.json (same relative path from src/ and dist/). */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}
