import { existsSync } from "node:fs";
import { cliEntry, packageRoot, resolvePaths, which, type Paths } from "./paths.js";
import { spawnRunner, type Runner } from "./rex.js";

const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** Everything the setup/doctor/uninstall commands touch, injectable for tests. */
export interface Ctx {
  env: NodeJS.ProcessEnv;
  paths: Paths;
  pkgRoot: string;
  cli: string;
  node: string;
  /** Absolute rex path, or null when not found. */
  rexBin: string | null;
  rex: Runner;
  launchctl: Runner;
  tailscaleBin: string | null;
  tailscale: Runner;
  fetch: typeof fetch;
  /** Waits (launchd polling/retries); tests make it instant. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  out: (s: string) => void;
  err: (s: string) => void;
}

const missing =
  (what: string): Runner =>
  async () => ({ stdout: "", stderr: `${what} not found`, code: 127 });

export function findRex(env: NodeJS.ProcessEnv): string | null {
  if (env.REX_BIN) return existsSync(env.REX_BIN) ? env.REX_BIN : null;
  return which("rex", env);
}

export function findTailscale(env: NodeJS.ProcessEnv): string | null {
  if (env.TAILSCALE_BIN) return env.TAILSCALE_BIN;
  return which("tailscale", env) ?? (existsSync(TAILSCALE_APP) ? TAILSCALE_APP : null);
}

export function makeCtx(env: NodeJS.ProcessEnv = process.env): Ctx {
  const rexBin = findRex(env);
  const tailscaleBin = findTailscale(env);
  const pkgRoot = packageRoot();
  return {
    env,
    paths: resolvePaths(env),
    pkgRoot,
    cli: cliEntry(pkgRoot),
    node: process.execPath,
    rexBin,
    rex: rexBin ? spawnRunner(rexBin, 15_000) : missing("rex"),
    launchctl: spawnRunner("/bin/launchctl", 15_000),
    tailscaleBin,
    tailscale: tailscaleBin ? spawnRunner(tailscaleBin, 15_000) : missing("tailscale"),
    fetch,
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
  };
}

/** Installed via `npx` (a throwaway cache): services must not point there. */
export function isEphemeralInstall(pkgRoot: string): boolean {
  return /[/\\]_npx[/\\]/.test(pkgRoot);
}

/**
 * True when HOME is not the account's real home (a sandbox): the running Rex server reads the real
 * init.lua, so reloading it would not pick up our changes.
 */
export function isSandboxHome(ctx: Ctx, realHome: string): boolean {
  return ctx.paths.home !== realHome;
}
