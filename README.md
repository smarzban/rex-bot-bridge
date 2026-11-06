# rex-grokbot-bridge

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
| `watched` (default) | List every session. Read, type into, press keys in, wait on, and close **only panes you opted in**: a whole session (every pane in it) or a single pane. Close a session or spawn agents into it only when the session itself is watched; spawn into a new session (which is then watched). It cannot opt anything in itself. |
| `full` | All of the above in **every** Rex session. |

Opt in from Rex's command palette: **Bot: Watch / Unwatch This Session** (every pane in the session) or **Bot: Watch / Unwatch This Pane** (only the focused pane). An alert confirms it, and **Bot: List Watched** shows both kinds. Or use `rex-grokbot watch add <session-id|block-id>` (inside a pane, `rex-grokbot whoami` prints its `REX_SESSION` and `REX_BLOCK`; `rex ls --json` lists every session's id and label; `rex-grokbot watch list` checks).

What you watch is also what notifies the bot: status pushes come only from watched panes and panes in watched sessions, and an agent's `rex-grokbot say` is sent only from those (elsewhere it prints "not sent" and exits 0). Seeing a session in `list_agents` (labels, short status) is not being notified about it. Switch modes with `rex-grokbot config set mode watched|full` (takes effect on the next call, no restart).

Other protections:

- The bridge listens on `127.0.0.1` only. It reaches your tailnet through `tailscale serve` (tailnet only, never Funnel) on **its own HTTPS port**, `https://<mac>.<tailnet>.ts.net:8443`, not a path on port 443: other apps on the Mac can serve OAuth metadata at the 443 origin's `/.well-known/`, and an MCP client that sees our 401 would find it and try to sign in there.
- `/mcp` needs `Authorization: Bearer <token>` (constant-time compare). The token lives in `~/.config/rex-grokbot-bridge/token` (mode 600), is never logged, and is re-read per request; `rex-grokbot token --rotate` replaces it and restarts the bridge, so the old one stops working at once.
- Every tool call is logged to `~/.local/state/rex-grokbot-bridge/audit.log` (tool, truncated args, result). No token, no pane contents.
- The webhook URL and key are never printed or logged; `notify.log` records only HTTP status codes.
- `GET /healthz` is unauthenticated and returns only `{ok, rex_reachable, watcher_heartbeat_age_s}`.
- No OAuth: every `/.well-known/*` path is a JSON 404, and a missing or wrong token gets a plain `401` with `WWW-Authenticate: Bearer realm="rex-grokbot-bridge"` (no `resource_metadata`). The connector uses the static `Authorization` header.
- Pane text returned to the bot is marked untrusted, and the routine instructions tell it so.

## Prerequisites

- macOS with **Node 22+ and npm** (`brew install node`; `install.sh` checks both)
- **Rex**, running, with `rex` on your PATH (`command -v rex`)
- **Tailscale**, logged in on this Mac, with **HTTPS certificates enabled for the tailnet** (admin console → DNS → MagicDNS + HTTPS)
- **Grok Bot** desktop

## Quickstart

1. **Grok Bot's Tailscale plugin:** Grok Bot desktop → Connect apps → Your plugins → Tailscale → Authenticate. If Tailscale isn't under **Your plugins**, install it from **Connect apps** first. Log in to the **same tailnet as this Mac** (`tailscale status` shows which one), and make sure that tailnet has **MagicDNS** and **HTTPS certificates** on (Tailscale admin console → DNS).
2. **Install:**

   ```sh
   curl -fsSL https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/install.sh | sh
   ```

   Read the script first if you like: <https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/install.sh>. It checks macOS, Node and npm, installs the `rex-grokbot` CLI with npm (never sudo), and offers to run `rex-grokbot setup`. Re-run it to upgrade.
   Or with npm yourself: `npm i -g rex-grokbot-bridge` once it's on npm; until then from a checkout: `git clone https://github.com/smarzban/rex-grokbot-bridge && cd rex-grokbot-bridge && npm install && npm i -g .`
3. **Set up this Mac:** `rex-grokbot setup` (the installer offers to run it).
4. **Set up Grok Bot:** give your Grok Bot the guide's raw address, `https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/docs/grok-bot.md`, and say "set this up with me". [The guide](docs/grok-bot.md) is written for the bot; it walks you through your half and asks you, one at a time, for:
   - the output of `rex-grokbot url` (the connector address; not a secret);
   - the token: `rex-grokbot token | pbcopy`, then paste it **once, in a private 1:1 chat** with your own bot. It goes into the connector as a static `Authorization: Bearer <token>` header, never OAuth: if the app offers to sign in, decline. If the token ever lands anywhere else (a group chat, a doc, a screenshot), rotate it with `rex-grokbot token --rotate | pbcopy` and give the bot the new one;
   - then it creates the routine and shows you its webhook URL (and key, if any).
5. **Give the routine's webhook to this Mac:** `rex-grokbot setup webhook`
6. **Check everything:** `rex-grokbot doctor --test-webhook` (the bot replies "rex-grokbot-bridge webhook OK"), then [opt a session or pane in](#security-model-in-plain-words) and let an agent finish there.

Keep the Mac awake with Rex running while you do this.

### If the bot can't reach the Mac

| What the bot sees | Likely cause | Fix |
|---|---|---|
| The plugin can't be used / asks to log in | Tailscale plugin not authenticated | Redo step 1 |
| Name doesn't resolve, or timeout | Plugin on another tailnet, MagicDNS off, or the Mac asleep/offline | Match the tailnet (`tailscale status`), wake the Mac |
| TLS / certificate error | HTTPS certificates off for the tailnet | Turn on HTTPS (admin console → DNS), then `rex-grokbot setup serve` |
| HTTP 404 or connection refused | Tailscale Serve isn't mapping the bridge's port | `rex-grokbot setup serve` |
| An HTML page or another app answers | The URL is missing the bridge's port (`:8443` by default) | Use exactly what `rex-grokbot url` prints |
| HTTP 502 | Tailscale reached the Mac but the bridge isn't running | `rex-grokbot doctor` and follow its fix lines |

`rex-grokbot setup` asks one question on a first run (the mode) and a yes/no before `tailscale serve`, then prints numbered sections:

1. **Checks:** Node, Rex and the Rex server.
2. **Settings:** creates the token and `~/.config/rex-grokbot-bridge/` (700; files 600), sets the mode.
3. **Rex palette** (`setup rex`): adds the palette actions to Rex's `init.lua` as one marked block (backed up first, validated with `rex config check`, rolled back if the check fails).
4. **Services** (`setup services`): installs and starts the launchd services `com.rexgrokbotbridge.bridge` and `com.rexgrokbotbridge.watch`.
5. **Tailscale Serve** (`setup serve`): runs `tailscale serve --bg --https=8443 http://127.0.0.1:7400` (after asking), giving the bridge its own origin. If another app already has `/` on port 8443 it asks before replacing it (default no; `--yes` never replaces); if the port holds several paths or a TCP forward it leaves it alone. Either way you can pick another port with `rex-grokbot config set servePort <port>`. 8443 is the default (10000 is the other common choice); 443 isn't allowed. Those are also Funnel's ports (443/8443/10000), but the bridge never enables Funnel.
6. **Agent skill** (`setup skill`): installs a small `rex-grokbot` skill into `~/.claude/skills` and `~/.agents/skills` (if those exist) so agents know about `rex-grokbot say`.

Each line is ✅, ⚠️ or ❌, and every ⚠️/❌ has a `fix:` line. It ends with **Next**: the Grok Bot guide, `rex-grokbot setup webhook`, and `rex-grokbot doctor --test-webhook`. Each part re-runs on its own, e.g. `rex-grokbot setup services`.

Install globally, not with `npx`: the services point at the installed files.

**Non-interactive:** `rex-grokbot setup --yes [--mode watched|full] [--no-rex-config] [--no-services] [--no-serve] [--no-skills]`, then `rex-grokbot setup webhook --url URL --key-file FILE --yes`. With `--yes`, nothing on Tailscale Serve is overwritten.

## Grok Bot setup

**[docs/grok-bot.md](docs/grok-bot.md)** is addressed to the bot: the steps it walks you through, the connector, the routine's instructions, the `rex-usage` skill it saves, and troubleshooting. Your half is Quickstart above. Webhook keys for `Authorization` are sent as `Bearer <key>`; any other header gets the raw key.

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
| `rex-grokbot url` | print the Grok Bot connector URL (https://&lt;mac&gt;.&lt;tailnet&gt;.ts.net:8443/mcp) (`rex-grokbot help url`) |
| `rex-grokbot token [--rotate]` | print the bearer token for the connector's Authorization header (--rotate: new one) (`rex-grokbot help token`) |
| `rex-grokbot watch add <session\|pane>`<br>`rex-grokbot watch remove <session\|pane>`<br>`rex-grokbot watch list`<br>`rex-grokbot watch` | opt a Rex session or a single pane in or out of the bot; bare: run the watcher (`rex-grokbot help watch`) |
| `rex-grokbot say "message"` | from an agent: send a message to the coordinator bot (`rex-grokbot help say`) |
| `rex-grokbot whoami` | print this pane's REX_SESSION and REX_BLOCK (`rex-grokbot help whoami`) |
| `rex-grokbot serve` | run the MCP bridge (127.0.0.1:7400 by default) (`rex-grokbot help serve`) |
| `rex-grokbot notify < event.json` | internal: POST the JSON on stdin to the webhook (`rex-grokbot help notify`) |
<!-- commands:end -->

## MCP tools

| Tool | Args | Does |
|---|---|---|
| `list_agents` | `session?` | Sessions → panes: ids, labels, foreground process, program status (`state`, `kind`, `app`, `msg`), `watched` (session: on the list; pane: the pane or its session is) |
| `read_pane` | `block_id`, `session_id?`, `lines=80` | Tail of the pane's screen and scrollback (untrusted text) |
| `send_message` | `block_id`, `session_id?`, `text`, `submit=true`, `require_idle=false` | Pastes text, then Enter |
| `send_keys` | `block_id`, `session_id?`, `keys[]` | e.g. `["escape"]`, `["ctrl+c"]`, `["1","enter"]` |
| `spawn_agent` | `agent`, `cwd`, `prompt?`, `session_id?` \| `new_session_label?`, `label?`, `command?`, `watch=true` | New tab in a session, or a new session (`watch` applies in full mode; in watched mode only a new session is added) |
| `wait_for_status` | `block_id`, `session_id?`, `states`, `timeout_s=120` | Polls program status |
| `close_pane` / `close_session` | ids | Close a pane / kill a session (and drop them from the opt-in list) |
| `watch_session` / `unwatch_session` | `session_id` | Edit the opt-in list: a whole session (`watch_session` only in full mode) |
| `watch_pane` / `unwatch_pane` | `block_id` | Edit the opt-in list: one pane (`watch_pane` only in full mode) |
| `list_watched`, `bridge_status` | — | Watched sessions and panes; mode, Rex version, watcher heartbeat, watched counts |

Program status comes from OSC 7501, which Claude Code and Pi report natively. For other programs `status` is `null`; use `process.name`.

## Files

| Path | What |
|---|---|
| `~/.config/rex-grokbot-bridge/` | `token`, `config.json`, `watched` (opt-in list: `session:…` and `block:…` lines), `heartbeat` |
| `~/.config/rex/rex-grokbot-backups/` | `init.lua` backups (next to `init.lua`; kept by `uninstall --purge`) |
| `~/Library/LaunchAgents/com.rexgrokbotbridge.{bridge,watch}.plist` | The services |
| `~/Library/Logs/rex-grokbot-bridge/` | `bridge.log`, `watch.log`, `notify.log` |
| `~/.local/state/rex-grokbot-bridge/audit.log` | Tool-call audit log |
| Rex `init.lua` | One block between `-- >>> rex-grokbot-bridge >>>` and `-- <<< rex-grokbot-bridge <<<` |

## Troubleshooting

Run `rex-grokbot doctor` first; every ❌ comes with a fix line.

- **Grok Bot says "authorization failed" or tries to sign in:** the connector was saved as OAuth, or its URL isn't exactly what `rex-grokbot url` prints. Delete it and re-add it with the URL from `rex-grokbot url` (`…:8443/mcp`) and the static `Authorization: Bearer <token>` header ([guide](docs/grok-bot.md#if-something-breaks)).
- **The bot gets HTTP 502:** Tailscale reached your Mac but the bridge is down. Check `launchctl print gui/$(id -u)/com.rexgrokbotbridge.bridge` and `~/Library/Logs/rex-grokbot-bridge/bridge.log`, then `launchctl kickstart -k gui/$(id -u)/com.rexgrokbotbridge.bridge` or `rex-grokbot setup services`.
- **Doctor says the watcher heartbeat is old:** the watcher is down, so no status pushes. Check `watch.log` and `launchctl print gui/$(id -u)/com.rexgrokbotbridge.watch`.
- **The routine never fires:** `rex-grokbot doctor --test-webhook` should report HTTP 200. Then check the pane or its session is watched (`rex-grokbot watch list`) and that its agent reports status (OSC 7501). `notify.log` shows every attempt's status code.
- **"refused: the bridge is in watched mode":** opt the pane or its session in (palette or `rex-grokbot watch add`; see [opt-in](#security-model-in-plain-words)). Closing a session or spawning into it needs the session itself watched, not just a pane.
- **An agent's `rex-grokbot say` prints "not sent":** its pane isn't watched (nor its session), or it isn't running in Rex. Watch the pane or session. Don't switch to `full` mode to fix this: it opens every session.
- **The palette actions are missing:** `rex config check`, then `rex config reload`.

## Uninstall

```sh
rex-grokbot uninstall [--purge] [--serve-off]   # --purge also deletes ~/.config/rex-grokbot-bridge; --serve-off removes our Tailscale Serve mappings
npm rm -g rex-grokbot-bridge
```

`init.lua` backups stay in `~/.config/rex/rex-grokbot-backups/`.

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
