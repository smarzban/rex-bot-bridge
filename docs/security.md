# Security model

What rex-grokbot-bridge lets the bot do, how you limit it, and what protects the connection.

**Anyone who has the bearer token and can reach the URL can run commands on your Mac as you.** `spawn_agent` can start any program and `send_message` types into shells. Keep that in mind when you choose a mode and what to share.

## Modes

| Mode | What the bot can do |
|---|---|
| `shared` (default) | List every session. Read, type into, press keys in, wait on, and close **only what you share with it**: a whole session (every pane in it) or a single pane. Close a session or spawn agents into it only when the session itself is shared; spawn into a new session (which is then shared). It cannot share anything itself. |
| `all` | All of the above in **every** Rex session. |

Switch modes with `rex-grokbot config set mode shared|all` (takes effect on the next call, no restart).

## Sharing a session or pane

- **From Rex's command palette:** **Bot: Share / Unshare This Session** (every pane in the session) or **Bot: Share / Unshare This Pane** (only the focused pane). An alert confirms it, and **Bot: List Shared** shows both kinds.
- **From the CLI:** `rex-grokbot share add <session-id|block-id>`, `rex-grokbot share remove …`, and `rex-grokbot share list` to check.
- **Finding the ids:** inside a pane, `rex-grokbot whoami` prints its `REX_SESSION` and `REX_BLOCK`; `rex ls --json` lists every session's id and label.

The share list is `~/.config/rex-grokbot-bridge/shared` (`session:…` and `block:…` lines). The bridge, the CLI and the palette all take the same lock (`shared.lock`) to edit it, so concurrent edits are never lost.

## What notifies the bot

What you share is also what notifies the bot:

- Status pushes (an agent turning `done`, `blocked` or `error`) come only from shared panes and panes in shared sessions.
- An agent's `rex-grokbot say` is sent only from those; elsewhere it prints "not sent" and exits 0.
- Seeing a session in `list_agents` (labels, short status) is not being notified about it.

Don't switch to `all` mode just to make `say` work: it opens every session. Share the pane or session instead.

## Protections

- **Local only, then tailnet only.** The bridge listens on `127.0.0.1`. It reaches your tailnet through `tailscale serve` (tailnet only, never Funnel) on **its own HTTPS port**, `https://<mac>.<tailnet>.ts.net:8443`, not a path on port 443: other apps on the Mac can serve OAuth metadata at the 443 origin's `/.well-known/`, and an MCP client that sees our 401 would find it and try to sign in there. See [setup](setup.md#tailscale-serve-and-the-port) for the port.
- **Bearer token.** `/mcp` needs `Authorization: Bearer <token>` (constant-time compare). The token lives in `~/.config/rex-grokbot-bridge/token` (mode 600), is never logged, and is re-read per request. `rex-grokbot token --rotate` replaces it and restarts the bridge, so the old one stops working at once.
- **Token handoff.** Paste the token **once, in a private 1:1 chat** with your own bot. If it ever lands anywhere else (a group chat, a doc, a screenshot), rotate it with `rex-grokbot token --rotate | pbcopy` and give the bot the new one.
- **Audit log.** Every tool call is logged to `~/.local/state/rex-grokbot-bridge/audit.log` (tool, truncated args, result). No token, no pane contents.
- **Webhook secrets.** The webhook URL and key are never printed or logged; `notify.log` records only HTTP status codes.
- **Health check.** `GET /healthz` is unauthenticated and returns only `{ok, rex_reachable, watcher_heartbeat_age_s}`.
- **No OAuth.** Every `/.well-known/*` path is a JSON 404, and a missing or wrong token gets a plain `401` with `WWW-Authenticate: Bearer realm="rex-grokbot-bridge"` (no `resource_metadata`). The connector uses the static `Authorization` header.
- **Untrusted pane text.** Pane text returned to the bot is marked untrusted, and the routine instructions tell it so.
- **Files.** `~/.config/rex-grokbot-bridge/` is mode 700 and its files 600.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
