import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { Rex, type ProcessInfo, type StatusRecord } from "./rex.js";
import type { Mode } from "./settings.js";
import { WatchFile } from "./watch.js";

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

export const AGENTS = ["claude", "codex", "pi", "grok", "shell", "custom"] as const;
export type Agent = (typeof AGENTS)[number];

const REACH_TTL_MS = 5_000;

/** Default terminal states for wait_for_status. */
export const SETTLED_STATES = ["done", "blocked", "error", "idle"];

export interface PaneInfo {
  block_id: string;
  block_label?: string;
  window_id?: string;
  window_label?: string;
  process: ProcessInfo | null;
  status: StatusRecord | null;
}

export interface SessionInfo {
  session_id: string;
  session_label?: string;
  watched: boolean;
  panes: PaneInfo[];
}

export interface OpsDeps {
  rex: Rex;
  watch: WatchFile;
  heartbeatFile: string;
  auditLogPath: string;
  /** For tests: replaces setTimeout-based sleeping in wait_for_status. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** Delay between a paste and the Enter that submits it (default 150ms). */
  pasteSettleMs?: number;
  /** Powers: "watched" limits pane/session tools to watched sessions. Read per call. Required (fail closed). */
  mode: () => Promise<Mode>;
}

export const OPT_IN_HINT =
  'Ask the human to opt it in (Rex command palette "Bot: Watch / Unwatch This Session", or `rex-grokbot watch add <session_id>`)';

/** Runs fn over items with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

const orNull = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

/** Every bridge operation, independent of MCP so it can be unit-tested with a fake rex runner. */
export class Ops {
  private readonly rex: Rex;
  private readonly watch: WatchFile;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly pasteSettleMs: number;
  private readonly mode: () => Promise<Mode>;

  constructor(private readonly deps: OpsDeps) {
    this.mode = deps.mode;
    this.rex = deps.rex;
    this.watch = deps.watch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? 1000;
    this.pasteSettleMs = deps.pasteSettleMs ?? 150;
  }

  /** Finds which session owns a block (rex scopes most block commands to a session). */
  async resolveSession(blockId: string, sessionId?: string): Promise<string> {
    if (sessionId) return sessionId;
    const sessions = await this.rex.sessions();
    for (const s of sessions) {
      const blocks = await orNull(this.rex.blocks(s.session_id));
      if (blocks?.some((b) => b.block_id === blockId)) return s.session_id;
    }
    throw new BridgeError(`block ${blockId} not found in any session`);
  }

  /** In watched mode, refuses unless the session is on the watch list. */
  private async gateSession(tool: string, sessionId: string): Promise<void> {
    if ((await this.mode()) === "full") return;
    if ((await this.watch.list()).includes(sessionId)) return;
    throw new BridgeError(
      `${tool} refused: the bridge is in "watched" mode and session ${sessionId} is not watched. ${OPT_IN_HINT}. ` +
        "The Mac's owner can allow every session with `rex-grokbot config set mode full`.",
    );
  }

  /**
   * Session that owns blockId, gated. In watched mode a caller-supplied session_id is verified to really
   * own the block, so a watched session id cannot be paired with a block from an unwatched one.
   */
  private async target(tool: string, blockId: string, sessionId?: string): Promise<string> {
    const session = await this.resolveSession(blockId, sessionId);
    if ((await this.mode()) === "full") return session;
    if (sessionId) {
      const blocks = await this.rex.blocks(session).catch(() => []);
      if (!blocks.some((b) => b.block_id === blockId)) {
        throw new BridgeError(`block ${blockId} is not in session ${sessionId}`);
      }
    }
    await this.gateSession(tool, session);
    return session;
  }

  async listAgents(filterSession?: string): Promise<{ sessions: SessionInfo[] }> {
    const [all, watched] = await Promise.all([this.rex.sessions(), this.watch.list()]);
    const sessions = filterSession
      ? all.filter((s) => s.session_id === filterSession || s.label === filterSession)
      : all;
    if (filterSession && sessions.length === 0) throw new BridgeError(`session ${filterSession} not found`);
    const result = await mapLimit(sessions, 4, async (s): Promise<SessionInfo> => {
      const [blocks, windows] = await Promise.all([
        this.rex.blocks(s.session_id).catch(() => []),
        this.rex.windowLabels(s.session_id).catch(() => new Map<string, string>()),
      ]);
      const panes = await mapLimit(blocks, 8, async (b): Promise<PaneInfo> => {
        const [process, status] = await Promise.all([
          orNull(this.rex.process(s.session_id, b.block_id)),
          orNull(this.rex.status(s.session_id, b.block_id)),
        ]);
        return {
          block_id: b.block_id,
          block_label: b.label,
          window_id: b.window_id,
          window_label: b.window_id ? windows.get(b.window_id) : undefined,
          process,
          status,
        };
      });
      return { session_id: s.session_id, session_label: s.label, watched: watched.includes(s.session_id), panes };
    });
    return { sessions: result };
  }

  async readPane(blockId: string, sessionId: string | undefined, lines: number) {
    const session = await this.target("read_pane", blockId, sessionId);
    const text = await this.rex.capture(session, blockId);
    const all = text.replace(/\n$/, "").split("\n");
    const tail = all.slice(-lines);
    return { session_id: session, block_id: blockId, lines: tail.length, total_lines: all.length, text: tail.join("\n") };
  }

  async sendMessage(opts: {
    block_id: string;
    session_id?: string;
    text: string;
    submit: boolean;
    require_idle: boolean;
  }) {
    const session = await this.target("send_message", opts.block_id, opts.session_id);
    if (opts.require_idle) {
      const st = await this.rex.status(session, opts.block_id);
      if (st?.state === "working") {
        throw new BridgeError(
          `refused: pane ${opts.block_id} is working (${st.app ?? "unknown app"}: ${st.msg ?? ""}). ` +
            "Wait for it (wait_for_status) or call again with require_idle=false.",
        );
      }
    }
    await this.rex.paste(session, opts.block_id, opts.text);
    if (opts.submit) {
      // Let the program finish ingesting the paste before Enter, or a TUI may treat Enter as part of it.
      await this.sleep(this.pasteSettleMs);
      await this.rex.sendKeys(session, opts.block_id, ["enter"]);
    }
    return { session_id: session, block_id: opts.block_id, sent_chars: opts.text.length, submitted: opts.submit };
  }

  async sendKeys(blockId: string, sessionId: string | undefined, keys: string[]) {
    const session = await this.target("send_keys", blockId, sessionId);
    await this.rex.sendKeys(session, blockId, keys);
    return { session_id: session, block_id: blockId, keys };
  }

  async spawnAgent(opts: {
    agent: Agent;
    cwd: string;
    prompt?: string;
    session_id?: string;
    new_session_label?: string;
    label?: string;
    command?: string[];
    watch: boolean;
  }) {
    if (opts.session_id && opts.new_session_label) {
      throw new BridgeError("give either session_id (new tab) or new_session_label (new session), not both");
    }
    if (!opts.session_id && !opts.new_session_label) {
      throw new BridgeError("give session_id (new tab in that session) or new_session_label (new session)");
    }
    const watchedMode = (await this.mode()) === "watched";
    if (opts.session_id) await this.gateSession("spawn_agent", opts.session_id);
    const cwd = expandHome(opts.cwd);
    if (!isAbsolute(cwd)) throw new BridgeError(`cwd must be an absolute path (or start with ~): ${opts.cwd}`);
    const st = await stat(cwd).catch(() => null);
    if (!st?.isDirectory()) throw new BridgeError(`cwd is not a directory: ${cwd}`);

    const argv = agentArgv(opts.agent, opts.prompt, opts.command);
    let res;
    if (opts.session_id) {
      // rex run needs a command, so a plain shell is started explicitly.
      const cmd = argv.length ? argv : [process.env.SHELL || "/bin/zsh", "-l"];
      res = await this.rex.runInSession(opts.session_id, cwd, cmd, opts.label);
    } else {
      res = await this.rex.newSession(opts.new_session_label as string, cwd, argv);
      if (opts.label) await this.rex.renameBlock(res.session_id, res.block_id, opts.label);
    }
    let watched: boolean;
    if (watchedMode) {
      // Only a session the bot just created is added (or it could not reach its own agent). An existing
      // session is never (re-)added: the human may have unwatched it while the spawn was in flight.
      if (opts.new_session_label) {
        await this.watch.add(res.session_id);
        watched = true;
      } else {
        watched = (await this.watch.list()).includes(res.session_id);
      }
    } else if (opts.watch) {
      await this.watch.add(res.session_id);
      watched = true;
    } else {
      watched = (await this.watch.list()).includes(res.session_id);
    }
    return { ...res, agent: opts.agent, argv, cwd, watched };
  }

  async waitForStatus(blockId: string, sessionId: string | undefined, states: string[], timeoutS: number) {
    const session = await this.target("wait_for_status", blockId, sessionId);
    const deadline = this.now() + timeoutS * 1000;
    let last: StatusRecord | null = null;
    for (;;) {
      // Access can be revoked mid-wait (unwatched, or mode switched to watched): recheck before each poll.
      await this.gateSession("wait_for_status", session);
      last = await this.rex.status(session, blockId);
      if (last && states.includes(last.state)) {
        return { session_id: session, block_id: blockId, timed_out: false, status: last };
      }
      if (this.now() >= deadline) {
        return { session_id: session, block_id: blockId, timed_out: true, status: last };
      }
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
    }
  }

  async closePane(blockId: string, sessionId?: string) {
    const session = await this.target("close_pane", blockId, sessionId);
    await this.rex.closeBlock(session, blockId);
    return { session_id: session, block_id: blockId, closed: true };
  }

  async closeSession(sessionId: string) {
    await this.gateSession("close_session", sessionId);
    await this.rex.killSession(sessionId);
    const unwatched = await this.watch.remove(sessionId);
    return { session_id: sessionId, closed: true, removed_from_watch_list: unwatched };
  }

  async watchSession(sessionId: string) {
    if ((await this.mode()) === "watched") {
      throw new BridgeError(
        `watch_session refused: the bridge is in "watched" mode, where only the human adds sessions. ${OPT_IN_HINT}.`,
      );
    }
    const changed = await this.watch.add(sessionId);
    return { session_id: sessionId, watched: true, changed };
  }

  async unwatchSession(sessionId: string) {
    const changed = await this.watch.remove(sessionId);
    return { session_id: sessionId, watched: false, changed };
  }

  async listWatched() {
    return { sessions_file: this.watch.path, watched: await this.watch.list() };
  }

  async heartbeatAgeS(): Promise<number | null> {
    try {
      const ts = Date.parse((await readFile(this.deps.heartbeatFile, "utf8")).trim());
      if (Number.isNaN(ts)) return null;
      return Math.max(0, Math.round((Date.now() - ts) / 1000));
    } catch {
      return null;
    }
  }

  private reach: { at: number; value: Promise<boolean> } | null = null;

  /**
   * Used by the unauthenticated /healthz: the result is cached for 5s and concurrent callers share one
   * in-flight probe, so health checks can never fan out into unbounded rex subprocesses.
   */
  rexReachable(): Promise<boolean> {
    const now = this.now();
    if (this.reach && now - this.reach.at < REACH_TTL_MS) return this.reach.value;
    const value = this.rex.version().then(
      () => true,
      () => false,
    );
    this.reach = { at: now, value };
    return value;
  }

  async bridgeStatus() {
    const [version, heartbeat, watched, mode] = await Promise.all([
      this.rex.version().catch((e: Error) => ({ error: e.message })),
      this.heartbeatAgeS(),
      this.watch.list().catch(() => []),
      this.mode(),
    ]);
    return {
      mode,
      rex: version,
      watcher_heartbeat_age_s: heartbeat,
      watched_count: watched.length,
      audit_log: this.deps.auditLogPath,
    };
  }
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/**
 * Maps an agent to its argv. All four agent CLIs take the initial prompt as a positional argument
 * (checked with `<cli> --help`: `claude [prompt]`, `codex [PROMPT]`, `pi [messages...]`, `grok [PROMPT]`).
 */
export function agentArgv(agent: Agent, prompt?: string, command?: string[]): string[] {
  if (agent === "custom") {
    if (!command?.length) throw new BridgeError("agent=custom needs command (an argv array)");
    if (prompt) throw new BridgeError("prompt is not used with agent=custom; put it in command");
    return command;
  }
  if (command) throw new BridgeError("command is only allowed with agent=custom");
  if (agent === "shell") {
    if (prompt) throw new BridgeError("agent=shell takes no prompt; use send_message after spawning");
    return [];
  }
  if (prompt !== undefined) {
    if (!prompt.trim()) throw new BridgeError("prompt is empty");
    if (prompt.startsWith("-")) {
      throw new BridgeError("prompt must not start with '-' (the CLI would read it as an option)");
    }
    return [agent, prompt];
  }
  return [agent];
}
