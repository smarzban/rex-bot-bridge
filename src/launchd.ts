import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { packageRoot, type Paths } from "./paths.js";
import type { Runner } from "./rex.js";

export const LABELS = { bridge: "com.rexbotbridge.bridge", watch: "com.rexbotbridge.watch" } as const;
export type Service = keyof typeof LABELS;
export const LEGACY_LABELS = ["com.rex.bot-bridge", "com.rex.bot-watch"];

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
    REX_BOT_DIR: ctx.paths.stateDir,
  };
  return {
    bridge: {
      label: LABELS.bridge,
      description: "rex-bot-bridge MCP server",
      programArguments: [ctx.node, ctx.cli, "serve"],
      workingDirectory: ctx.pkgRoot,
      env,
      log: join(ctx.paths.logsDir, "bridge.log"),
    },
    watch: {
      label: LABELS.watch,
      description: "rex-bot-bridge status watcher",
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

/** Writes both plists and (re)loads them: bootout (ignored if not loaded), then bootstrap. */
export async function installServices(ctx: ServiceContext, launchctl: Runner): Promise<string[]> {
  const specs = serviceSpecs(ctx);
  await mkdir(ctx.paths.launchAgentsDir, { recursive: true });
  await mkdir(ctx.paths.logsDir, { recursive: true, mode: 0o700 });
  const done: string[] = [];
  for (const spec of Object.values(specs)) {
    const path = plistPath(ctx.paths, spec.label);
    await writeFile(path, await renderPlist(spec), { mode: 0o644 });
    await launchctl(["bootout", `${domain()}/${spec.label}`]);
    const r = await launchctl(["bootstrap", domain(), path]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap ${spec.label} failed: ${(r.stderr || r.stdout).trim()}`);
    done.push(spec.label);
  }
  return done;
}

export async function uninstallServices(paths: Paths, launchctl: Runner): Promise<string[]> {
  const removed: string[] = [];
  for (const label of Object.values(LABELS)) {
    const path = plistPath(paths, label);
    const r = await launchctl(["bootout", `${domain()}/${label}`]);
    let existed = r.code === 0;
    try {
      await readFile(path);
      await rm(path);
      existed = true;
    } catch {
      /* not there */
    }
    if (existed) removed.push(label);
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
