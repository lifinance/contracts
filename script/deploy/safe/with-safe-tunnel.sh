#!/bin/bash
#
# with-safe-tunnel.sh — ensure the lifi-connect tunnel to the Safe proposal
# MongoDB is up (logging into AWS SSO and starting the tunnel if needed), then
# optionally run a command.
#
# Since the legacy VPN was retired, the Safe proposal DB (SC_MONGODB_URI) is
# reachable only through the lifi-connect port-forward tunnel. The Mongo-touching
# Safe package scripts (confirm-safe-tx, propose-safe-tx, add-safe-owners-and-
# threshold, unpause-all-diamonds, execute-timelock) run through this wrapper —
# `with-safe-tunnel.sh && <original command>` — so they ensure the tunnel
# automatically and *visibly* (it announces what it does and opens a Terminal
# window). The underlying TS signing logic never opens a tunnel on its own; that
# stays here, in one explicit place.
#
# Opening a prod tunnel is a human-only step (docs/Setup-agents.md), so auto-
# start is gated on an interactive TTY: in a non-interactive shell (an agent's
# environment) the wrapper never opens the prod tunnel — it fails fast and tells
# the human to start it. An already-running tunnel is used regardless.
#
# Usage:
#   bash script/deploy/safe/with-safe-tunnel.sh                 # ensure only, exit 0
#   bash script/deploy/safe/with-safe-tunnel.sh bun confirm-safe-tx   # ensure, then run
#   bun run safe:tunnel                                         # same, via alias
#
# The tunnel is left running afterwards (ports are static — start once, reuse
# all day).

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

# A CA-bundle env var pointing at a file that does not exist breaks every TLS
# client that honours it (aws/pip/curl) with an opaque "[Errno 2] No such file"
# error — e.g. after a security-agent upgrade regenerates its cert paths. When
# one of ours points at a missing file it is misconfigured, so unset it for this
# process (aws then falls back to its bundled roots) and warn.
sanitize_ca_env() {
  local var file
  for var in REQUESTS_CA_BUNDLE CURL_CA_BUNDLE AWS_CA_BUNDLE SSL_CERT_FILE; do
    file="${!var:-}"
    if [ -n "$file" ] && [ ! -f "$file" ]; then
      echo "⚠ ${var} points at a missing file — unsetting it for this run (${file})" >&2
      unset "$var"
    fi
  done
}

# Ensure the AWS SSO session is valid; if not, run the login (opens a browser).
# lifi-connect needs this — without it the tunnel start just prints "session
# expired" and does nothing.
ensure_sso() {
  local probe
  probe=$(aws configure list-profiles 2>/dev/null | head -n1)
  if aws sts get-caller-identity ${probe:+--profile "$probe"} >/dev/null 2>&1; then
    return 0
  fi
  echo "AWS SSO session expired — logging in (a browser window will open)…"
  aws sso login --sso-session LIFI
}

main() {
  local root env_file bin port i=0
  root=$(repo_root)
  env_file="${root}/.env"

  sanitize_ca_env

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
    # Opening a *production* tunnel is a human-only step (docs/Setup-agents.md):
    # it's a persistent prod channel gated behind explicit human approval, and an
    # agent's non-interactive shell can't see the SSO/Okta browser prompt anyway.
    # So only auto-start when attached to an interactive terminal; otherwise
    # fail fast with the same guidance getSafeMongoCollection() surfaces and let
    # the human bring the tunnel up. (The "port already up" pass-through above is
    # free and stays available to everyone, agents included.)
    if ! [ -t 1 ]; then
      echo "Safe Mongo tunnel (localhost:${port}) is down and this is a non-interactive shell." >&2
      echo "Opening a prod tunnel is a human-only step — start it yourself:" >&2
      echo "  lifi-connect prod smart-contracts   (see docs/Setup.md)" >&2
      exit 1
    fi
    echo "Safe Mongo tunnel (localhost:${port}) is down — starting lifi-connect prod smart-contracts…"
    ensure_sso
    start_tunnel "$bin"
    until port_up "$port"; do
      i=$((i + 1))
      if [ "$i" -ge "$WAIT_SECONDS" ]; then
        echo "✗ Tunnel did not come up within ${WAIT_SECONDS}s on localhost:${port}." >&2
        echo "  Check the lifi-connect output (Terminal window / ${TMPDIR:-/tmp}/lifi-connect-safe.log)" >&2
        echo "  and that SC_MONGODB_URI's port matches what 'lifi-connect prod smart-contracts' prints." >&2
        exit 1
      fi
      sleep 1
    done
    echo "✓ Tunnel is up (localhost:${port}) — leaving it running"
  fi

  # With a command, run it (tunnel now up). With no args, ensuring the tunnel
  # was the whole job — exit 0 so callers can chain `with-safe-tunnel.sh && <cmd>`.
  if [ "$#" -gt 0 ]; then exec "$@"; fi
}

main "$@"
