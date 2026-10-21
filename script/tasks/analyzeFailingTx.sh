#!/bin/bash

# analyzeFailingTx.sh
#
# Thin entry point for analyzeFailingTx (script/playgroundHelpers.sh): cast run, receipt
# and trace attempts for one transaction, using the premium RPC from getRPCUrl.
#
# Note: no `set -euo pipefail` on purpose — the sourced deploy framework relies
# on `$?` checks and retry loops that strict mode would abort.

function printAnalyzeFailingTxUsage() {
  cat <<'EOF'
Usage: ./script/tasks/analyzeFailingTx.sh NETWORK TX_HASH

Example:
  ./script/tasks/analyzeFailingTx.sh arbitrum 0xabc…
EOF
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ $# -ne 2 ]]; then
    printAnalyzeFailingTxUsage >&2
    exit 1
  fi

  # shellcheck disable=SC1091
  source script/playgroundHelpers.sh

  analyzeFailingTx "$1" "$2"
fi
