#!/bin/sh
# rex-bot-bridge installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/smarzban/rex-bot-bridge/main/install.sh | sh
#
# Installs the rex-bot CLI with npm (from the npm registry once published, else from GitHub), then
# offers to run `rex-bot setup`. Re-running it upgrades in place. Never uses sudo, never installs Node.
#
# Environment:
#   REX_BOT_SOURCE   npm | github      where to install from (default: npm if published, else github)
#   REX_BOT_VERSION  npm version or git ref (default: latest / main)
#
# Everything runs from main(), called on the last line, so a truncated download runs nothing.

set -eu

REPO="smarzban/rex-bot-bridge"
PKG="rex-bot-bridge"

say() { printf '%s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

check_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    die "rex-bot-bridge is for macOS (it runs as launchd services next to Rex). This is $(uname -s)."
  fi
  say "✅ macOS $(sw_vers -productVersion 2>/dev/null || echo)"
}

check_node() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    die "Node.js 22+ and npm are needed. Install them, then run this again:
    brew install node
(or from https://nodejs.org)"
  fi
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$node_major" -lt 22 ]; then
    die "Node $(node --version) is too old; rex-bot-bridge needs Node 22 or newer. Upgrade, then run this again:
    brew upgrade node
(or from https://nodejs.org)"
  fi
  say "✅ Node $(node --version), npm $(npm --version)"
}

check_tools() {
  if command -v rex >/dev/null 2>&1; then
    say "✅ rex: $(command -v rex)"
  else
    warn "rex not found on PATH. Install Rex (https://www.superlogical.com/rex/docs) before running rex-bot setup."
  fi
  if command -v tailscale >/dev/null 2>&1 || [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    say "✅ Tailscale found"
  else
    warn "Tailscale not found. Install it (https://tailscale.com/download) and log in; Grok Bot reaches this Mac through it."
  fi
}

# Sets PREFIX and BIN; fails with a fix when the global prefix isn't writable.
check_prefix() {
  PREFIX=$(npm prefix -g 2>/dev/null) || die "Could not read npm's global prefix (npm prefix -g)."
  BIN="$PREFIX/bin"
  target="$PREFIX/lib/node_modules"
  [ -d "$target" ] || target="$PREFIX"
  if [ ! -w "$target" ]; then
    die "npm's global folder $target is not writable by you, and this installer never uses sudo. Either:
  - use Homebrew's Node (its prefix is yours):  brew install node
  - or give npm a prefix in your home folder:
      npm config set prefix \"\$HOME/.npm-global\"
      echo 'export PATH=\"\$HOME/.npm-global/bin:\$PATH\"' >> ~/.zshrc
      export PATH=\"\$HOME/.npm-global/bin:\$PATH\"
Then run this installer again."
  fi
}

installed_version() {
  if [ -x "$BIN/rex-bot" ]; then "$BIN/rex-bot" --version 2>/dev/null || true; fi
}

choose_spec() {
  source=${REX_BOT_SOURCE:-}
  version=${REX_BOT_VERSION:-}
  if [ -z "$source" ]; then
    if npm view "$PKG" version >/dev/null 2>&1; then source=npm; else source=github; fi
  fi
  case "$source" in
    npm) SPEC="$PKG@${version:-latest}" ;;
    github) SPEC="github:$REPO#${version:-main}" ;;
    *) die "REX_BOT_SOURCE must be npm or github, not '$source'." ;;
  esac
}

finish() {
  if ! command -v rex-bot >/dev/null 2>&1 || [ "$(command -v rex-bot)" != "$BIN/rex-bot" ]; then
    warn "$BIN is not first on your PATH, so 'rex-bot' may not run the copy just installed. Add it:
    echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc && export PATH=\"$BIN:\$PATH\""
  fi
  if [ -t 1 ] && [ -r /dev/tty ]; then
    printf 'Run rex-bot setup now? [Y/n] '
    answer=""
    read -r answer </dev/tty || answer=n
    case "$answer" in
      "" | y | Y | yes | YES)
        "$BIN/rex-bot" setup </dev/tty
        return
        ;;
    esac
  fi
  say ""
  say "Next: rex-bot setup"
}

main() {
  say "rex-bot-bridge installer"
  say ""
  check_macos
  check_node
  check_tools
  check_prefix
  choose_spec
  old=$(installed_version)

  say ""
  say "Installing $SPEC into $PREFIX (npm install -g) ..."
  npm install -g --no-fund --no-audit "$SPEC" || die "npm install -g $SPEC failed (see npm's message above)."

  new=$("$BIN/rex-bot" --version 2>/dev/null) || die "Installed, but $BIN/rex-bot --version doesn't run."
  if [ -n "$old" ] && [ "$old" != "$new" ]; then
    say "✅ Upgraded rex-bot $old → $new ($BIN/rex-bot)"
  elif [ -n "$old" ]; then
    say "✅ Reinstalled rex-bot $new ($BIN/rex-bot)"
  else
    say "✅ Installed rex-bot $new ($BIN/rex-bot)"
  fi
  finish
}

main "$@"
