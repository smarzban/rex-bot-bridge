// `rex-bot setup webhook`: where the watcher and `rex-bot say` POST to (a Grok Bot routine's webhook).
import type { Ctx } from "./context.js";
import { DOC_URL } from "./grokbot.js";
import { describe, enrich, postWebhook, type PostResult } from "./notify.js";
import { MAX_TRIES, type Prompter } from "./prompt.js";
import { readSettings, setKey, writeSettings, type Settings } from "./settings.js";

export interface WebhookFlags {
  /** --url */
  url?: string;
  /** The contents of --key-file (already read; "-" means stdin, read by the caller). */
  key?: string;
  /** --header */
  header?: string;
  /** false with --no-test */
  test: boolean;
}

export interface WebhookOptions {
  /** Test-post timeout (tests shorten it). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** https://…, or http:// to this Mac only (a local test sink). */
export function validWebhookUrl(u: string): boolean {
  if (/^https:\/\/\S+$/.test(u)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/\S*)?$/.test(u);
}

/** Strips a leading `Bearer ` from a key value. */
function stripBearer(v: string): string {
  return v.trim().replace(/^bearer(\s+|$)/i, "").trim();
}

/**
 * Reads the (hidden) key answer. A pasted header line gives the header name and the key; a leading
 * `Bearer ` is stripped either way. It counts as a header line when there's a space after the colon
 * (`X-Key: v`), the name is Authorization (`Authorization:Bearer v`), or nothing follows the colon
 * (`X-Key:`, which is an error: no key). Otherwise, e.g. a bare `abc:def`, it's the key as typed.
 * A bare `Bearer` (no key after it) is an error, not "no key". An empty answer is `{key: ""}`.
 */
export function parseKeyAnswer(a: string): { key: string; header?: string } | { error: string } {
  const t = a.trim();
  const m = /^([A-Za-z0-9-]+):(\s*)(.*)$/.exec(t);
  if (m && (m[2] || !m[3] || m[1]!.toLowerCase() === "authorization")) {
    const key = stripBearer(m[3]!);
    if (!key) return { error: "That header line has no key after the colon." };
    return { header: m[1]!, key };
  }
  const key = stripBearer(t);
  if (t && !key) return { error: "That's just \"Bearer\" with no key after it." };
  return { key };
}

/**
 * Reads a header answer. A pasted full header line (`Name: value`) gives the name, and its value
 * (minus any `Bearer `) becomes the key. Returns an error reason (never echoing the answer) when
 * the name isn't a header name.
 */
export function parseHeaderAnswer(a: string, key: string): { header: string; key: string } | { error: string } {
  let name = a.trim() || "Authorization";
  const m = /^([^:\s]+)\s*:\s*(.*)$/.exec(name);
  if (m) {
    name = m[1]!;
    const v = stripBearer(m[2]!);
    if (v) key = v;
  }
  if (!HEADER_NAME.test(name)) return { error: "a header name is letters, digits and dashes only, e.g. X-Webhook-Key" };
  return { header: name, key };
}

/** Asks until `check` passes (it returns an error reason, or nothing); undefined after MAX_TRIES bad answers. */
export async function askValid(
  p: Prompter,
  question: string,
  check: (a: string) => string | undefined,
  say: (s: string) => void,
  opts: { secret?: boolean } = {},
): Promise<string | undefined> {
  for (let tries = 1; tries <= MAX_TRIES; tries++) {
    const a = await p.ask(question, opts);
    const reason = check(a);
    if (!reason) return a;
    say(`   ${reason}${tries < MAX_TRIES ? " Try again." : ""}`);
  }
  return undefined;
}

export const URL_QUESTION = "Webhook URL (https://…)";
export const KEY_QUESTION = "Webhook key (Enter if none; input hidden)";
export const HEADER_QUESTION =
  "Header name for the key [Authorization] (just the name, e.g. X-Webhook-Key; Enter for Authorization: Bearer <key>; input hidden)";
export const TEST_QUESTION = "Send a test now?";
/** Appended to a question whose saved value is never shown. */
export const KEEP = " (set; Enter keeps it)";

/** What to do about a failed test post. Never includes the URL or key. */
export function webhookHint(r: PostResult): string {
  if (r.status === 401 || r.status === 403)
    return "The routine refused the key. Copy the key again from the routine's Webhook trigger, check which header it goes in (Authorization or e.g. X-Webhook-Key), then: rex-bot setup webhook";
  if (r.status === 404) return "Nothing at that URL (wrong URL, or the routine was deleted). Copy the webhook URL again from the routine, then: rex-bot setup webhook";
  if (r.reason === "timeout") return "No answer within 5s. Check this Mac's network and the routine, then: rex-bot doctor --test-webhook";
  if (r.status === 0) return `Could not connect (${r.reason ?? "failed"}). Check the URL's host, then: rex-bot setup webhook`;
  if (r.status >= 500) return "The routine's host had an error. Try again later: rex-bot doctor --test-webhook";
  return "Check the routine's webhook URL and key: rex-bot setup webhook";
}

/** POSTs a doctor_test event (the routine instructions answer it with "rex-bot-bridge webhook OK"). */
export async function testWebhook(ctx: Ctx, s: Settings, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<PostResult> {
  return postWebhook(s.webhook, enrich({ event: "doctor_test" }), { logFile: ctx.paths.notifyLog, fetch: ctx.fetch, timeoutMs });
}

/**
 * Asks for (or takes from flags) the webhook URL, key and header name, saves them to config.json, and
 * offers a test post. Never prints the URL or the key. Exit: 0 saved (and test passed or skipped),
 * 1 test failed or no valid answer, 2 usage.
 */
export async function setupWebhook(ctx: Ctx, flags: WebhookFlags, p: Prompter, opts: WebhookOptions = {}): Promise<number> {
  const say = ctx.out;
  const ok = (s: string) => ctx.out(`✅ ${s}`);
  const warn = (s: string) => ctx.out(`⚠️  ${s}`);
  const usage = (s: string) => {
    ctx.err(`rex-bot setup webhook: ${s}\nRun \`rex-bot setup webhook --help\` for usage.`);
    return 2;
  };

  let s = await readSettings(ctx.paths.configFile);
  const cur = { ...s.webhook };

  // Flags are checked before anything is asked or saved.
  if (flags.url !== undefined && !validWebhookUrl(flags.url)) return usage("--url must start with https://");
  let fromKeyFlag: { key: string; header?: string } | undefined;
  if (flags.key !== undefined) {
    const r = parseKeyAnswer(flags.key);
    if ("error" in r) return usage(`--key-file: ${r.error}`);
    fromKeyFlag = r;
  }
  if (flags.header !== undefined && !HEADER_NAME.test(flags.header)) return usage("--header must be a header name, e.g. X-Webhook-Key");
  if (!p.interactive && flags.url === undefined && !cur.url) return usage("no webhook URL saved yet; pass --url URL");

  say("rex-bot setup webhook\n");
  say("The watcher and `rex-bot say` POST to your Grok Bot routine's webhook. Its URL (and key, if it");
  say(`shows one) are on the routine's Webhook trigger. Guide: ${DOC_URL}\n`);

  // URL
  let url = flags.url ?? cur.url;
  if (flags.url === undefined && p.interactive) {
    const a = await askValid(
      p,
      URL_QUESTION + (cur.url ? KEEP : ""),
      (x) => (!x || validWebhookUrl(x) ? undefined : "The webhook URL must start with https://."),
      say,
    );
    if (a === undefined) {
      warn(`No valid webhook URL after ${MAX_TRIES} tries; nothing saved.`);
      return 1;
    }
    if (a) url = a;
  }
  if (!url) {
    say("No URL given; nothing saved. Run `rex-bot setup webhook` again when you have the routine's webhook URL.");
    return 0;
  }

  // Key: a pasted header line can also give the header name.
  let key = cur.key;
  let header: string | undefined = flags.header;
  if (fromKeyFlag) {
    key = fromKeyFlag.key || undefined;
    header ??= fromKeyFlag.header;
  } else if (p.interactive) {
    let k: { key: string; header?: string } | undefined;
    const a = await askValid(
      p,
      cur.key ? KEY_QUESTION.replace("Enter if none", "set; Enter keeps it") : KEY_QUESTION,
      (x) => {
        const r = parseKeyAnswer(x);
        if ("error" in r) return r.error;
        k = r;
        return undefined;
      },
      say,
      { secret: true },
    );
    if (a === undefined || !k) {
      warn(`No valid webhook key after ${MAX_TRIES} tries; nothing saved.`);
      return 1;
    }
    if (k.key) key = k.key;
    header ??= k.header;
  }

  // Header name (hidden too: people paste a whole `Name: value` line here, value and all).
  if (key && !header && p.interactive) {
    const keep = cur.header && cur.header.toLowerCase() !== "authorization" ? cur.header : undefined;
    const q = keep
      ? `Header name for the key [${keep}] (Enter keeps ${keep}; type Authorization for Authorization: Bearer <key>; input hidden)`
      : HEADER_QUESTION;
    let parsed: { header: string; key: string } | undefined;
    await askValid(
      p,
      q,
      (x) => {
        const r = parseHeaderAnswer(x || keep || "", key!);
        if ("error" in r) return `That isn't a header name: ${r.error}.`;
        parsed = r;
        return undefined;
      },
      say,
      { secret: true },
    );
    if (parsed) {
      key = parsed.key;
      header = parsed.header;
    } else {
      warn(`No valid header name after ${MAX_TRIES} tries; the key will be sent as Authorization: Bearer <key>.`);
      header = "Authorization";
    }
  }
  header ??= key ? (cur.header ?? "Authorization") : undefined;

  // Re-read right before saving: the prompts can take minutes, and anything else (mode, port, …) may
  // have changed meanwhile. Only the webhook.* fields are ours to write.
  s = await readSettings(ctx.paths.configFile);
  s = setKey(s, "webhook.url", url);
  s = setKey(s, "webhook.key", key ?? "");
  s = setKey(s, "webhook.header", header && header.toLowerCase() !== "authorization" ? header : "");
  await writeSettings(ctx.paths.configFile, s);
  const how = s.webhook.key ? `key sent as ${s.webhook.header ? `${s.webhook.header}: <key>` : "Authorization: Bearer <key>"}` : "no key";
  ok(`Webhook saved to ${ctx.paths.configFile}: URL (set), ${how}`);

  if (!flags.test || !(await p.confirm(TEST_QUESTION, true))) {
    say("\nTest it any time: rex-bot doctor --test-webhook");
    return 0;
  }
  const r = await testWebhook(ctx, s, opts.timeoutMs);
  if (r.ok) {
    ok(`Test sent: ${describe(r)}. Your routine should run and reply "rex-bot-bridge webhook OK".`);
    say("\nNext: rex-bot doctor --test-webhook");
    return 0;
  }
  ctx.err(`❌ Test failed: ${describe(r)}\n   fix: ${webhookHint(r)}`);
  return 1;
}
