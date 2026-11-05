import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { packageRoot, type Paths } from "./paths.js";
import type { Runner } from "./rex.js";

export const LABELS = { bridge: "com.rexgrokbotbridge.bridge", watch: "com.rexgrokbotbridge.watch" } as const;
export type Service = keyof typeof LABELS;

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface PlistSpec {
  label: string;
  description: string;
  programArguments: string[];
  workingDirectory: string;
  env: Record<string, string>;
  log: string;
}

export async function renderPlist(spec: PlistSpec, templatePath = join(packageRoot(), "templates/launchd.plist")) {
  const tpl = await readFile(templatePath, "utf8");
  const args = spec.programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");
  const values: Record<string, string> = {
    DESCRIPTION: xmlEscape(spec.description).replace(/--/g, "- -"),
    LABEL: xmlEscape(spec.label),
    PROGRAM_ARGUMENTS: args,
    WORKING_DIRECTORY: xmlEscape(spec.workingDirectory),
    ENVIRONMENT: env,
    LOG: xmlEscape(spec.log),
  };
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => {
    const v = values[k];
    if (v === undefined) throw new Error(`unknown template field ${k}`);
    return v;
  });
}

export interface ServiceContext {
  paths: Paths;
  node: string;
  cli: string;
  rexBin: string;
  pkgRoot: string;
  /** The Rex server address setup itself used (REX_SERVER), passed on so services reach the same server. */
  rexServer?: string;
}

/** PATH for services: rex's dir and node's dir first, then the usual system dirs. */
export function servicePath(ctx: ServiceContext): string {
  const dirs = [dirname(ctx.rexBin), dirname(ctx.node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

export function serviceSpecs(ctx: ServiceContext): Record<Service, PlistSpec> {
  const env = {
    HOME: ctx.paths.home,
    PATH: servicePath(ctx),
    REX_BIN: ctx.rexBin,
    REX_GROKBOT_DIR: ctx.paths.stateDir,
    ...(ctx.rexServer ? { REX_SERVER: ctx.rexServer } : {}),
  };
  return {
    bridge: {
      label: LABELS.bridge,
      description: "rex-grokbot-bridge MCP server",
      programArguments: [ctx.node, ctx.cli, "serve"],
      workingDirectory: ctx.pkgRoot,
      env,
      log: join(ctx.paths.logsDir, "bridge.log"),
    },
    watch: {
      label: LABELS.watch,
      description: "rex-grokbot-bridge status watcher",
      programArguments: [ctx.node, ctx.cli, "watch"],
      workingDirectory: ctx.pkgRoot,
      env,
      log: join(ctx.paths.logsDir, "watch.log"),
    },
  };
}

export function plistPath(paths: Paths, label: string): string {
  return join(paths.launchAgentsDir, `${label}.plist`);
}

export function domain(uid = process.getuid?.() ?? 501): string {
  return `gui/${uid}`;
}

export interface InstallOptions {
  /** Waits between polls and retries; injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a bootout to finish before bootstrapping anyway. */
  bootoutWaitMs?: number;
  /** How many times bootstrap is tried. */
  tries?: number;
}

export interface ServiceResult {
  label: string;
  ok: boolean;
  /** launchctl's message when bootstrap failed on every try. */
  error?: string;
  plist: string;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The exact command that loads one of our services by hand. */
export function bootstrapCommand(paths: Paths, label: string): string {
  return `launchctl bootstrap gui/$(id -u) '${plistPath(paths, label)}'`;
}

/**
 * Writes both plists and (re)loads them. `bootout` returns before launchd has finished unloading, and a
 * bootstrap in that window fails ("Bootstrap failed: 5: Input/output error"), so this waits until
 * `launchctl print` no longer finds the label, then bootstraps with retries and backoff.
 * Never throws for a launchctl failure: each service's result says whether it loaded.
 */
export async function installServices(ctx: ServiceContext, launchctl: Runner, opts: InstallOptions = {}): Promise<ServiceResult[]> {
  const sleep = opts.sleep ?? realSleep;
  const waitMs = opts.bootoutWaitMs ?? 10_000;
  const tries = opts.tries ?? 3;
  const specs = serviceSpecs(ctx);
  await mkdir(ctx.paths.launchAgentsDir, { recursive: true });
  await mkdir(ctx.paths.logsDir, { recursive: true, mode: 0o700 });
  const results: ServiceResult[] = [];
  for (const spec of Object.values(specs)) {
    const path = plistPath(ctx.paths, spec.label);
    const target = `${domain()}/${spec.label}`;
    await writeFile(path, await renderPlist(spec), { mode: 0o644 });
    await launchctl(["bootout", target]);
    for (let waited = 0; waited < waitMs; waited += 250) {
      if ((await launchctl(["print", target])).code !== 0) break;
      await sleep(250);
    }
    let error: string | undefined;
    for (let i = 0; i < tries; i++) {
      if (i > 0) await sleep(500 * 2 ** (i - 1));
      const r = await launchctl(["bootstrap", domain(), path]);
      if (r.code === 0) {
        error = undefined;
        break;
      }
      error = (r.stderr || r.stdout).trim() || `exit ${r.code}`;
    }
    results.push({ label: spec.label, ok: !error, error, plist: path });
  }
  return results;
}

/**
 * Boots out and deletes the services whose plist is in this HOME's LaunchAgents. A label without our plist
 * is left alone (so an uninstall with a different HOME, e.g. a test sandbox, never stops real services).
 */
export async function uninstallServices(paths: Paths, launchctl: Runner): Promise<string[]> {
  const removed: string[] = [];
  for (const label of Object.values(LABELS)) {
    const path = plistPath(paths, label);
    const exists = await readFile(path).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    await launchctl(["bootout", `${domain()}/${label}`]);
    await rm(path, { force: true });
    removed.push(label);
  }
  return removed;
}

export interface ServiceState {
  loaded: boolean;
  running: boolean;
  pid?: number;
  lastExit?: string;
}

export async function serviceState(label: string, launchctl: Runner): Promise<ServiceState> {
  const r = await launchctl(["print", `${domain()}/${label}`]);
  if (r.code !== 0) return { loaded: false, running: false };
  const state = /^\s*state = (\S+)/m.exec(r.stdout)?.[1];
  const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
  const lastExit = /^\s*last exit code = (.+)$/m.exec(r.stdout)?.[1];
  return { loaded: true, running: state === "running", pid: pid ? Number(pid) : undefined, lastExit };
}
