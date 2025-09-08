#!/bin/bash

# Step 2 runner: filters contracts by deployment date relative to LibAsset v2.0.0
# Usage: ./script/tasks/libAssetUpgradeStep2.sh <chainName> [environment]

set -euo pipefail

source script/tasks/libAssetUpgrade.sh

CHAIN_NAME="${1:-}"
ENVIRONMENT="${2:-production}"

if [[ -z "$CHAIN_NAME" ]]; then
  echo "Usage: $0 <chainName> [environment]" >&2
  exit 1
fi

echo "[step2] Parsing classification and filtering for $CHAIN_NAME ($ENVIRONMENT)" >&2

parseContractClassification

# Write candidates directly (avoid mapfile for macOS bash)
filterContractsForUpgrade "$CHAIN_NAME" "$ENVIRONMENT" "${LIBASSET_CONTRACTS[@]}" > contractsToRedeploy.txt

COUNT=$(grep -cve '^\s*$' contractsToRedeploy.txt || true)
echo "[step2] Wrote ${COUNT} contracts to contractsToRedeploy.txt" >&2
