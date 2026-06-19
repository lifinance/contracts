#!/bin/bash
# testCheckPauserFunds.sh — E2E tests for the EXSC-536 fix.
#
# Forks Base mainnet, pauses the STAGING LiFiDiamond (never production), and
# verifies that estimatePauseCost / checkPauserFunds.sh report PAUSED (not ERROR).
#
# Run from the repository root:
#   ./script/utils/testCheckPauserFunds.sh
#
# Required env (in .env or shell):
#   PRIV_KEY_PAUSER_WALLET_STAGING  — private key for the staging pauser wallet
#   ETH_NODE_URI_BASE               — Base mainnet RPC URL (used as fork source)
#
# Never modifies real on-chain state — all changes occur on a local anvil fork.

set -uo pipefail

# ── Config ─────────────────────────────────────────────────────────────────────
ANVIL_PORT=18545
ANVIL_RPC="http://localhost:$ANVIL_PORT"
STAGING_DIAMOND="0x947330863B5BA5E134fE8b73e0E1c7Eed90446C7"
PROD_DEPLOY_LOG="./deployments/base.json"
PASS=0
FAIL=0

# ── Bootstrap ──────────────────────────────────────────────────────────────────
if [[ ! -f script/helperFunctions.sh ]]; then
  echo "ERROR: run from the repository root (script/helperFunctions.sh not found)" >&2
  exit 1
fi

# Load .env so PRIV_KEY_PAUSER_WALLET_STAGING and ETH_NODE_URI_BASE are available
if [[ -f .env ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' .env | grep -E '^(PRIV_KEY_PAUSER_WALLET_STAGING|ETH_NODE_URI_BASE)=' | xargs)
fi

if [[ -z "${PRIV_KEY_PAUSER_WALLET_STAGING:-}" ]]; then
  echo "ERROR: PRIV_KEY_PAUSER_WALLET_STAGING is not set" >&2
  exit 1
fi
if [[ -z "${ETH_NODE_URI_BASE:-}" ]]; then
  echo "ERROR: ETH_NODE_URI_BASE is not set" >&2
  exit 1
fi

# shellcheck source=script/helperFunctions.sh
# shellcheck disable=SC1091
source script/helperFunctions.sh

# ── Cleanup trap ───────────────────────────────────────────────────────────────
ORIG_PROD_LOG=$(mktemp)
ORIG_GLOBAL_JSON=$(mktemp)
ORIG_DOTENV=$(mktemp)
cp "$PROD_DEPLOY_LOG" "$ORIG_PROD_LOG"
cp "./config/global.json" "$ORIG_GLOBAL_JSON"
cp "./.env" "$ORIG_DOTENV"
ANVIL_PID=""
trap 'cp "$ORIG_PROD_LOG" "$PROD_DEPLOY_LOG"; cp "$ORIG_GLOBAL_JSON" "./config/global.json"; cp "$ORIG_DOTENV" "./.env"; rm -f "$ORIG_PROD_LOG" "$ORIG_GLOBAL_JSON" "$ORIG_DOTENV"; [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true' EXIT

# ── Start anvil fork ───────────────────────────────────────────────────────────
echo "Forking Base via anvil on port $ANVIL_PORT..."
anvil --port "$ANVIL_PORT" --fork-url "$ETH_NODE_URI_BASE" --silent &
ANVIL_PID=$!
# Wait until the RPC is ready (up to 30 s)
WAIT_ATTEMPTS=0
until cast block-number --rpc-url "$ANVIL_RPC" >/dev/null 2>&1; do
  sleep 0.2
  WAIT_ATTEMPTS=$((WAIT_ATTEMPTS + 1))
  if [[ $WAIT_ATTEMPTS -ge 150 ]]; then
    echo "ERROR: anvil did not start within 30 s" >&2
    exit 1
  fi
done
echo "Anvil ready (pid $ANVIL_PID, block $(cast block-number --rpc-url "$ANVIL_RPC"))"

# ── Pre-flight: verify pauser wallet matches staging diamond ───────────────────
PAUSER_ADDR=$(cast wallet address --private-key "$PRIV_KEY_PAUSER_WALLET_STAGING" 2>/dev/null)
ON_CHAIN_PAUSER=$(cast call "$STAGING_DIAMOND" "pauserWallet()(address)" --rpc-url "$ANVIL_RPC" 2>/dev/null)

# case-insensitive compare via tr (bash 3.2 on macOS doesn't support ${VAR,,})
PAUSER_ADDR_LC=$(printf '%s' "$PAUSER_ADDR" | tr '[:upper:]' '[:lower:]')
ON_CHAIN_PAUSER_LC=$(printf '%s' "$ON_CHAIN_PAUSER" | tr '[:upper:]' '[:lower:]')

if [[ "$PAUSER_ADDR_LC" != "$ON_CHAIN_PAUSER_LC" ]]; then
  echo "ERROR: PRIV_KEY_PAUSER_WALLET_STAGING derives address $PAUSER_ADDR" >&2
  echo "       but staging diamond's pauserWallet() is $ON_CHAIN_PAUSER" >&2
  echo "       Update PRIV_KEY_PAUSER_WALLET_STAGING in .env to match." >&2
  exit 1
fi
echo "Pauser wallet verified: $PAUSER_ADDR"

# ── Redirect helpers to staging for the duration of the test ──────────────────
# estimatePauseCost reads deployments/base.json for the diamond address and
# config/global.json for the pauser wallet. Patch both to point at staging values
# so that checkPauserFunds.sh (which reads both files internally) also uses them.
jq --arg addr "$STAGING_DIAMOND" '.LiFiDiamond = $addr' "$ORIG_PROD_LOG" > "$PROD_DEPLOY_LOG"
jq --arg addr "$PAUSER_ADDR" '.pauserWallet = $addr' "$ORIG_GLOBAL_JSON" > "./config/global.json"
# helperFunctions.sh re-reads .env on every `source` (set -a; source .env; set +a).
# We must patch .env itself so any subprocess that sources helperFunctions.sh also
# uses the anvil fork RPC instead of the real Base mainnet URL.
sed "s|^ETH_NODE_URI_BASE=.*|ETH_NODE_URI_BASE=$ANVIL_RPC|" "$ORIG_DOTENV" > "./.env"

# Override RPC so all cast/helperFunction calls hit the local fork
export ETH_NODE_URI_BASE="$ANVIL_RPC"

# ── Assertion helpers ──────────────────────────────────────────────────────────
function assertEq() {
  local LABEL="$1" GOT="$2" WANT="$3"
  if [[ "$GOT" == "$WANT" ]]; then
    echo "  PASS [$LABEL]: got '$GOT'"
    PASS=$((PASS + 1))
  else
    echo "  FAIL [$LABEL]: expected '$WANT', got '$GOT'"
    FAIL=$((FAIL + 1))
  fi
}

function assertNumericPositive() {
  local LABEL="$1" VALUE="$2"
  if [[ "$VALUE" =~ ^[0-9]+$ && "$VALUE" -gt 0 ]]; then
    echo "  PASS [$LABEL]: $VALUE (positive integer)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL [$LABEL]: expected positive integer, got '$VALUE'"
    FAIL=$((FAIL + 1))
  fi
}

function assertEmpty() {
  local LABEL="$1" VALUE="$2"
  if [[ -z "$VALUE" ]]; then
    echo "  PASS [$LABEL]: output is empty (as expected)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL [$LABEL]: expected empty output, got '$VALUE'"
    FAIL=$((FAIL + 1))
  fi
}

function assertContains() {
  local LABEL="$1" OUTPUT="$2" PATTERN="$3"
  if printf '%s' "$OUTPUT" | grep -qF "$PATTERN"; then
    echo "  PASS [$LABEL]: output contains '$PATTERN'"
    PASS=$((PASS + 1))
  else
    echo "  FAIL [$LABEL]: '$PATTERN' not found in output"
    printf '  (output was: %s)\n' "$OUTPUT"
    FAIL=$((FAIL + 1))
  fi
}

function assertNotContains() {
  local LABEL="$1" OUTPUT="$2" PATTERN="$3"
  if ! printf '%s' "$OUTPUT" | grep -qF "$PATTERN"; then
    echo "  PASS [$LABEL]: output does not contain '$PATTERN'"
    PASS=$((PASS + 1))
  else
    echo "  FAIL [$LABEL]: '$PATTERN' unexpectedly found in output"
    printf '  (output was: %s)\n' "$OUTPUT"
    FAIL=$((FAIL + 1))
  fi
}

# ── Phase 1: active diamond ────────────────────────────────────────────────────
echo ""
echo "=== Phase 1: active diamond (before pause) ==="

# Assertion 1: exit 0
echo "Assertion 1: estimatePauseCost base → exit 0"
COST=$(estimatePauseCost "base" "$PAUSER_ADDR" 2>/dev/null)
ACTIVE_RC=$?
assertEq "estimatePauseCost active: exit code" "$ACTIVE_RC" "0"

# Assertion 2: positive wei cost
echo "Assertion 2: estimatePauseCost base → positive wei"
assertNumericPositive "estimatePauseCost active: wei cost" "$COST"

# Assertion 3: checkPauserFunds.sh → data row, no ERROR
echo "Assertion 3: checkPauserFunds.sh base → data row"
ACTIVE_OUTPUT=$(./script/utils/checkPauserFunds.sh base 2>&1)
if printf '%s' "$ACTIVE_OUTPUT" | grep -qE 'CRITICAL|WARNING|OK'; then
  echo "  PASS [checkPauserFunds active: data row]: status row found"
  PASS=$((PASS + 1))
else
  echo "  FAIL [checkPauserFunds active: data row]: no CRITICAL/WARNING/OK row found"
  printf '  (output was: %s)\n' "$ACTIVE_OUTPUT"
  FAIL=$((FAIL + 1))
fi
assertNotContains "checkPauserFunds active: no ERROR" "$ACTIVE_OUTPUT" "ERROR"

# ── Pause the diamond ──────────────────────────────────────────────────────────
echo ""
echo "Pausing staging diamond on fork..."
PAUSE_RC=0
cast send "$STAGING_DIAMOND" "pauseDiamond()" \
  --private-key "$PRIV_KEY_PAUSER_WALLET_STAGING" \
  --rpc-url "$ANVIL_RPC" \
  --confirmations 1 \
  >/dev/null 2>&1 || PAUSE_RC=$?

if [[ $PAUSE_RC -ne 0 ]]; then
  echo "ERROR: pauseDiamond() failed (exit $PAUSE_RC) — cannot continue with paused-state tests" >&2
  echo "  Check that PRIV_KEY_PAUSER_WALLET_STAGING is authorized on the staging diamond." >&2
  exit 1
fi
echo "Diamond paused successfully."

# ── Phase 2: paused diamond ────────────────────────────────────────────────────
echo ""
echo "=== Phase 2: paused diamond (after pause) ==="

# Assertion 4: exit 2 (the bug fix — was exit 1 before EXSC-536)
echo "Assertion 4: estimatePauseCost base → exit 2"
estimatePauseCost "base" "$PAUSER_ADDR" >/dev/null 2>&1
PAUSED_RC=$?
assertEq "estimatePauseCost paused: exit code" "$PAUSED_RC" "2"

# Assertion 5: no stdout (exit 2 path does not echo a cost)
echo "Assertion 5: estimatePauseCost base → no stdout"
COST_PAUSED=$(estimatePauseCost "base" "$PAUSER_ADDR" 2>/dev/null)
assertEmpty "estimatePauseCost paused: stdout empty" "$COST_PAUSED"

# Assertions 6 & 7: checkPauserFunds.sh → PAUSED row, no ERROR
echo "Assertion 6-7: checkPauserFunds.sh base → PAUSED, no ERROR"
PAUSED_OUTPUT=$(./script/utils/checkPauserFunds.sh base 2>&1)
assertContains    "checkPauserFunds paused: PAUSED in output" "$PAUSED_OUTPUT" "PAUSED"
assertNotContains "checkPauserFunds paused: no ERROR"         "$PAUSED_OUTPUT" "ERROR"

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "══════════════════════════════════"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
