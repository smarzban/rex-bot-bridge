#!/usr/bin/env bash
# Prints (does not run) the tailscale serve command that exposes the bridge on your tailnet.
# The bridge itself only listens on 127.0.0.1; tailscale serve terminates HTTPS and proxies to it.
set -euo pipefail
port="${REX_BRIDGE_PORT:-7400}"
path="${1:-/rex-bridge}"
host="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1 || true)"
[ -n "$host" ] || host="<this-mac>.<tailnet>.ts.net"
cat <<OUT
# Expose the bridge to your tailnet (tailnet only; this is serve, not funnel):
tailscale serve --bg --https=443 --set-path ${path} http://127.0.0.1:${port}

# MCP URL for Grok Bot:
#   https://${host}${path}/mcp
# Header:
#   Authorization: Bearer <contents of ~/.config/rex-bot-bridge/token>
#
# Check:   tailscale serve status
# Remove:  tailscale serve --https=443 --set-path ${path} off
OUT
