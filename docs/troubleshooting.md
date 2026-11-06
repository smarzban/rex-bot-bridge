# Troubleshooting

Run `rex-grokbot doctor` first; every ❌ comes with a fix line. `rex-grokbot doctor --test-webhook` also sends a test notification.

## The bot can't reach the Mac

| What the bot sees | Likely cause | Fix |
|---|---|---|
| The plugin can't be used / asks to log in | Tailscale plugin not authenticated | Authenticate Grok Bot's Tailscale plugin on the Mac's tailnet ([requirements](setup.md#requirements)) |
| Name doesn't resolve, or timeout | Plugin on another tailnet, MagicDNS off, or the Mac asleep/offline | Match the tailnet (`tailscale status`), wake the Mac |
| TLS / certificate error | HTTPS certificates off for the tailnet | Turn on HTTPS (admin console → DNS), then `rex-grokbot setup serve` |
| HTTP 404 or connection refused | Tailscale Serve isn't mapping the bridge's port | `rex-grokbot setup serve` |
| An HTML page or another app answers | The URL is missing the bridge's port (`:8443` by default) | Use exactly what `rex-grokbot url` prints |
| HTTP 502 | Tailscale reached the Mac but the bridge isn't running, or you changed `port` and Serve still points at the old one | `rex-grokbot doctor` and follow its fix lines; after a port change, `rex-grokbot setup serve` |

The connector URL must be exactly what `rex-grokbot url` prints, including the port (`:8443` by default). Port details: [setup](setup.md#tailscale-serve-and-the-port).

## Other problems

- **Grok Bot says "authorization failed" or tries to sign in:** the connector was saved as OAuth, or its URL isn't exactly what `rex-grokbot url` prints. Delete it and re-add it with the URL from `rex-grokbot url` (`…:8443/mcp`) and the static `Authorization: Bearer <token>` header ([guide](grok-bot.md#if-something-breaks)).
- **The bot gets HTTP 502:** Tailscale reached your Mac but the bridge is down. Check `launchctl print gui/$(id -u)/com.rexgrokbotbridge.bridge` and `~/Library/Logs/rex-grokbot-bridge/bridge.log`, then `launchctl kickstart -k gui/$(id -u)/com.rexgrokbotbridge.bridge` or `rex-grokbot setup services`.
- **Doctor says the watcher heartbeat is old:** the watcher is down, so no status pushes. Check `watch.log` and `launchctl print gui/$(id -u)/com.rexgrokbotbridge.watch`.
- **The routine never fires:** `rex-grokbot doctor --test-webhook` should report HTTP 200. Then check the pane or its session is shared (`rex-grokbot share list`) and that its agent reports status (OSC 7501). `notify.log` shows every attempt's status code.
- **"refused: … isn't shared with the bot":** share the pane or its session (palette or `rex-grokbot share add`; see [sharing](security.md#sharing-a-session-or-pane)). Closing a session or spawning into it needs the session itself shared, not just a pane.
- **An agent's `rex-grokbot say` prints "not sent":** its pane isn't shared (nor its session), or it isn't running in Rex. Share the pane or session. Don't switch to `all` mode to fix this: it opens every session.
- **The palette actions are missing:** `rex config check`, then `rex config reload`. If they're still missing after an upgrade, quit and reopen the Rex app (your sessions keep running).

Still stuck? [Open an issue](https://github.com/smarzban/rex-grokbot-bridge/issues/new/choose) with the bug template, and never paste your token, webhook URL or key.
