#!/bin/bash
#
# checkPauserFunds.sh — audit whether the pauser wallet on each production EVM network can
# afford pauseDiamond(). Read-only: estimates the single-pause cost, reads the pauser
# balance, and reports NUM OF PAUSES + a status per network. EVM only (Tron / testnets, and
# chains with no native currency such as tempo, are skipped).
#
# Usage:
#   ./script/utils/checkPauserFunds.sh [NETWORK ...]
#     (no args)   audit all active, non-testnet, non-Tron networks in networks.json
#     NETWORK...  audit only the named networks
#
# NUM OF PAUSES = balance ÷ cost of ONE pauseDiamond() — how many pauses the wallet can fund.
# Status:  OK (>= 2.5 pauses)   WARNING (1 to 2.5)   CRITICAL (< 1 pause)
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
NUM OF PAUSES = balance / cost of one pauseDiamond() (how many pauses the wallet can fund).
Statuses: OK (>=2.5 pauses)  WARNING (1-2.5)  CRITICAL (<1)  PAUSED  ERROR  SKIP
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

# fmtAmount: show a wei value in native units rounded to 3 significant figures — enough to
# eyeball funding; full 18-digit precision isn't useful here. %g may switch to scientific
# notation for extreme values (e.g. near-zero gas costs).
# Usage: fmtAmount WEI
function fmtAmount() {
  local WEI="$1"
  printf '%.3g' "$(cast from-wei "$WEI")"
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
# Usage: fmtRow NETWORK COST REQUIRED BALANCE PAUSES STATUS
function fmtRow() {
  local NETWORK="$1" COST="$2" REQUIRED="$3" BALANCE="$4" PAUSES="$5" STATUS="$6"
  printf '%s\t%s\t%s\t%s\t%s\t%s' "$NETWORK" "$COST" "$REQUIRED" "$BALANCE" "$PAUSES" "$STATUS"
}

# colorizeStatus: color the trailing STATUS word of each row. Applied AFTER `column -t` so the
# non-printing escape codes can't skew column-width alignment, and only on a TTY so piped or
# redirected output stays plain and parseable.
function colorizeStatus() {
  if [[ ! -t 1 ]]; then
    cat
    return
  fi
  local RED=$'\033[31m' YEL=$'\033[33m' GRN=$'\033[32m' CYN=$'\033[36m' DIM=$'\033[2m' RST=$'\033[0m'
  sed -E \
    -e "s/(CRITICAL)[[:space:]]*\$/${RED}\\1${RST}/" \
    -e "s/(ERROR)[[:space:]]*\$/${RED}\\1${RST}/" \
    -e "s/(WARNING)[[:space:]]*\$/${YEL}\\1${RST}/" \
    -e "s/(PAUSED)[[:space:]]*\$/${CYN}\\1${RST}/" \
    -e "s/(OK)[[:space:]]*\$/${GRN}\\1${RST}/" \
    -e "s/(SKIP)[[:space:]]*\$/${DIM}\\1${RST}/"
}

# checkNetwork: audit ONE network and echo its "<CAT>|<RATIO>|<row>" line to stdout.
# Runs in a background subshell during the parallel sweep, so it must not write back to
# parent-shell state (e.g. HAS_CRITICAL) — the caller derives that from the collected rows.
function checkNetwork() {
  local NETWORK="$1"

  if isTestnetNetwork "$NETWORK" >/dev/null 2>&1 || isTronNetwork "$NETWORK" >/dev/null 2>&1; then
    echo "$CAT_SKIP|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "SKIP")"
    return
  fi
  # output suppressed: isNetworkActive logs "not found" for unknown args, which would
  # otherwise land on stdout and pollute the table.
  if ! isNetworkActive "$NETWORK" >/dev/null 2>&1; then
    echo "$CAT_SKIP|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "SKIP")"
    return
  fi

  # Skip chains with no meaningful native currency (nativeCurrency "N/A") — e.g. tempo, which
  # pays gas in a non-native token, so a native balance vs native gas-cost comparison is moot.
  local SYMBOL
  SYMBOL=$(getValueFromJSONFile "./config/networks.json" "${NETWORK}.nativeCurrency")
  if [[ -z "$SYMBOL" || "$SYMBOL" == "N/A" ]]; then
    echo "$CAT_SKIP|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "SKIP")"
    return
  fi

  local COST RC
  COST=$(estimatePauseCost "$NETWORK")
  RC=$?
  if [[ $RC -eq 2 ]]; then
    echo "$CAT_PAUSED|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "PAUSED")"
    return
  fi
  if [[ $RC -ne 0 || ! "$COST" =~ ^[0-9]+$ || "$COST" == "0" ]]; then
    echo "$CAT_ERROR|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "ERROR")"
    return
  fi

  local RPC_URL BALANCE
  RPC_URL=$(resolveRpc "$NETWORK")
  BALANCE=$(cast balance "$PAUSER" --rpc-url "$RPC_URL" 2>/dev/null)
  if ! [[ "$BALANCE" =~ ^[0-9]+$ ]]; then
    echo "$CAT_ERROR|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "ERROR")"
    return
  fi

  local REQUIRED RATIO STATUS
  REQUIRED=$(echo "$COST * $WARN_MULT_NUM / $WARN_MULT_DEN" | bc)
  RATIO=$(echo "scale=2; $BALANCE / $COST" | bc)
  [[ "$RATIO" == .* ]] && RATIO="0$RATIO"   # bc prints ".40"; make it "0.40"

  if [[ $(echo "$BALANCE < $COST" | bc) -eq 1 ]]; then
    STATUS="CRITICAL"
  elif [[ $(echo "$BALANCE < $REQUIRED" | bc) -eq 1 ]]; then
    STATUS="WARNING"
  else
    STATUS="OK"
  fi

  local COST_N REQ_N BAL_N PAUSES_DISP
  COST_N=$(fmtAmount "$COST")
  REQ_N=$(fmtAmount "$REQUIRED")
  BAL_N=$(fmtAmount "$BALANCE")
  # Display the pause count compactly (scientific for extreme over-funding) but keep the raw
  # RATIO as the sort key so ordering stays exact.
  PAUSES_DISP=$(printf '%g' "$RATIO")

  echo "$CAT_DATA|$RATIO|$(fmtRow "$NETWORK" "${COST_N} ${SYMBOL}" "${REQ_N} ${SYMBOL}" "${BAL_N} ${SYMBOL}" "$PAUSES_DISP" "$STATUS")"
}

# Run the sweep in parallel: networks are independent and most of the time is RPC latency, so
# a sequential loop wastes minutes waiting. Each worker writes its row to a file; we collect
# after `wait`. A backgrounded subshell can't set parent state, so HAS_CRITICAL is derived
# from the collected rows. Progress goes to stderr to keep stdout a clean, pipeable table.
TOTAL=${#NETWORKS[@]}
MAX_JOBS=${MAX_CONCURRENT_JOBS:-10} # shared concurrency knob (see helperFunctions.sh)
RESULT_DIR=$(mktemp -d)
trap 'rm -rf "$RESULT_DIR"' EXIT
echo "Checking pauser-wallet funding on $TOTAL network(s), up to $MAX_JOBS in parallel — reading live gas prices & balances..." >&2

IDX=0
for NETWORK in "${NETWORKS[@]}"; do
  IDX=$((IDX + 1))
  printf '[%d/%d] %s\n' "$IDX" "$TOTAL" "$NETWORK" >&2
  # throttle to MAX_JOBS concurrent workers
  while (($(jobs -rp | wc -l) >= MAX_JOBS)); do wait -n; done
  checkNetwork "$NETWORK" >"$RESULT_DIR/result_$IDX" &
done
wait

for ((I = 1; I <= TOTAL; I++)); do
  [[ -s "$RESULT_DIR/result_$I" ]] && ROWS+=("$(cat "$RESULT_DIR/result_$I")")
done

if printf '%s\n' "${ROWS[@]}" | grep -q 'CRITICAL$'; then
  HAS_CRITICAL=1
fi

# header + sorted rows through one column pipe: sort by category then ratio, strip both keys.
# colorizeStatus runs last so coloring can't affect the column-width calculation.
# pipefail is set, so a failure in any render stage (sort/cut/column/colorize) surfaces as the
# pipeline's exit status; fail loudly rather than printing nothing and still exiting 0.
if ! {
  fmtRow "NETWORK" "COST(1x)" "REQUIRED(2.5x)" "BALANCE" "NUM OF PAUSES" "STATUS"
  printf '\n'
  printf '%s\n' "${ROWS[@]}" | sort -t'|' -k1,1n -k2,2g | cut -d'|' -f3-
} | column -t -s "$(printf '\t')" | colorizeStatus; then
  error "failed to render results table" >&2
  exit 1
fi

echo "NUM OF PAUSES = balance ÷ cost of one pauseDiamond() · OK ≥2.5 · WARNING 1–2.5 · CRITICAL <1" >&2

if [[ $HAS_CRITICAL -eq 1 ]]; then
  # Summary alert to stderr (keeps stdout = table only); exit code is the machine signal.
  echo "" >&2
  warning "one or more networks are CRITICAL (pauser cannot afford a single pause)" >&2
  exit 1
fi
exit 0
