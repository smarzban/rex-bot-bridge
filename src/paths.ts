import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Every file and directory rex-bot-bridge touches, resolved from HOME (and env overrides). */
export interface Paths {
  home: string;
  /** ~/.config/rex-bot-bridge (REX_BOT_DIR overrides). Mode 700. */
  stateDir: string;
  tokenFile: string;
  configFile: string;
  watchedFile: string;
  heartbeatFile: string;
  backupsDir: string;
  /** Where 0.2.x kept init.lua backups (inside stateDir); moved to backupsDir by setup/uninstall. */
  legacyBackupsDir: string;
  /** ~/Library/Logs/rex-bot-bridge */
  logsDir: string;
  notifyLog: string;
  auditLog: string;
  /** Rex's init.lua: REX_CONFIG, else $XDG_CONFIG_HOME/rex/init.lua, else ~/.config/rex/init.lua. */
  rexInitLua: string;
  launchAgentsDir: string;
  /** v1 opt-in list, imported once by setup. */
  legacyWatchedFile: string;
  /** Parent dirs that get the rex-bot skill if they exist. */
  skillRoots: string[];
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.HOME || homedir();
  const stateDir = env.REX_BOT_DIR || join(home, ".config/rex-bot-bridge");
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const logsDir = env.REX_BOT_LOG_DIR || join(home, "Library/Logs/rex-bot-bridge");
  return {
    home,
    stateDir,
    tokenFile: env.REX_BRIDGE_TOKEN_FILE || join(stateDir, "token"),
    configFile: join(stateDir, "config.json"),
    watchedFile: join(stateDir, "watched"),
    heartbeatFile: join(stateDir, "heartbeat"),
    // Next to init.lua, not in stateDir: `uninstall --purge` deletes stateDir and must keep these.
    backupsDir: join(dirname(env.REX_CONFIG || join(xdg, "rex/init.lua")), "rex-bot-backups"),
    legacyBackupsDir: join(stateDir, "init-backups"),
    logsDir,
    notifyLog: join(logsDir, "notify.log"),
    auditLog: env.REX_BRIDGE_AUDIT_LOG || join(home, ".local/state/rex-bot-bridge/audit.log"),
    rexInitLua: env.REX_CONFIG || join(xdg, "rex/init.lua"),
    launchAgentsDir: join(home, "Library/LaunchAgents"),
    legacyWatchedFile: join(xdg, "rex/bot-watch/sessions"),
    skillRoots: [join(home, ".claude"), join(home, ".agents")],
  };
}

/** Root of the installed package (the directory holding package.json, dist/, lua/, templates/). */
export function packageRoot(): string {
  // This file is src/paths.ts (tsx) or dist/paths.js (built): the root is one level up either way.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The built CLI entry point the services and the watcher run. */
export function cliEntry(root = packageRoot()): string {
  return join(root, "dist/cli/rex-bot.js");
}

/** Like `command -v`: the first executable named `name` on PATH, or null. */
export function which(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
