#!/bin/bash

# emergencyPauseBreakGlassDispatch.test.sh
#
# EXSC-368 behavioural guardrail for the frozen break-glass pause script. It SOURCES
# script/emergency/emergencyPauseBreakGlass.sh (whose main() is guarded, so sourcing only loads
# functions — no real pause) and asserts:
#   1. normalizePrivateKey accepts the pauser key with/without 0x + whitespace, lowercases it,
#      and rejects empty/malformed input (EXSC-507).
#   2. The EVM dispatch (bgSendPause) actually signs + broadcasts a direct tx against a local
#      Anvil node — the pauser-EOA direct-send path the prod pause relies on (EXSC-367).
#
# All key material is generated at RUNTIME (cast wallet new) and the sender is funded via the
# anvil_setBalance cheatcode, so no private-key literal is ever committed to the repo.
# No secrets / live RPCs. Run from the repo root: bash test/scripts/emergencyPauseBreakGlassDispatch.test.sh
# Returns 0 if all assertions pass, 1 otherwise.

# Burn address as the dummy pause target (an address literal, not a key).
RECIPIENT="0x000000000000000000000000000000000000dEaD"
ANVIL_PORT=8545
ANVIL_URL="http://127.0.0.1:${ANVIL_PORT}"

PASS=0
FAIL=0
ANVIL_PID=""

# Load the frozen break-glass functions (main is guarded behind a BASH_SOURCE check).
# shellcheck source=/dev/null
source script/emergency/emergencyPauseBreakGlass.sh

function cleanup() {
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null
}
trap cleanup EXIT

function pass() {
  echo "  ✅ $1"
  PASS=$((PASS + 1))
}
function fail() {
  echo "  ❌ $1"
  FAIL=$((FAIL + 1))
}

# ---------------------------------------------------------------------------
# 1. Key normalization (EXSC-507) — key generated at runtime, no literal committed
# ---------------------------------------------------------------------------
function testNormalization() {
  echo ""
  echo ">>> normalizePrivateKey"
  local BARE CANON UPPER
  BARE=$(cast wallet new | awk '/Private key:/ {print $3}')
  BARE="${BARE#0x}"
  CANON="0x${BARE}"
  UPPER="0x$(echo "$BARE" | tr 'a-f' 'A-F')"

  [[ "$(normalizePrivateKey "$CANON" K 2>/dev/null)" == "$CANON" ]] && pass "accepts 0x-prefixed" || fail "0x-prefixed"
  [[ "$(normalizePrivateKey "$BARE" K 2>/dev/null)" == "$CANON" ]] && pass "accepts bare (no 0x)" || fail "bare"
  [[ "$(normalizePrivateKey "$UPPER" K 2>/dev/null)" == "$CANON" ]] && pass "lowercases uppercase hex" || fail "uppercase"
  [[ "$(normalizePrivateKey "  ${CANON}
" K 2>/dev/null)" == "$CANON" ]] && pass "trims whitespace/newlines" || fail "whitespace"

  normalizePrivateKey "" K >/dev/null 2>&1 && fail "empty should be rejected" || pass "rejects empty"
  normalizePrivateKey "0x1234" K >/dev/null 2>&1 && fail "short should be rejected" || pass "rejects too-short"
  normalizePrivateKey "0x${BARE:0:62}zz" K >/dev/null 2>&1 && fail "non-hex should be rejected" || pass "rejects non-hex"
}

# ---------------------------------------------------------------------------
# 2. EVM dispatch broadcasts against Anvil (EXSC-367 direct-send proof)
# ---------------------------------------------------------------------------
function testAnvilDispatch() {
  echo ""
  echo ">>> bgSendPause EVM dispatch against Anvil"

  if ! command -v anvil >/dev/null 2>&1; then
    echo "  ⚠️  anvil not found — skipping dispatch broadcast test"
    return 0
  fi

  anvil --silent --port "$ANVIL_PORT" >/dev/null 2>&1 &
  ANVIL_PID=$!

  local READY=0 I
  for I in $(seq 1 30); do
    if cast block-number --rpc-url "$ANVIL_URL" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 0.5
  done
  if [[ "$READY" -ne 1 ]]; then
    fail "Anvil did not become ready on $ANVIL_URL"
    return 1
  fi

  # Generate an ephemeral signer at runtime and fund it via the anvil cheatcode (no key literal).
  local NEWKP EPH_ADDR EPH_KEY
  NEWKP=$(cast wallet new)
  EPH_ADDR=$(echo "$NEWKP" | awk '/Address:/ {print $2}')
  EPH_KEY=$(echo "$NEWKP" | awk '/Private key:/ {print $3}')
  cast rpc anvil_setBalance "$EPH_ADDR" 0x3635c9adc5dea00000 --rpc-url "$ANVIL_URL" >/dev/null 2>&1 # 1000 ETH

  # Restrict to a real production EVM network name so bgCastSendAsync(mainnet) resolves; the RPC
  # is pointed at the local Anvil. Calldata "0x" = a plain value-less tx (we are proving the
  # signing/broadcast path, not a real pauseDiamond target).
  local NONCE_BEFORE NONCE_AFTER
  NONCE_BEFORE=$(cast nonce "$EPH_ADDR" --rpc-url "$ANVIL_URL" 2>/dev/null)
  if bgSendPause "mainnet" "$RECIPIENT" "0x" "$EPH_KEY" "$ANVIL_URL" >/dev/null 2>&1; then
    sleep 1
    NONCE_AFTER=$(cast nonce "$EPH_ADDR" --rpc-url "$ANVIL_URL" 2>/dev/null)
    if [[ "$NONCE_BEFORE" =~ ^[0-9]+$ && "$NONCE_AFTER" =~ ^[0-9]+$ && "$NONCE_AFTER" -gt "$NONCE_BEFORE" ]]; then
      pass "bgSendPause broadcast a real direct tx from the pauser EOA (nonce $NONCE_BEFORE → $NONCE_AFTER)"
    else
      fail "bgSendPause returned success but sender nonce did not advance ($NONCE_BEFORE → $NONCE_AFTER)"
    fi
  else
    fail "bgSendPause failed to broadcast against Anvil"
  fi

  kill "$ANVIL_PID" 2>/dev/null
  wait "$ANVIL_PID" 2>/dev/null
  ANVIL_PID=""
}

function main() {
  echo "================================================================"
  echo " emergencyPauseBreakGlass dispatch smoke test (EXSC-368)"
  echo "================================================================"

  testNormalization
  testAnvilDispatch

  echo ""
  echo "----------------------------------------------------------------"
  echo "Result: $PASS passed, $FAIL failed"
  echo "----------------------------------------------------------------"

  [[ "$FAIL" -eq 0 ]]
}

main "$@"
