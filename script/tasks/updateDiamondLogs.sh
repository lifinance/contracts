#!/bin/bash

# updateDiamondLogs.sh
#
# Regenerate deployments/<NETWORK>.diamond[.staging].json from the diamond's on-chain
# loupe and periphery registry. Thin entry point for updateDiamondLogs so callers
# (agents, zsh sessions) don't have to source helperFunctions.sh themselves.
#
# Note: no `set -euo pipefail` on purpose — the sourced deploy framework relies
# on `$?` checks and retry loops that strict mode would abort.

function printUpdateDiamondLogsUsage() {
  cat <<'EOF'
Usage: ./script/tasks/updateDiamondLogs.sh ENVIRONMENT [NETWORK...]

Arguments:
  ENVIRONMENT   production | staging
  NETWORK       one or more network names from config/networks.json
                (omit to update every included network)

Examples:
  ./script/tasks/updateDiamondLogs.sh production xlayer
  ./script/tasks/updateDiamondLogs.sh production arbitrum base
EOF
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  ENVIRONMENT="${1:-}"
  if [[ "$ENVIRONMENT" != "production" && "$ENVIRONMENT" != "staging" ]]; then
    printUpdateDiamondLogsUsage >&2
    exit 1
  fi
  shift

  # shellcheck disable=SC1091
  source script/helperFunctions.sh

  # updateDiamondLogs word-splits its NETWORK argument and runs the networks in parallel;
  # an empty list means every included network
  updateDiamondLogs "$ENVIRONMENT" "$*"
fi
