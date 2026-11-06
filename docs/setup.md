# Setup, upgrade and uninstall

The full install guide. The short path is the README's [Quickstart](../README.md#quickstart).

## Requirements

- macOS with **Node 22+ and npm** (`brew install node`; `install.sh` checks both)
- **Rex**, running, with `rex` on your PATH (`command -v rex`)
- **Tailscale**, logged in on this Mac, with **HTTPS certificates enabled for the tailnet** (admin console → DNS → MagicDNS + HTTPS)
- **Grok Bot** desktop, with its Tailscale plugin authenticated to the **same tailnet as this Mac** (Grok Bot → Connect apps → Your plugins → Tailscale → Authenticate; if Tailscale isn't under **Your plugins**, install it from **Connect apps** first). `tailscale status` shows which tailnet the Mac is on.

Keep the Mac awake with Rex running while you set up.

## Install

Install globally, not with `npx`: the launchd services point at the installed files.

### Installer script (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/install.sh | sh
```

Read the script first if you like: <https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/install.sh>. It checks macOS, Node and npm, installs the `rex-grokbot` CLI with npm (from the npm registry, or from GitHub if the package isn't published there; never sudo, never installs Node), and offers to run `rex-grokbot setup`.

Environment overrides: `REX_GROKBOT_SOURCE=npm|github` picks the source, `REX_GROKBOT_VERSION` an npm version or git ref.

### npm

```sh
npm i -g rex-grokbot-bridge
rex-grokbot setup
```

### From source

```sh
git clone https://github.com/smarzban/rex-grokbot-bridge
cd rex-grokbot-bridge
npm install
npm i -g .
rex-grokbot setup
```

## What `rex-grokbot setup` does

`rex-grokbot setup` asks one question on a first run (the mode, see [security](security.md#modes)) and a yes/no before `tailscale serve`, then prints numbered sections:

1. **Checks:** Node, Rex and the Rex server.
2. **Settings:** creates the token and `~/.config/rex-grokbot-bridge/` (700; files 600), sets the mode.
3. **Rex palette** (`setup rex`): adds the palette actions to Rex's `init.lua` as one marked block (backed up first, validated with `rex config check`, rolled back if the check fails), then reloads the Rex config.
4. **Services** (`setup services`): installs and starts the launchd services `com.rexgrokbotbridge.bridge` and `com.rexgrokbotbridge.watch`.
5. **Tailscale Serve** (`setup serve`): runs `tailscale serve --bg --https=8443 http://127.0.0.1:7400` (after asking), giving the bridge its own origin. See [below](#tailscale-serve-and-the-port).
6. **Agent skill** (`setup skill`): installs a small `rex-grokbot` skill into `~/.claude/skills` and `~/.agents/skills` (if those exist) so agents know about `rex-grokbot say`.

Each line is ✅, ⚠️ or ❌, and every ⚠️/❌ has a `fix:` line. It ends with **Next**: the Grok Bot guide, `rex-grokbot setup webhook`, and `rex-grokbot doctor --test-webhook`. Each part re-runs on its own, e.g. `rex-grokbot setup services`. Re-running setup is safe: it keeps your token, mode and webhook.

### The webhook

The webhook is separate: you get it from the Grok Bot routine, which you create after setup ([docs/grok-bot.md](grok-bot.md)). Then:

```sh
rex-grokbot setup webhook             # asks for the URL, the key (hidden) and the header name, then sends a test
rex-grokbot doctor --test-webhook     # the bot replies "rex-grokbot-bridge webhook OK"
```

Webhook keys for `Authorization` are sent as `Bearer <key>`; any other header gets the raw key. The key prompt accepts a pasted header line and drops a leading `Bearer `. The URL and key are never printed.

### Non-interactive

```sh
rex-grokbot setup --yes [--mode shared|all] [--no-rex-config] [--no-services] [--no-serve] [--no-skills]
rex-grokbot setup webhook --url URL --key-file FILE --yes    # --key-file - reads the key from stdin
```

With `--yes`, nothing on Tailscale Serve is overwritten.

## Tailscale Serve and the port

- The bridge listens on `127.0.0.1:7400`. Tailscale Serve maps **its own HTTPS port**, `8443` by default, to it: `https://<mac>.<tailnet>.ts.net:8443`. `rex-grokbot url` prints the exact connector URL (`…:8443/mcp`).
- It uses its own port, not a path on 443, because other apps on the Mac can serve OAuth metadata at the 443 origin's `/.well-known/`, and an MCP client that sees our 401 would find it and try to sign in there.
- If another app already has `/` on port 8443, setup asks before replacing it (default no; `--yes` never replaces). If the port holds several paths or a TCP forward, it leaves it alone.
- Either way you can pick another port with `rex-grokbot config set servePort <port>`, then `rex-grokbot setup serve`. 8443 is the default (10000 is the other common choice); 443 isn't allowed. Those are also Funnel's ports (443/8443/10000), but the bridge never enables Funnel.
- Changing where the bridge listens (`rex-grokbot config set port|host …`) needs the services restarted: `rex-grokbot setup services`. Tailscale Serve always forwards to `http://127.0.0.1:<port>`, so after a **port** change also run `rex-grokbot setup serve`: it finds the old mapping on the Serve port and asks before replacing it (answer yes; `--yes` never replaces it, so run it interactively). Until then the bot gets HTTP 502.

## Upgrading

Re-run the installer, or `npm i -g rex-grokbot-bridge`, then `rex-grokbot setup`. Setup reloads the Rex config so new palette actions load. If the Rex palette still doesn't show the **Bot:** actions, quit and reopen the Rex app (your sessions keep running).

## Uninstall

```sh
rex-grokbot uninstall [--purge] [--serve-off]   # --purge also deletes ~/.config/rex-grokbot-bridge; --serve-off removes our Tailscale Serve mappings
npm rm -g rex-grokbot-bridge
```

`uninstall` stops and removes the launchd services, the `init.lua` block and the agent skill. It asks before removing the Tailscale Serve mapping on our port, and only ever removes our own. `init.lua` backups stay in `~/.config/rex/rex-grokbot-backups/`.
