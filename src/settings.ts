import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "./watch.js";

export const MODES = ["watched", "full"] as const;
export type Mode = (typeof MODES)[number];

/** ~/.config/rex-grokbot-bridge/config.json */
export interface Settings {
  mode: Mode;
  host: string;
  port: number;
  /** The tailnet HTTPS port Tailscale Serve gives the bridge as its own origin (https://<mac>:<servePort>). */
  servePort: number;
  webhook: { url?: string; key?: string; header?: string };
  /** What setup chose not to install, so doctor reports those checks as skipped instead of failed. */
  skipped?: { services?: boolean; serve?: boolean };
}

export const DEFAULTS: Settings = {
  mode: "watched",
  host: "127.0.0.1",
  port: 7400,
  servePort: 8443,
  webhook: {},
};

/** Keys `rex-grokbot config get|set` accepts. Secrets are hidden by `get` unless --show. */
export const KEYS = ["mode", "port", "host", "servePort", "webhook.url", "webhook.key", "webhook.header"] as const;
export type Key = (typeof KEYS)[number];

export const SECRET_KEYS: readonly Key[] = ["webhook.url", "webhook.key"];

export async function settingsExist(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function readSettings(path: string): Promise<Settings> {
  let raw: Partial<Settings> = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as Partial<Settings>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  const s: Settings = { ...DEFAULTS, ...raw, webhook: { ...(raw.webhook ?? {}) } };
  if (!MODES.includes(s.mode)) s.mode = DEFAULTS.mode;
  if (!Number.isInteger(s.servePort) || s.servePort < 1 || s.servePort > 65535 || s.servePort === 443) s.servePort = DEFAULTS.servePort;
  return s;
}

/** Writes config.json atomically, file 600 and its directory 700. */
export async function writeSettings(path: string, s: Settings): Promise<void> {
  await ensurePrivateDir(dirname(path));
  await atomicWrite(path, JSON.stringify(s, null, 2) + "\n", 0o600);
  await chmod(path, 0o600);
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export function getKey(s: Settings, key: Key): string | number | undefined {
  switch (key) {
    case "webhook.url":
      return s.webhook.url;
    case "webhook.key":
      return s.webhook.key;
    case "webhook.header":
      return s.webhook.header;
    default:
      return s[key];
  }
}

/** Returns a copy with key set (validated). An empty value clears a webhook field. */
export function setKey(s: Settings, key: Key, value: string): Settings {
  const out: Settings = { ...s, webhook: { ...s.webhook } };
  switch (key) {
    case "mode":
      if (!MODES.includes(value as Mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
      out.mode = value as Mode;
      break;
    case "port": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`port must be 1-65535, got ${value}`);
      out.port = n;
      break;
    }
    case "host":
      out.host = value;
      break;
    case "servePort": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`servePort must be 1-65535, got ${value}`);
      // 443 is the Mac's shared origin, where other apps' OAuth metadata can hijack the connector.
      if (n === 443) throw new Error("servePort can't be 443: the bridge needs its own origin (default 8443)");
      out.servePort = n;
      break;
    }
    case "webhook.url":
      if (value && !/^https?:\/\//.test(value)) throw new Error("webhook.url must start with https:// or http://");
      out.webhook.url = value || undefined;
      break;
    case "webhook.key":
      out.webhook.key = value || undefined;
      break;
    case "webhook.header":
      if (value && !/^[A-Za-z0-9-]+$/.test(value)) throw new Error("webhook.header must be a header name");
      out.webhook.header = value || undefined;
      break;
    default:
      throw new Error(`unknown key ${key as string}; keys: ${KEYS.join(", ")}`);
  }
  return out;
}

export function isKey(k: string): k is Key {
  return (KEYS as readonly string[]).includes(k);
}
