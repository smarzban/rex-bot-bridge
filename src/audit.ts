import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  duration_ms: number;
}

const MAX_TEXT = 200;
const MAX_ITEMS = 20;

function truncate(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `…(+${s.length - MAX_TEXT})` : s;
}

/**
 * Copy of args safe to log: long strings (message text, prompts) are truncated, and so are arrays
 * (e.g. a custom command argv): each element is truncated, and at most 20 elements are kept.
 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === "string") out[k] = truncate(v);
    else if (Array.isArray(v)) {
      const items = v.slice(0, MAX_ITEMS).map((x) => (typeof x === "string" ? truncate(x) : x));
      if (v.length > MAX_ITEMS) items.push(`…(+${v.length - MAX_ITEMS} more)`);
      out[k] = items;
    } else out[k] = v;
  }
  return out;
}

export class AuditLog {
  private ready: Promise<unknown> | null = null;
  constructor(readonly path: string) {}

  async write(entry: AuditEntry): Promise<void> {
    try {
      this.ready ??= mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await this.ready;
      const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry, args: redactArgs(entry.args) });
      await appendFile(this.path, line + "\n", { mode: 0o600 });
    } catch (e) {
      console.error(`audit log write failed: ${(e as Error).message}`);
    }
  }
}
