#!/bin/bash

# verifyRolloutContracts.sh
#
# Re-verifies the contracts a rollout left unverified. One MongoDB query selects the
# records of CONTRACT at VERSION still marked verified:false; only records on the given
# networks whose address matches deployments/<network>.json are verified on the explorer,
# and the flag is flipped for each one that passes. A successful inline verify during the
# deploy already set the flag, so the selection is normally empty or a handful of records.
#
# Note: no `set -euo pipefail` on purpose - the sourced helperFunctions.sh relies on `$?`
# checks and retry loops that strict mode would abort (same as scriptMaster.sh).

# the filter CLI's maximum; its default of 50 would silently truncate the selection
VERIFY_ROLLOUT_QUERY_LIMIT=1000

function printVerifyRolloutUsage() {
  cat <<'EOF'
Usage: bash script/deploy/verifyRolloutContracts.sh ENVIRONMENT CONTRACT VERSION NETWORK [NETWORK...]

Verifies on the block explorer every record of CONTRACT at VERSION that MongoDB still
marks verified:false on one of the given networks, provided its address matches
deployments/<network>.json (deployments/<network>.staging.json in staging), and writes
verified:true for each one that passes. Networks in DO_NOT_VERIFY_IN_THESE_NETWORKS are
reported as excluded and left untouched.

Arguments:
  ENVIRONMENT          production or staging
  CONTRACT             contract name (e.g. AcrossFacetV3)
  VERSION              the version this rollout deployed
  NETWORK              one or more network names the rollout deployed to

Exit code: 0 when every selected record was verified and flagged (or none needed it),
1 when the query failed or any record failed to verify or flag.

Example:
  bash script/deploy/verifyRolloutContracts.sh production AcrossFacetV3 1.2.0 base arbitrum
EOF
}

# queryUnverifiedRolloutRecords: Fetch the MongoDB records of one contract version that
# are still marked verified:false, across all networks, in a single query.
#
# Usage: queryUnverifiedRolloutRecords ENVIRONMENT CONTRACT VERSION
#   ENVIRONMENT - production or staging
#   CONTRACT    - contract name
#   VERSION     - contract version
#
# Returns: the JSON array of records on stdout and 0; 1 with an error when the query
# exits non-zero, prints no valid JSON array, or fills the limit (a possibly truncated
# selection is never treated as complete)
# Example: queryUnverifiedRolloutRecords "production" "AcrossFacetV3" "1.2.0"
function queryUnverifiedRolloutRecords() {
  local ENVIRONMENT="$1"
  local CONTRACT="$2"
  local VERSION="$3"

  local OUTPUT
  OUTPUT=$(bunx tsx script/deploy/query-deployment-logs.ts filter \
    --env "$ENVIRONMENT" \
    --contract "$CONTRACT" \
    --version "$VERSION" \
    --verified false \
    --limit "$VERIFY_ROLLOUT_QUERY_LIMIT" \
    --no-use-cache \
    --format json)
  local EXIT_CODE=$?
  if [[ $EXIT_CODE -ne 0 ]]; then
    error "MongoDB query for unverified $CONTRACT $VERSION records failed (exit $EXIT_CODE) - check that MONGODB_URI is set and the lifi-connect tunnel is up, then re-run" >&2
    return 1
  fi

  # strip leading log lines; a "[info] ..." line must not be taken for the array's start
  OUTPUT=$(echo "$OUTPUT" | sed -nE '/^\[[[:space:]]*($|[]{])/,$p')
  if ! echo "$OUTPUT" | jq -e 'type == "array"' >/dev/null 2>&1; then
    error "MongoDB query for unverified $CONTRACT $VERSION records returned invalid JSON - the selection is unknown, so nothing was verified; re-run once the query works" >&2
    return 1
  fi

  local COUNT
  COUNT=$(echo "$OUTPUT" | jq 'length')
  if [[ $COUNT -ge $VERIFY_ROLLOUT_QUERY_LIMIT ]]; then
    error "MongoDB query returned $COUNT records, the query limit - the selection may be truncated, so nothing was verified" >&2
    return 1
  fi

  echo "$OUTPUT"
}

# verifyRolloutContracts: Verify and flag the unverified records of one rollout.
# Selection keeps a record only if its network is one of NETWORKS and its address equals
# the network's deployment-file address (case-insensitive), so a superseded or stale
# record is never touched. The exclusion gate runs before verifyContract, which returns
# 1 for an excluded network too and would otherwise count it as a failure. Every
# selected record is processed even after a failure; failures are listed at the end.
#
# Usage: verifyRolloutContracts ENVIRONMENT CONTRACT VERSION NETWORK [NETWORK...]
#   ENVIRONMENT - production or staging
#   CONTRACT    - contract name
#   VERSION     - contract version the rollout deployed
#   NETWORK     - networks the rollout deployed to
#
# Returns: 0 if every selected record was verified and flagged, or none needed it;
# 1 on invalid arguments, a failed query, or any failed verify or flag update
# Example: verifyRolloutContracts "production" "AcrossFacetV3" "1.2.0" base arbitrum
function verifyRolloutContracts() {
  if [[ $# -lt 4 ]]; then
    printVerifyRolloutUsage
    return 1
  fi
  local ENVIRONMENT="$1"
  local CONTRACT="$2"
  local VERSION="$3"
  shift 3
  local NETWORKS=("$@")

  if [[ "$ENVIRONMENT" != "production" && "$ENVIRONMENT" != "staging" ]]; then
    error "ENVIRONMENT must be production or staging, got '$ENVIRONMENT'"
    return 1
  fi

  local RECORDS
  RECORDS=$(queryUnverifiedRolloutRecords "$ENVIRONMENT" "$CONTRACT" "$VERSION") || return 1

  local SELECTION=()
  local NETWORK
  for NETWORK in "${NETWORKS[@]}"; do
    local NETWORK_RECORDS
    NETWORK_RECORDS=$(echo "$RECORDS" | jq -r \
      --arg NETWORK "$NETWORK" --arg CONTRACT "$CONTRACT" --arg VERSION "$VERSION" \
      '.[] | select(.network == $NETWORK and .contractName == $CONTRACT
        and .version == $VERSION)
        | "\(.address)\t\(.constructorArgs // "")"')
    [[ -z "$NETWORK_RECORDS" ]] && continue

    local DEPLOYED_ADDRESS
    if ! DEPLOYED_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$CONTRACT"); then
      warning "$NETWORK: unverified $CONTRACT $VERSION record but no $CONTRACT address in its deployment file - skipped"
      continue
    fi

    local RECORD_ADDRESS
    local CONSTRUCTOR_ARGS
    while IFS=$'\t' read -r RECORD_ADDRESS CONSTRUCTOR_ARGS; do
      if [[ "$(echo "$RECORD_ADDRESS" | tr '[:upper:]' '[:lower:]')" != "$(echo "$DEPLOYED_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]]; then
        warning "$NETWORK: record address $RECORD_ADDRESS does not match deployed $DEPLOYED_ADDRESS - skipped"
        continue
      fi
      if isNetworkExcludedFromVerification "$NETWORK"; then
        warning "$NETWORK: excluded by DO_NOT_VERIFY_IN_THESE_NETWORKS - $RECORD_ADDRESS left unverified"
        continue
      fi
      SELECTION+=("$NETWORK"$'\t'"$DEPLOYED_ADDRESS"$'\t'"$RECORD_ADDRESS"$'\t'"$CONSTRUCTOR_ARGS")
    done <<<"$NETWORK_RECORDS"
  done

  if [[ ${#SELECTION[@]} -eq 0 ]]; then
    success "$CONTRACT $VERSION: nothing needed re-verifying on the given networks"
    return 0
  fi

  local FAILED=()
  local ENTRY
  for ENTRY in "${SELECTION[@]}"; do
    IFS=$'\t' read -r NETWORK DEPLOYED_ADDRESS RECORD_ADDRESS CONSTRUCTOR_ARGS <<<"$ENTRY"
    echo "[info] verifying $CONTRACT $VERSION on $NETWORK at $DEPLOYED_ADDRESS"
    # subshell: the verify helpers assign CONTRACT/VERSION/... without `local`, which
    # under bash's dynamic scoping would overwrite this function's locals mid-loop
    if ! (verifyContract "$NETWORK" "$CONTRACT" "$DEPLOYED_ADDRESS" "$CONSTRUCTOR_ARGS"); then
      error "$NETWORK: explorer verification failed for $DEPLOYED_ADDRESS"
      FAILED+=("$NETWORK $DEPLOYED_ADDRESS (explorer verification)")
      continue
    fi
    if ! bunx tsx script/deploy/update-deployment-logs.ts update \
      --env "$ENVIRONMENT" \
      --network "$NETWORK" \
      --contract "$CONTRACT" \
      --version "$VERSION" \
      --address "$RECORD_ADDRESS" \
      --verified true; then
      error "$NETWORK: verified on the explorer but writing verified:true to MongoDB failed"
      FAILED+=("$NETWORK $DEPLOYED_ADDRESS (MongoDB verified flag)")
      continue
    fi
    success "$NETWORK: $CONTRACT $VERSION verified and flagged"
  done

  if [[ ${#FAILED[@]} -gt 0 ]]; then
    error "${#FAILED[@]} of ${#SELECTION[@]} record(s) failed:"
    printf '  - %s\n' "${FAILED[@]}"
    return 1
  fi
  success "$CONTRACT $VERSION: ${#SELECTION[@]} record(s) verified and flagged"
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    printVerifyRolloutUsage
    exit 0
  fi

  # all framework paths are relative to the repo root
  if [[ ! -f "script/helperFunctions.sh" ]]; then
    echo "[error] this script must be run from the repository root (e.g. bash script/deploy/verifyRolloutContracts.sh ...)"
    exit 1
  fi

  if [[ ! -f ".env" ]]; then
    echo "[error] .env file not found in repository root - copy .env.example to .env and configure it"
    exit 1
  fi

  # shellcheck disable=SC1091
  source script/helperFunctions.sh

  verifyRolloutContracts "$@"
  exit $?
fi
