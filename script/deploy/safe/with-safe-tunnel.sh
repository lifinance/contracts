#!/bin/bash
#
# with-safe-tunnel.sh — ensure the lifi-connect tunnel to the Safe proposal
# MongoDB is up, then run the given command.
#
# Since the legacy VPN was retired, the Safe proposal DB (SC_MONGODB_URI) is
# reachable only through the lifi-connect port-forward tunnel, and Safe scripts
# (confirm-safe-tx, propose-to-safe, list-pending-proposals, …) fail fast if it
# isn't running. Wrap them with this to start the tunnel on demand:
#
#   bash script/deploy/safe/with-safe-tunnel.sh bun confirm-safe-tx
#
# or via the package.json alias:
#
#   bun run safe:tunnel                       # just ensure the tunnel, then exit
#   bun run safe:tunnel bun confirm-safe-tx   # ensure the tunnel, then run
#
# The tunnel is left running afterwards (ports are static — start once, reuse
# all day). This is a convenience wrapper only: the signing scripts never start
# a production tunnel themselves.

set -euo pipefail

readonly WAIT_SECONDS=45 # max time to wait for the tunnel port to open

repo_root() { git rev-parse --show-toplevel 2>/dev/null || pwd; }

# Resolve the lifi-connect binary (PATH first, then the default install dir).
lifi_connect_bin() {
  if command -v lifi-connect >/dev/null 2>&1; then
    echo "lifi-connect"
  elif [ -x "${HOME}/.local/bin/lifi-connect" ]; then
    echo "${HOME}/.local/bin/lifi-connect"
  else
    return 1
  fi
}

# Extract the tunnel port from SC_MONGODB_URI in .env. Only the port is read and
# echoed — the connection string (with credentials) is never printed.
tunnel_port() {
  local env_file="$1" line
  [ -f "$env_file" ] || return 1
  line=$(grep -E '^[[:space:]]*SC_MONGODB_URI=' "$env_file" | tail -n1) || return 1
  printf '%s' "$line" | grep -oE '(localhost|127\.0\.0\.1):[0-9]+' | grep -oE '[0-9]+$' | tail -n1
}

# True if something is listening on 127.0.0.1:<port>. Uses bash's /dev/tcp so no
# external tool (nc/lsof) is required.
port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Start `lifi-connect prod smart-contracts`. On macOS open a visible Terminal
# window (so any Okta/browser auth prompt is seen); otherwise run detached.
start_tunnel() {
  local bin="$1"
  if [ "$(uname -s)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
    osascript >/dev/null 2>&1 <<EOF
tell application "Terminal"
  do script "${bin} prod smart-contracts"
  activate
end tell
EOF
    echo "  → opened a new Terminal window running the tunnel"
  else
    local log="${TMPDIR:-/tmp}/lifi-connect-safe.log"
    nohup "$bin" prod smart-contracts >"$log" 2>&1 &
    echo "  → started in background (PID $!, logs: ${log}); stop with: kill $!"
  fi
}

main() {
  local root env_file bin port i=0
  root=$(repo_root)
  env_file="${root}/.env"

  if ! bin=$(lifi_connect_bin); then
    echo "lifi-connect is not installed — see docs/Setup.md (Accessing LI.FI resources)." >&2
    [ "$#" -gt 0 ] && exec "$@"
    exit 1
  fi

  port=$(tunnel_port "$env_file" || true)
  if [ -z "${port:-}" ]; then
    echo "Could not read a localhost port from SC_MONGODB_URI in ${env_file}." >&2
    echo "Point SC_MONGODB_URI at the lifi-connect tunnel first — see docs/Setup.md." >&2
    [ "$#" -gt 0 ] && exec "$@"
    exit 1
  fi

  if port_up "$port"; then
    echo "✓ Safe Mongo tunnel already up (localhost:${port})"
  else
    echo "Safe Mongo tunnel (localhost:${port}) is down — starting lifi-connect prod smart-contracts…"
    start_tunnel "$bin"
    until port_up "$port"; do
      i=$((i + 1))
      if [ "$i" -ge "$WAIT_SECONDS" ]; then
        echo "✗ Tunnel did not come up within ${WAIT_SECONDS}s on localhost:${port}." >&2
        echo "  Logged in? Run: aws sso login --sso-session LIFI" >&2
        echo "  Or start it manually: lifi-connect prod smart-contracts" >&2
        exit 1
      fi
      sleep 1
    done
    echo "✓ Tunnel is up (localhost:${port}) — leaving it running"
  fi

  [ "$#" -gt 0 ] && exec "$@"
}

main "$@"
