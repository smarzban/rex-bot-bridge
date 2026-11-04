# Changelog

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
- MIT licence; package ready for npm (`files` whitelist, `engines`, `os`).

## 0.1.0

- MCP bridge (`list_agents`, `read_pane`, `send_message`, `send_keys`, `spawn_agent`, `wait_for_status`,
  `close_pane`, `close_session`, `watch_session`, `unwatch_session`, `list_watched`, `bridge_status`) and the
  `rex-bot say` / `whoami` CLI.
