# rex-bot-bridge

Let a coordinator bot (Grok Bot, over Tailscale) **see and drive the coding agents running in your [Rex](https://www.superlogical.com/rex/docs) terminals**, and get pinged when they finish or get stuck.

- **Bot → agents:** an MCP server the bot connects to. It can list sessions and panes, read a pane's screen, type into it, press keys, spawn new agents (Claude Code, Codex, Pi, Grok Build, shells), wait for them, and close them.
- **Agents → bot:** a watcher that POSTs to the bot's webhook when an agent's status turns `done`, `blocked`, or `error`, and a `rex-bot say "…"` command agents use to send it a message.

```
                 ┌──────────────────────────── your Mac ─────────────────────────────┐
 Grok Bot ──MCP──▶ tailscale serve ─▶ rex-bot serve (127.0.0.1:7400) ─▶ rex ─▶ Rex panes
 (tailnet)       │                                                             │      │
    ▲            │        rex-bot watch (lua/bot-watch.lua) ◀── status (OSC 7501) ─┘      │
    └─ webhook ──┼────────  rex-bot notify  ◀──  rex-bot say "…" (from an agent)          │
                 └───────────────────────────────────────────────────────────────────┘
```

macOS only. Both directions live in this one package; `rex-bot setup` installs them as two launchd services.

## Security model, in plain words

**Anyone who has the bearer token and can reach the URL can run commands on your Mac as you.** `spawn_agent` can start any program and `send_message` types into shells. Keep that in mind when you choose a mode:

| Mode | What the bot can do |
|---|---|
| `watched` (default) | List every session. Read, type into, press keys in, wait on, and close panes **only in sessions you opted in**. Spawn agents into a watched session or a new session (which is then watched). It cannot opt sessions in itself. |
| `full` | All of the above in **every** Rex session. |

Opt a session in from Rex's command palette (**Bot: Watch / Unwatch This Session**) or with `rex-bot watch add <session-id>`. Switch modes with `rex-bot config set mode watched|full` (takes effect on the next call, no restart).

Other protections:

- The bridge listens on `127.0.0.1` only. It reaches your tailnet through `tailscale serve` (tailnet only, never Funnel).
- `/mcp` needs `Authorization: Bearer <token>` (constant-time compare). The token lives in `~/.config/rex-bot-bridge/token` (mode 600), is never logged, and is re-read per request, so `rex-bot token --rotate` takes effect at once.
- Every tool call is logged to `~/.local/state/rex-bot-bridge/audit.log` (tool, truncated args, result). No token, no pane contents.
- The webhook URL and key are never printed or logged; `notify.log` records only HTTP status codes.
- `GET /healthz` is unauthenticated and returns only `{ok, rex_reachable, watcher_heartbeat_age_s}`.
- Pane text returned to the bot is marked untrusted, and the routine instructions tell it so.

## Prerequisites

- macOS with **Node 22+**
- **Rex**, running, with `rex` on your PATH (`command -v rex`)
- **Tailscale**, logged in on this Mac
- **Grok Bot** desktop with its Tailscale plugin

## Quickstart

```sh
npm i -g rex-bot-bridge
rex-bot setup
rex-bot doctor
```

`setup` asks a few questions (mode, webhook, whether to run `tailscale serve`) and then:

1. creates the token and `~/.config/rex-bot-bridge/` (700; files 600),
2. adds the palette actions to Rex's `init.lua` as one marked block (backed up first, validated with `rex config check`, rolled back if the check fails),
3. installs and starts the launchd services `com.rexbotbridge.bridge` and `com.rexbotbridge.watch`,
4. runs `tailscale serve --bg --https=443 --set-path /rex-bridge http://127.0.0.1:7400` (after asking),
5. installs a small `rex-bot` skill into `~/.claude/skills` and `~/.agents/skills` (if those exist) so agents know about `rex-bot say`,
6. prints the Grok Bot setup text.

Install from the global npm prefix, not `npx`: the services point at the installed files.

**Non-interactive:** `rex-bot setup --yes [--mode watched|full] [--webhook-url URL] [--webhook-key-file FILE] [--webhook-header NAME] [--no-services] [--no-serve] [--no-skills] [--no-rex-config] [--show-token]`. With `--yes`, nothing on Tailscale Serve is overwritten and the token is not shown.

## Grok Bot setup

`rex-bot grokbot` prints this with your URL filled in (`--show-token` fills in the token too):

1. **Tailscale plugin:** Grok Bot desktop → Connect apps → Your plugins → Tailscale → Authenticate (your personal tailnet).
2. **Connector:** ask Grok Bot in chat to add a custom MCP connector named `rex` with URL `https://<your-mac>.<tailnet>.ts.net/rex-bridge/mcp`, Streamable HTTP, header `Authorization: Bearer <token>` (static header, not OAuth).
3. **Routine:** create a routine with a **Webhook** trigger and the `rex` connector, paste the instructions `rex-bot grokbot` prints (they cover `agent_status`, `agent_message`, when to approve permission prompts, and never pasting secrets), then give its webhook to rex-bot:

   ```sh
   rex-bot config set webhook.url '<routine webhook url>'
   rex-bot config set webhook.key -            # reads the key from stdin; skip if there is none
   rex-bot config set webhook.header X-Key     # only if the key goes in a header other than Authorization
   rex-bot doctor --test-webhook
   ```

   `Authorization` keys are sent as `Bearer <key>`; any other header gets the raw key.

## Commands

| Command | Does |
|---|---|
| `rex-bot setup` | Install or repair everything (safe to re-run; keeps your mode and webhook) |
| `rex-bot doctor [--json] [--test-webhook]` | Check the whole chain; exits 1 on any ❌ |
| `rex-bot uninstall [--yes] [--purge] [--serve-off]` | Remove services, the init.lua block and the skill. Keeps `~/.config/rex-bot-bridge` unless `--purge`; asks before removing the Tailscale Serve mapping |
| `rex-bot grokbot [--show-token]` | Print the Grok Bot setup text again |
| `rex-bot config get\|set <key> [value]` | `mode`, `port`, `host`, `servePath`, `webhook.url`, `webhook.key`, `webhook.header` (secrets hidden unless `get --show`) |
| `rex-bot token [--rotate] [--show]` | Create or rotate the bearer token |
| `rex-bot watch add\|remove <session>` / `watch list` | Opt sessions in or out |
| `rex-bot say "message"` | From an agent: message the bot (always exits 0) |
| `rex-bot whoami` | Print this pane's `REX_SESSION` / `REX_BLOCK` |
| `rex-bot serve` / `rex-bot watch` | The two services (launchd runs them; fine by hand too) |
| `rex-bot notify` | Internal: POST the JSON on stdin to the webhook |

`rex-bot-bridge serve` and `rex-bot-bridge token` still work (v1 names).

## MCP tools

| Tool | Args | Does |
|---|---|---|
| `list_agents` | `session?` | Sessions → panes: ids, labels, foreground process, program status (`state`, `kind`, `app`, `msg`), `watched` |
| `read_pane` | `block_id`, `session_id?`, `lines=80` | Tail of the pane's screen and scrollback (untrusted text) |
| `send_message` | `block_id`, `session_id?`, `text`, `submit=true`, `require_idle=false` | Pastes text, then Enter |
| `send_keys` | `block_id`, `session_id?`, `keys[]` | e.g. `["escape"]`, `["ctrl+c"]`, `["1","enter"]` |
| `spawn_agent` | `agent`, `cwd`, `prompt?`, `session_id?` \| `new_session_label?`, `label?`, `command?`, `watch=true` | New tab in a session, or a new session |
| `wait_for_status` | `block_id`, `session_id?`, `states`, `timeout_s=120` | Polls program status |
| `close_pane` / `close_session` | ids | Close a pane / kill a session |
| `watch_session` / `unwatch_session` | `session_id` | Edit the opt-in list (`watch_session` only in full mode) |
| `list_watched`, `bridge_status` | — | Watched ids; mode, Rex version, watcher heartbeat |

Program status comes from OSC 7501, which Claude Code and Pi report natively. For other programs `status` is `null`; use `process.name`.

## Files

| Path | What |
|---|---|
| `~/.config/rex-bot-bridge/` | `token`, `config.json`, `watched` (opt-in list), `heartbeat`, `init-backups/` |
| `~/Library/LaunchAgents/com.rexbotbridge.{bridge,watch}.plist` | The services |
| `~/Library/Logs/rex-bot-bridge/` | `bridge.log`, `watch.log`, `notify.log` |
| `~/.local/state/rex-bot-bridge/audit.log` | Tool-call audit log |
| Rex `init.lua` | One block between `-- >>> rex-bot-bridge >>>` and `-- <<< rex-bot-bridge <<<` |

Upgrading from v1: `setup` imports your old opt-in list from `~/.config/rex/bot-watch/sessions` (and leaves the file there), offers `full` mode to keep v1 behaviour, and tells you to stop the old `com.rex.bot-*` services or hand-started `rex-bridge` / `bot-watch` sessions. If your `init.lua` defines `bot_watch_toggle` inline, remove that block by hand and re-run `setup`.

## Troubleshooting

Run `rex-bot doctor` first; every ❌ comes with a fix line.

- **The bot gets HTTP 502:** Tailscale reached your Mac but the bridge is down. Check `launchctl print gui/$(id -u)/com.rexbotbridge.bridge` and `~/Library/Logs/rex-bot-bridge/bridge.log`, then `rex-bot setup` to reinstall the service.
- **Doctor says the watcher heartbeat is old:** the watcher is down, so no status pushes. Check `watch.log` and `launchctl print gui/$(id -u)/com.rexbotbridge.watch`.
- **The routine never fires:** `rex-bot doctor --test-webhook` should report HTTP 200. Then check the session is watched (`rex-bot watch list`) and that its agent reports status (OSC 7501). `notify.log` shows every attempt's status code.
- **"refused: the bridge is in watched mode":** opt the session in (palette or `rex-bot watch add`), or `rex-bot config set mode full`.
- **The palette actions are missing:** `rex config check`, then `rex config reload`.

## Uninstall

```sh
rex-bot uninstall            # add --purge to delete ~/.config/rex-bot-bridge too
npm uninstall -g rex-bot-bridge
```

## Development

```sh
npm install
npm test                       # unit tests with a fake rex
npm run typecheck
npm run build
node scripts/e2e-sandbox.mjs   # real Rex, sandboxed HOME, no launchd or Tailscale changes
```

## License

MIT
