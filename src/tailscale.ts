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

/**
 * The bridge gets a whole tailnet HTTPS port (its own origin), never a path on :443: an origin shared with
 * other apps lets their `/.well-known/oauth-*` metadata hijack the connector's auth. `--https=<port>` takes a port;
 * 8443 is the default (10000 is the other common one). Those are also Funnel's ports, but we never use Funnel.
 */
export function serveArgs(servePort: number, port: number): string[] {
  return ["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${port}`];
}

export function serveOffArgs(servePort: number): string[] {
  return ["serve", `--https=${servePort}`, "off"];
}

/** Removes the ≤ 0.4 mapping of `legacyPath` on :443 (only that path; `/` and other paths are untouched). */
export function legacyServeOffArgs(legacyPath: string): string[] {
  return ["serve", "--https=443", "--set-path", legacyPath, "off"];
}

/** Shell-quoted command for display. */
export function shellCommand(bin: string, args: string[]): string {
  const q = (s: string) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [bin, ...args].map(q).join(" ");
}

/**
 * What a Serve slot (a whole port, or a path on :443) is served by right now:
 * - absent:   nothing is mapped there (safe to add our mapping),
 * - occupied: some handler is there (a proxy, a file path, a text response, several paths, a TCP forward,
 *             or one we don't recognise),
 * - unknown:  `tailscale serve status` failed or printed something we can't parse.
 */
export type ServeTarget =
  | { kind: "absent" }
  | { kind: "occupied"; target: string; /** a single HTTPS `/` handler: `serve --https=<port> <target>` replaces it */ root?: boolean }
  | { kind: "unknown"; reason: string };

interface ServeHandler {
  Proxy?: string;
  Path?: string;
  Text?: string;
  [k: string]: unknown;
}

type ServeStatus = {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string; [k: string]: unknown }>;
  Web?: Record<string, { Handlers?: Record<string, ServeHandler> }>;
};

export function describeHandler(h: ServeHandler): string {
  if (!h || typeof h !== "object") return "an unrecognised handler";
  if (typeof h.Proxy === "string") return h.Proxy.replace(/\/$/, "");
  if (typeof h.Path === "string") return `files at ${h.Path}`;
  if (typeof h.Text === "string") return "a static text response";
  const keys = Object.keys(h);
  return keys.length ? `an unrecognised handler (${keys.join(", ")})` : "an empty handler";
}

async function readServeStatus(ts: Runner): Promise<ServeStatus | { unknown: string }> {
  const r = await ts(["serve", "status", "--json"], { timeoutMs: 10_000 }).catch((e: Error) => e);
  if (r instanceof Error) return { unknown: r.message };
  if (r.code !== 0) return { unknown: (r.stderr || r.stdout).trim() || `exit ${r.code}` };
  let j: unknown;
  try {
    j = JSON.parse(r.stdout.trim() || "{}");
  } catch {
    return { unknown: "unparsable `tailscale serve status --json` output" };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { unknown: "unexpected serve status shape" };
  const { Web: web, TCP: tcp } = j as { Web?: unknown; TCP?: unknown };
  if ((web != null && (typeof web !== "object" || Array.isArray(web))) || (tcp != null && (typeof tcp !== "object" || Array.isArray(tcp))))
    return { unknown: "unexpected serve status shape" };
  return j as ServeStatus;
}

/** The Web entries for one port (keys look like `mac.tail.ts.net:8443`). */
function sitesOn(st: ServeStatus, port: number) {
  return Object.entries(st.Web ?? {})
    .filter(([hostPort]) => hostPort.endsWith(`:${port}`))
    .map(([, site]) => site?.Handlers ?? {});
}

/**
 * What the whole tailnet port `servePort` serves. Ours is exactly one handler, `/`, proxying to the bridge;
 * any handler on that port (even beside `/`), or a raw TCP forward, makes it occupied.
 */
export async function portTarget(ts: Runner, servePort: number): Promise<ServeTarget> {
  const st = await readServeStatus(ts);
  if ("unknown" in st) return { kind: "unknown", reason: st.unknown };
  const tcp = st.TCP?.[String(servePort)];
  if (tcp && typeof tcp === "object" && typeof tcp.TCPForward === "string") return { kind: "occupied", target: `a TCP forward to ${tcp.TCPForward}` };
  const handlers = sitesOn(st, servePort).flatMap((h) => Object.entries(h));
  if (!handlers.length) {
    if (tcp && typeof tcp === "object" && !tcp.HTTPS && Object.keys(tcp).length) return { kind: "occupied", target: "a non-HTTPS listener" };
    return { kind: "absent" };
  }
  if (handlers.length === 1 && handlers[0]![0] === "/") {
    const target = describeHandler(handlers[0]![1]);
    if (tcp && typeof tcp === "object" && tcp.HTTP && !tcp.HTTPS) return { kind: "occupied", target: `${target} (plain HTTP)` };
    return { kind: "occupied", target, root: true };
  }
  return { kind: "occupied", target: handlers.map(([path, h]) => `${path} → ${describeHandler(h)}`).join(", ") };
}

/** What `path` on :443 serves (the ≤ 0.4 location, kept for migration and cleanup). */
export async function legacyPathTarget(ts: Runner, path: string): Promise<ServeTarget> {
  const st = await readServeStatus(ts);
  if ("unknown" in st) return { kind: "unknown", reason: st.unknown };
  for (const handlers of sitesOn(st, 443)) {
    const h = handlers[path];
    if (h !== undefined) return { kind: "occupied", target: describeHandler(h) };
  }
  return { kind: "absent" };
}

/** True when the slot already proxies to `desired` (and nothing else). */
export function servesDesired(t: ServeTarget, desired: string): boolean {
  return t.kind === "occupied" && t.target === desired;
}

/** The bridge's own origin, https://<mac>.<tailnet>.ts.net:<servePort> (no trailing slash). */
export function bridgeOrigin(dnsName: string | undefined, servePort: number): string {
  return `https://${dnsName ?? "<this-mac>.<tailnet>.ts.net"}${servePort === 443 ? "" : `:${servePort}`}`;
}

/** The ≤ 0.4 URL, https://<mac>.<tailnet>.ts.net/rex-bridge. */
export function legacyUrl(dnsName: string | undefined, path: string): string {
  return `https://${dnsName ?? "<this-mac>.<tailnet>.ts.net"}${path}`;
}
