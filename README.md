# rex-bot-bridge

MCP server that lets a remote coordinator agent (Grok Bot, over Tailscale) **see and drive** agent sessions running in [Rex](https://www.superlogical.com/rex/docs): list panes, read their screens, type into them, spawn new agents (Claude Code, Codex, Pi, Grok Build, shells), wait for them to finish, and close them. It also ships `rex-bot`, a tiny CLI that agents inside Rex use to message the coordinator.

```
Grok Bot ──(tailnet, HTTPS)──> tailscale serve ──> 127.0.0.1:7400/mcp ──> rex CLI ──> Rex panes
   ^                                                                                    │
   └──────── webhook <── agent-notify <── bot-watch.lua (status) / rex-bot say (messages) ┘
```

The agent → bot direction (status pushes) is the existing `~/.config/rex/bot-watch` watcher; this repo is the bot → agent direction.

## Security model — read this

**Anyone who holds the bearer token and can reach the URL can run arbitrary commands on this Mac as your user** (`spawn_agent` with `agent: custom` runs any argv; `send_message` types into any shell). The bridge grants full powers over every Rex session by design. Protections:

- Listens on `127.0.0.1:7400` only. Exposure is a separate, explicit `tailscale serve` (tailnet only, never `funnel`).
- `Authorization: Bearer <token>` required on `/mcp` (constant-time compare, 401 otherwise). Token lives in `~/.config/rex-bot-bridge/token` (mode 600) and is never logged. It is re-read per request, so rotating takes effect immediately.
- `rex` is run with argument arrays, never through a shell. IDs and key names are validated; message text is delivered as a Rex paste event (`rex api call block.event -`, JSON over stdin, never in argv).
- Every tool call is appended to `~/.local/state/rex-bot-bridge/audit.log` (JSONL: timestamp, tool, args with long strings truncated to 200 chars, ok/error, duration). No token, no pane contents.
- `GET /healthz` is unauthenticated and returns only `{ok, rex_reachable, watcher_heartbeat_age_s}`.
- `read_pane` output is untrusted program output; the tool description tells the model so.

Rotate the token if it may have leaked: `node dist/cli/bridge.js token --rotate`.

## Setup

Requires Node ≥ 22, Rex, and (for exposure) Tailscale.

```sh
npm install
npm run build
npm run token                 # creates ~/.config/rex-bot-bridge/token if missing; prints the path only
node dist/cli/bridge.js serve # or: npm start
curl -s http://127.0.0.1:7400/healthz
```

Environment overrides: `REX_BRIDGE_HOST` (default `127.0.0.1`), `REX_BRIDGE_PORT` (`7400`), `REX_BIN` (path to `rex`; needed under launchd because it lives in the app bundle), `REX_BRIDGE_TOKEN_FILE`, `REX_BRIDGE_AUDIT_LOG`, `REX_BOT_WATCH_DIR`.

**Run at login (optional):** edit and install `launchd/com.rex.bot-bridge.plist.example` (instructions inside). Logs go to `~/Library/Logs/rex-bot-bridge.log`.

**Expose on the tailnet:** `scripts/print-serve-command.sh` prints the command; run it yourself:

```sh
tailscale serve --bg --https=443 --set-path /rex-bridge http://127.0.0.1:7400
```

The server matches `/mcp` and `/healthz` by suffix, so it works whether or not the proxy strips the `/rex-bridge` prefix.

## Grok Bot connector

Add a custom MCP server in Grok Bot (with its Tailscale plugin enabled):

| Field | Value |
|---|---|
| URL | `https://<this-mac>.<tailnet>.ts.net/rex-bridge/mcp` |
| Transport | Streamable HTTP |
| Header | `Authorization: Bearer <token>` (show it once with `node dist/cli/bridge.js token --show`) |

Use the static header, not OAuth (OAuth sign-in for private tailnet MCP servers is reported broken).

## Tools

| Tool | Args | Does |
|---|---|---|
| `list_agents` | `session?` | Every session → panes: ids/labels, window, foreground process (name, cwd, pid), program status (`state`, `kind`, `app`, `msg`), `watched` |
| `read_pane` | `block_id`, `session_id?`, `lines=80` (≤2000) | Tail of the pane's screen + scrollback (untrusted) |
| `send_message` | `block_id`, `session_id?`, `text`, `submit=true`, `require_idle=false` | Delivers text as one paste event (bracketed paste when the program enables it; TUIs mangle long typed bursts), waits 150 ms, then Enter. `require_idle` refuses while the agent reports `working` |
| `send_keys` | `block_id`, `session_id?`, `keys[]` | e.g. `["escape"]`, `["ctrl+c"]`, `["1","enter"]` (Rex key syntax) |
| `spawn_agent` | `agent`, `cwd`, `prompt?`, `session_id?` \| `new_session_label?`, `label?`, `command?`, `watch=true` | New tab in a session, or a new session. Returns `session_id`, `block_id` |
| `wait_for_status` | `block_id`, `session_id?`, `states=[done,blocked,error,idle]`, `timeout_s=120` (≤600) | Polls program status; returns the record or `timed_out: true` |
| `close_pane` | `block_id`, `session_id?` | Closes the pane |
| `close_session` | `session_id` | Kills the session and drops it from the watch list |
| `watch_session` / `unwatch_session` | `session_id` | Edits `~/.config/rex/bot-watch/sessions` (atomic, comments kept) |
| `list_watched` | — | Watched session ids |
| `bridge_status` | — | Rex version, watcher heartbeat age, watched count, audit log path |

`session_id` is resolved from `block_id` when omitted. Program status comes from OSC 7501 (Claude Code and Pi report it natively); for other programs `status` is `null` — use `process.name`.

**Agents and prompts** (`<cli> --help` checked 2026-11-04): all four take the initial prompt as a positional argument, so `spawn_agent` runs `claude "<prompt>"`, `codex "<prompt>"`, `pi "<prompt>"`, `grok "<prompt>"`. A prompt starting with `-` is rejected (the CLI would parse it as an option); send it with `send_message` after spawning instead. `shell` starts a login shell; `custom` runs `command` as-is. Spawned panes use `--keep-open`, so output stays readable after the program exits.

## `rex-bot` (agents → coordinator)

```sh
rex-bot whoami            # prints REX_SESSION / REX_BLOCK of this pane
rex-bot say "PR #12 is ready for review"
```

`say` pipes `{event: "agent_message", text, rex_session, rex_block, cwd}` to `~/.local/bin/agent-notify --source rex`, with `AGENT_NOTIFY_URL` from the environment or `~/.config/agent-notify/url`. It never fails the caller (exit 0) but prints an error if it isn't configured. Install it on PATH with `npm link` (or symlink `dist/cli/rex-bot.js` into `~/.local/bin/rex-bot`).

Snippet for an `AGENTS.md` / `CLAUDE.md`:

```markdown
## Coordinator
A coordinator bot watches this Rex session. To tell it something (finished, blocked, need a decision),
run `rex-bot say "<one-line message>"`. Keep it short and specific. Status changes (done/blocked/error)
are reported automatically; use `say` for anything that needs words.
```

## Development

```sh
npm test          # unit tests with a fake rex runner
npm run typecheck
npm run build
```
