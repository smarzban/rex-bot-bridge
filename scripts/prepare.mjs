#!/usr/bin/env node
// `prepare`: builds dist/. Runs on `npm install` in a checkout, on `npm pack`/`publish`, and when npm
// installs this package from git (`npm i -g github:smarzban/rex-bot-bridge`).
//
// For a *global* git install, npm prepares the clone with npm_config_global=true still set, so its
// "install the devDependencies" step installs globally instead of into the clone and the build finds no
// tsc. When that happens, install the devDependencies locally here (global/prefix unset), then build.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const npm = process.env.npm_execpath ? [process.execPath, process.env.npm_execpath] : ["npm"];
const run = (args, env = process.env) => {
  const r = spawnSync(npm[0], [...npm.slice(1), ...args], { cwd: root, stdio: "inherit", env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!existsSync(join(root, "node_modules/.bin/tsc"))) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^npm_config_(global|prefix|location)$/i.test(k)) delete env[k];
  env.npm_config_global = "false";
  console.error("rex-bot-bridge prepare: installing build tools into the checkout");
  run(["install", "--include=dev", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock"], env);
}
run(["run", "build"]);
