# Changelog

## 0.7.2 — 2026-11-06

First release on npm: `npm i -g rex-grokbot-bridge` now works alongside the curl installer (which installs from
npm when the package is published). Docs and repo baseline only; no behaviour changes.

- **README is a front door:** what it is, highlights, how it works, a short "Is this safe?", requirements,
  quickstart and routed links. The reference material moved, unchanged in substance, into `docs/`:
  `docs/security.md` (modes, sharing, what notifies the bot, protections), `docs/setup.md` (install paths, what
  setup does, Tailscale Serve port, non-interactive flags, upgrading, uninstall), `docs/reference.md` (commands,
  MCP tools, settings, files) and `docs/troubleshooting.md`.
- **The generated command table lives in `docs/reference.md`** (`npm run docs:commands`, now
  `scripts/gen-reference-commands.ts`).
- **New:** `llms.txt`, `SECURITY.md` (private vulnerability reporting), `CONTRIBUTING.md`, `AGENTS.md`, issue and
  PR templates, CODEOWNERS, `.editorconfig`, `.gitattributes`, and CI (typecheck, test, build on macOS, Node 22).
- **Tests:** every relative link and anchor in the published Markdown resolves; the bare-placeholder check covers
  every doc.
- **The MCP server reports package.json's version** instead of a hard-coded copy (a test keeps them equal).
- **Docs accuracy:** the front door and `llms.txt` now say that in `shared` mode the bot can also start new
  sessions (running any command), which are then shared; and that changing the bridge's `port` also needs
  `rex-grokbot setup serve` (also in `rex-grokbot help config`).
- package.json description and keywords match the README; the npm package also ships `SECURITY.md` and
  `CONTRIBUTING.md`.

## 0.7.1 — 2026-11-06

- **Share list: a cross-process lock.** The bridge, the CLI (`rex-grokbot share add|remove`) and the Rex palette
  (Bot: Share / Unshare …) all edit `~/.config/rex-grokbot-bridge/shared`; two of them at the same moment could
  lose one edit. Every write now holds `shared.lock` (a directory, made atomically by `mkdir`) for its whole
  read/modify/write. A writer waits up to ~3s, then fails with "share list is locked by another writer; try again"
  and the lock path, leaving the file alone. A lock older than 10s (a crashed writer) is removed, but only after
  re-checking it under a short break-lock (`shared.lock.break`), so two writers that both saw it stale can't
  remove each other's fresh lock. Readers (the
  watcher, bridge gating, `say`) don't lock; the rename keeps reads atomic.
- **Palette writes use a unique temp file** instead of a fixed `shared.tmp`, still 0600 before anything is
  written.
- **`rex-grokbot setup` always reloads the Rex config** when the palette block is in place, also when the block
  is unchanged. Seen live upgrading 0.6.0 → 0.7.0: the block didn't change (it loads the package's Lua, whose
  content did), so there was no reload and the new palette actions didn't load. Setup then notes: if the palette
  doesn't show the Bot: actions, quit and reopen the Rex app (sessions keep running). A sandbox HOME still never
  reloads the real Rex. The README says the same in Quickstart.

## 0.7.0 — 2026-11-06

What the bot may see and drive is now **shared** with it, a whole session or a single pane, and
`rex-grokbot say` respects that.

Seen live: the person shared only the coordinator's session, and the bot was notified about another agent that
was a pane in a different window of that same session (a shared session covers every pane in it). And any agent
with the skill could message the bot with `rex-grokbot say` from a session that wasn't shared.

- **Renamed: "watch" (the bot's powers) is now "share".** No aliases, no migration (there are no installs yet):
  modes `watched`/`full` → `shared` (default)/`all`; palette **Bot: Watch / Unwatch This Session** →
  **Bot: Share / Unshare This Session**; CLI `rex-grokbot watch add|remove|list` → `rex-grokbot share
  add|remove|list`; tools `watch_session`/`unwatch_session`/`list_watched` → `share_session`/`unshare_session`/
  `list_shared`; `spawn_agent`'s `watch` → `share`; the list file `~/.config/rex-grokbot-bridge/watched` →
  `…/shared`; `bridge_status`/`list_agents` fields `watched*` → `shared*`. The status watcher keeps its name
  (`rex-grokbot watch`, `lua/bot-watch.lua`, `com.rexgrokbotbridge.watch`, heartbeat): it watches Rex for status
  changes, a different thing; bare `rex-grokbot watch` runs it, and `rex-grokbot watch add` is a usage error.
- **Pane-level sharing.** The `shared` file holds `session:<uuid>` and/or `block:<uuid>` lines; any other token is
  ignored. A shared session covers every pane in it; a shared pane covers only that pane. One parser,
  `lua/sharelist.lua`, is used by the watcher and the palette and kept in step with `src/share.ts` (a test runs
  both on the same inputs).
- **Watcher:** notifies for a status event when its pane or its session is shared (also rechecked after the
  debounce).
- **Bridge gating (shared mode):** `read_pane`, `send_message`, `send_keys`, `close_pane` and `wait_for_status`
  are allowed when the pane or its session is shared. `close_session` and `spawn_agent` into an existing session
  need the session itself shared; a shared pane is not enough. Refusals read "pane/session … isn't shared with
  the bot; the person can share it from the Rex palette (Bot: Share / Unshare This Pane, or This Session) or
  `rex-grokbot share add …`" with the real id. New tools `share_pane` (refused in shared mode, like
  `share_session`) and `unshare_pane`. `list_shared` returns `shared_file`, `sessions` and `panes`; `list_agents`
  marks each pane's `shared`; `bridge_status` adds `shared_sessions`/`shared_panes`. `close_pane`/`close_session`
  drop their entries from the list.
- **CLI:** `rex-grokbot share add|remove` take a session or block id; `share list` prints the kind, id and label
  (from a running Rex server only; it never starts one).
- **Palette:** **Bot: Share / Unshare This Session**, new **Bot: Share / Unshare This Pane** (the focused pane,
  same alert feedback) and **Bot: List Shared** (both kinds).
- **`rex-grokbot say`** sends only when `REX_BLOCK` or its `REX_SESSION` is shared. Otherwise (or outside Rex)
  it prints one "not sent: this pane isn't shared with the bot …" line to stderr and exits 0, as it now also does
  for an empty message (was exit 2). The agent skill says so.
- **Grok Bot guide:** the connector is named `Rex`; the routine prompt handles `kind: auth` (tell the owner what
  is needed, never paste credentials), replies to every `doctor_test` (never a duplicate), is written as intent
  rather than tool names, and sends results to the owner in that chat; steps 2 and 3 share one
  `rex-grokbot url`; reachability is a Tailscale host:port check followed by an HTTP GET of healthz; Node 22+ and
  npm are listed as prerequisites; share scope (session vs pane, listing is not notification) and both ways to
  share; `rex-usage` covers pane vs session sharing and `say` gating.
- **Docs render on GitHub:** no bare `<…>` placeholders in prose (the README command table escapes them); a test
  checks README, the guide, the skill and the changelog.

## 0.6.0 — 2026-11-06

The project is now **rex-grokbot-bridge**, and the Grok Bot guide is written for the bot. There are no existing
installs to carry forward, so the rename is complete and the old upgrade paths are gone.

- **Rename.** The GitHub repo is `smarzban/rex-grokbot-bridge` and the npm package is `rex-grokbot-bridge` (it was
  `rex-bot-bridge`). Every GitHub/raw/codeload URL, the guide links, the MCP server name, the `WWW-Authenticate`
  realm, help and output use the new name. The doctor test reply is now "rex-grokbot-bridge webhook OK". The CLI is
  still `rex-grokbot`.
- **Internals renamed too, with no migration:** `~/.config/rex-grokbot-bridge`, `~/Library/Logs/rex-grokbot-bridge`,
  `~/.local/state/rex-grokbot-bridge`, `~/.config/rex/rex-grokbot-backups`, launchd labels
  `com.rexgrokbotbridge.{bridge,watch}`, the `init.lua` markers `-- >>> rex-grokbot-bridge >>>`, the skill marker
  `installed-by: rex-grokbot-bridge`, `lua/rex-grokbot-actions.lua`, and env vars `REX_GROKBOT_DIR`,
  `REX_GROKBOT_LOG_DIR`, `REX_GROKBOT_NODE`, `REX_GROKBOT_CLI`, `REX_GROKBOT_SOURCE`, `REX_GROKBOT_VERSION`.
- **Removed backward-compat code:** the v1 opt-in list import (`~/.config/rex/bot-watch/sessions`, `migratedV1At`),
  v1 launchd label and hand-started session warnings, v1 inline palette detection, the 0.2.x `init-backups`
  move, removal of the pre-0.4 `rex-bot` skill, and the ≤ 0.4 `/rex-bridge`-on-443 migration in setup, doctor
  and uninstall (with the `servePath` setting). Their tests went with them.
- **Bot-first guide.** `docs/grok-bot.md` is now the page Grok Bot follows (based on the bot's own rewrite): done
  criteria, who does what, nine steps, the routine prompt (reads the pane with `read_pane` on `rex_block`, reports
  `done` events briefly, stays quiet only for duplicates), a `rex-usage` skill for chat turns, and troubleshooting
  for OAuth sign-in, HTTP 502 and reachability. Fixed against the code: palette action **Bot: Watch / Unwatch This
  Session**, `spawn_agent`'s `watch` (ignored in watched mode), `watch_session` refused in watched mode.
- **README Quickstart** carries the person's half: the Tailscale plugin details, what the bot will ask for (URL,
  token pasted once in a private chat, static header, rotation), and an "If the bot can't reach the Mac" table.

## 0.5.0 — 2026-11-05

The bridge gets its own HTTPS origin on the tailnet, so another app's OAuth metadata can't hijack the connector.

Seen live: Grok Bot showed "rex authorization failed" while the bridge itself answered fine. Port 443 on the Mac
belonged to another app, which serves OAuth metadata at `https://<mac>/.well-known/oauth-authorization-server`.
An MCP client that gets our 401 runs RFC 9728 / RFC 8414 discovery at the origin root, found that app's auth server
and tried to sign in there. Sharing an origin was the root cause.

- **Own port.** `rex-grokbot setup serve` now runs `tailscale serve --bg --https=8443 http://127.0.0.1:7400` (the
  whole port, no `--set-path`). The connector URL is `https://<mac>.<tailnet>.ts.net:8443/mcp`; healthz is
  `…:8443/healthz`. New setting `servePort` (default 8443; 1-65535, not 443): `rex-grokbot config set servePort
  <port>`. 8443 is the default (10000 is the other common choice); these are also Funnel's ports (443/8443/10000),
  but the bridge never enables Funnel.
- **A port already in use is never replaced without asking.** Another app at `/` on the port: asks, default no,
  `--yes` never replaces; an explicit yes replaces only `/`. Several paths, a TCP forward or plain HTTP on the
  port: not offered at all; the fix line says to pick another `servePort`.
- **Migration from 0.4.** If our old `/rex-bridge` path on port 443 is still there (and proxies to this bridge),
  setup offers (default yes) to remove it once `https://<mac>:8443/healthz` answers, and says to update the
  connector URL. Only that path is removed (`tailscale serve --https=443 --set-path /rex-bridge off`); `/` and
  other paths are never touched, nor a `/rex-bridge` that points elsewhere. If the new origin doesn't answer yet,
  the old path is kept and the off command is printed. `servePath` in an old `config.json` is read only for this
  and is no longer a settable key.
- **No OAuth, ever.** The bridge answers a JSON 404 to every `/.well-known/*` path (checked before the `/mcp`
  suffix match: `/.well-known/oauth-protected-resource/mcp` used to get a 401). A missing or wrong token still
  gets `401` with `WWW-Authenticate: Bearer realm="rex-bot-bridge"` and no `resource_metadata`.
- **`url`, `doctor`, `uninstall`, help, README and the guide** use the new origin. Doctor checks the port mapping,
  the tailnet healthz, a new `oauth_discovery` check (`…:8443/.well-known/oauth-authorization-server` must be
  404), and warns (`serve_legacy`) with the exact off command when our old `/rex-bridge` mapping is still on 443.
  `uninstall` removes our port mapping and our legacy path (asked; with `--yes` only with `--serve-off`).
- **Guide:** the connector's auth is none / custom headers with the static `Authorization: Bearer <token>`, never
  OAuth; a troubleshooting entry for "authorization failed" / a sign-in prompt (delete the connector and re-add it
  with the header and the `:8443` URL); the reachability check uses `…:8443/healthz`.

Upgrading: re-run `rex-grokbot setup` (or `rex-grokbot setup serve`), then update the `rex` connector in Grok Bot
to the URL `rex-grokbot url` prints.

## 0.4.0 — 2026-11-05

The command is now `rex-grokbot`; the connector's endpoint and credential are printed separately; the Grok Bot
guide is rewritten around who does what and what the bot may trust.

- **Renamed the CLI to `rex-grokbot`.** One bin, `rex-grokbot` (`dist/cli/rex-grokbot.js`); the `rex-bot` and
  `rex-bot-bridge` bins are gone (no aliases: nothing was published yet). Help, setup/doctor/uninstall output and
  fix lines, error prefixes, the launchd plists, the Lua watcher and palette actions, `install.sh`, README and
  docs all use the new name. The npm package and repo stay `rex-bot-bridge`, as do `~/.config/rex-bot-bridge`,
  the log/state dirs, the `com.rexbotbridge.*` labels, the init.lua markers and the `/rex-bridge` Serve path.
  Re-run `rex-grokbot setup` after upgrading so the services point at the new entry point.
- **Agent skill renamed to `rex-grokbot`** (`~/.claude/skills/rex-grokbot`, `~/.agents/skills/rex-grokbot`;
  `rex-grokbot say` / `rex-grokbot whoami`). Setup and uninstall remove an old `rex-bot` skill only when it
  carries our `installed-by: rex-bot-bridge` marker.
- **`rex-grokbot token`** prints the bearer token and nothing else (one line: `rex-grokbot token | pbcopy`);
  no token yet → "no token yet; run rex-grokbot setup", exit 1. `--rotate` writes a new token, restarts the
  bridge service if it is loaded (`launchctl kickstart -k`), prints the new token, and reminds you on stderr to
  update the Grok Bot connector. `--show` is gone.
- **`rex-grokbot url`** prints only the connector URL, `https://<mac>.<tailnet>.ts.net/rex-bridge/mcp`
  (exit 1 with a fix line when Tailscale isn't running; a stderr warning when Serve doesn't map it yet).
- **Removed `rex-grokbot grokbot`** and its paste-this connector message: the instructions live in the guide.
- **[docs/grok-bot.md](docs/grok-bot.md) rewritten:** a who-does-what table (person on the Mac / person in the
  Grok Bot app / Grok Bot); Tailscale plugin prerequisites and a `/healthz` reachability check before adding the
  connector; endpoint and credential entered separately, with honest guidance on entering the token (the app's
  own secret field if it has one; otherwise a private chat, never echoed; rotate if it leaked); routine
  instructions that treat every webhook field (including `agent_message` text) and all pane text as untrusted,
  act only on sessions matching an already-authorized task, never treat an agent's request as permission, and
  approve permission prompts only when the exact command, directory and effects are visible and in scope (never
  "always allow"); a Session discovery section; `full` mode moved out of troubleshooting into a Modes section
  with a clear warning.
- **Setup no longer warns "Webhook not set yet"** on a fresh install (it is step 2 under Next). Re-runs still
  show ✅ Webhook configured; doctor still reports the webhook.

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
- **`install.sh`:** `curl -fsSL https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/install.sh | sh`
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
