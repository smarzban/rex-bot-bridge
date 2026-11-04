import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function readToken(path: string): Promise<string | null> {
  try {
    const t = (await readFile(path, "utf8")).trim();
    return t.length ? t : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Creates the token file if missing (or replaces it when rotate is set). Always leaves it mode 600. */
export async function ensureToken(path: string, rotate = false): Promise<{ token: string; created: boolean }> {
  const existing = rotate ? null : await readToken(path);
  if (existing) {
    await chmod(path, 0o600);
    return { token: existing, created: false };
  }
  const token = generateToken();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, token + "\n", { mode: 0o600 });
  await chmod(path, 0o600); // mode above only applies when the file is created
  return { token, created: true };
}

/** Constant-time comparison (hash first so lengths never leak). */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Extracts the bearer token from an Authorization header value. */
export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}
