#!/bin/bash

deployUpgradesToSAFE() {
  source .env
  source script/config.sh
  source script/helperFunctions.sh

  ENVIRONMENT=$1
  FILE_SUFFIX=$(getFileSuffix $ENVIRONMENT)
  NETWORK=$(getUserSelectedNetwork)
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
  if [[ $GIT_BRANCH == "main" ]]; then
    # We can assume code in the main branch has been pre-approved and audited
    VERIFIED="OK"
  else
    VERIFIED=$(bun --silent script/deploy/github/verify-approvals.ts --branch "$GIT_BRANCH" --token "$GH_TOKEN" --facets "$SCRIPTS")
  fi

  if [[ $VERIFIED == "OK" ]]; then
    echo "PR has been approved. Continuing..."
    # Loop through each script and call "forge script" to get the cut calldata
    declare -a CUTS
    for script in $SCRIPTS; do
      UPDATE_SCRIPT=$(echo "$DEPLOY_SCRIPT_DIRECTORY"Update"$script".s.sol)
      PRIVATE_KEY=$(getPrivateKey $NETWORK $ENVIRONMENT)
      echo "Calculating facet cuts for $script..."
      RAW_RETURN_DATA=$(NO_BROADCAST=true NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$PRIVATE_KEY forge script "$UPDATE_SCRIPT" -f $NETWORK -vvvvv --json --skip-simulation --legacy)
      CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
      FACET_CUT=$(echo $CLEAN_RETURN_DATA | jq -r '.returns.cutData.value')
      if [ "$FACET_CUT" != "0x" ]; then
        echo "Proposing facet cut for $script..."
        DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")
        RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"
        bun script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$FACET_CUT" --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$SAFE_SIGNER_PRIVATE_KEY"
      fi
    done
    exit 0
  fi
}
