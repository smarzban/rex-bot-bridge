import { appendFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { Settings } from "./settings.js";

const MAX_CHARS = 2000;

/** Authorization => "Bearer <key>"; any other header name gets the raw key. No key => no header. */
export function authHeaders(webhook: Settings["webhook"]): Record<string, string> {
  if (!webhook.key) return {};
  const name = webhook.header || "Authorization";
  return { [name]: name.toLowerCase() === "authorization" ? `Bearer ${webhook.key}` : webhook.key };
}

/** Adds source/host/timestamp when missing and truncates long string fields. */
export function enrich(payload: Record<string, unknown>, now = new Date()): Record<string, unknown> {
  const out: Record<string, unknown> = { source: "rex", host: hostname(), timestamp: now.toISOString(), ...payload };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && v.length > MAX_CHARS) out[k] = v.slice(0, MAX_CHARS) + "...";
  }
  return out;
}

export interface PostResult {
  ok: boolean;
  /** HTTP status, or 0 when the request did not complete. */
  status: number;
  /** Short reason without the URL or key: "not configured", "timeout", an errno code. */
  reason?: string;
}

export interface PostOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Appends "<iso> event=<event> http=<status>" (never the URL or key). */
  logFile?: string;
}

/** POSTs JSON to the configured webhook. Never throws and never puts the URL or key in its result. */
export async function postWebhook(
  webhook: Settings["webhook"],
  payload: Record<string, unknown>,
  opts: PostOptions = {},
): Promise<PostResult> {
  let result: PostResult;
  if (!webhook.url) {
    result = { ok: false, status: 0, reason: "not configured" };
  } else {
    const f = opts.fetch ?? fetch;
    try {
      const res = await f(webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(webhook) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      await res.arrayBuffer().catch(() => {});
      result = { ok: res.ok, status: res.status };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      const reason =
        err.name === "TimeoutError" || err.name === "AbortError" ? "timeout" : (err.cause?.code ?? "request failed");
      result = { ok: false, status: 0, reason };
    }
  }
  if (opts.logFile) {
    const line = `${new Date().toISOString()} event=${String(payload.event ?? "?")} http=${result.status}${result.reason ? ` (${result.reason})` : ""}\n`;
    try {
      await mkdir(dirname(opts.logFile), { recursive: true, mode: 0o700 });
      await appendFile(opts.logFile, line, { mode: 0o600 });
    } catch {
      /* logging is best effort */
    }
  }
  return result;
}

export function describe(r: PostResult): string {
  return r.status ? `HTTP ${r.status}` : (r.reason ?? "failed");
}
