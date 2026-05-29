#!/bin/bash
#
# checkPauserFunds.sh — audit whether the pauser wallet on each production EVM network can
# afford pauseDiamond(). Read-only: estimates the single-pause cost, reads the pauser
# balance, and reports a ratio + status per network. EVM only (Tron / testnets skipped).
#
# Usage:
#   ./script/utils/checkPauserFunds.sh [NETWORK ...]
#     (no args)   audit all active, non-testnet, non-Tron networks in networks.json
#     NETWORK...  audit only the named networks
#
# Status:  OK (ratio >= 2.5)   WARNING (1 <= ratio < 2.5)   CRITICAL (ratio < 1)
#          PAUSED (already paused)   ERROR (estimate/RPC failed)   SKIP (filtered/no diamond)
# Exit code: 1 if any audited network is CRITICAL, else 0.
#
# Must be run from the repository root.

# NOTE: intentionally no `set -e` — failures are handled per-network so the sweep continues.
set -uo pipefail

function usage() {
  cat <<'EOF'
Usage: ./script/utils/checkPauserFunds.sh [NETWORK ...]
  No args     audit all active, non-testnet, non-Tron networks
  NETWORK...  audit only the named networks
Statuses: OK (>=2.5x)  WARNING (1x-2.5x)  CRITICAL (<1x)  PAUSED  ERROR  SKIP
Exit code 1 if any network is CRITICAL.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f script/helperFunctions.sh ]]; then
  echo "ERROR: run this script from the repository root (script/helperFunctions.sh not found)" >&2
  exit 1
fi
# shellcheck source=script/helperFunctions.sh disable=SC1091
source script/helperFunctions.sh

# 2.5x expressed as 5/2 for integer bc math
readonly WARN_MULT_NUM=5
readonly WARN_MULT_DEN=2

# trimZeros: strip trailing zeros (and a trailing dot) from a decimal string for display.
# Usage: trimZeros DECIMAL_STRING
function trimZeros() {
  printf '%s' "$1" | sed -E 's/([0-9])0+$/\1/; s/\.$//'
}

# resolveRpc: ETH_NODE_URI_* env var first, networks.json rpcUrl as fallback.
function resolveRpc() {
  local NET="$1"
  getRPCUrl "$NET" 2>/dev/null || getRpcUrlFromNetworksJson "$NET"
}

# Build the network list: explicit args, else every key in networks.json.
NETWORKS=()
if [[ $# -gt 0 ]]; then
  NETWORKS=("$@")
else
  while IFS= read -r NET; do
    NETWORKS+=("$NET")
  done < <(getAllNetworksArray)
fi
if [[ ${#NETWORKS[@]} -eq 0 ]]; then
  error "no networks to audit"
  exit 1
fi

PAUSER=$(getValueFromJSONFile "./config/global.json" "pauserWallet")
if [[ -z "$PAUSER" ]]; then
  error "could not read pauserWallet from config/global.json"
  exit 1
fi

# Each entry: "<CAT>|<RATIO>|formatted row". CAT then RATIO order the table:
#   ERROR first (needs attention), then data rows by ratio ascending, then PAUSED, then SKIP.
ROWS=()
HAS_CRITICAL=0

# sort categories (field 1 of each ROWS entry) — keeps ordering independent of ratio magnitude
readonly CAT_ERROR=0
readonly CAT_DATA=1
readonly CAT_PAUSED=2
readonly CAT_SKIP=3

# fmtRow: join the 6 table columns with tabs (column -t aligns them at the end).
# Usage: fmtRow NETWORK COST REQUIRED BALANCE RATIO STATUS
function fmtRow() { printf '%s\t%s\t%s\t%s\t%s\t%s' "$1" "$2" "$3" "$4" "$5" "$6"; }

# plainRow: a row with dashes in the numeric columns (for SKIP/PAUSED/ERROR).
function plainRow() { fmtRow "$1" "-" "-" "-" "-" "$2"; }

# Progress goes to stderr so the final table on stdout stays clean and pipeable.
TOTAL=${#NETWORKS[@]}
echo "Checking pauser-wallet funding on $TOTAL network(s) — reading live gas prices & balances, this can take a minute..." >&2

IDX=0
for NETWORK in "${NETWORKS[@]}"; do
  IDX=$((IDX + 1))
  printf '[%d/%d] %s\n' "$IDX" "$TOTAL" "$NETWORK" >&2
  if isTestnetNetwork "$NETWORK" >/dev/null 2>&1 || isTronNetwork "$NETWORK" >/dev/null 2>&1; then
    ROWS+=("$CAT_SKIP|0|$(plainRow "$NETWORK" "SKIP")")
    continue
  fi
  STATUS_FIELD=$(getValueFromJSONFile "./config/networks.json" "${NETWORK}.status")
  if [[ "$STATUS_FIELD" != "active" ]]; then
    ROWS+=("$CAT_SKIP|0|$(plainRow "$NETWORK" "SKIP")")
    continue
  fi

  SYMBOL=$(getValueFromJSONFile "./config/networks.json" "${NETWORK}.nativeCurrency")
  [[ -z "$SYMBOL" ]] && SYMBOL="?"

  COST=$(estimatePauseCost "$NETWORK")
  RC=$?
  if [[ $RC -eq 2 ]]; then
    ROWS+=("$CAT_PAUSED|0|$(plainRow "$NETWORK" "PAUSED")")
    continue
  fi
  if [[ $RC -ne 0 || ! "$COST" =~ ^[0-9]+$ || "$COST" == "0" ]]; then
    ROWS+=("$CAT_ERROR|0|$(plainRow "$NETWORK" "ERROR")")
    continue
  fi

  RPC_URL=$(resolveRpc "$NETWORK")
  BALANCE=$(cast balance "$PAUSER" --rpc-url "$RPC_URL" 2>/dev/null)
  if ! [[ "$BALANCE" =~ ^[0-9]+$ ]]; then
    ROWS+=("$CAT_ERROR|0|$(plainRow "$NETWORK" "ERROR")")
    continue
  fi

  REQUIRED=$(echo "$COST * $WARN_MULT_NUM / $WARN_MULT_DEN" | bc)
  RATIO=$(echo "scale=2; $BALANCE / $COST" | bc)
  [[ "$RATIO" == .* ]] && RATIO="0$RATIO"   # bc prints ".40"; make it "0.40"

  if [[ $(echo "$BALANCE < $COST" | bc) -eq 1 ]]; then
    STATUS="CRITICAL"
    HAS_CRITICAL=1
  elif [[ $(echo "$BALANCE < $REQUIRED" | bc) -eq 1 ]]; then
    STATUS="WARNING"
  else
    STATUS="OK"
  fi

  COST_N=$(trimZeros "$(cast from-wei "$COST")")
  REQ_N=$(trimZeros "$(cast from-wei "$REQUIRED")")
  BAL_N=$(trimZeros "$(cast from-wei "$BALANCE")")

  ROWS+=("$CAT_DATA|$RATIO|$(fmtRow "$NETWORK" "${COST_N} ${SYMBOL}" "${REQ_N} ${SYMBOL}" "${BAL_N} ${SYMBOL}" "$RATIO" "$STATUS")")
done

# header + sorted rows through one column pipe: sort by category then ratio, strip both keys
{
  fmtRow "NETWORK" "COST(1x)" "REQUIRED(2.5x)" "BALANCE" "RATIO" "STATUS"
  printf '\n'
  printf '%s\n' "${ROWS[@]}" | sort -t'|' -k1,1n -k2,2g | cut -d'|' -f3-
} | column -t -s "$(printf '\t')"

if [[ $HAS_CRITICAL -eq 1 ]]; then
  # Summary alert to stderr (keeps stdout = table only); exit code is the machine signal.
  echo "" >&2
  warning "one or more networks are CRITICAL (pauser cannot afford a single pause)" >&2
  exit 1
fi
exit 0
