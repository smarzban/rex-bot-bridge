#!/bin/sh
# rex-grokbot-bridge installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/install.sh | sh
#
# Installs the rex-grokbot CLI with npm (from the npm registry once published, else from GitHub), then
# offers to run `rex-grokbot setup`. Re-running it upgrades in place. Never uses sudo, never installs Node.
#
# Environment:
#   REX_GROKBOT_SOURCE   npm | github      where to install from (default: npm if published, else github)
#   REX_GROKBOT_VERSION  npm version or git ref (default: latest / main)
#
# Everything runs from main(), called on the last line, so a truncated download runs nothing.

set -eu

REPO="smarzban/rex-grokbot-bridge"
PKG="rex-grokbot-bridge"

say() { printf '%s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die() {
  printf '❌ %s\n' "$*" >&2
  exit 1
}

check_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    die "rex-grokbot-bridge is for macOS (it runs as launchd services next to Rex). This is $(uname -s)."
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
    die "Node $(node --version) is too old; rex-grokbot-bridge needs Node 22 or newer. Upgrade, then run this again:
    brew upgrade node
(or from https://nodejs.org)"
  fi
  say "✅ Node $(node --version), npm $(npm --version)"
}

check_tools() {
  if command -v rex >/dev/null 2>&1; then
    say "✅ rex: $(command -v rex)"
  else
    warn "rex not found on PATH. Install Rex (https://www.superlogical.com/rex/docs) before running rex-grokbot setup."
  fi
  if command -v tailscale >/dev/null 2>&1 || [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    say "✅ Tailscale found"
  else
    warn "Tailscale not found. Install it (https://tailscale.com/download) and log in; Grok Bot reaches this Mac through it."
  fi
}

# Sets PREFIX and BIN; fails with a fix when the global prefix isn't writable.
# npm 11 redacts UUID-looking path segments in its output ("/a/***/b"), so `npm prefix -g` can print a
# path that doesn't exist. Then use the first known candidate that matches it with *** as a wildcard:
# $NPM_CONFIG_PREFIX / $npm_config_prefix, or the folder npm itself is installed in.
resolve_redacted_prefix() {
  shown=$1
  pattern=$(printf '%s' "$shown" | sed 's/\*\*\*/*/g')
  npm_home=""
  npm_path=$(command -v npm) && npm_home=$(dirname "$(dirname "$npm_path")")
  for candidate in "${NPM_CONFIG_PREFIX:-}" "${npm_config_prefix:-}" "$npm_home"; do
    [ -n "$candidate" ] || continue
    # shellcheck disable=SC2254 # $pattern is a glob on purpose
    case "$candidate" in $pattern) printf '%s' "$candidate" && return 0 ;; esac
  done
  return 1
}

check_prefix() {
  PREFIX=$(npm prefix -g 2>/dev/null) || die "Could not read npm's global prefix (npm prefix -g)."
  case "$PREFIX" in
    *'***'*)
      shown_prefix=$PREFIX
      PREFIX=$(resolve_redacted_prefix "$shown_prefix") ||
        die "npm hid part of its global folder path (it printed $shown_prefix), so this installer can't tell where rex-grokbot will be installed. Nothing was installed. Set NPM_CONFIG_PREFIX to npm's global folder (the one holding bin/ and
lib/node_modules) and run again, e.g.:
    curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | NPM_CONFIG_PREFIX=/path/to/prefix sh"
      ;;
  esac
  BIN="$PREFIX/bin"
  # The nearest folder that exists: npm creates the rest, so that's the one that must be writable.
  target="$PREFIX/lib/node_modules"
  while [ ! -d "$target" ] && [ "$target" != "/" ]; do target=$(dirname "$target"); done
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
  if [ -x "$BIN/rex-grokbot" ]; then "$BIN/rex-grokbot" --version 2>/dev/null || true; fi
}

choose_spec() {
  SOURCE=${REX_GROKBOT_SOURCE:-}
  version=${REX_GROKBOT_VERSION:-}
  if [ -z "$SOURCE" ]; then
    if npm view "$PKG" version >/dev/null 2>&1; then SOURCE=npm; else SOURCE=github; fi
  fi
  case "$SOURCE" in
    npm) SPEC="$PKG@${version:-latest}" ;;
    github)
      REF=${version:-main}
      SPEC="github:$REPO#$REF"
      ;;
    *) die "REX_GROKBOT_SOURCE must be npm or github, not '$SOURCE'." ;;
  esac
}

# From GitHub: download the source at REF, build it in a temp folder, and pack it, so the global install
# is a plain tarball install. (npm's own `npm i -g github:…` prepares git deps with the global flag still
# set, which loses the build's devDependencies.) Sets SPEC to the tarball.
build_from_github() {
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/rex-grokbot-install.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT
  say "Downloading $REPO@$REF and building it ..."
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xzf - -C "$WORK" ||
    die "Could not download $REPO at '$REF' (check REX_GROKBOT_VERSION)."
  src=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -f "$src/package.json" ] || die "The download of $REPO@$REF has no package.json."
  # A local build: the user's global prefix settings must not apply here.
  (
    cd "$src" &&
      env -u NPM_CONFIG_PREFIX -u npm_config_prefix -u NPM_CONFIG_GLOBAL -u npm_config_global \
        npm install --include=dev --no-audit --no-fund --ignore-scripts --loglevel=error >/dev/null &&
      env -u NPM_CONFIG_PREFIX -u npm_config_prefix -u NPM_CONFIG_GLOBAL -u npm_config_global \
        npm pack --pack-destination "$WORK" --loglevel=error >/dev/null
  ) || die "Building $REPO@$REF failed (see npm's message above)."
  SPEC=$(find "$WORK" -maxdepth 1 -name "$PKG-*.tgz" | head -n 1)
  [ -n "$SPEC" ] || die "Building $REPO@$REF produced no package."
}

finish() {
  if ! command -v rex-grokbot >/dev/null 2>&1 || [ "$(command -v rex-grokbot)" != "$BIN/rex-grokbot" ]; then
    warn "$BIN is not first on your PATH, so 'rex-grokbot' may not run the copy just installed. Add it:
    echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc && export PATH=\"$BIN:\$PATH\""
  fi
  if [ -t 1 ] && [ -r /dev/tty ]; then
    printf 'Run rex-grokbot setup now? [Y/n] '
    answer=""
    read -r answer </dev/tty || answer=n
    case "$answer" in
      "" | y | Y | yes | YES)
        "$BIN/rex-grokbot" setup </dev/tty
        return
        ;;
    esac
  fi
  say ""
  say "Next: rex-grokbot setup"
}

main() {
  say "rex-grokbot-bridge installer"
  say ""
  check_macos
  check_node
  check_tools
  check_prefix
  choose_spec
  old=$(installed_version)

  say ""
  label=$SPEC
  if [ "$SOURCE" = github ]; then build_from_github; fi
  say "Installing $label into $PREFIX (npm install -g) ..."
  npm install -g --no-fund --no-audit --loglevel=error "$SPEC" >/dev/null || die "npm install -g $label failed (see npm's message above)."

  new=$("$BIN/rex-grokbot" --version 2>/dev/null) || die "Installed, but $BIN/rex-grokbot --version doesn't run."
  if [ -n "$old" ] && [ "$old" != "$new" ]; then
    say "✅ Upgraded rex-grokbot $old → $new ($BIN/rex-grokbot)"
  elif [ -n "$old" ]; then
    say "✅ Reinstalled rex-grokbot $new ($BIN/rex-grokbot)"
  else
    say "✅ Installed rex-grokbot $new ($BIN/rex-grokbot)"
  fi
  finish
}

main "$@"
