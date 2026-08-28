#!/bin/bash

deployUpgradesToSAFE() {
  source .env
  source script/helperFunctions.sh

  ENVIRONMENT=$1
  FILE_SUFFIX=$(getFileSuffix $ENVIRONMENT)
  NETWORK=$(getUserSelectedNetwork)

  # This script proposes facet upgrades to the Safe multisig. Testnet networks
  # have an EOA-owned diamond with no Safe; the Safe-proposal flow does not apply.
  if isTestnetNetwork "$NETWORK"; then
    error "deployUpgradesToSAFE is not supported on testnet networks (no Safe). Use diamondUpdateFacet for testnet upgrades."
    return 1
  fi

  DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
  if [ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]; then
    USE_MUTABLE_DIAMOND=true
  else
    USE_MUTABLE_DIAMOND=false
  fi
  echo "Preparing upgrade proposal for" $DIAMOND_CONTRACT_NAME
  # Get list of Update scripts from ./script/deploy/facets where file name starts with "Update" and ends in ".sol" strip path, the worf "Update" and ".s.sol" from the file name
  # separate by new line

  SCRIPTS=$(ls -1 "$DEPLOY_SCRIPT_DIRECTORY" | sed -e 's/\.s.sol$//' | grep 'Update' | sed 's/Update//g' | gum choose --no-limit)

  if [[ -z $SCRIPTS ]]; then
    echo "No facets selected!"
    exit 1
  fi

  GIT_BRANCH=$(git branch --show-current)
  # anything that is not exactly "staging" reaches the production private key via
  # getPrivateKey's else branch, so the gate has to run for those values too
  if [[ "$ENVIRONMENT" != "staging" ]]; then
    if ! bunx tsx ./script/deploy/github/verify-approvals.ts --environment "$ENVIRONMENT" --branch "$GIT_BRANCH" --facets "$SCRIPTS"; then
      error "Production deploy gate failed for branch '$GIT_BRANCH' - aborting before anything is proposed to the Safe"
      return 1
    fi
    echo "Production deploy gate passed. Continuing..."
  fi

  # read from fd 3 so commands inside the loop (forge, bun) keep their own stdin
  while IFS= read -r -u3 SCRIPT; do
    [[ -z "$SCRIPT" ]] && continue
    UPDATE_SCRIPT=$(echo "$DEPLOY_SCRIPT_DIRECTORY"Update"$SCRIPT".s.sol)
    PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT")
    echo "Calculating facet cuts for $SCRIPT..."

    if ! executeAndParse \
      "NO_BROADCAST=true NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$PRIVATE_KEY forge script \"$UPDATE_SCRIPT\" --fork-url $NETWORK --json --skip-simulation --legacy" \
      "true" \
      "forge script failed for $SCRIPT on network $NETWORK" \
      "continue"; then
      continue
    fi

    CLEAN_RETURN_DATA=$(echo "${RAW_RETURN_DATA:-}" | sed 's/^.*{\"logs/{\"logs/')
    FACET_CUT=$(jq -r '.returns.cutData.value' <<< "${CLEAN_RETURN_DATA:-}")
    if [ "$FACET_CUT" != "0x" ]; then
      echo "Proposing facet cut for $SCRIPT..."
      DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")
      RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"
      bun script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$FACET_CUT" --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$SAFE_SIGNER_PRIVATE_KEY"
    fi
  done 3<<<"$SCRIPTS"
  exit 0
}
