// `rex-grokbot token` and `rex-grokbot url`: the two things the Grok Bot connector needs, printed
// separately so the endpoint and the credential can be handed over in different ways.
import type { Ctx } from "./context.js";
import { domain, LABELS, serviceState } from "./launchd.js";
import { ensurePrivateDir, readSettings } from "./settings.js";
import { bridgeUrl, servesDesired, serveTarget, tailscaleStatus } from "./tailscale.js";
import { ensureToken, readToken } from "./token.js";

/**
 * Prints the bearer token and nothing else on stdout (one line, so `rex-grokbot token | pbcopy` works).
 * With rotate: writes a new one, restarts the bridge service if it is loaded, and prints the new one.
 */
export async function tokenCommand(ctx: Ctx, rotate: boolean): Promise<number> {
  const { paths } = ctx;
  if (!rotate) {
    const token = await readToken(paths.tokenFile);
    if (!token) {
      ctx.err("rex-grokbot: no token yet; run rex-grokbot setup");
      return 1;
    }
    ctx.out(token);
    return 0;
  }
  await ensurePrivateDir(paths.stateDir);
  const { token } = await ensureToken(paths.tokenFile, true);
  if ((await serviceState(LABELS.bridge, ctx.launchctl)).loaded) {
    const r = await ctx.launchctl(["kickstart", "-k", `${domain()}/${LABELS.bridge}`]);
    if (r.code === 0) ctx.err(`rex-grokbot: token rotated; restarted ${LABELS.bridge}.`);
    else ctx.err(`rex-grokbot: token rotated, but restarting ${LABELS.bridge} failed: ${(r.stderr || r.stdout).trim()}\n  fix: rex-grokbot setup services`);
  } else {
    ctx.err("rex-grokbot: token rotated (the bridge service isn't loaded, so nothing was restarted).");
  }
  ctx.err("rex-grokbot: update the Authorization header of the rex connector in Grok Bot; the old token no longer works.");
  ctx.out(token);
  return 0;
}

/** Prints only the connector URL, https://<mac>.<tailnet>.ts.net/rex-bridge/mcp. */
export async function urlCommand(ctx: Ctx): Promise<number> {
  const s = await readSettings(ctx.paths.configFile);
  const ts = ctx.tailscaleBin ? await tailscaleStatus(ctx.tailscale) : { running: false, dnsName: undefined };
  if (!ts.running || !ts.dnsName) {
    ctx.err(
      `rex-grokbot: Tailscale is not running${ctx.tailscaleBin ? "" : " (tailscale CLI not found)"}, so this Mac has no tailnet address.\n` +
        "  fix: start Tailscale and log in, then: rex-grokbot setup serve",
    );
    return 1;
  }
  const target = await serveTarget(ctx.tailscale, s.servePath);
  if (!servesDesired(target, `http://127.0.0.1:${s.port}`)) {
    ctx.err(`rex-grokbot: warning: Tailscale Serve doesn't map ${s.servePath} to the bridge yet.\n  fix: rex-grokbot setup serve`);
  }
  ctx.out(`${bridgeUrl(ts.dnsName, s.servePath)}/mcp`);
  return 0;
}
