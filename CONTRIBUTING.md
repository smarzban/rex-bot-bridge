# Contributing

Thanks for helping. rex-grokbot-bridge is small: a Node 22 / TypeScript CLI and MCP server for macOS, plus a
little Lua for Rex. Agent-facing project rules are in [AGENTS.md](https://github.com/smarzban/rex-grokbot-bridge/blob/main/AGENTS.md); this is the short version.

## Dev setup

You need macOS, Node 22+ and npm. A running [Rex](https://www.superlogical.com/rex/docs) is needed only for
the Lua tests and the sandbox end-to-end check.

```sh
git clone https://github.com/smarzban/rex-grokbot-bridge
cd rex-grokbot-bridge
npm install
```

## Tests

```sh
npm run typecheck
npm run build          # before npm test: the CLI tests run the built dist/
npm test               # unit tests with a fake rex; Lua tests skip without rex, pty tests without python3
npm run e2e:sandbox    # real Rex, temp HOME, no launchd or Tailscale changes; kills only its own sessions
```

Don't test against your live install (`~/.config/rex-grokbot-bridge`, your `init.lua`, launchd services,
`tailscale serve`); `e2e:sandbox` exists so you don't have to.

## Docs

- The command table in [docs/reference.md](docs/reference.md) is generated from `src/cli/help.ts`: after
  changing help text, run `npm run docs:commands` and commit the result.
- Markdown placeholders go in backticks (a bare `<token>` vanishes on GitHub), and relative links must
  resolve; `npm test` checks both.
- Never put a real token, webhook URL or key, hostname, tailnet name, email or home path in docs or tests.

## Pull requests

- Branch from `main`, keep commits logical, and open the PR against `main`.
- Fill in the PR template's test plan; CI (typecheck, build, test on macOS) must pass.
- User-visible changes get a line in [CHANGELOG.md](CHANGELOG.md).
- Security problems: report privately, see [SECURITY.md](SECURITY.md).
