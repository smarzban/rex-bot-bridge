# rex-grokbot-bridge

[![CI](https://github.com/smarzban/rex-grokbot-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/smarzban/rex-grokbot-bridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/rex-grokbot-bridge)](https://www.npmjs.com/package/rex-grokbot-bridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An MCP server and webhook bridge for macOS that lets **Grok Bot**, over **Tailscale**, see and drive the coding agents (Claude Code, Codex, Pi, Grok Build, shells) running in your **[Rex](https://www.superlogical.com/rex/docs) terminal**, and get pinged when they finish or get stuck.

- **Bot → agents:** an MCP server the bot connects to. It lists sessions and panes, reads a pane's screen, types into it, presses keys, spawns new agents, waits for them, and closes them.
- **Agents → bot:** a watcher POSTs to the bot's webhook when an agent's status turns `done`, `blocked` or `error`, and agents can message the bot with `rex-grokbot say "…"`.
- **You choose what's shared:** by default the bot drives only the Rex sessions or panes you share with it, from Rex's command palette or the CLI.
- **Tailnet only:** the bridge listens on `127.0.0.1` and is reachable only through Tailscale Serve on your tailnet, never the public internet.
- **One command to install:** `rex-grokbot setup` installs both directions as launchd services, and `rex-grokbot doctor` checks the whole chain.

## How it works

```
                 ┌──────────────────────────── your Mac ─────────────────────────────┐
 Grok Bot ──MCP──▶ tailscale serve :8443 ─▶ rex-grokbot serve (127.0.0.1:7400) ─▶ rex ─▶ Rex panes
 (tailnet)       │                                                             │      │
    ▲            │        rex-grokbot watch (lua/bot-watch.lua) ◀── status (OSC 7501) ─┘      │
    └─ webhook ──┼────────  rex-grokbot notify  ◀──  rex-grokbot say "…" (from an agent)          │
                 └───────────────────────────────────────────────────────────────────┘
```

Both directions live in this one package.

## Is this safe?

Anyone with the token who can reach the URL can run commands on your Mac as you, so the bridge keeps both tight:

- **Bearer token:** every MCP call needs it; it's stored mode 600, never logged, and `rex-grokbot token --rotate` revokes it at once.
- **Tailnet only:** `127.0.0.1` plus Tailscale Serve on its own HTTPS port; never Funnel, no OAuth.
- **You choose what's shared:** in the default `shared` mode the bot drives and hears from only the sessions and panes you share.
- **Audit log:** every tool call is logged (tool, truncated args, result; no token, no pane contents).

Details: [docs/security.md](docs/security.md).

## Requirements

- macOS with Node 22+ and npm
- [Rex](https://www.superlogical.com/rex/docs), running, with `rex` on your PATH
- Tailscale on this Mac, with MagicDNS and HTTPS certificates on for the tailnet
- Grok Bot desktop, its Tailscale plugin logged in to the same tailnet

## Quickstart

1. **Install** the CLI (it checks Node and npm, never uses sudo, and offers to run setup):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/install.sh | sh
   ```

   Or with npm: `npm i -g rex-grokbot-bridge`. Other paths, upgrading and uninstall: [docs/setup.md](docs/setup.md).
2. **Set up this Mac:** `rex-grokbot setup` (token, mode, Rex palette actions, launchd services, Tailscale Serve, agent skill).
3. **Set up Grok Bot:** give it the guide's raw address, `https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/docs/grok-bot.md`, and say "set this up with me". It asks you for:
   - the output of `rex-grokbot url` (the connector address; not a secret);
   - the token: `rex-grokbot token | pbcopy`, pasted **once, in a private 1:1 chat** with your own bot. It goes in as a static `Authorization: Bearer <token>` header; if the app offers to sign in, decline. If the token lands anywhere else, rotate it: `rex-grokbot token --rotate | pbcopy`.

   Then it creates a routine and shows you its webhook URL (and key, if any).
4. **Give the routine's webhook to this Mac:** `rex-grokbot setup webhook`
5. **Check everything:** `rex-grokbot doctor --test-webhook` (the bot replies "rex-grokbot-bridge webhook OK").
6. **Share a session or pane:** in Rex's command palette, **Bot: Share / Unshare This Session** or **This Pane** (or `rex-grokbot share add <session-id|block-id>`). Let an agent finish there and the bot hears about it.

Keep the Mac awake with Rex running while you do this. Install globally, not with `npx`: the services point at the installed files.

## Documentation

| For | Read |
|---|---|
| Users | [Setup, upgrade, uninstall](docs/setup.md) · [Security model and sharing](docs/security.md) |
| Grok Bot | [docs/grok-bot.md](docs/grok-bot.md): addressed to the bot; hand it the raw URL |
| Reference | [Commands, MCP tools, settings, files](docs/reference.md) · `rex-grokbot --help` |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) · `rex-grokbot doctor` |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) |

## License

[MIT](LICENSE)
