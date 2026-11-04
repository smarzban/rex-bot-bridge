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

/** Copy of args safe to log: long strings (e.g. message text, prompts) are truncated. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === "string" && v.length > MAX_TEXT) out[k] = v.slice(0, MAX_TEXT) + `…(+${v.length - MAX_TEXT})`;
    else out[k] = v;
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
