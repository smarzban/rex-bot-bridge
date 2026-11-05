import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { isEphemeralInstall, isSandboxHome, type Ctx } from "./context.js";
import { DOC_RAW_URL, DOC_URL } from "./grokbot.js";
import { bootstrapCommand, installServices, LEGACY_LABELS, serviceState } from "./launchd.js";
import type { Prompter } from "./prompt.js";
import { installBlock, migrateBackups } from "./rexconfig.js";
import { getJson } from "./doctor.js";
import { ensurePrivateDir, legacyServePath, MODES, readSettings, settingsExist, writeSettings, type Mode, type Settings } from "./settings.js";
import { installSkills } from "./skills.js";
import {
  bridgeOrigin,
  legacyPathTarget,
  legacyServeOffArgs,
  legacyUrl,
  portTarget,
  serveArgs,
  servesDesired,
  shellCommand,
  tailscaleStatus,
} from "./tailscale.js";
import { ensureToken } from "./token.js";
import { parseWatched, WatchFile } from "./watch.js";

/** The parts `rex-grokbot setup <part>` runs on their own. Bare `setup` runs them all (webhook is separate). */
export const PARTS = ["rex", "services", "serve", "skill"] as const;
export type Part = (typeof PARTS)[number];

export interface SetupFlags {
  yes: boolean;
  mode?: Mode;
  services: boolean;
  serve: boolean;
  skills: boolean;
  rexConfig: boolean;
}

/** The last thing bare `rex-grokbot setup` prints. */
export const NEXT_BLOCK = `Next
  1. Set up Grok Bot: ${DOC_URL}
     (or give your Grok Bot this address: ${DOC_RAW_URL})
  2. Add the routine's webhook: rex-grokbot setup webhook
  3. Check everything: rex-grokbot doctor --test-webhook`;

const SECTION_TITLES: Record<Part, string> = {
  rex: "Rex palette",
  services: "Services",
  serve: "Tailscale Serve",
  skill: "Agent skill",
};

export const LEGACY_SESSION_LABELS = ["rex-bridge", "bot-watch"];

const MODE_HELP = `Powers for the bot:
  watched  (recommended) the bot can only read, type into, and close panes in sessions you opted in
           (palette "Bot: Watch / Unwatch This Session" or \`rex-grokbot watch add <session>\`), plus new
           sessions it spawns. It can list every session.
  full     the bot can drive every Rex session on this Mac.`;

/** Rex sessions whose label suggests a v1 bridge/watcher started by hand. */
export async function legacySessions(ctx: Ctx): Promise<string[]> {
  const r = await ctx.rex(["ls", "--json"]).catch(() => null);
  if (!r || r.code !== 0) return [];
  try {
    const j = JSON.parse(r.stdout) as { sessions?: { session_id: string; label?: string }[] };
    return (j.sessions ?? []).filter((s) => s.label && LEGACY_SESSION_LABELS.includes(s.label)).map((s) => `${s.label} (${s.session_id})`);
  } catch {
    return [];
  }
}

export async function legacyServices(ctx: Ctx): Promise<string[]> {
  const out: string[] = [];
  for (const label of LEGACY_LABELS) if ((await serviceState(label, ctx.launchctl)).loaded) out.push(label);
  return out;
}

/** Imports v1 opt-in ids into `watched`; returns the ids that were added. The old file is left alone. */
export async function migrateWatched(legacyFile: string, watchedFile: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(legacyFile, "utf8");
  } catch {
    return [];
  }
  const watch = new WatchFile(watchedFile);
  const added: string[] = [];
  for (const id of parseWatched(content)) if (await watch.add(id)) added.push(id);
  return added;
}

/** One printer per run: numbered section headers, and ✅/⚠️/❌ lines with an optional fix line. */
function printer(ctx: Ctx) {
  let n = 0;
  let failed = false;
  const fixLine = (fix?: string) => (fix ? `\n      fix: ${fix.replace(/\n/g, "\n           ")}` : "");
  return {
    section: (title: string) => ctx.out(`${n ? "\n" : ""}${++n}. ${title}`),
    ok: (s: string) => ctx.out(`   ✅ ${s}`),
    warn: (s: string, fix?: string) => ctx.out(`   ⚠️  ${s}${fixLine(fix)}`),
    fail: (s: string, fix?: string) => {
      failed = true;
      ctx.err(`   ❌ ${s}${fixLine(fix)}`);
    },
    note: (s: string) => ctx.out(`      ${s}`),
    get failed() {
      return failed;
    },
  };
}
type Printer = ReturnType<typeof printer>;

/** Section 1. Returns false when setup can't go on. `needRex`: the part talks to Rex or installs services. */
async function checks(ctx: Ctx, out: Printer, needRex: boolean): Promise<boolean> {
  out.section("Checks");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    out.fail(`Node ${process.versions.node} is too old; rex-bot-bridge needs Node 22 or newer.`, "Install Node 22+, then re-run");
    return false;
  }
  out.ok(`Node ${process.versions.node}`);
  if (process.platform !== "darwin") out.warn("rex-bot-bridge services are built for macOS; other platforms are untested.");
  if (!needRex) return true;
  if (!ctx.rexBin) {
    out.fail("rex not found on PATH.", "Install Rex and make sure `command -v rex` works (or set REX_BIN)");
    return false;
  }
  const ver = await ctx.rex(["api", "call", "server.version"], { timeoutMs: 5000 });
  if (ver.code !== 0) {
    out.fail("The Rex server is not reachable (`rex api call server.version` failed).", "Open Rex, then re-run");
    return false;
  }
  out.ok(`Rex found: ${ctx.rexBin}`);
  if (!existsSync(ctx.cli)) {
    out.fail(`${ctx.cli} is missing.`, "Build the package first: npm run build");
    return false;
  }
  return true;
}

/** Section 2 (bare setup only): state dir, token, mode, v1 import. */
async function settingsSection(ctx: Ctx, out: Printer, flags: SetupFlags, p: Prompter): Promise<Settings> {
  const { paths } = ctx;
  out.section("Settings");
  await ensurePrivateDir(paths.stateDir);
  const { created } = await ensureToken(paths.tokenFile);
  out.ok(`Token ${created ? "created" : "kept"}: ${paths.tokenFile} (mode 600)`);

  const hadSettings = await settingsExist(paths.configFile);
  const s = await readSettings(paths.configFile);

  // The v1 list is imported once. Re-importing on every run would give the bot back sessions the
  // human has since unwatched, so a recorded import or an existing v2 list means it's skipped.
  if (!s.migratedV1At && existsSync(paths.legacyWatchedFile)) {
    if (!existsSync(paths.watchedFile)) {
      const migrated = await migrateWatched(paths.legacyWatchedFile, paths.watchedFile);
      if (migrated.length) out.ok(`Imported ${migrated.length} watched session(s) from ${paths.legacyWatchedFile} (that file was left in place).`);
    } else {
      out.note(`${paths.watchedFile} already exists, so the v1 list ${paths.legacyWatchedFile} was not imported.`);
    }
    s.migratedV1At = new Date().toISOString();
  }

  if (flags.mode) {
    s.mode = flags.mode;
  } else if (!hadSettings) {
    ctx.out("\n" + MODE_HELP);
    s.mode = await p.choose("Mode", MODES, "watched");
  }
  out.ok(`Mode: ${s.mode}${hadSettings && !flags.mode ? " (kept)" : ""}`);
  // A fresh install has no webhook yet; that's step 2 under Next, not a problem, so no warning.
  if (s.webhook.url) out.ok("Webhook configured (change it: rex-grokbot setup webhook)");
  s.skipped = { services: !flags.services, serve: !flags.serve };
  await writeSettings(paths.configFile, s);
  return s;
}

async function rexSection(ctx: Ctx, out: Printer): Promise<void> {
  const { paths } = ctx;
  const actionsPath = join(ctx.pkgRoot, "lua/rex-bot-actions.lua");
  const r = await installBlock({ initPath: paths.rexInitLua, backupsDir: paths.backupsDir, actionsPath, rex: ctx.rex }).catch(
    (e: Error) => ({ status: "error" as const, detail: e.message }),
  );
  if (r.status === "error") {
    out.fail(r.detail, "rex-grokbot setup rex");
  } else if (r.status === "legacy-inline") {
    out.warn(
      `${paths.rexInitLua} already defines bot_watch_toggle / bot_watch_list inline (v1).`,
      "Remove that old block by hand (the two rex.action{…} entries and their helpers), then: rex-grokbot setup rex",
    );
  } else if (r.status === "check-failed") {
    out.fail(`rex config check failed after editing ${paths.rexInitLua}; restored the previous file.\n${r.detail}`, `Fix ${paths.rexInitLua} (rex config check), then: rex-grokbot setup rex`);
  } else {
    out.ok(`Palette actions ${r.status === "unchanged" ? "already in" : "added to"} ${paths.rexInitLua}${r.backup ? ` (backup: ${r.backup})` : ""}`);
    if (r.status === "installed") {
      if (isSandboxHome(ctx, userInfo().homedir)) {
        out.note("(HOME is not your account's home, so the running Rex server was not reloaded.)");
      } else {
        const rl = await ctx.rex(["config", "reload"]);
        if (rl.code === 0) out.ok("Rex config reloaded");
        else out.warn("`rex config reload` failed.", "rex config reload");
      }
    }
  }
}

async function servicesSection(ctx: Ctx, out: Printer, s: Settings, p: Prompter): Promise<boolean> {
  const { paths } = ctx;
  const oldServices = await legacyServices(ctx);
  if (oldServices.length) {
    out.warn(
      `v1 launchd services are loaded: ${oldServices.join(", ")}. Stop them so they don't fight over port ${s.port}.`,
      oldServices.map((l) => `launchctl bootout gui/$(id -u)/${l}`).join("\n"),
    );
  }
  const oldSessions = await legacySessions(ctx);
  if (oldSessions.length) {
    out.warn(`Rex sessions that look like a v1 bridge/watcher are running: ${oldSessions.join(", ")}.`, "Close them yourself once the new services are up");
  }
  if (isEphemeralInstall(ctx.pkgRoot)) {
    out.warn(
      "rex-bot-bridge is running from an npx cache; services must point at a stable install.",
      "curl -fsSL https://raw.githubusercontent.com/smarzban/rex-bot-bridge/main/install.sh | sh",
    );
    if (!(await p.confirm("Install services pointing at this npx cache anyway?", false))) {
      out.warn("Services not installed.", "rex-grokbot setup services (from a global install)");
      return false;
    }
  }
  if (!existsSync(paths.tokenFile)) {
    await ensurePrivateDir(paths.stateDir);
    await ensureToken(paths.tokenFile);
    out.ok(`Token created: ${paths.tokenFile} (mode 600)`);
  }
  let results;
  try {
    results = await installServices(
      { paths, node: ctx.node, cli: ctx.cli, rexBin: ctx.rexBin!, pkgRoot: ctx.pkgRoot, rexServer: ctx.env.REX_SERVER },
      ctx.launchctl,
      { sleep: ctx.sleep },
    );
  } catch (e) {
    out.fail(`Could not write the services: ${(e as Error).message}`, "rex-grokbot setup services");
    return false;
  }
  for (const r of results) {
    if (r.ok) out.ok(`${r.label} loaded`);
    else out.fail(`${r.label} did not load: ${r.error}`, bootstrapCommand(paths, r.label));
  }
  if (results.some((r) => r.ok)) out.note(`Logs: ${paths.logsDir}`);
  return results.every((r) => r.ok);
}

/** Returns true when the bridge's port mapping is in place afterwards. */
async function serveSection(ctx: Ctx, out: Printer, s: Settings, p: Prompter): Promise<boolean> {
  const ts = await tailscaleStatus(ctx.tailscale);
  const desired = `http://127.0.0.1:${s.port}`;
  const cmd = shellCommand("tailscale", serveArgs(s.servePort, s.port));
  if (!ctx.tailscaleBin || !ts.running) {
    out.warn(`Tailscale is not running${ctx.tailscaleBin ? "" : " (tailscale CLI not found)"}.`, `Start Tailscale, then: rex-grokbot setup serve`);
    return false;
  }
  const origin = bridgeOrigin(ts.dnsName, s.servePort);
  const current = await portTarget(ctx.tailscale, s.servePort);
  if (servesDesired(current, desired)) {
    out.ok(`Already maps ${origin} → ${desired}`);
  } else {
    let run: boolean;
    const pickPort = `pick another port: rex-grokbot config set servePort <port>, then: rex-grokbot setup serve`;
    if (current.kind === "occupied" && current.root) {
      // A single `/` handler: our command replaces exactly that. Never by default (so --yes leaves it alone).
      out.warn(`Tailscale Serve port ${s.servePort} is already in use: ${origin}/ → ${current.target}.`, pickPort);
      run = await p.confirm(`Replace it with ${desired}?`, false);
    } else if (current.kind === "occupied") {
      // Several paths, a TCP forward, plain HTTP: one command can't cleanly take the port over, so don't offer to.
      out.warn(`Tailscale Serve port ${s.servePort} is already in use: ${current.target}. Setup won't change it.`, pickPort);
      return false;
    } else if (current.kind === "unknown") {
      out.warn(`Could not read Tailscale Serve's current config (${current.reason}), so setup can't tell whether port ${s.servePort} is in use.`);
      run = await p.confirm(`Run \`${cmd}\` anyway (it replaces anything at ${origin}/)?`, false);
    } else {
      out.note(`To give the bridge its own HTTPS origin on your tailnet (tailnet only, not Funnel), setup will run:\n         ${cmd}`);
      run = await p.confirm("Run it now?", true);
    }
    if (!run) {
      out.warn("Tailscale Serve not changed.", cmd);
      return false;
    }
    const r = await ctx.tailscale(serveArgs(s.servePort, s.port));
    if (r.code !== 0) {
      out.fail(`tailscale serve failed: ${(r.stderr || r.stdout).trim()}`, cmd);
      return false;
    }
    out.ok(`${origin} → ${desired}`);
    out.note(`Connector URL: ${origin}/mcp (rex-grokbot url)`);
  }
  await migrateLegacyServe(ctx, out, s, p, ts.dnsName, origin, desired);
  return true;
}

/**
 * ≤ 0.4 mapped `/rex-bridge` on :443, an origin other apps share (and whose OAuth metadata can hijack the
 * connector). Once the port mapping answers, offer to remove that path, only when it proxies to our bridge.
 * `/`, other paths, and a foreign or unreadable mapping are never touched.
 */
async function migrateLegacyServe(ctx: Ctx, out: Printer, s: Settings, p: Prompter, dnsName: string | undefined, origin: string, desired: string) {
  const path = legacyServePath(s);
  if (!servesDesired(await legacyPathTarget(ctx.tailscale, path), desired)) return;
  const offCmd = shellCommand("tailscale", legacyServeOffArgs(path));
  out.warn(`The old mapping ${legacyUrl(dnsName, path)} → ${desired} (0.4 and earlier) is still on port 443, which other apps share.`);
  const health = await getJson(ctx.fetch, `${origin}/healthz`, 8000);
  if (!(health.status === 200 && health.body?.ok === true)) {
    out.warn(`Kept it for now: ${origin}/healthz didn't answer (${health.error ?? `HTTP ${health.status}`}), so the new mapping isn't confirmed working.`, `once rex-grokbot doctor is green: ${offCmd}`);
    return;
  }
  if (!(await p.confirm(`Remove the old ${path} mapping on port 443 (only that path)?`, true))) {
    out.warn("Old mapping left in place.", offCmd);
    return;
  }
  const r = await ctx.tailscale(legacyServeOffArgs(path));
  if (r.code !== 0) {
    out.fail(`removing the old mapping failed: ${(r.stderr || r.stdout).trim()}`, offCmd);
    return;
  }
  out.ok(`Removed the old mapping ${legacyUrl(dnsName, path)}`);
  out.note(`The connector URL changed: set the rex connector in Grok Bot to ${origin}/mcp`);
}

async function skillSection(ctx: Ctx, out: Printer): Promise<void> {
  const r = await installSkills(ctx.paths.skillRoots);
  for (const f of r.installed) out.ok(`Installed: ${f}`);
  for (const f of r.legacyRemoved) out.ok(`Removed the old rex-bot skill: ${f}`);
  for (const k of r.skipped) out.note(`Not installed at ${k.path}: ${k.reason}`);
  if (!r.installed.length) out.warn("No agent skill installed (needs ~/.claude or ~/.agents).");
}

/**
 * `rex-grokbot setup` (no part): Checks, Settings, then every part the flags allow, then the Next block.
 * `rex-grokbot setup <part>`: Checks, then that part only.
 */
export async function setup(ctx: Ctx, flags: SetupFlags, p: Prompter, part?: Part): Promise<number> {
  const out = printer(ctx);
  ctx.out(part ? `rex-bot-bridge setup: ${SECTION_TITLES[part].toLowerCase()}\n` : "rex-bot-bridge setup\n");
  const needRex = !part || part === "rex" || part === "services";
  if (!(await checks(ctx, out, needRex))) return 1;
  // 0.2.x kept init.lua backups inside the state dir, which `uninstall --purge` deletes: move them out.
  const migrated = await migrateBackups(ctx.paths.legacyBackupsDir, ctx.paths.backupsDir);
  if (migrated.length) out.ok(`Moved ${migrated.length} init.lua backup(s) to ${ctx.paths.backupsDir}`);

  if (part) {
    const s = await readSettings(ctx.paths.configFile);
    out.section(SECTION_TITLES[part]);
    if (part === "rex") await rexSection(ctx, out);
    else if (part === "skill") await skillSection(ctx, out);
    else {
      const done = part === "services" ? await servicesSection(ctx, out, s, p) : await serveSection(ctx, out, s, p);
      // Doctor stops calling this part "skipped" once it has been set up.
      if (done && s.skipped?.[part]) {
        s.skipped = { ...s.skipped, [part]: false };
        await writeSettings(ctx.paths.configFile, s);
      }
    }
    ctx.out("\nNext: rex-grokbot doctor");
    return out.failed ? 1 : 0;
  }

  const s = await settingsSection(ctx, out, flags, p);
  out.section(SECTION_TITLES.rex);
  if (flags.rexConfig) await rexSection(ctx, out);
  else out.warn("Skipped (--no-rex-config).", "rex-grokbot setup rex");
  out.section(SECTION_TITLES.services);
  if (flags.services) await servicesSection(ctx, out, s, p);
  else out.warn("Skipped (--no-services). Run the bridge and watcher yourself (rex-grokbot serve / rex-grokbot watch), or later:", "rex-grokbot setup services");
  out.section(SECTION_TITLES.serve);
  if (flags.serve) await serveSection(ctx, out, s, p);
  else out.warn("Skipped (--no-serve).", "rex-grokbot setup serve");
  out.section(SECTION_TITLES.skill);
  if (flags.skills) await skillSection(ctx, out);
  else out.warn("Skipped (--no-skills).", "rex-grokbot setup skill");

  ctx.out("\n" + NEXT_BLOCK);
  return out.failed ? 1 : 0;
}
