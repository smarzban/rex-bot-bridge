import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { Ctx } from "./context.js";
import { LABELS, LEGACY_LABELS, serviceState } from "./launchd.js";
import { describe, enrich, postWebhook } from "./notify.js";
import { checkConfig, inspectBlock } from "./rexconfig.js";
import { readSettings } from "./settings.js";
import { skillsPresent } from "./skills.js";
import { bridgeUrl, serveArgs, serveTarget, shellCommand, tailscaleStatus } from "./tailscale.js";

export type Level = "ok" | "warn" | "fail";
export interface Check {
  id: string;
  level: Level;
  detail: string;
  fix?: string;
}

const ICON: Record<Level, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };
const HEARTBEAT_MAX_S = 120;

async function getJson(f: typeof fetch, url: string, timeoutMs = 4000): Promise<{ status: number; body?: any; error?: string }> {
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
    else add("rex_server", "fail", "Rex server not reachable", "Open Rex, then re-run `rex-bot doctor`");
  }

  // Token + config
  const tokenStat = await stat(paths.tokenFile).catch(() => null);
  if (!tokenStat) add("token", "fail", `no token at ${paths.tokenFile}`, "rex-bot token");
  else if ((tokenStat.mode & 0o077) !== 0) add("token", "warn", `${paths.tokenFile} is readable by others`, `chmod 600 '${paths.tokenFile}'`);
  else add("token", "ok", `${paths.tokenFile} (mode 600)`);
  add("mode", "ok", `mode ${s.mode}${s.mode === "full" ? " (the bot can drive every session)" : " (only watched sessions)"}`);

  // init.lua
  const blk = await inspectBlock(paths.rexInitLua);
  if (blk.legacy) {
    add("rex_actions_legacy", "warn", `${paths.rexInitLua} still defines bot_watch_toggle inline (v1)`, "Remove the old inline block, then `rex-bot setup`");
  }
  if (!blk.present) {
    add("rex_actions", "fail", `rex-bot-bridge block missing from ${paths.rexInitLua}`, "rex-bot setup");
  } else if (!blk.actionsPath || !existsSync(blk.actionsPath)) {
    add("rex_actions", "fail", `init.lua block points at a missing file: ${blk.actionsPath ?? "?"}`, "rex-bot setup (re-points it at this install)");
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
    else if (servicesSkipped && !st.loaded) add(id, "warn", `${label} not installed (setup --no-services)`, "rex-bot setup (without --no-services)");
    else if (st.loaded) add(id, "fail", `${label} loaded but not running (last exit ${st.lastExit ?? "?"})`, `See ${paths.logsDir}/${name}.log`);
    else add(id, "fail", `${label} not loaded`, "rex-bot setup");
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
    add("bridge_local", bridgeLevel, `bridge not answering on ${s.host}:${s.port} (${local.error ?? `HTTP ${local.status}`})`, servicesSkipped ? "rex-bot serve" : `See ${paths.logsDir}/bridge.log`);
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
  else add("watcher", bridgeLevel, age === null ? "no watcher heartbeat yet" : `watcher heartbeat is ${age}s old`, servicesSkipped ? "rex-bot watch" : `See ${paths.logsDir}/watch.log`);

  // Tailscale
  const ts = await tailscaleStatus(ctx.tailscale);
  const tsLevel: Level = serveSkipped ? "warn" : "fail";
  const serveCmd = shellCommand("tailscale", serveArgs(s.servePath, s.port));
  if (!ctx.tailscaleBin) add("tailscale", tsLevel, "tailscale CLI not found", "Install Tailscale");
  else if (!ts.running) add("tailscale", tsLevel, `Tailscale not running (${ts.backendState ?? "unknown"})`, "Open Tailscale and log in");
  else add("tailscale", "ok", `Tailscale up as ${ts.dnsName}`);

  if (ts.running) {
    const t = await serveTarget(ctx.tailscale, s.servePath);
    const target = t.kind === "occupied" ? t.target : null;
    const desired = `http://127.0.0.1:${s.port}`;
    if (serveSkipped && target !== desired) {
      add("serve", "warn", `Tailscale Serve not set up by setup (--no-serve)${target ? `; ${s.servePath} → ${target}` : ""}`, serveCmd);
    } else if (target === desired) {
      add("serve", "ok", `Tailscale Serve ${s.servePath} → ${desired}`);
      const remote = await getJson(ctx.fetch, `${bridgeUrl(ts.dnsName, s.servePath)}/healthz`, 8000);
      if (remote.status === 200 && remote.body?.ok) add("bridge_tailnet", "ok", "bridge /healthz reachable over the tailnet URL");
      else
        add(
          "bridge_tailnet",
          remote.status === 502 ? bridgeLevel : "fail",
          `tailnet /healthz failed (${remote.error ?? `HTTP ${remote.status}`})`,
          remote.status === 502 ? "502 means the bridge is down: check the bridge service" : "tailscale serve status",
        );
    } else {
      const what =
        t.kind === "unknown"
          ? `Could not read Tailscale Serve status (${t.reason})`
          : target
            ? `Tailscale Serve ${s.servePath} → ${target} (expected ${desired})`
            : `Tailscale Serve has no ${s.servePath} mapping`;
      add("serve", "fail", what, t.kind === "unknown" ? "tailscale serve status" : serveCmd);
    }
  }

  // Webhook
  if (!s.webhook.url) {
    add("webhook", "warn", "webhook not configured: status pushes and `rex-bot say` go nowhere", "rex-bot config set webhook.url '<routine webhook url>'");
  } else {
    add("webhook", "ok", `webhook configured${s.webhook.key ? ` (key in ${s.webhook.header ?? "Authorization"})` : " (no key)"}`);
    if (opts.testWebhook) {
      const r = await postWebhook(s.webhook, enrich({ event: "doctor_test" }), { logFile: paths.notifyLog, fetch: ctx.fetch });
      add("webhook_test", r.ok ? "ok" : "fail", `doctor_test sent: ${describe(r)}`, r.ok ? undefined : "Check the routine's webhook URL/key: rex-bot config set webhook.url …");
    }
  }

  // Skills (informational)
  const skills = await skillsPresent(paths.skillRoots);
  add("skills", skills.length ? "ok" : "warn", skills.length ? `agent skill installed: ${skills.join(", ")}` : "agent skill not installed", skills.length ? undefined : "rex-bot setup");

  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((c) => `${ICON[c.level]} ${c.id.padEnd(18)} ${c.detail}${c.fix && c.level !== "ok" ? `\n   ${"".padEnd(18)} fix: ${c.fix}` : ""}`)
    .join("\n");
}
