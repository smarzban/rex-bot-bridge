import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuditLog } from "../src/audit.js";
import { Ops } from "../src/ops.js";
import type { Ctx } from "../src/context.js";
import { resolvePaths } from "../src/paths.js";
import { Rex, type RunOptions, type RunResult } from "../src/rex.js";
import { createBridgeHttpServer } from "../src/server.js";
import { WatchFile } from "../src/watch.js";

export const S1 = "session:01a1a7e9-0000-7000-8000-000000000001";
export const B1 = "block:01a1a7e9-0000-7000-8000-0000000000b1";
export const B2 = "block:01a1a7e9-0000-7000-8000-0000000000b2";
/** A second session, not on the watch list, with one pane. */
export const S2 = "session:01a1a7e9-0000-7000-8000-000000000002";
export const B3 = "block:01a1a7e9-0000-7000-8000-0000000000b3";
export const TOKEN = "test-token-abcdefghijklmnopqrstuvwxyz0123456789";

export interface Call {
  args: string[];
  input?: string;
}

/** A fake `rex` with one session (S1) and two panes. `state` controls B1's program status. */
export class FakeRex {
  calls: Call[] = [];
  state: string | null = "idle";
  statusSequence: (string | null)[] = [];

  runner = async (args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    this.calls.push({ args, input: opts.input });
    const ok = (v: unknown) => ({ stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "", code: 0 });
    const key = args.slice(0, 2).join(" ");
    if (key === "api call" && args[2] === "server.version") return ok({ rex_version: "0.0.test", api_revision: 10 });
    if (key === "api call" && args[2] === "block.event") return ok({});
    if (key === "ls --json") return ok({ sessions: [{ session_id: S1, label: "work" }, { session_id: S2, label: "other" }] });
    if (key === "block ls" && args[args.indexOf("-s") + 1] === S2)
      return ok({ blocks: [{ block_id: B3, label: "other", window_id: "window:w2" }] });
    if (key === "block ls")
      return ok({
        blocks: [
          { block_id: B1, label: "claude", window_id: "window:w1" },
          { block_id: B2, label: "shell", window_id: "window:w1" },
        ],
      });
    if (key === "session inspect") return ok({ windows: [{ window_id: "window:w1", label: "main" }] });
    if (key === "block call") {
      const block = args[args.indexOf("-b") + 1];
      if (block !== B1 && block !== B2 && block !== B3) return { stdout: "", stderr: `Error: block target "${block}" not found`, code: 3 };
      if (args.at(-1) === "process")
        return ok({ foreground: { pid: 42, name: "2.1.318", argv0: "claude", cwd: "/work" } });
      if (block === B2 || block === B3) return ok({ records: [] });
      const st = this.statusSequence.length ? this.statusSequence.shift()! : this.state;
      return ok({ records: st ? [{ state: st, app: "claude-code", msg: "thinking", owner: { pid: 1 } }] : [] });
    }
    if (args[0] === "capture") return ok(Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    if (args[0] === "send" || args[0] === "send-key") return ok("");
    if (args[0] === "run") return ok({ window_id: "window:new", block_ids: ["block:01a1a7e9-0000-7000-8000-0000000000b9"] });
    if (args[0] === "new")
      return ok({
        session_id: "session:01a1a7e9-0000-7000-8000-000000000009",
        initial_windows: [{ window_id: "window:n", block_ids: ["block:01a1a7e9-0000-7000-8000-0000000000c1"] }],
      });
    if (key === "block rename" || key === "block close" || key === "session kill") return ok("");
    return { stdout: "", stderr: `fake rex: unhandled ${args.join(" ")}`, code: 1 };
  };

  callsOf(cmd: string): Call[] {
    return this.calls.filter((c) => c.args[0] === cmd);
  }

  /** block.event calls, with their stdin JSON parsed. */
  pastes(): { session_id: string; block_id: string; event: { type: string; payload: { text: string } } }[] {
    return this.calls
      .filter((c) => c.args[0] === "api" && c.args[2] === "block.event")
      .map((c) => JSON.parse(c.input ?? "{}"));
  }
}

/**
 * Env for a CLI subprocess under test, built from scratch (never from process.env), so a test can't
 * reach the real ~/.config, Rex server, or token through an inherited REX_*, XDG_CONFIG_HOME,
 * REX_BRIDGE_TOKEN_FILE or REX_GROKBOT_LOG_DIR. HOME must be a temp dir.
 */
export function childEnv(vars: Record<string, string> & { HOME: string }): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...vars };
  if (process.env.TMPDIR && !("TMPDIR" in vars)) env.TMPDIR = process.env.TMPDIR;
  return env;
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rex-bridge-test-"));
}

export async function startBridge(fake = new FakeRex(), mode: "watched" | "full" = "full") {
  const dir = await tempDir();
  const watchPath = join(dir, "sessions");
  await writeFile(watchPath, "# watched sessions\n\n" + S1 + "  # main\n");
  const auditPath = join(dir, "audit.log");
  // Fake clock: sleeping advances time instantly, so timeout paths run without real waiting.
  const clock = { t: 1_000_000 };
  const ops = new Ops({
    rex: new Rex(fake.runner),
    watch: new WatchFile(watchPath),
    heartbeatFile: join(dir, "heartbeat"),
    auditLogPath: auditPath,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    pollMs: 1000,
    mode: async () => mode,
  });
  const server = createBridgeHttpServer({ ops, audit: new AuditLog(auditPath), getToken: async () => TOKEN });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  return {
    fake,
    dir,
    watchPath,
    auditPath,
    clock,
    url,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function connect(url: string, token = TOKEN): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** Calls a tool and returns {isError, text, json?}. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  const text = r.content.map((c) => c.text).join("\n");
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: !!r.isError, text, json };
}

const ROOT = join(import.meta.dirname, "..");
const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", code: 0 });

export interface FakeEnv {
  ctx: Ctx;
  out: string[];
  tsCalls: string[][];
  launchctlCalls: string[][];
}

/** A setup/uninstall Ctx with fake rex/launchctl/tailscale and HOME in a temp dir; out collects stdout+stderr. */
export async function fakeCtx(serveStatus: RunResult | Error, home?: string): Promise<FakeEnv> {
  home ??= await tempDir();
  const out: string[] = [];
  const tsCalls: string[][] = [];
  const launchctlCalls: string[][] = [];
  const fake = new FakeRex();
  const ctx: Ctx = {
    env: { HOME: home },
    paths: resolvePaths({ HOME: home }),
    pkgRoot: ROOT,
    cli: join(ROOT, "package.json"),
    node: process.execPath,
    rexBin: "/fake/rex",
    rex: async (args, opts) => (args[0] === "config" ? ok() : fake.runner(args, opts)),
    launchctl: async (args) => {
      launchctlCalls.push(args);
      return { stdout: "", stderr: "not loaded", code: 113 };
    },
    tailscaleBin: "/fake/tailscale",
    tailscale: async (args) => {
      tsCalls.push(args);
      if (args[0] === "status") return ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.tail.ts.net." } }));
      if (args[0] === "serve" && args[1] === "status") {
        if (serveStatus instanceof Error) throw serveStatus;
        return serveStatus;
      }
      return ok();
    },
    fetch: (async () => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    out: (s) => out.push(s),
    err: (s) => out.push(s),
  };
  return { ctx, out, tsCalls, launchctlCalls };
}
