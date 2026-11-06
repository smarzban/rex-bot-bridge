# AGENTS.md

## Routing guideline

Stranger litmus test: would this instruction make sense to a stranger who cloned this repo? If
no, it belongs in AGENTS.local.md.

A gitignored AGENTS.local.md may exist beside this file; if present, read and follow it before starting work.

Pointer files carry no content: edits go to AGENTS.md or AGENTS.local.md, never CLAUDE.md — it is a
frozen one-line pointer and says so in-file.

Lazy creation: if an agent has private-routed content (per the litmus test above) and no
AGENTS.local.md exists yet in this working copy, it creates one — the committed .gitignore entry
already covers it, so the pattern self-propagates to every clone.

@AGENTS.local.md

## Project overview

rex-grokbot-bridge is a macOS-only Node 22 / TypeScript package (npm name `rex-grokbot-bridge`, CLI
`rex-grokbot`). It runs an MCP server (`src/server.ts`, `src/tools.ts`) that lets Grok Bot, over
Tailscale Serve, read and drive the coding agents in Rex terminal panes, and a watcher
(`lua/bot-watch.lua`, run by `rex-grokbot watch`) that POSTs agent status changes to the bot's
webhook. `rex-grokbot setup` installs both as launchd services. User docs: [README.md](README.md) and
[docs/](docs/setup.md); [docs/grok-bot.md](docs/grok-bot.md) is addressed to the bot itself.

## Build / test / verify

- Install: `npm install` (Node 22+, macOS)
- Typecheck: `npm run typecheck`
- Test: `npm test` (unit tests with a fake `rex`; the Lua tests skip when `rex` isn't on PATH, the
  pty tests when `python3` is missing)
- Build: `npm run build` (to `dist/`; run it before `npm test`, whose CLI tests run the built CLI)
- Live check with a real Rex: `npm run e2e:sandbox` (builds, uses a temp HOME, creates and kills only
  its own `e2e-sandbox-*` sessions; never touches launchd, Tailscale Serve, the real `~/.config` or
  `init.lua`)
- Canonical verify: `npm run typecheck && npm run build && npm test` (the CLI tests run `dist/`), plus `npm run e2e:sandbox`
  before a release. CI (`.github/workflows/ci.yml`) runs the first three on macOS.

## Conventions

- **Secrets:** never print, log, commit or paste the bearer token, the webhook URL or its key, in
  code, tests, docs, PRs or chat. Test fixtures use obviously fake values (mark with
  `gitleaks:allow` if gitleaks flags them). Run `gitleaks dir .` and `gitleaks git .` before a PR.
- **No real identifiers in docs or tests:** no real hostnames, tailnet names, emails, tokens,
  webhook URLs or home-directory paths. Use placeholders in backticks (`<mac>.<tailnet>.ts.net`,
  `~/…`). Bare `<…>` in Markdown prose is a test failure (it vanishes on GitHub): backtick it or
  write `&lt;…&gt;`.
- **Command docs are generated:** after changing `src/cli/help.ts`, run `npm run docs:commands` to
  regenerate the table in [docs/reference.md](docs/reference.md); `test/help.test.ts` fails if it's
  stale. Keep README, `docs/*.md` and `llms.txt` links working (`test/links.test.ts` checks
  relative links and anchors).
- **Safety in dev:** don't touch a live install (the real `~/.config/rex-grokbot-bridge`, `init.lua`,
  launchd services, `tailscale serve`) or Rex sessions you didn't create. Use `e2e:sandbox`.
- **Releases:** each release bumps `package.json` (`npm version X.Y.Z --no-git-tag-version`; the CLI and
  the MCP server read their version from it) and adds a dated entry at the top of [CHANGELOG.md](CHANGELOG.md). Release = merge the PR to `main`, then
  the owner runs `npm publish`. Never run `npm publish` or `npm login` as an agent.
- **Flow:** branch from `main`, logical commits, PR against `main` with proof (tests, typecheck,
  build, e2e:sandbox where it applies). CI must be green.
