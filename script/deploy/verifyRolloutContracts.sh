#!/bin/bash

# verifyRolloutContracts.sh
#
# Re-verifies the contracts a rollout left unverified. One MongoDB query loads every record
# of CONTRACT at VERSION; on each given network the record whose address matches
# deployments/<network>.json is verified on the explorer (with the compiler settings it was
# deployed with) unless it is already flagged, and the flag is flipped once it passes.
#
# Note: no `set -euo pipefail` on purpose - the sourced helperFunctions.sh relies on `$?`
# checks and retry loops that strict mode would abort (same as scriptMaster.sh).

# the filter CLI's maximum; its default of 50 would silently truncate the selection
VERIFY_ROLLOUT_QUERY_LIMIT=1000

function printVerifyRolloutUsage() {
  cat <<'EOF'
Usage: bash script/deploy/verifyRolloutContracts.sh \
  ENVIRONMENT CONTRACT VERSION NETWORK [NETWORK...]

On each NETWORK, finds the MongoDB record of CONTRACT at VERSION whose address matches
deployments/<network>.json (deployments/<network>.staging.json in staging). If it is still
verified:false, verifies it on the block explorer with the solc/evm/optimizer settings the
record carries and writes verified:true. Networks run concurrently, up to
MAX_CONCURRENT_JOBS (default 10). Tron networks and networks in
DO_NOT_VERIFY_IN_THESE_NETWORKS are reported as skipped and left untouched.

Arguments:
  ENVIRONMENT          production or staging
  CONTRACT             contract name (e.g. AcrossFacetV3)
  VERSION              the version this rollout deployed (e.g. 1.2.0, no leading v)
  NETWORK              one or more networks.json keys the rollout deployed to

Exit code: 0 when every network's record is verified and flagged (or was already);
1 on an unknown network, a failed query, a network with no record of VERSION at its
deployment-file address, or any failed verify or flag update.

Example:
  bash script/deploy/verifyRolloutContracts.sh production AcrossFacetV3 1.2.0 base arbitrum
EOF
}

# queryRolloutRecords: Fetch every MongoDB record of one contract version, across all
# networks and verification states, in a single query.
#
# Usage: queryRolloutRecords ENVIRONMENT CONTRACT VERSION
#   ENVIRONMENT - production or staging
#   CONTRACT    - contract name
#   VERSION     - contract version
#
# Returns: the JSON array of records on stdout and 0; 1 with an error when the query
# exits non-zero, prints no valid JSON array, or fills the limit (a possibly truncated
# selection is never treated as complete)
# Example: queryRolloutRecords "production" "AcrossFacetV3" "1.2.0"
function queryRolloutRecords() {
  local ENVIRONMENT="$1"
  local CONTRACT="$2"
  local VERSION="$3"
  local WHAT="MongoDB query for $CONTRACT $VERSION records"

  local OUTPUT
  OUTPUT=$(bunx tsx script/deploy/query-deployment-logs.ts filter \
    --env "$ENVIRONMENT" \
    --contract "$CONTRACT" \
    --version "$VERSION" \
    --limit "$VERIFY_ROLLOUT_QUERY_LIMIT" \
    --no-use-cache \
    --format json)
  local EXIT_CODE=$?
  if [[ $EXIT_CODE -ne 0 ]]; then
    error "$WHAT failed (exit $EXIT_CODE) - check MONGODB_URI and the lifi-connect tunnel" >&2
    return 1
  fi

  # strip leading log lines; a "[info] ..." line must not be taken for the array's start
  OUTPUT=$(echo "$OUTPUT" | sed -nE '/^\[[[:space:]]*($|[]{])/,$p')
  if ! echo "$OUTPUT" | jq -e 'type == "array"' >/dev/null 2>&1; then
    error "$WHAT returned invalid JSON - nothing was verified; re-run once it works" >&2
    return 1
  fi

  local COUNT
  COUNT=$(echo "$OUTPUT" | jq 'length')
  if [[ $COUNT -ge $VERIFY_ROLLOUT_QUERY_LIMIT ]]; then
    error "$WHAT hit the $COUNT-record limit - may be truncated, nothing was verified" >&2
    return 1
  fi

  echo "$OUTPUT"
}

# findUnknownNetworks: Print each NETWORK that is not a key of networks.json.
#
# Usage: findUnknownNetworks NETWORK [NETWORK...]
#   NETWORK - network names to check
#
# Returns: the unknown names, one per line (nothing when all are known); always 0
# Example: findUnknownNetworks base arbitrm
function findUnknownNetworks() {
  jq -r '$ARGS.positional - keys | .[]' --args "$@" <"$NETWORKS_JSON_FILE_PATH"
}

# writeRolloutResult: Record one network's outcome for the parent to aggregate after wait.
#
# Usage: writeRolloutResult RESULT_FILE STATUS MESSAGE
#   RESULT_FILE - per-network result file
#   STATUS      - ok, skip or fail
#   MESSAGE     - one-line reason shown in the summary
#
# Returns: 0
# Example: writeRolloutResult "$DIR/base.result" fail "explorer verification"
function writeRolloutResult() {
  printf '%s\t%s\n' "$2" "$3" >"$1"
}

# verifyRolloutNetwork: Verify and flag one network's record of a rollout. Run as a
# background worker: it writes its outcome to RESULT_FILE instead of returning it.
#
# Usage: verifyRolloutNetwork ENVIRONMENT CONTRACT VERSION NETWORK RECORDS RESULT_FILE
#   ENVIRONMENT - production or staging
#   CONTRACT    - contract name
#   VERSION     - contract version the rollout deployed
#   NETWORK     - network to verify on
#   RECORDS     - JSON array of this network's records of CONTRACT at VERSION
#   RESULT_FILE - where the outcome is written (see writeRolloutResult)
#
# Routing/Behavior:
#   - Tron or excluded network: skip, before verifyContract (which returns 1 for an
#     excluded network and would otherwise count it as a failure)
#   - no deployment-file address, or no record at that address: fail
#   - record at that address already verified: ok, nothing sent
#   - otherwise: verify with the record's compiler settings, then flag every unverified
#     spelling of the address via mark-verified
#
# Returns: 0
# Example: verifyRolloutNetwork production AcrossFacetV3 1.2.0 base "$JSON" "$DIR/base.result"
function verifyRolloutNetwork() {
  local ENVIRONMENT="$1" CONTRACT="$2" VERSION="$3" NETWORK="$4" RECORDS="$5" RESULT="$6"

  if isTronNetwork "$NETWORK" || isNetworkExcludedFromVerification "$NETWORK"; then
    warning "$NETWORK: excluded from forge verification - left unverified"
    writeRolloutResult "$RESULT" skip "excluded from verification"
    return 0
  fi

  local DEPLOYED_ADDRESS
  if ! DEPLOYED_ADDRESS=$(getContractAddressFromDeploymentLogs \
    "$NETWORK" "$ENVIRONMENT" "$CONTRACT"); then
    error "$NETWORK: no $CONTRACT address in its deployment file"
    writeRolloutResult "$RESULT" fail "no $CONTRACT address in deployment file"
    return 0
  fi

  local MATCHES
  MATCHES=$(echo "$RECORDS" | jq -c --arg ADDRESS "$DEPLOYED_ADDRESS" \
    '[.[] | select((.address | ascii_downcase) == ($ADDRESS | ascii_downcase))]')
  echo "$RECORDS" | jq -r --arg ADDRESS "$DEPLOYED_ADDRESS" \
    '.[] | select((.address | ascii_downcase) != ($ADDRESS | ascii_downcase))
      | select(.verified != true) | .address' |
    while read -r STALE_ADDRESS; do
      warning "$NETWORK: unverified $STALE_ADDRESS is not the deployed address - ignored"
    done

  if [[ $(echo "$MATCHES" | jq 'length') -eq 0 ]]; then
    error "$NETWORK: no $CONTRACT $VERSION record at deployed $DEPLOYED_ADDRESS - check VERSION"
    writeRolloutResult "$RESULT" fail "no $VERSION record at $DEPLOYED_ADDRESS"
    return 0
  fi

  local UNVERIFIED
  UNVERIFIED=$(echo "$MATCHES" | jq -c '[.[] | select(.verified != true)]')
  if [[ $(echo "$UNVERIFIED" | jq 'length') -eq 0 ]]; then
    writeRolloutResult "$RESULT" ok "already verified"
    return 0
  fi

  local -a SETTINGS
  mapfile -t SETTINGS < <(echo "$UNVERIFIED" | jq -r '.[0]
    | (.constructorArgs // ""), (.solcVersion // ""), (.evmVersion // ""),
      (.optimizerRuns // "")')
  echo "[info] verifying $CONTRACT $VERSION on $NETWORK at $DEPLOYED_ADDRESS"
  # subshell: the verify helpers assign CONTRACT/VERSION/... without `local`, which
  # under bash's dynamic scoping would overwrite this function's locals
  if ! (verifyContract "$NETWORK" "$CONTRACT" "$DEPLOYED_ADDRESS" "${SETTINGS[@]}"); then
    error "$NETWORK: explorer verification failed for $DEPLOYED_ADDRESS"
    writeRolloutResult "$RESULT" fail "$DEPLOYED_ADDRESS (explorer verification)"
    return 0
  fi

  local RECORD_ADDRESS
  for RECORD_ADDRESS in $(echo "$UNVERIFIED" | jq -r '[.[].address] | unique | .[]'); do
    if ! bunx tsx script/deploy/update-deployment-logs.ts mark-verified \
      --env "$ENVIRONMENT" \
      --network "$NETWORK" \
      --contract "$CONTRACT" \
      --address "$RECORD_ADDRESS"; then
      error "$NETWORK: verified on the explorer but writing verified:true to MongoDB failed"
      writeRolloutResult "$RESULT" fail "$DEPLOYED_ADDRESS (MongoDB verified flag)"
      return 0
    fi
  done
  success "$NETWORK: $CONTRACT $VERSION verified and flagged"
  writeRolloutResult "$RESULT" ok "verified and flagged"
}

# summarizeRolloutResults: Print each network's worker log and outcome, in argument order.
#
# Usage: summarizeRolloutResults RESULT_DIR NETWORK [NETWORK...]
#   RESULT_DIR - directory holding <network>.log and <network>.result
#   NETWORK    - networks that were processed
#
# Returns: 0 if no network failed; 1 otherwise (a missing result counts as a failure)
# Example: summarizeRolloutResults "$DIR" base arbitrum
function summarizeRolloutResults() {
  local RESULT_DIR="$1"
  shift
  local NETWORK STATUS MESSAGE
  local FAILED=()
  for NETWORK in "$@"; do
    cat "$RESULT_DIR/$NETWORK.log" 2>/dev/null
    STATUS="fail"
    MESSAGE="worker produced no result"
    [[ -f "$RESULT_DIR/$NETWORK.result" ]] &&
      IFS=$'\t' read -r STATUS MESSAGE <"$RESULT_DIR/$NETWORK.result"
    [[ "$STATUS" == "fail" ]] && FAILED+=("$NETWORK: $MESSAGE")
  done

  if [[ ${#FAILED[@]} -gt 0 ]]; then
    error "${#FAILED[@]} of $# network(s) failed:"
    printf '  - %s\n' "${FAILED[@]}"
    return 1
  fi
  return 0
}

# verifyRolloutContracts: Verify and flag the deployed record of one rollout on each of
# NETWORKS, one background worker per network, throttled by MAX_CONCURRENT_JOBS.
#
# Usage: verifyRolloutContracts ENVIRONMENT CONTRACT VERSION NETWORK [NETWORK...]
#   ENVIRONMENT - production or staging
#   CONTRACT    - contract name
#   VERSION     - contract version the rollout deployed
#   NETWORK     - networks the rollout deployed to
#
# Returns: 0 if every network is verified and flagged, already was, or is excluded;
# 1 on invalid arguments, a failed query, or any failed network
# Example: verifyRolloutContracts "production" "AcrossFacetV3" "1.2.0" base arbitrum
function verifyRolloutContracts() {
  if [[ $# -lt 4 ]]; then
    printVerifyRolloutUsage
    return 1
  fi
  local ENVIRONMENT="$1" CONTRACT="$2" VERSION="$3"
  shift 3
  local NETWORKS=("$@")

  if [[ "$ENVIRONMENT" != "production" && "$ENVIRONMENT" != "staging" ]]; then
    error "ENVIRONMENT must be production or staging, got '$ENVIRONMENT'"
    return 1
  fi
  local CONCURRENCY="${MAX_CONCURRENT_JOBS:-10}"
  if [[ ! "$CONCURRENCY" =~ ^[1-9][0-9]*$ ]]; then
    error "MAX_CONCURRENT_JOBS must be a positive integer - got '$CONCURRENCY'"
    return 1
  fi
  local UNKNOWN
  UNKNOWN=$(findUnknownNetworks "${NETWORKS[@]}")
  if [[ -n "$UNKNOWN" ]]; then
    error "not in $NETWORKS_JSON_FILE_PATH: $(echo "$UNKNOWN" | paste -sd ' ' -)"
    return 1
  fi

  local RECORDS
  RECORDS=$(queryRolloutRecords "$ENVIRONMENT" "$CONTRACT" "$VERSION") || return 1

  local RESULT_DIR
  RESULT_DIR=$(mktemp -d)
  local NETWORK NETWORK_RECORDS
  for NETWORK in "${NETWORKS[@]}"; do
    while [[ $(jobs -rp | wc -l | tr -d ' ') -ge $CONCURRENCY ]]; do
      sleep 1
    done
    NETWORK_RECORDS=$(echo "$RECORDS" | jq -c --arg NETWORK "$NETWORK" \
      '[.[] | select(.network == $NETWORK)]')
    verifyRolloutNetwork "$ENVIRONMENT" "$CONTRACT" "$VERSION" "$NETWORK" \
      "$NETWORK_RECORDS" "$RESULT_DIR/$NETWORK.result" \
      </dev/null >"$RESULT_DIR/$NETWORK.log" 2>&1 &
  done
  wait

  local STATUS=0
  summarizeRolloutResults "$RESULT_DIR" "${NETWORKS[@]}" || STATUS=1
  rm -rf "$RESULT_DIR"
  [[ $STATUS -eq 0 ]] &&
    success "$CONTRACT $VERSION: all ${#NETWORKS[@]} network(s) verified, flagged or skipped"
  return $STATUS
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    printVerifyRolloutUsage
    exit 0
  fi

  # all framework paths are relative to the repo root
  if [[ ! -f "script/helperFunctions.sh" ]]; then
    echo "[error] run this script from the repository root"
    exit 1
  fi

  if [[ ! -f ".env" ]]; then
    echo "[error] .env not found in repository root - copy .env.example to .env"
    exit 1
  fi

  # shellcheck disable=SC1091
  source script/helperFunctions.sh

  verifyRolloutContracts "$@"
  exit $?
fi
