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

## Releases

Users only get releases: the installer and `npm i -g rex-grokbot-bridge` both install the latest release,
never `main`. To cut one (maintainers):

1. In a PR: `npm version X.Y.Z --no-git-tag-version` and a dated `## X.Y.Z — YYYY-MM-DD` entry at the top of
   [CHANGELOG.md](CHANGELOG.md). Merge it.
2. Tag the merged commit on `main` and push the tag:

   ```sh
   git switch main && git pull
   git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z
   ```

3. [`release.yml`](.github/workflows/release.yml) checks that the tag is `v` + `package.json`'s version, that
   it's on `main` and that CHANGELOG.md has the entry, runs typecheck, build and test, then publishes to npm
   (with provenance; skipped if that version is already there) and creates the GitHub Release with the
   CHANGELOG section as notes (skipped if it exists). A failed run can be re-run from the Actions tab.

One-time setup (owner): npm publishes through
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so there is no npm token secret. On
npmjs.com, open the package → Settings → Trusted publishing → GitHub Actions, and enter organization or user
`smarzban`, repository `rex-grokbot-bridge`, workflow filename `release.yml` (no environment). Under
**Allowed actions**, allow `npm publish` (configs made after Sep 3, 2026 allow only `npm stage publish` by
default, and the workflow runs `npm publish`).
