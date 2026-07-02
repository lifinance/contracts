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
# Chains whose gas price is 0 (free gas, e.g. nibiru) report OK with NUM OF PAUSES "inf" —
# a pause costs nothing there, so any balance affords unlimited pauses.
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
Free-gas chains (gas price 0) report OK with NUM OF PAUSES "inf".
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

# Sort key for free-gas rows (gas price 0 → infinite pauses): 1e28, larger than any real ratio
# (balance in wei tops out around 1e24 even against a 1-wei cost), so they land last among the
# data rows. A plain digit string keeps `sort -g` portable (no reliance on "inf" parsing).
readonly FREE_GAS_SORT_RATIO=9999999999999999999999999999

# Retry transient RPC read failures (throttling/timeouts) a few times before marking a network
# ERROR, so a brief blip on one chain doesn't show as a spurious ERROR row. (estimatePauseCost
# retries its own estimate/gas-price reads; this covers the balance read here.)
readonly RPC_READ_MAX_ATTEMPTS=3
readonly RPC_READ_RETRY_SLEEP_SECONDS=2

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
  # Explicitly named networks must exist — fail fast on a typo instead of silently emitting a
  # SKIP row and exiting 0 (a targeted audit that audits nothing must not look clean).
  for NET in "${NETWORKS[@]}"; do
    if ! jq -e --arg n "$NET" '.[$n] != null' ./config/networks.json >/dev/null 2>&1; then
      error "unknown network '$NET' — not found in networks.json"
      exit 1
    fi
  done
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

# fmtRow: join the 7 table columns with tabs (column -t aligns them at the end). STATUS stays last
# so colorizeStatus can match it at end-of-line.
# Usage: fmtRow NETWORK COST REQUIRED BALANCE PAUSES TOPUP STATUS
function fmtRow() {
  local NETWORK="$1" COST="$2" REQUIRED="$3" BALANCE="$4" PAUSES="$5" TOPUP="$6" STATUS="$7"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s' "$NETWORK" "$COST" "$REQUIRED" "$BALANCE" "$PAUSES" "$TOPUP" "$STATUS"
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
    echo "$CAT_SKIP|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "-" "SKIP")"
    return
  fi
  # output suppressed: isNetworkActive logs "not found" for unknown args, which would
  # otherwise land on stdout and pollute the table.
  if ! isNetworkActive "$NETWORK" >/dev/null 2>&1; then
    echo "$CAT_SKIP|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "-" "SKIP")"
    return
  fi

  # Skip chains with no meaningful native currency (nativeCurrency "N/A") — e.g. tempo, which
  # pays gas in a non-native token, so a native balance vs native gas-cost comparison is moot.
  local SYMBOL
  SYMBOL=$(getValueFromJSONFile "./config/networks.json" "${NETWORK}.nativeCurrency")
  if [[ -z "$SYMBOL" || "$SYMBOL" == "N/A" ]]; then
    echo "$CAT_SKIP|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "-" "SKIP")"
    return
  fi

  local COST RC
  COST=$(estimatePauseCost "$NETWORK")
  RC=$?
  if [[ $RC -eq 2 ]]; then
    echo "$CAT_PAUSED|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "-" "PAUSED")"
    return
  fi
  # COST 0 is NOT an error: estimatePauseCost rejects a zero gas ESTIMATE, so 0 can only mean
  # the chain's gas PRICE is 0 (free gas) — handled after the balance read below.
  if [[ $RC -ne 0 || ! "$COST" =~ ^[0-9]+$ ]]; then
    echo "$CAT_ERROR|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "-" "ERROR")"
    return
  fi

  local RPC_URL BALANCE BAL_ATTEMPT=1
  RPC_URL=$(resolveRpc "$NETWORK")
  while :; do
    BALANCE=$(cast balance "$PAUSER" --rpc-url "$RPC_URL" 2>/dev/null)
    [[ "$BALANCE" =~ ^[0-9]+$ ]] && break
    if [[ $BAL_ATTEMPT -ge $RPC_READ_MAX_ATTEMPTS ]]; then
      echo "$CAT_ERROR|0|$(fmtRow "$NETWORK" "-" "-" "-" "-" "-" "ERROR")"
      return
    fi
    sleep "$RPC_READ_RETRY_SLEEP_SECONDS"
    BAL_ATTEMPT=$((BAL_ATTEMPT + 1))
  done

  # Free-gas chain: a pause costs nothing, so any balance affords unlimited pauses — report OK
  # (a data row, so it counts as "evaluated" for the blind-sweep guard). Actual RPC/estimation
  # failures still surface as ERROR above and via the balance-read retry loop.
  if [[ "$COST" == "0" ]]; then
    echo "$CAT_DATA|$FREE_GAS_SORT_RATIO|$(fmtRow "$NETWORK" "free gas" "-" "$(fmtAmount "$BALANCE") ${SYMBOL}" "inf" "-" "OK")"
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

  # TOP-UP TO OK: native amount to send to reach OK (balance ≥ REQUIRED = 2.5× cost). Positive for
  # CRITICAL/WARNING (balance < REQUIRED); "-" for OK (already funded).
  local TOPUP_WEI TOPUP_DISP
  TOPUP_WEI=$(echo "$REQUIRED - $BALANCE" | bc)
  if [[ $(echo "$TOPUP_WEI > 0" | bc) -eq 1 ]]; then
    TOPUP_DISP="$(fmtAmount "$TOPUP_WEI") ${SYMBOL}"
  else
    TOPUP_DISP="-"
  fi

  local COST_N REQ_N BAL_N PAUSES_DISP
  COST_N=$(fmtAmount "$COST")
  REQ_N=$(fmtAmount "$REQUIRED")
  BAL_N=$(fmtAmount "$BALANCE")
  # Display the pause count compactly (scientific for extreme over-funding) but keep the raw
  # RATIO as the sort key so ordering stays exact.
  PAUSES_DISP=$(printf '%g' "$RATIO")

  echo "$CAT_DATA|$RATIO|$(fmtRow "$NETWORK" "${COST_N} ${SYMBOL}" "${REQ_N} ${SYMBOL}" "${BAL_N} ${SYMBOL}" "$PAUSES_DISP" "$TOPUP_DISP" "$STATUS")"
}

# Run the sweep in parallel: networks are independent and most of the time is RPC latency, so
# a sequential loop wastes minutes waiting. Each worker writes its row to a file; we collect
# after `wait`. A backgrounded subshell can't set parent state, so HAS_CRITICAL is derived
# from the collected rows. Progress goes to stderr to keep stdout a clean, pipeable table.
TOTAL=${#NETWORKS[@]}
MAX_JOBS=${MAX_CONCURRENT_JOBS:-10} # shared concurrency knob (see helperFunctions.sh)
# guard against MAX_CONCURRENT_JOBS=0 / non-numeric, which would spin the throttle loop forever
[[ "$MAX_JOBS" =~ ^[1-9][0-9]*$ ]] || MAX_JOBS=10
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
  fmtRow "NETWORK" "COST(1x)" "REQUIRED(2.5x)" "BALANCE" "NUM OF PAUSES" "TOP-UP TO OK" "STATUS"
  printf '\n'
  printf '%s\n' "${ROWS[@]}" | sort -t'|' -k1,1n -k2,2g | cut -d'|' -f3-
} | column -t -s "$(printf '\t')" | colorizeStatus; then
  error "failed to render results table" >&2
  exit 1
fi

echo "NUM OF PAUSES = balance ÷ cost of one pauseDiamond() · OK ≥2.5 · WARNING 1–2.5 · CRITICAL <1 · free gas (price 0) = inf" >&2

# Blind-sweep guard: if we audited in-scope networks but EVERY one returned ERROR — no
# OK/WARNING/CRITICAL/PAUSED answer anywhere (e.g. a broad RPC outage, or a misconfigured pauser
# making every estimate revert) — the check assessed nothing, so fail rather than report a
# false-green "all fine". A few ERRORs alongside real answers do NOT trip this (one flaky RPC
# shouldn't page). Categories: 0=ERROR, 1=DATA(OK/WARNING/CRITICAL), 2=PAUSED, 3=SKIP.
ERROR_COUNT=$(printf '%s\n' "${ROWS[@]}" | grep -cE '^0[|]')
EVALUATED_COUNT=$(printf '%s\n' "${ROWS[@]}" | grep -cE '^[12][|]')
if [[ "$ERROR_COUNT" -gt 0 && "$EVALUATED_COUNT" -eq 0 ]]; then
  echo "" >&2
  error "every audited network returned ERROR ($ERROR_COUNT) — funding could not be assessed on any chain (RPC/estimation failures)" >&2
  exit 1
fi

if [[ $HAS_CRITICAL -eq 1 ]]; then
  # Summary alert to stderr (keeps stdout = table only); exit code is the machine signal.
  echo "" >&2
  warning "one or more networks are CRITICAL (pauser cannot afford a single pause)" >&2
  exit 1
fi
exit 0
