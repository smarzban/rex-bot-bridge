#!/bin/sh
# rex-grokbot-bridge installer (macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/smarzban/rex-grokbot-bridge/main/install.sh | sh
#
# Installs the latest RELEASE of the rex-grokbot CLI with npm (from the npm registry once a release is
# published there, else the latest GitHub Release, built from its tag), then offers to run
# `rex-grokbot setup`. Re-running it upgrades in place. Never uses sudo, never installs Node.
#
# Environment:
#   REX_GROKBOT_SOURCE   npm | github      where to install from (default: npm if a release is published
#                                          there, else github)
#   REX_GROKBOT_VERSION  npm version or git tag/ref (default: the latest release). `main` with
#                        REX_GROKBOT_SOURCE=github installs unreleased code (unsupported).
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

# Sets REF to the tag of the latest GitHub Release, or RELEASE_ERR and returns 1 when the API can't be
# reached or has no release. Fetch first, parse second: a pipe would hide a failed curl.
latest_release_tag() {
  api="https://api.github.com/repos/$REPO/releases/latest"
  json=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null) || {
    RELEASE_ERR="could not read $api (offline, rate-limited, or no release yet)"
    return 1
  }
  tag=$(printf '%s\n' "$json" | tr ',{}' '\n' |
    sed -n 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  case "$tag" in
    "" | *[!A-Za-z0-9._-]*)
      RELEASE_ERR="no usable release tag in $api"
      return 1
      ;;
  esac
  REF=$tag
}

choose_spec() {
  SOURCE=${REX_GROKBOT_SOURCE:-}
  version=${REX_GROKBOT_VERSION:-}
  if [ -z "$SOURCE" ]; then
    # npm only when its latest is a real release (X.Y.Z): a placeholder or prerelease doesn't count.
    if npm view "$PKG" version 2>/dev/null | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+'; then SOURCE=npm; else SOURCE=github; fi
  fi
  case "$SOURCE" in
    npm)
      SPEC="$PKG@${version:-latest}"
      LABEL="$SPEC from npm"
      ;;
    github)
      if [ -n "$version" ]; then
        REF=$version
      else
        latest_release_tag || die "Could not find the latest release of $REPO on GitHub: $RELEASE_ERR. Nothing was installed. Try again later, or pick a release yourself:
    curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | REX_GROKBOT_VERSION=vX.Y.Z sh
(releases: https://github.com/$REPO/releases)"
      fi
      SPEC="github:$REPO#$REF"
      case "$REF" in
        v[0-9]*) LABEL="$REPO $REF (GitHub release)" ;;
        *)
          LABEL="$REPO@$REF (from GitHub)"
          warn "REX_GROKBOT_VERSION=$REF is not a release tag: installing unreleased code (unsupported)."
          ;;
      esac
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
  say "Installing $LABEL"
  if [ "$SOURCE" = github ]; then build_from_github; fi
  say "Installing into $PREFIX (npm install -g) ..."
  npm install -g --no-fund --no-audit --loglevel=error "$SPEC" >/dev/null || die "npm install -g $LABEL failed (see npm's message above)."

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
