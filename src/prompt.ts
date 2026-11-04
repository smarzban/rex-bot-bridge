import { createInterface } from "node:readline";

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
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      if (secret) {
        // Echo nothing after the question while typing.
        const rlw = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
        let asked = false;
        rlw._writeToOutput = (s: string) => {
          if (!asked) {
            rlw.output.write(s);
            asked = true;
          }
        };
      }
      rl.question(question, (answer) => {
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
      for (;;) {
        const a = (await line(`${question} (${choices.join("/")}) [${def}]: `)).toLowerCase();
        if (!a) return def;
        const hit = choices.find((c) => c === a);
        if (hit) return hit;
        process.stderr.write(`Please answer one of: ${choices.join(", ")}\n`);
      }
    },
  };
}

/** A prompter with scripted answers, for tests. */
export function scriptedPrompter(answers: Record<string, string | boolean> = {}): Prompter {
  const find = (q: string) => Object.entries(answers).find(([k]) => q.includes(k))?.[1];
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
