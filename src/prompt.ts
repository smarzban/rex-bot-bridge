import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** How many times an invalid answer is re-asked before setup gives up on that item. */
export const MAX_TRIES = 3;

export interface Prompter {
  /** Yes/no question. With --yes (or no TTY) returns the default without asking. */
  confirm(question: string, def: boolean): Promise<boolean>;
  /** Free text; returns "" when skipped. `secret` hides the typed text. */
  ask(question: string, opts?: { secret?: boolean; def?: string }): Promise<string>;
  /** Pick one of `choices`; returns def without asking in non-interactive mode. */
  choose<T extends string>(question: string, choices: readonly T[], def: T): Promise<T>;
  interactive: boolean;
}

/** Prompts on stdin/stderr (stdout stays clean for output). Non-interactive when yes=true or stdin is not a TTY. */
export function makePrompter(yes: boolean): Prompter {
  const interactive = !yes && !!process.stdin.isTTY;

  const line = (question: string, secret = false): Promise<string> =>
    new Promise((resolve) => {
      // For a secret, readline gets a muted output: it would otherwise echo each keystroke and
      // redraw (clear) the line, wiping the question. We print the question ourselves instead.
      const output = secret ? new Writable({ write: (_c, _e, cb) => cb() }) : process.stderr;
      const rl = createInterface({ input: process.stdin, output, terminal: true });
      // Ctrl-C: readline swallows SIGINT in terminal mode, so exit like a shell would.
      rl.on("SIGINT", () => {
        process.stderr.write("\n");
        process.exit(130);
      });
      if (secret) process.stderr.write(question);
      rl.question(secret ? "" : question, (answer) => {
        if (secret) process.stderr.write("\n");
        rl.close();
        resolve(answer.trim());
      });
    });

  return {
    interactive,
    async confirm(question, def) {
      if (!interactive) return def;
      const a = (await line(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
      if (!a) return def;
      return a === "y" || a === "yes";
    },
    async ask(question, opts = {}) {
      if (!interactive) return opts.def ?? "";
      const a = await line(`${question}${opts.def ? ` [${opts.def}]` : ""}: `, opts.secret);
      return a || opts.def || "";
    },
    async choose(question, choices, def) {
      if (!interactive) return def;
      for (let tries = 1; ; tries++) {
        const a = (await line(`${question} (${choices.join("/")}) [${def}]: `)).toLowerCase();
        if (!a) return def;
        const hit = choices.find((c) => c === a);
        if (hit) return hit;
        if (tries >= MAX_TRIES) {
          process.stderr.write(`⚠️  No valid answer after ${MAX_TRIES} tries; using ${def}.\n`);
          return def;
        }
        process.stderr.write(`Please answer one of: ${choices.join(", ")}\n`);
      }
    },
  };
}

/**
 * A prompter with scripted answers, for tests. Keys are matched as substrings of the question.
 * An array answers successive askings in order (the last entry repeats).
 */
export function scriptedPrompter(answers: Record<string, string | string[] | boolean> = {}): Prompter {
  const used = new Map<string, number>();
  const find = (q: string): string | boolean | undefined => {
    const hit = Object.entries(answers).find(([k]) => q.includes(k));
    if (!hit) return undefined;
    const [k, a] = hit;
    if (!Array.isArray(a)) return a;
    const i = used.get(k) ?? 0;
    used.set(k, i + 1);
    return a[Math.min(i, a.length - 1)];
  };
  return {
    interactive: true,
    async confirm(q, def) {
      const a = find(q);
      return typeof a === "boolean" ? a : def;
    },
    async ask(q, opts = {}) {
      const a = find(q);
      return typeof a === "string" ? a : (opts.def ?? "");
    },
    async choose(q, choices, def) {
      const a = find(q);
      return typeof a === "string" && (choices as readonly string[]).includes(a) ? (a as typeof def) : def;
    },
  };
}
