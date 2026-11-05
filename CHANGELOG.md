# Changelog

## 0.3.0 — 2026-11-05

Setup v3: no more circular order for new users, a Grok Bot guide, tsk-style help, and a curl installer.

- **`rex-bot setup` no longer asks for the webhook** (you only get it after creating the Grok Bot routine). It prints
  numbered sections (Checks, Settings, Rex palette, Services, Tailscale Serve, Agent skill), one ✅/⚠️/❌ line each
  with a `fix:` line, and ends with a **Next** block: the Grok Bot guide, `rex-bot setup webhook`, and
  `rex-bot doctor --test-webhook`. It no longer prints the Grok Bot text or offers to show the token.
- **`rex-bot setup rex | services | serve | skill`** re-run one part on its own.
- **`rex-bot setup webhook`** asks for the routine's webhook URL, key (hidden) and header name, saves them, and offers
  a test post with a fix hint for 401/404/timeouts. `--url`, `--key-file FILE|-`, `--header`, `--yes`, `--no-test`.
  Enter keeps a saved value, which is shown only as "set". `--webhook-*` on bare `setup` is now a usage error
  pointing here. A bare `Bearer` at the key prompt is re-asked instead of meaning "no key".
- **[docs/grok-bot.md](docs/grok-bot.md):** the Grok Bot guide (Tailscale plugin, connector, routine and its
  instructions, webhook, test, troubleshooting), written so the Grok Bot agent can follow the raw URL too.
  `rex-bot grokbot` now prints only the connector message and the guide's link.
- **Help:** `rex-bot --help` lists commands in groups; every command has `rex-bot help <command>` /
  `<command> --help` with usage, options, output, examples and exit codes. Unknown commands and options give one
  line plus a `--help` hint, exit 2. The README command table is generated from it (`npm run docs:commands`).
- **`install.sh`:** `curl -fsSL https://raw.githubusercontent.com/smarzban/rex-bot-bridge/main/install.sh | sh`
  checks macOS/Node/npm, installs with npm (registry, else GitHub; `REX_BOT_SOURCE`, `REX_BOT_VERSION`), never uses
  sudo, reports old → new version on upgrade, and offers to run `rex-bot setup`.
- **Fix: launchd re-install race.** `bootout` returns before launchd has unloaded the service, so the immediate
  `bootstrap` could fail ("Bootstrap failed: 5: Input/output error") and leave a service unloaded. Setup now waits
  until the label is gone (up to 10 s), retries bootstrap 3 times with backoff, and names the service that failed
  with launchctl's message and the exact `launchctl bootstrap` line.
- **Fix: `uninstall --purge` deleted the init.lua backup it had just made.** Backups now live next to init.lua in
  `~/.config/rex/rex-bot-backups/` and survive `--purge`; two backups in the same millisecond no longer overwrite. Setup and
  uninstall move 0.2.x backups out of `~/.config/rex-bot-bridge/init-backups/` first (never overwriting).
- `setup webhook` re-reads config.json before saving and writes only the `webhook.*` fields.
- `install.sh` copes with npm 11 redacting UUID-like path segments in `npm prefix -g` (`***`).
- doctor's fix lines are exact commands (`launchctl bootstrap gui/$(id -u) '<plist>'`, `launchctl kickstart -k …`,
  `rex-bot setup webhook`, `rex-bot setup rex|services|skill`).
- Packaging: `npm run build` keeps the exec bit on `dist/cli/*.js` (a linked `npm i -g <folder>` no longer says
  "permission denied" after a rebuild); `prepare` builds a checkout or git install. `install.sh` builds GitHub refs
  itself, because npm 11 prepares a *global* git dependency without its devDependencies. Fake test keys are
  allow-listed for gitleaks.

## 0.2.0 — 2026-11-04

One-command installer for other people (macOS).

- `rex-bot setup` installs everything: token, `~/.config/rex-bot-bridge/config.json`, two launchd services
  (`com.rexbotbridge.bridge`, `com.rexbotbridge.watch`), Tailscale Serve on `/rex-bridge`, Rex palette actions
  (one marked block in `init.lua`, checked with `rex config check` and rolled back on failure), and a `rex-bot`
  agent skill. It ends with copy-paste text for Grok Bot. `--yes` and `--no-*` flags make it scriptable.
- `rex-bot doctor [--json] [--test-webhook]` checks the whole chain with a fix line per problem.
- `rex-bot uninstall [--purge] [--serve-off]` reverts it.
- **Watched mode** (default for new installs): pane and session tools only work on sessions the human opted in;
  `watch_session` is refused. `full` keeps v1 behaviour. `rex-bot config set mode full|watched`.
- The watcher ships in the package (`lua/bot-watch.lua`) and posts through `rex-bot notify` (Node fetch,
  5 s timeout); it no longer needs a personal `agent-notify` script. `rex-bot say` uses the same path.
- State moved to `~/.config/rex-bot-bridge/` (`watched`, `heartbeat`, `config.json`, `token`). Setup imports the
  v1 opt-in list from `~/.config/rex/bot-watch/sessions` and leaves the old file in place.
- `rex-bot` gained `setup`, `doctor`, `uninstall`, `serve`, `watch`, `token`, `config`, `notify`, `grokbot`.
  `rex-bot-bridge serve|token` still work.
- Watched mode hardening: `spawn_agent` never (re-)adds an existing session (only a new one is auto-watched);
  `wait_for_status` rechecks access before every poll; the watcher rechecks the opt-in list before sending; the
  bridge never defaults to `full`.
- Setup never replaces a Tailscale Serve path that holds any other handler, or whose status it can't read,
  without an explicit yes (`--yes` leaves it alone). `init.lua` is also restored when `rex config check` times
  out or can't start.
- State files (`watched`, `heartbeat`) are created 0600. The palette actions show an alert with the result.
- MIT licence; package ready for npm (`files` whitelist, `engines`, `os`).

## 0.1.0

- MCP bridge (`list_agents`, `read_pane`, `send_message`, `send_keys`, `spawn_agent`, `wait_for_status`,
  `close_pane`, `close_session`, `watch_session`, `unwatch_session`, `list_watched`, `bridge_status`) and the
  `rex-bot say` / `whoami` CLI.
