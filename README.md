# rex-bot-bridge

Let a coordinator bot (Grok Bot, over Tailscale) **see and drive the coding agents running in your [Rex](https://www.superlogical.com/rex/docs) terminals**, and get pinged when they finish or get stuck.

- **Bot → agents:** an MCP server the bot connects to. It can list sessions and panes, read a pane's screen, type into it, press keys, spawn new agents (Claude Code, Codex, Pi, Grok Build, shells), wait for them, and close them.
- **Agents → bot:** a watcher that POSTs to the bot's webhook when an agent's status turns `done`, `blocked`, or `error`, and a `rex-grokbot say "…"` command agents use to send it a message.

```
                 ┌──────────────────────────── your Mac ─────────────────────────────┐
 Grok Bot ──MCP──▶ tailscale serve :8443 ─▶ rex-grokbot serve (127.0.0.1:7400) ─▶ rex ─▶ Rex panes
 (tailnet)       │                                                             │      │
    ▲            │        rex-grokbot watch (lua/bot-watch.lua) ◀── status (OSC 7501) ─┘      │
    └─ webhook ──┼────────  rex-grokbot notify  ◀──  rex-grokbot say "…" (from an agent)          │
                 └───────────────────────────────────────────────────────────────────┘
```

macOS only. Both directions live in this one package; `rex-grokbot setup` installs them as two launchd services.

## Security model, in plain words

**Anyone who has the bearer token and can reach the URL can run commands on your Mac as you.** `spawn_agent` can start any program and `send_message` types into shells. Keep that in mind when you choose a mode:

| Mode | What the bot can do |
|---|---|
| `watched` (default) | List every session. Read, type into, press keys in, wait on, and close panes **only in sessions you opted in**. Spawn agents into a watched session or a new session (which is then watched). It cannot opt sessions in itself. |
| `full` | All of the above in **every** Rex session. |

Opt a session in from Rex's command palette (**Bot: Watch / Unwatch This Session**; an alert confirms it, and **Bot: List Watched Sessions** shows the list) or with `rex-grokbot watch add <session-id>`. Switch modes with `rex-grokbot config set mode watched|full` (takes effect on the next call, no restart).

Other protections:

- The bridge listens on `127.0.0.1` only. It reaches your tailnet through `tailscale serve` (tailnet only, never Funnel) on **its own HTTPS port**, `https://<mac>.<tailnet>.ts.net:8443`, not a path on port 443: other apps on the Mac can serve OAuth metadata at the 443 origin's `/.well-known/`, and an MCP client that sees our 401 would find it and try to sign in there.
- `/mcp` needs `Authorization: Bearer <token>` (constant-time compare). The token lives in `~/.config/rex-bot-bridge/token` (mode 600), is never logged, and is re-read per request; `rex-grokbot token --rotate` replaces it and restarts the bridge, so the old one stops working at once.
- Every tool call is logged to `~/.local/state/rex-bot-bridge/audit.log` (tool, truncated args, result). No token, no pane contents.
- The webhook URL and key are never printed or logged; `notify.log` records only HTTP status codes.
- `GET /healthz` is unauthenticated and returns only `{ok, rex_reachable, watcher_heartbeat_age_s}`.
- No OAuth: every `/.well-known/*` path is a JSON 404, and a missing or wrong token gets a plain `401` with `WWW-Authenticate: Bearer realm="rex-bot-bridge"` (no `resource_metadata`). The connector uses the static `Authorization` header.
- Pane text returned to the bot is marked untrusted, and the routine instructions tell it so.

## Prerequisites

- macOS with **Node 22+** (`brew install node`)
- **Rex**, running, with `rex` on your PATH (`command -v rex`)
- **Tailscale**, logged in on this Mac, with **HTTPS certificates enabled for the tailnet** (admin console → DNS → MagicDNS + HTTPS)
- **Grok Bot** desktop

## Quickstart

1. **Grok Bot's Tailscale plugin:** Grok Bot desktop → Connect apps → Your plugins → Tailscale → Authenticate (same tailnet as this Mac).
2. **Install:**

   ```sh
   curl -fsSL https://raw.githubusercontent.com/smarzban/rex-bot-bridge/main/install.sh | sh
   ```

   Read the script first if you like: <https://raw.githubusercontent.com/smarzban/rex-bot-bridge/main/install.sh>. It checks macOS, Node and npm, installs the `rex-grokbot` CLI with npm (never sudo), and offers to run `rex-grokbot setup`. Re-run it to upgrade.
   Or with npm yourself: `npm i -g rex-bot-bridge` once it's on npm; until then from a checkout: `git clone https://github.com/smarzban/rex-bot-bridge && cd rex-bot-bridge && npm install && npm i -g .`
3. **Set up this Mac:** `rex-grokbot setup` (the installer offers to run it).
4. **Set up Grok Bot:** follow [docs/grok-bot.md](docs/grok-bot.md): a reachability check, the connector (`rex-grokbot url` for the address, `rex-grokbot token | pbcopy` for the credential) and the routine. You can also give your Grok Bot that page's raw address: `https://raw.githubusercontent.com/smarzban/rex-bot-bridge/main/docs/grok-bot.md`.
5. **Give the routine's webhook to this Mac:** `rex-grokbot setup webhook`
6. **Check everything:** `rex-grokbot doctor --test-webhook`

`rex-grokbot setup` asks one question on a first run (the mode) and a yes/no before `tailscale serve`, then prints numbered sections:

1. **Checks:** Node, Rex and the Rex server.
2. **Settings:** creates the token and `~/.config/rex-bot-bridge/` (700; files 600), sets the mode.
3. **Rex palette** (`setup rex`): adds the palette actions to Rex's `init.lua` as one marked block (backed up first, validated with `rex config check`, rolled back if the check fails).
4. **Services** (`setup services`): installs and starts the launchd services `com.rexbotbridge.bridge` and `com.rexbotbridge.watch`.
5. **Tailscale Serve** (`setup serve`): runs `tailscale serve --bg --https=8443 http://127.0.0.1:7400` (after asking), giving the bridge its own origin. If port 8443 is already used by something else it asks before replacing it (default no; `--yes` never replaces; or pick another with `rex-grokbot config set servePort <port>`). Tailscale Serve takes any HTTPS port; 8443 is the default and 443 isn't allowed. Upgrading from 0.4: once the new port answers, it offers to remove the old `/rex-bridge` path on port 443 (only that path, only if it points at this bridge), and tells you to update the connector URL.
6. **Agent skill** (`setup skill`): installs a small `rex-grokbot` skill into `~/.claude/skills` and `~/.agents/skills` (if those exist) so agents know about `rex-grokbot say`.

Each line is ✅, ⚠️ or ❌, and every ⚠️/❌ has a `fix:` line. It ends with **Next**: the Grok Bot guide, `rex-grokbot setup webhook`, and `rex-grokbot doctor --test-webhook`. Each part re-runs on its own, e.g. `rex-grokbot setup services`.

Install globally, not with `npx`: the services point at the installed files.

**Non-interactive:** `rex-grokbot setup --yes [--mode watched|full] [--no-rex-config] [--no-services] [--no-serve] [--no-skills]`, then `rex-grokbot setup webhook --url URL --key-file FILE --yes`. With `--yes`, nothing on Tailscale Serve is overwritten (it does remove our own old `/rex-bridge` path once the new port answers).

## Grok Bot setup

See **[docs/grok-bot.md](docs/grok-bot.md)**: the Tailscale plugin, who does what, a reachability check, the `rex` connector (endpoint from `rex-grokbot url`, credential from `rex-grokbot token | pbcopy`, entered separately), the routine and its instructions, opting sessions in, the webhook, and troubleshooting. Webhook keys for `Authorization` are sent as `Bearer <key>`; any other header gets the raw key.

## Commands

Run `rex-grokbot --help`, or `rex-grokbot help <command>` / `rex-grokbot <command> --help` for usage, options, examples and exit codes. This table is generated from that help text (`npm run docs:commands`):

<!-- commands:start (generated by npm run docs:commands; edit src/cli/help.ts) -->
| Command | Does |
|---|---|
| `rex-grokbot setup [--yes] [--mode watched\|full] [--no-rex-config] [--no-services] [--no-serve] [--no-skills]`<br>`rex-grokbot setup rex \| services \| serve \| skill [--yes]`<br>`rex-grokbot setup webhook [--url URL] [--key-file FILE\|-] [--header NAME] [--yes] [--no-test]` | install or repair everything (or one part); setup webhook adds the routine's webhook (`rex-grokbot help setup`) |
| `rex-grokbot setup webhook [--url URL] [--key-file FILE\|-] [--header NAME] [--yes] [--no-test]` | save the Grok Bot routine's webhook (URL, key, header) and send a test (`rex-grokbot help setup webhook`) |
| `rex-grokbot doctor [--json] [--test-webhook]` | check the whole chain; every problem comes with a fix line (`rex-grokbot help doctor`) |
| `rex-grokbot uninstall [--yes] [--purge] [--serve-off]` | remove the services, palette actions and skill (`rex-grokbot help uninstall`) |
| `rex-grokbot config get <key> [--show]`<br>`rex-grokbot config set <key> <value>` | read or change one setting in config.json (`rex-grokbot help config`) |
| `rex-grokbot url` | print the Grok Bot connector URL (https://<mac>.<tailnet>.ts.net:8443/mcp) (`rex-grokbot help url`) |
| `rex-grokbot token [--rotate]` | print the bearer token for the connector's Authorization header (--rotate: new one) (`rex-grokbot help token`) |
| `rex-grokbot watch add <session>`<br>`rex-grokbot watch remove <session>`<br>`rex-grokbot watch list`<br>`rex-grokbot watch` | opt a Rex session in or out of the bot (watched mode); bare: run the watcher (`rex-grokbot help watch`) |
| `rex-grokbot say "message"` | from an agent: send a message to the coordinator bot (`rex-grokbot help say`) |
| `rex-grokbot whoami` | print this pane's REX_SESSION and REX_BLOCK (`rex-grokbot help whoami`) |
| `rex-grokbot serve` | run the MCP bridge (127.0.0.1:7400 by default) (`rex-grokbot help serve`) |
| `rex-grokbot notify < event.json` | internal: POST the JSON on stdin to the webhook (`rex-grokbot help notify`) |
<!-- commands:end -->

The command was called `rex-bot` before 0.4.0 (with a `rex-bot-bridge` alias); both are gone. The npm package is still `rex-bot-bridge`.

## MCP tools

| Tool | Args | Does |
|---|---|---|
| `list_agents` | `session?` | Sessions → panes: ids, labels, foreground process, program status (`state`, `kind`, `app`, `msg`), `watched` |
| `read_pane` | `block_id`, `session_id?`, `lines=80` | Tail of the pane's screen and scrollback (untrusted text) |
| `send_message` | `block_id`, `session_id?`, `text`, `submit=true`, `require_idle=false` | Pastes text, then Enter |
| `send_keys` | `block_id`, `session_id?`, `keys[]` | e.g. `["escape"]`, `["ctrl+c"]`, `["1","enter"]` |
| `spawn_agent` | `agent`, `cwd`, `prompt?`, `session_id?` \| `new_session_label?`, `label?`, `command?`, `watch=true` | New tab in a session, or a new session (`watch` applies in full mode; in watched mode only a new session is added) |
| `wait_for_status` | `block_id`, `session_id?`, `states`, `timeout_s=120` | Polls program status |
| `close_pane` / `close_session` | ids | Close a pane / kill a session |
| `watch_session` / `unwatch_session` | `session_id` | Edit the opt-in list (`watch_session` only in full mode) |
| `list_watched`, `bridge_status` | — | Watched ids; mode, Rex version, watcher heartbeat |

Program status comes from OSC 7501, which Claude Code and Pi report natively. For other programs `status` is `null`; use `process.name`.

## Files

| Path | What |
|---|---|
| `~/.config/rex-bot-bridge/` | `token`, `config.json`, `watched` (opt-in list), `heartbeat` |
| `~/.config/rex/rex-bot-backups/` | `init.lua` backups (next to `init.lua`; kept by `uninstall --purge`) |
| `~/Library/LaunchAgents/com.rexbotbridge.{bridge,watch}.plist` | The services |
| `~/Library/Logs/rex-bot-bridge/` | `bridge.log`, `watch.log`, `notify.log` |
| `~/.local/state/rex-bot-bridge/audit.log` | Tool-call audit log |
| Rex `init.lua` | One block between `-- >>> rex-bot-bridge >>>` and `-- <<< rex-bot-bridge <<<` |

Upgrading from v1: `setup` imports your old opt-in list from `~/.config/rex/bot-watch/sessions` (and leaves the file there), offers `full` mode to keep v1 behaviour, and tells you to stop the old `com.rex.bot-*` services or hand-started `rex-bridge` / `bot-watch` sessions. If your `init.lua` defines `bot_watch_toggle` inline, remove that block by hand and run `rex-grokbot setup rex`.

## Troubleshooting

Run `rex-grokbot doctor` first; every ❌ comes with a fix line.

- **Grok Bot says "authorization failed" or tries to sign in:** the connector was saved as OAuth, or its URL is the old `…/rex-bridge/mcp` on port 443. Delete it and re-add it with the URL from `rex-grokbot url` (`…:8443/mcp`) and the static `Authorization: Bearer <token>` header ([guide](docs/grok-bot.md#troubleshooting)).
- **The bot gets HTTP 502:** Tailscale reached your Mac but the bridge is down. Check `launchctl print gui/$(id -u)/com.rexbotbridge.bridge` and `~/Library/Logs/rex-bot-bridge/bridge.log`, then `launchctl kickstart -k gui/$(id -u)/com.rexbotbridge.bridge` or `rex-grokbot setup services`.
- **Doctor says the watcher heartbeat is old:** the watcher is down, so no status pushes. Check `watch.log` and `launchctl print gui/$(id -u)/com.rexbotbridge.watch`.
- **The routine never fires:** `rex-grokbot doctor --test-webhook` should report HTTP 200. Then check the session is watched (`rex-grokbot watch list`) and that its agent reports status (OSC 7501). `notify.log` shows every attempt's status code.
- **"refused: the bridge is in watched mode":** opt the session in (palette or `rex-grokbot watch add`; see [Session discovery](docs/grok-bot.md#session-discovery-opting-a-session-in)). Don't switch to `full` mode to fix this: it opens every session.
- **The palette actions are missing:** `rex config check`, then `rex config reload`.

## Uninstall

```sh
rex-grokbot uninstall [--purge] [--serve-off]   # --purge also deletes ~/.config/rex-bot-bridge; --serve-off removes our Tailscale Serve mappings
npm rm -g rex-bot-bridge
```

`init.lua` backups stay in `~/.config/rex/rex-bot-backups/`.

## Development

```sh
npm install
npm test                       # unit tests with a fake rex
npm run typecheck
npm run build
node scripts/e2e-sandbox.mjs   # real Rex, sandboxed HOME, no launchd or Tailscale changes
npm run docs:commands          # regenerate the README command table from --help
```

## License

MIT
