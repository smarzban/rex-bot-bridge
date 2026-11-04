import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { isEphemeralInstall, isSandboxHome, type Ctx } from "./context.js";
import { grokbotText } from "./grokbot.js";
import { installServices, LEGACY_LABELS, serviceState } from "./launchd.js";
import type { Prompter } from "./prompt.js";
import { installBlock } from "./rexconfig.js";
import { ensurePrivateDir, MODES, readSettings, setKey, settingsExist, writeSettings, type Mode } from "./settings.js";
import { installSkills } from "./skills.js";
import { serveArgs, serveTarget, shellCommand, tailscaleStatus } from "./tailscale.js";
import { ensureToken } from "./token.js";
import { parseWatched, WatchFile } from "./watch.js";

export interface SetupFlags {
  yes: boolean;
  mode?: Mode;
  webhookUrl?: string;
  webhookKeyFile?: string;
  webhookHeader?: string;
  services: boolean;
  serve: boolean;
  skills: boolean;
  rexConfig: boolean;
  showToken: boolean;
}

export const LEGACY_SESSION_LABELS = ["rex-bridge", "bot-watch"];

const MODE_HELP = `Powers for the bot:
  watched  (recommended) the bot can only read, type into, and close panes in sessions you opted in
           (palette "Bot: Watch / Unwatch This Session" or \`rex-bot watch add <session>\`), plus new
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

export async function setup(ctx: Ctx, flags: SetupFlags, p: Prompter): Promise<number> {
  const { paths } = ctx;
  const say = ctx.out;
  const warn = (s: string) => ctx.out(`⚠️  ${s}`);
  const ok = (s: string) => ctx.out(`✅ ${s}`);
  let failed = false;

  say("rex-bot-bridge setup\n");

  // 1. Preflight
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    ctx.err(`❌ Node ${process.versions.node} is too old; rex-bot-bridge needs Node 22 or newer.`);
    return 1;
  }
  if (process.platform !== "darwin") warn("rex-bot-bridge services are built for macOS; other platforms are untested.");
  if (!ctx.rexBin) {
    ctx.err("❌ rex not found on PATH. Install Rex and make sure `command -v rex` works (or set REX_BIN).");
    return 1;
  }
  const ver = await ctx.rex(["api", "call", "server.version"], { timeoutMs: 5000 });
  if (ver.code !== 0) {
    ctx.err("❌ The Rex server is not reachable (`rex api call server.version` failed). Open Rex and try again.");
    return 1;
  }
  ok(`Rex found: ${ctx.rexBin}`);
  if (isEphemeralInstall(ctx.pkgRoot)) {
    warn(
      "rex-bot-bridge is running from an npx cache. Services must point at a stable install:\n" +
        "    npm i -g rex-bot-bridge && rex-bot setup",
    );
    if (flags.services && !(await p.confirm("Install services pointing at this npx cache anyway?", false))) {
      flags.services = false;
    }
  }
  if (!existsSync(ctx.cli)) {
    ctx.err(`❌ ${ctx.cli} is missing. Build the package first (npm run build).`);
    return 1;
  }

  // 2. State dir, token, settings
  await ensurePrivateDir(paths.stateDir);
  const { created } = await ensureToken(paths.tokenFile);
  ok(`Token ${created ? "created" : "kept"}: ${paths.tokenFile} (mode 600)`);

  const hadSettings = await settingsExist(paths.configFile);
  let s = await readSettings(paths.configFile);

  const migrated = await migrateWatched(paths.legacyWatchedFile, paths.watchedFile);
  if (migrated.length) {
    ok(`Imported ${migrated.length} watched session(s) from ${paths.legacyWatchedFile} (that file was left in place).`);
  }

  if (flags.mode) {
    s.mode = flags.mode;
  } else if (!hadSettings) {
    const v1 = existsSync(paths.legacyWatchedFile);
    say("\n" + MODE_HELP);
    if (v1) say("  (Your v1 setup gave the bot full powers. Choose full to keep that.)");
    s.mode = await p.choose("Mode", MODES, "watched");
    if (v1 && !p.interactive && s.mode === "watched") {
      warn('v1 gave the bot full powers; this install defaults to "watched". Run `rex-bot config set mode full` to keep v1 behaviour.');
    }
  }
  ok(`Mode: ${s.mode}${hadSettings && !flags.mode ? " (kept)" : ""}`);

  // 3. Webhook
  if (flags.webhookUrl) s = setKey(s, "webhook.url", flags.webhookUrl);
  if (flags.webhookKeyFile) s = setKey(s, "webhook.key", (await readFile(flags.webhookKeyFile, "utf8")).trim());
  if (flags.webhookHeader) s = setKey(s, "webhook.header", flags.webhookHeader);
  if (!s.webhook.url && p.interactive) {
    say("\nThe watcher and `rex-bot say` POST to a Grok Bot routine's webhook (see the Grok Bot text at the end).");
    const url = await p.ask("Webhook URL (Enter to skip and set it later)");
    if (url) {
      s = setKey(s, "webhook.url", url);
      const key = await p.ask("Webhook key (Enter if none; input hidden)", { secret: true });
      if (key) {
        s = setKey(s, "webhook.key", key);
        const header = await p.ask("Header for the key", { def: "Authorization" });
        if (header && header !== "Authorization") s = setKey(s, "webhook.header", header);
      }
    }
  }
  s.skipped = { services: !flags.services, serve: !flags.serve };
  await writeSettings(paths.configFile, s);
  if (s.webhook.url) ok("Webhook configured");
  else warn("Webhook not configured yet: rex-bot config set webhook.url '<url>'");

  // 4. v1 leftovers (report only)
  const oldServices = await legacyServices(ctx);
  if (oldServices.length) {
    warn(
      `v1 launchd services are loaded: ${oldServices.join(", ")}. Stop them so they don't fight over port ${s.port}:\n` +
        oldServices.map((l) => `    launchctl bootout gui/$(id -u)/${l}`).join("\n"),
    );
  }
  const oldSessions = await legacySessions(ctx);
  if (oldSessions.length) {
    warn(`Rex sessions that look like a v1 bridge/watcher are running: ${oldSessions.join(", ")}. Close them yourself once the new services are up.`);
  }

  // 5. Rex actions in init.lua
  if (flags.rexConfig) {
    const actionsPath = join(ctx.pkgRoot, "lua/rex-bot-actions.lua");
    const r = await installBlock({ initPath: paths.rexInitLua, backupsDir: paths.backupsDir, actionsPath, rex: ctx.rex });
    if (r.status === "legacy-inline") {
      warn(
        `${paths.rexInitLua} already defines bot_watch_toggle / bot_watch_list inline (v1).\n` +
          "    Remove that old block by hand (the two rex.action{…} entries and their helpers), then run `rex-bot setup` again.",
      );
    } else if (r.status === "check-failed") {
      failed = true;
      ctx.err(`❌ rex config check failed after editing ${paths.rexInitLua}; restored the previous file.\n${r.detail}`);
    } else {
      ok(`Rex palette actions ${r.status === "unchanged" ? "already in" : "added to"} ${paths.rexInitLua}${r.backup ? ` (backup: ${r.backup})` : ""}`);
      if (r.status === "installed") {
        if (isSandboxHome(ctx, userInfo().homedir)) {
          say("   (HOME is not your account's home, so the running Rex server was not reloaded.)");
        } else {
          const rl = await ctx.rex(["config", "reload"]);
          if (rl.code === 0) ok("Rex config reloaded");
          else warn("`rex config reload` failed; run it yourself.");
        }
      }
    }
  }

  // 6. launchd services
  if (flags.services) {
    try {
      const labels = await installServices(
        { paths, node: ctx.node, cli: ctx.cli, rexBin: ctx.rexBin, pkgRoot: ctx.pkgRoot, rexServer: ctx.env.REX_SERVER },
        ctx.launchctl,
      );
      ok(`Services installed and started: ${labels.join(", ")} (logs: ${paths.logsDir})`);
    } catch (e) {
      failed = true;
      ctx.err(`❌ ${(e as Error).message}`);
    }
  } else {
    say("   Services skipped (--no-services). Run the bridge and watcher yourself: rex-bot serve / rex-bot watch");
  }

  // 7. Tailscale Serve
  let dnsName: string | undefined;
  const ts = await tailscaleStatus(ctx.tailscale);
  dnsName = ts.dnsName;
  if (flags.serve) {
    const desired = `http://127.0.0.1:${s.port}`;
    const cmd = shellCommand("tailscale", serveArgs(s.servePath, s.port));
    if (!ctx.tailscaleBin || !ts.running) {
      warn(`Tailscale is not running${ctx.tailscaleBin ? "" : " (tailscale CLI not found)"}. Start it, then run:\n    ${cmd}`);
    } else {
      const current = await serveTarget(ctx.tailscale, s.servePath);
      let run = false;
      if (current === desired) ok(`Tailscale Serve already maps ${s.servePath} → ${desired}`);
      else if (current) {
        warn(`Tailscale Serve already maps ${s.servePath} → ${current}.`);
        run = await p.confirm(`Replace it with ${desired}?`, false);
      } else {
        say(`\nTo expose the bridge on your tailnet (tailnet only, not Funnel), setup will run:\n    ${cmd}`);
        run = await p.confirm("Run it now?", true);
      }
      if (run) {
        const r = await ctx.tailscale(serveArgs(s.servePath, s.port));
        if (r.code === 0) ok(`Tailscale Serve: https://${dnsName}${s.servePath} → ${desired}`);
        else {
          failed = true;
          ctx.err(`❌ tailscale serve failed: ${(r.stderr || r.stdout).trim()}`);
        }
      } else if (current !== desired) {
        say(`   Skipped. Run it later:\n    ${cmd}`);
      }
    }
  } else {
    say("   Tailscale Serve skipped (--no-serve).");
  }

  // 8. Agent skill
  if (flags.skills) {
    const r = await installSkills(paths.skillRoots);
    for (const f of r.installed) ok(`Agent skill installed: ${f}`);
    for (const k of r.skipped) say(`   Skill not installed at ${k.path}: ${k.reason}`);
  }

  // 9. Grok Bot text
  const showToken =
    flags.showToken || (p.interactive && (await p.confirm("\nShow the bearer token in the Grok Bot text below?", false)));
  const token = showToken ? (await ensureToken(paths.tokenFile)).token : null;
  say("\n" + grokbotText({ dnsName, servePath: s.servePath, token, webhookConfigured: !!s.webhook.url }));
  say(`Next: rex-bot doctor${s.webhook.url ? " --test-webhook" : ""}`);
  return failed ? 1 : 0;
}
