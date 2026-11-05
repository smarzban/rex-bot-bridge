import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { isEphemeralInstall, isSandboxHome, type Ctx } from "./context.js";
import { grokbotText } from "./grokbot.js";
import { installServices, LEGACY_LABELS, serviceState } from "./launchd.js";
import { MAX_TRIES, type Prompter } from "./prompt.js";
import { installBlock } from "./rexconfig.js";
import { ensurePrivateDir, MODES, readSettings, setKey, settingsExist, writeSettings, type Mode, type Settings } from "./settings.js";
import { installSkills } from "./skills.js";
import { serveArgs, servesDesired, serveTarget, shellCommand, tailscaleStatus } from "./tailscale.js";
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

/** Strips a leading `Bearer ` from a key value. */
function stripBearer(v: string): string {
  return v.trim().replace(/^bearer\s+/i, "").trim();
}

const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/**
 * Reads the (hidden) key answer. A pasted header line `Name: value` (a space after the colon, so a
 * bare key like `abc:def` stays a key) gives the header name and the key; a leading `Bearer ` is
 * stripped either way.
 */
export function parseKeyAnswer(a: string): { key: string; header?: string } {
  const m = /^([A-Za-z0-9-]+):\s+(.*)$/.exec(a.trim());
  if (m) return { header: m[1]!, key: stripBearer(m[2]!) };
  return { key: stripBearer(a) };
}

/**
 * Reads a header answer. A pasted full header line (`Name: value`) gives the name, and its value
 * (minus any `Bearer `) becomes the key. Returns an error reason (never echoing the answer) when
 * the name isn't a header name.
 */
export function parseHeaderAnswer(a: string, key: string): { header: string; key: string } | { error: string } {
  let name = a.trim() || "Authorization";
  const m = /^([^:\s]+)\s*:\s*(.*)$/.exec(name);
  if (m) {
    name = m[1]!;
    const v = stripBearer(m[2]!);
    if (v) key = v;
  }
  if (!HEADER_NAME.test(name)) return { error: "a header name is letters, digits and dashes only, e.g. X-Webhook-Key" };
  return { header: name, key };
}

/** Asks until `check` passes (it returns an error reason, or nothing); undefined after MAX_TRIES bad answers. */
async function askValid(
  p: Prompter,
  question: string,
  check: (a: string) => string | undefined,
  say: (s: string) => void,
  opts: { secret?: boolean } = {},
): Promise<string | undefined> {
  for (let tries = 1; tries <= MAX_TRIES; tries++) {
    const a = await p.ask(question, opts);
    const reason = check(a);
    if (!reason) return a;
    say(`   ${reason}${tries < MAX_TRIES ? " Try again." : ""}`);
  }
  return undefined;
}

export const KEY_QUESTION = "Webhook key (Enter if none; input hidden)";
export const HEADER_QUESTION =
  "Header name for the key [Authorization] (just the name, e.g. X-Webhook-Key; Enter for Authorization: Bearer <key>; input hidden)";

/** Interactive webhook questions: URL, then the key (hidden), then the header name (only with a key). */
async function askWebhook(s: Settings, p: Prompter, say: (s: string) => void, warn: (s: string) => void): Promise<Settings> {
  const url = await askValid(
    p,
    "Webhook URL (Enter to skip and set it later)",
    (a) => (!a || /^https:\/\/\S+$/.test(a) ? undefined : "The webhook URL must start with https://."),
    say,
  );
  if (url === undefined) {
    warn(`No valid webhook URL after ${MAX_TRIES} tries; skipped.`);
    return s;
  }
  if (!url) return s;
  s = setKey(s, "webhook.url", url);

  const k = parseKeyAnswer(await p.ask(KEY_QUESTION, { secret: true }));
  if (!k.key) return s;
  let key = k.key;
  let header = k.header;

  if (!header) {
    // Hidden too: people paste a whole `Name: value` header line here, value and all.
    let parsed: { header: string; key: string } | undefined;
    await askValid(
      p,
      HEADER_QUESTION,
      (a) => {
        const r = parseHeaderAnswer(a, key);
        if ("error" in r) return `That isn't a header name: ${r.error}.`;
        parsed = r;
        return undefined;
      },
      say,
      { secret: true },
    );
    if (parsed) {
      key = parsed.key;
      header = parsed.header;
    } else {
      warn(`No valid header name after ${MAX_TRIES} tries; the key will be sent as Authorization: Bearer <key>. Change it later: rex-bot config set webhook.header <name>`);
    }
  }
  if (header && HEADER_NAME.test(header)) {
    say(`   Header: ${header}`); // the name only, never the value
    if (header.toLowerCase() !== "authorization") s = setKey(s, "webhook.header", header);
  }
  return setKey(s, "webhook.key", key);
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

  // The v1 list is imported once. Re-importing on every run would give the bot back sessions the
  // human has since unwatched, so a recorded import or an existing v2 list means it's skipped.
  if (!s.migratedV1At && existsSync(paths.legacyWatchedFile)) {
    if (!existsSync(paths.watchedFile)) {
      const migrated = await migrateWatched(paths.legacyWatchedFile, paths.watchedFile);
      if (migrated.length) {
        ok(`Imported ${migrated.length} watched session(s) from ${paths.legacyWatchedFile} (that file was left in place).`);
      }
    } else {
      say(`   ${paths.watchedFile} already exists, so the v1 list ${paths.legacyWatchedFile} was not imported.`);
    }
    s.migratedV1At = new Date().toISOString();
  }

  if (flags.mode) {
    s.mode = flags.mode;
  } else if (!hadSettings) {
    say("\n" + MODE_HELP);
    s.mode = await p.choose("Mode", MODES, "watched");
  }
  ok(`Mode: ${s.mode}${hadSettings && !flags.mode ? " (kept)" : ""}`);

  // 3. Webhook
  if (flags.webhookUrl) s = setKey(s, "webhook.url", flags.webhookUrl);
  if (flags.webhookKeyFile) s = setKey(s, "webhook.key", (await readFile(flags.webhookKeyFile, "utf8")).trim());
  if (flags.webhookHeader) s = setKey(s, "webhook.header", flags.webhookHeader);
  if (!s.webhook.url && p.interactive) {
    say("\nThe watcher and `rex-bot say` POST to a Grok Bot routine's webhook (see the Grok Bot text at the end).");
    try {
      s = await askWebhook(s, p, say, warn);
    } catch (e) {
      // Never lose the rest of setup over one answer.
      warn(`Webhook setup skipped (${(e as Error).message}). Set it later: rex-bot config set webhook.url '<url>'`);
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
    const r = await installBlock({ initPath: paths.rexInitLua, backupsDir: paths.backupsDir, actionsPath, rex: ctx.rex }).catch(
      (e: Error) => ({ status: "error" as const, detail: e.message }),
    );
    if (r.status === "error") {
      failed = true;
      ctx.err(`❌ ${r.detail}`);
    } else if (r.status === "legacy-inline") {
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
      if (servesDesired(current, desired)) ok(`Tailscale Serve already maps ${s.servePath} → ${desired}`);
      else if (current.kind === "occupied") {
        // Never overwritten by default (so --yes leaves it alone).
        warn(`Tailscale Serve already maps ${s.servePath} → ${current.target}.`);
        run = await p.confirm(`Replace it with ${desired}?`, false);
      } else if (current.kind === "unknown") {
        warn(`Could not read Tailscale Serve's current config (${current.reason}), so setup can't tell whether ${s.servePath} is in use.`);
        run = await p.confirm(`Run \`${cmd}\` anyway (it replaces anything at ${s.servePath})?`, false);
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
      } else if (!servesDesired(current, desired)) {
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
