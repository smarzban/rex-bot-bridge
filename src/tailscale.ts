import type { Runner } from "./rex.js";

export interface TailscaleStatus {
  running: boolean;
  /** e.g. my-mac.tailnet-name.ts.net (no trailing dot) */
  dnsName?: string;
  backendState?: string;
}

export async function tailscaleStatus(ts: Runner): Promise<TailscaleStatus> {
  const r = await ts(["status", "--json"], { timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.code !== 0) return { running: false };
  try {
    const j = JSON.parse(r.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    return {
      running: j.BackendState === "Running",
      backendState: j.BackendState,
      dnsName: j.Self?.DNSName?.replace(/\.$/, "") || undefined,
    };
  } catch {
    return { running: false };
  }
}

export function serveArgs(servePath: string, port: number): string[] {
  return ["serve", "--bg", "--https=443", "--set-path", servePath, `http://127.0.0.1:${port}`];
}

export function serveOffArgs(servePath: string): string[] {
  return ["serve", "--https=443", "--set-path", servePath, "off"];
}

/** Shell-quoted command for display. */
export function shellCommand(bin: string, args: string[]): string {
  const q = (s: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [bin, ...args].map(q).join(" ");
}

/** Where `servePath` on :443 currently proxies to (e.g. http://127.0.0.1:7400), or null. */
export async function serveTarget(ts: Runner, servePath: string): Promise<string | null> {
  const r = await ts(["serve", "status", "--json"], { timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout || "{}") as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    for (const [hostPort, web] of Object.entries(j.Web ?? {})) {
      if (!hostPort.endsWith(":443")) continue;
      const h = web.Handlers?.[servePath];
      if (h?.Proxy) return h.Proxy.replace(/\/$/, "");
    }
  } catch {
    /* unparsable */
  }
  return null;
}

export function bridgeUrl(dnsName: string | undefined, servePath: string): string {
  return `https://${dnsName ?? "<this-mac>.<tailnet>.ts.net"}${servePath}`;
}
