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

/**
 * What `servePath` on :443 is served by right now:
 * - absent:   nothing is mapped there (safe to add our mapping),
 * - occupied: some handler is there (a proxy, a file path, a text response, or one we don't recognise),
 * - unknown:  `tailscale serve status` failed or printed something we can't parse.
 */
export type ServeTarget =
  | { kind: "absent" }
  | { kind: "occupied"; target: string }
  | { kind: "unknown"; reason: string };

interface ServeHandler {
  Proxy?: string;
  Path?: string;
  Text?: string;
  [k: string]: unknown;
}

export function describeHandler(h: ServeHandler): string {
  if (typeof h.Proxy === "string") return h.Proxy.replace(/\/$/, "");
  if (typeof h.Path === "string") return `files at ${h.Path}`;
  if (typeof h.Text === "string") return "a static text response";
  const keys = Object.keys(h);
  return keys.length ? `an unrecognised handler (${keys.join(", ")})` : "an empty handler";
}

export async function serveTarget(ts: Runner, servePath: string): Promise<ServeTarget> {
  const r = await ts(["serve", "status", "--json"], { timeoutMs: 10_000 }).catch((e: Error) => e);
  if (r instanceof Error) return { kind: "unknown", reason: r.message };
  if (r.code !== 0) return { kind: "unknown", reason: (r.stderr || r.stdout).trim() || `exit ${r.code}` };
  let j: unknown;
  try {
    j = JSON.parse(r.stdout.trim() || "{}");
  } catch {
    return { kind: "unknown", reason: "unparsable `tailscale serve status --json` output" };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { kind: "unknown", reason: "unexpected serve status shape" };
  const web = (j as { Web?: unknown }).Web;
  if (web === undefined || web === null) return { kind: "absent" };
  if (typeof web !== "object") return { kind: "unknown", reason: "unexpected serve status shape" };
  for (const [hostPort, site] of Object.entries(web as Record<string, { Handlers?: Record<string, ServeHandler> }>)) {
    if (!hostPort.endsWith(":443")) continue;
    const h = site?.Handlers?.[servePath];
    if (h === undefined) continue;
    if (!h || typeof h !== "object") return { kind: "occupied", target: "an unrecognised handler" };
    return { kind: "occupied", target: describeHandler(h) };
  }
  return { kind: "absent" };
}

/** True when servePath already proxies to `desired`. */
export function servesDesired(t: ServeTarget, desired: string): boolean {
  return t.kind === "occupied" && t.target === desired;
}

export function bridgeUrl(dnsName: string | undefined, servePath: string): string {
  return `https://${dnsName ?? "<this-mac>.<tailnet>.ts.net"}${servePath}`;
}
