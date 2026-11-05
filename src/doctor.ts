import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { Ctx } from "./context.js";
import { bootstrapCommand, domain, LABELS, LEGACY_LABELS, plistPath, serviceState } from "./launchd.js";
import { describe, enrich, postWebhook } from "./notify.js";
import { checkConfig, inspectBlock } from "./rexconfig.js";
import { legacyServePath, readSettings } from "./settings.js";
import { skillsPresent } from "./skills.js";
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
import { webhookHint } from "./webhook.js";

export type Level = "ok" | "warn" | "fail";
export interface Check {
  id: string;
  level: Level;
  detail: string;
  fix?: string;
}

const ICON: Record<Level, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };
const HEARTBEAT_MAX_S = 120;

export async function getJson(f: typeof fetch, url: string, timeoutMs = 4000): Promise<{ status: number; body?: any; error?: string }> {
  try {
    const r = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, body };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { status: 0, error: err.name === "TimeoutError" ? "timeout" : (err.cause?.code ?? err.message) };
  }
}

export async function runDoctor(ctx: Ctx, opts: { testWebhook: boolean }): Promise<Check[]> {
  const { paths } = ctx;
  const checks: Check[] = [];
  const add = (id: string, level: Level, detail: string, fix?: string) => checks.push({ id, level, detail, fix });
  const s = await readSettings(paths.configFile);
  const servicesSkipped = !!s.skipped?.services;
  const serveSkipped = !!s.skipped?.serve;

  // Node
  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 22 ? "ok" : "fail", `Node ${process.versions.node}`, major >= 22 ? undefined : "Install Node 22 or newer");

  // Rex
  if (!ctx.rexBin) {
    add("rex", "fail", "rex not found on PATH", "Install Rex; `command -v rex` must find it (or set REX_BIN)");
  } else {
    add("rex", "ok", ctx.rexBin);
    const v = await ctx.rex(["api", "call", "server.version"], { timeoutMs: 5000 });
    let rev: unknown;
    try {
      rev = (JSON.parse(v.stdout) as { api_revision?: number }).api_revision;
    } catch {
      /* ignore */
    }
    if (v.code === 0) add("rex_server", "ok", `Rex server reachable (API revision ${rev ?? "?"})`);
    else add("rex_server", "fail", "Rex server not reachable", "Open Rex, then re-run `rex-grokbot doctor`");
  }

  // Token + config
  const tokenStat = await stat(paths.tokenFile).catch(() => null);
  if (!tokenStat) add("token", "fail", `no token at ${paths.tokenFile}`, "rex-grokbot setup");
  else if ((tokenStat.mode & 0o077) !== 0) add("token", "warn", `${paths.tokenFile} is readable by others`, `chmod 600 '${paths.tokenFile}'`);
  else add("token", "ok", `${paths.tokenFile} (mode 600)`);

  // State file modes: an install from before 0.2.0 may have left them 0644.
  const loose: string[] = [];
  for (const f of [paths.watchedFile, paths.heartbeatFile, paths.tokenFile, paths.configFile]) {
    const st = await stat(f).catch(() => null);
    if (st && (st.mode & 0o777) !== 0o600) loose.push(`${f} (${(st.mode & 0o777).toString(8)})`);
  }
  if (loose.length) {
    add("file_modes", "warn", `not mode 600: ${loose.join(", ")}`, `chmod 600 ${loose.map((l) => `'${l.replace(/ \(\d+\)$/, "")}'`).join(" ")}`);
  } else add("file_modes", "ok", "state files are mode 600");
  add("mode", "ok", `mode ${s.mode}${s.mode === "full" ? " (the bot can drive every session)" : " (only watched sessions)"}`);

  // init.lua
  const blk = await inspectBlock(paths.rexInitLua);
  if (blk.legacy) {
    add("rex_actions_legacy", "warn", `${paths.rexInitLua} still defines bot_watch_toggle inline (v1)`, "Remove the old inline block, then: rex-grokbot setup rex");
  }
  if (!blk.present) {
    add("rex_actions", "fail", `rex-bot-bridge block missing from ${paths.rexInitLua}`, "rex-grokbot setup rex");
  } else if (!blk.actionsPath || !existsSync(blk.actionsPath)) {
    add("rex_actions", "fail", `init.lua block points at a missing file: ${blk.actionsPath ?? "?"}`, "rex-grokbot setup rex (re-points it at this install)");
  } else {
    const complaint = ctx.rexBin ? await checkConfig(ctx.rex, paths.rexInitLua) : "rex not found";
    if (complaint) add("rex_actions", "fail", `rex config check failed: ${complaint}`, `Fix ${paths.rexInitLua}, then \`rex config check\``);
    else add("rex_actions", "ok", `init.lua block present, rex config check passed`);
  }

  // launchd
  for (const [name, label] of Object.entries(LABELS)) {
    const st = await serviceState(label, ctx.launchctl);
    const id = `service_${name}`;
    if (st.running) add(id, "ok", `${label} running (pid ${st.pid ?? "?"})`);
    else if (servicesSkipped && !st.loaded) add(id, "warn", `${label} not installed (setup --no-services)`, "rex-grokbot setup services");
    else if (st.loaded)
      add(
        id,
        "fail",
        `${label} loaded but not running (last exit ${st.lastExit ?? "?"})`,
        `See ${paths.logsDir}/${name}.log, then: launchctl kickstart -k gui/$(id -u)/${label}`,
      );
    else add(id, "fail", `${label} not loaded`, existsSync(plistPath(paths, label)) ? bootstrapCommand(paths, label) : "rex-grokbot setup services");
  }
  for (const label of LEGACY_LABELS) {
    if ((await serviceState(label, ctx.launchctl)).loaded) {
      add("legacy_service", "warn", `v1 service ${label} is still loaded`, `launchctl bootout gui/$(id -u)/${label}`);
    }
  }

  // Bridge health
  const local = await getJson(ctx.fetch, `http://${s.host}:${s.port}/healthz`);
  const bridgeLevel: Level = servicesSkipped ? "warn" : "fail";
  if (local.status === 200 && local.body?.ok) {
    add("bridge_local", local.body.rex_reachable ? "ok" : "warn", `bridge /healthz on ${s.host}:${s.port}: rex_reachable=${local.body.rex_reachable}`);
  } else {
    add("bridge_local", bridgeLevel, `bridge not answering on ${s.host}:${s.port} (${local.error ?? `HTTP ${local.status}`})`, servicesSkipped ? "rex-grokbot serve (or: rex-grokbot setup services)" : `See ${paths.logsDir}/bridge.log, then: launchctl kickstart -k ${domain()}/${LABELS.bridge}`);
  }

  // Watcher heartbeat
  let age: number | null = null;
  try {
    const ts = Date.parse((await readFile(paths.heartbeatFile, "utf8")).trim());
    if (!Number.isNaN(ts)) age = Math.round((Date.now() - ts) / 1000);
  } catch {
    /* none */
  }
  if (age !== null && age < HEARTBEAT_MAX_S) add("watcher", "ok", `watcher heartbeat ${age}s ago`);
  else add("watcher", bridgeLevel, age === null ? "no watcher heartbeat yet" : `watcher heartbeat is ${age}s old`, servicesSkipped ? "rex-grokbot watch (or: rex-grokbot setup services)" : `See ${paths.logsDir}/watch.log, then: launchctl kickstart -k ${domain()}/${LABELS.watch}`);

  // Tailscale
  const ts = await tailscaleStatus(ctx.tailscale);
  const tsLevel: Level = serveSkipped ? "warn" : "fail";
  const serveCmd = shellCommand("tailscale", serveArgs(s.servePort, s.port));
  if (!ctx.tailscaleBin) add("tailscale", tsLevel, "tailscale CLI not found", "Install Tailscale (https://tailscale.com/download)");
  else if (!ts.running) add("tailscale", tsLevel, `Tailscale not running (${ts.backendState ?? "unknown"})`, "Open Tailscale and log in");
  else add("tailscale", "ok", `Tailscale up as ${ts.dnsName}`);

  if (ts.running) {
    const t = await portTarget(ctx.tailscale, s.servePort);
    const target = t.kind === "occupied" ? t.target : null;
    const desired = `http://127.0.0.1:${s.port}`;
    const origin = bridgeOrigin(ts.dnsName, s.servePort);
    if (serveSkipped && target !== desired) {
      add("serve", "warn", `Tailscale Serve not set up by setup (--no-serve)${target ? `; port ${s.servePort} → ${target}` : ""}`, serveCmd);
    } else if (target === desired) {
      add("serve", "ok", `Tailscale Serve ${origin} → ${desired}`);
      const remote = await getJson(ctx.fetch, `${origin}/healthz`, 8000);
      if (remote.status === 200 && remote.body?.ok) {
        add("bridge_tailnet", "ok", `bridge /healthz reachable at ${origin}`);
        // No other app's OAuth metadata on our origin: MCP clients that get our 401 look for it there.
        const wk = await getJson(ctx.fetch, `${origin}/.well-known/oauth-authorization-server`, 8000);
        if (wk.status === 404) add("oauth_discovery", "ok", "no OAuth metadata on the bridge's origin (/.well-known/oauth-authorization-server → 404)");
        else
          add(
            "oauth_discovery",
            "fail",
            `${origin}/.well-known/oauth-authorization-server answered ${wk.error ?? `HTTP ${wk.status}`} (expected 404); a client may try OAuth instead of the bearer token`,
            `tailscale serve status (port ${s.servePort} must map only / → ${desired}), then: rex-grokbot setup serve`,
          );
      } else
        add(
          "bridge_tailnet",
          remote.status === 502 ? bridgeLevel : "fail",
          `tailnet /healthz failed (${remote.error ?? `HTTP ${remote.status}`})`,
          remote.status === 502 ? `502 means the bridge is down: launchctl kickstart -k ${domain()}/${LABELS.bridge}` : "tailscale serve status",
        );
    } else {
      const what =
        t.kind === "unknown"
          ? `Could not read Tailscale Serve status (${t.reason})`
          : target
            ? `Tailscale Serve port ${s.servePort} → ${target} (expected only ${desired})`
            : `Tailscale Serve has no port ${s.servePort} mapping`;
      const fix = t.kind === "unknown" ? "tailscale serve status" : target ? `rex-grokbot config set servePort <free port>, then: rex-grokbot setup serve` : serveCmd;
      add("serve", "fail", what, fix);
    }

    // The ≤ 0.4 mapping on :443 (shared with other apps): flag it only when it is ours.
    const path = legacyServePath(s);
    if (servesDesired(await legacyPathTarget(ctx.tailscale, path), desired)) {
      add(
        "serve_legacy",
        "warn",
        `old mapping ${legacyUrl(ts.dnsName, path)} → ${desired} still on port 443 (shared with other apps; the connector should use ${origin}/mcp)`,
        shellCommand("tailscale", legacyServeOffArgs(path)),
      );
    }
  }

  // Webhook
  if (!s.webhook.url) {
    add("webhook", "warn", "webhook not configured: status pushes and `rex-grokbot say` go nowhere", "rex-grokbot setup webhook");
  } else {
    add("webhook", "ok", `webhook configured${s.webhook.key ? ` (key in ${s.webhook.header ?? "Authorization"})` : " (no key)"}`);
    if (opts.testWebhook) {
      const r = await postWebhook(s.webhook, enrich({ event: "doctor_test" }), { logFile: paths.notifyLog, fetch: ctx.fetch });
      add("webhook_test", r.ok ? "ok" : "fail", `doctor_test sent: ${describe(r)}`, r.ok ? undefined : webhookHint(r));
    }
  }

  // Skills (informational)
  const skills = await skillsPresent(paths.skillRoots);
  add("skills", skills.length ? "ok" : "warn", skills.length ? `agent skill installed: ${skills.join(", ")}` : "agent skill not installed", skills.length ? undefined : "rex-grokbot setup skill");

  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((c) => `${ICON[c.level]} ${c.id.padEnd(18)} ${c.detail}${c.fix && c.level !== "ok" ? `\n   ${"".padEnd(18)} fix: ${c.fix}` : ""}`)
    .join("\n");
}
