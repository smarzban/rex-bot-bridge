import { spawn } from "node:child_process";

/** Result of one `rex` invocation. */
export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  timeoutMs?: number;
}

/** Runs `rex` with an argument array. Injectable so tests can fake Rex. */
export type Runner = (args: string[], opts?: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT = 64 * 1024 * 1024;

export class RexError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "RexError";
  }
  get notFound(): boolean {
    return this.code === 3 || /not found/i.test(this.stderr);
  }
}

/** Spawns the real `rex` binary. No shell is involved: args are passed as an argv array. */
export function spawnRunner(bin: string, defaultTimeoutMs = 15_000): Runner {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
      let stdout = "";
      let stderr = "";
      let size = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? defaultTimeoutMs);
      const onData = (which: "out" | "err") => (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) {
          child.kill("SIGKILL");
          return;
        }
        if (which === "out") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", onData("out"));
      child.stderr.on("data", onData("err"));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new RexError(`failed to start rex (${bin}): ${err.message}`, args, null, ""));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new RexError(`rex ${args[0] ?? ""} timed out`, args, null, stderr));
          return;
        }
        resolve({ stdout, stderr, code: code ?? 1 });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input ?? "");
    });
}

export interface ProcessInfo {
  name: string;
  cwd?: string;
  pid?: number;
}

export interface StatusRecord {
  state: string;
  kind?: string;
  app?: string;
  effective_app?: string;
  msg?: string;
  updated_at?: string;
}

export interface BlockSummary {
  block_id: string;
  label?: string;
  window_id?: string;
  placement?: string;
  flavor?: string;
}

export interface SessionSummary {
  session_id: string;
  label?: string;
}

export interface SpawnResult {
  session_id: string;
  block_id: string;
  window_id?: string;
}

/** Thin, typed wrapper around the `rex` CLI. */
export class Rex {
  constructor(private readonly run: Runner) {}

  async exec(args: string[], opts?: RunOptions): Promise<string> {
    const r = await this.run(args, opts);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`;
      throw new RexError(`rex ${args.slice(0, 2).join(" ")} failed: ${detail}`, args, r.code, r.stderr);
    }
    return r.stdout;
  }

  async json<T>(args: string[], opts?: RunOptions): Promise<T> {
    const out = await this.exec(args, opts);
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new RexError(`rex ${args.slice(0, 2).join(" ")} returned invalid JSON`, args, 0, "");
    }
  }

  async version(): Promise<Record<string, unknown>> {
    return this.json(["api", "call", "server.version"], { timeoutMs: 5_000 });
  }

  async sessions(): Promise<SessionSummary[]> {
    const r = await this.json<{ sessions?: SessionSummary[] }>(["ls", "--json"]);
    return r.sessions ?? [];
  }

  async blocks(session: string): Promise<BlockSummary[]> {
    const r = await this.json<{ blocks?: BlockSummary[] }>(["block", "ls", "-s", session, "--json"]);
    return r.blocks ?? [];
  }

  /** window_id -> window label */
  async windowLabels(session: string): Promise<Map<string, string>> {
    const r = await this.json<{ windows?: { window_id: string; label?: string }[] }>([
      "session",
      "inspect",
      session,
      "--json",
    ]);
    return new Map((r.windows ?? []).map((w) => [w.window_id, w.label ?? ""]));
  }

  async process(session: string, block: string): Promise<ProcessInfo | null> {
    const r = await this.json<{
      foreground?: { pid?: number; name?: string; argv0?: string; invoked_path?: string; cwd?: string };
    }>(["block", "call", "-s", session, "-b", block, "process"]);
    const fg = r.foreground;
    if (!fg) return null;
    return { name: processName(fg), cwd: fg.cwd, pid: fg.pid };
  }

  async status(session: string, block: string): Promise<StatusRecord | null> {
    const r = await this.json<{ records?: StatusRecord[] }>([
      "block",
      "call",
      "-s",
      session,
      "-b",
      block,
      "program_status",
    ]);
    const rec = r.records?.[0];
    if (!rec) return null;
    const { state, kind, app, effective_app, msg, updated_at } = rec;
    return { state, kind, app, effective_app, msg, updated_at };
  }

  async capture(session: string, block: string): Promise<string> {
    return this.exec(["capture", "-s", session, "-b", block, "--trim", "--unwrap"], { timeoutMs: 30_000 });
  }

  /** Text goes over stdin, so it is never parsed as a flag and has no argv length limit. */
  async send(session: string, block: string, text: string): Promise<void> {
    await this.exec(["send", "-s", session, "-b", block], { input: text });
  }

  async sendKeys(session: string, block: string, keys: string[]): Promise<void> {
    await this.exec(["send-key", "-s", session, "-b", block, "--", ...keys]);
  }

  async runInSession(
    session: string,
    cwd: string,
    argv: string[],
    label?: string,
  ): Promise<SpawnResult> {
    const args = ["run", "-s", session, "-c", cwd, "--focus=false", "--keep-open", "--json"];
    if (label) args.push("--label", label);
    args.push("--", ...argv);
    const r = await this.json<{ window_id?: string; block_ids?: string[] }>(args);
    const block = r.block_ids?.[0];
    if (!block) throw new RexError("rex run returned no block id", args, 0, "");
    return { session_id: session, block_id: block, window_id: r.window_id };
  }

  async newSession(label: string, cwd: string, argv: string[]): Promise<SpawnResult> {
    const args = ["new", label, "-c", cwd, "--json"];
    if (argv.length) args.push("--keep-open", "--", ...argv);
    const r = await this.json<{
      session_id?: string;
      initial_windows?: { window_id?: string; block_ids?: string[] }[];
    }>(args);
    const win = r.initial_windows?.[0];
    const block = win?.block_ids?.[0];
    if (!r.session_id || !block) throw new RexError("rex new returned no session/block id", args, 0, "");
    return { session_id: r.session_id, block_id: block, window_id: win?.window_id };
  }

  async renameBlock(session: string, block: string, label: string): Promise<void> {
    await this.exec(["block", "rename", "-s", session, block, label]);
  }

  async closeBlock(session: string, block: string): Promise<void> {
    await this.exec(["block", "close", "-s", session, block]);
  }

  async killSession(session: string): Promise<void> {
    await this.exec(["session", "kill", session]);
  }
}

/** Claude Code reports its version as the process name, so prefer argv0, then the invoked path. */
export function processName(fg: { name?: string; argv0?: string; invoked_path?: string }): string {
  const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  if (fg.argv0) return base(fg.argv0.replace(/^-/, ""));
  if (fg.invoked_path) return base(fg.invoked_path);
  return fg.name ?? "";
}
