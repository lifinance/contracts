#!/bin/bash

# verifyNetworkContracts.sh
#
# Verify every contract in deployments/<NETWORK>[.staging].json on the network's block
# explorer via verifyContract (no constructor args — blockscout/sourcify match runtime
# bytecode). Does not touch the MongoDB `verified` flag; callers write that back separately.
#
# Note: no `set -euo pipefail` on purpose — the sourced deploy framework relies
# on `$?` checks and retry loops that strict mode would abort.

function printVerifyNetworkContractsUsage() {
  cat <<'EOF'
Usage: ./script/tasks/verifyNetworkContracts.sh NETWORK [ENVIRONMENT]

Arguments:
  NETWORK       network name from config/networks.json
  ENVIRONMENT   production (default) | staging — selects deployments/<NETWORK>[.staging].json

Exit codes:
  0  every contract in the deployment file verified
  1  usage error, unreadable/empty deployment file, or one or more failed verifications
  2  NETWORK is in DO_NOT_VERIFY_IN_THESE_NETWORKS — nothing was verified

Examples:
  ./script/tasks/verifyNetworkContracts.sh base
  ./script/tasks/verifyNetworkContracts.sh base staging
EOF
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  NETWORK="${1:-}"
  ENVIRONMENT="${2:-production}"
  if [[ -z "$NETWORK" || $# -gt 2 ]] ||
    [[ "$ENVIRONMENT" != "production" && "$ENVIRONMENT" != "staging" ]]; then
    printVerifyNetworkContractsUsage >&2
    exit 1
  fi

  # shellcheck disable=SC1091
  source script/helperFunctions.sh

  # verifyContract also returns 1 for an excluded network, which the failure count below
  # cannot tell apart from a real failure — so excluded networks exit early with a distinct code
  if isNetworkExcludedFromVerification "$NETWORK"; then
    echo "${NETWORK} is in DO_NOT_VERIFY_IN_THESE_NETWORKS — nothing to verify"
    exit 2
  fi

  DEPLOYMENTS="deployments/${NETWORK}.$(getFileSuffix "$ENVIRONMENT")json"
  # command substitution (not `< <(jq …)`) so a missing/malformed file fails instead of
  # feeding the loop nothing and exiting 0
  if ! DEPLOYED_CONTRACTS=$(jq -r 'to_entries[]
    | select(.value != null and .value != "" and .value != "0x")
    | "\(.key)\t\(.value)"' "$DEPLOYMENTS"); then
    error "Cannot read ${DEPLOYMENTS} — missing or not valid JSON"
    exit 1
  fi
  if [[ -z "$DEPLOYED_CONTRACTS" ]]; then
    error "${DEPLOYMENTS} lists no contracts"
    exit 1
  fi

  FAILED=0
  while IFS=$'\t' read -r CONTRACT ADDRESS; do
    echo "Verifying ${CONTRACT} @ ${ADDRESS}"
    if ! verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" ""; then
      echo "FAILED: ${CONTRACT} @ ${ADDRESS}"
      FAILED=$((FAILED + 1))
    fi
  done <<<"$DEPLOYED_CONTRACTS"

  if [[ "$FAILED" -ne 0 ]]; then
    error "${FAILED} contract(s) failed verification on ${NETWORK}"
    exit 1
  fi
  success "All contracts in ${DEPLOYMENTS} verified"
fi
