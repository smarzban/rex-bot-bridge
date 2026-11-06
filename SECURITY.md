# Security policy

rex-grokbot-bridge lets a bot run commands on your Mac through Rex, so security reports matter.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting: the repository's **Security** tab →
**Report a vulnerability** ([direct link](https://github.com/smarzban/rex-grokbot-bridge/security/advisories/new)).
Please don't open a public issue, and don't include a real token, webhook URL or key in the report.

You'll get an acknowledgement as soon as the maintainer sees it; fixes ship as a new release with a CHANGELOG
entry.

## Supported versions

Only the latest release gets security fixes. Upgrade with the installer or `npm i -g rex-grokbot-bridge`, then
`rex-grokbot setup` ([docs/setup.md](docs/setup.md#upgrading)).

## In scope

- **Bridge authentication:** the bearer token check on `/mcp`, the no-OAuth `401` and `/.well-known/*`
  responses, anything reachable without the token beyond `GET /healthz`.
- **Sharing gates:** the bot reading, typing into, closing or spawning in a session or pane that isn't shared
  in `shared` mode; status pushes or `rex-grokbot say` messages from unshared panes.
- **Token and webhook handling:** the token, webhook URL or key being printed, logged, written with loose file
  modes, or sent anywhere other than their intended destination.
- **Exposure:** the bridge listening beyond `127.0.0.1`, or setup enabling Tailscale Funnel or replacing
  another app's Tailscale Serve mapping without asking.

Out of scope: someone who already has your token and tailnet access (that is the documented trust model, see
[docs/security.md](docs/security.md)), and vulnerabilities in Rex, Tailscale or Grok Bot themselves (report
those to their vendors).
