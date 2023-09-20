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

  # Loop through each script and call "forge script" to get the cut calldata
  declare -a CUTS
  for script in $SCRIPTS; do
    UPDATE_SCRIPT=$(echo "$DEPLOY_SCRIPT_DIRECTORY"Update"$script".s.sol)
    PRIVATE_KEY=$(getPrivateKey $NETWORK $ENVIRONMENT)
    echo "Calculating facet cuts for $script..."
    RAW_RETURN_DATA=$(NO_BROADCAST=true NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$PRIVATE_KEY forge script "$UPDATE_SCRIPT" -f $NETWORK -vvvv --json --silent --skip-simulation --legacy)
    CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
    FACET_CUT=$(echo $CLEAN_RETURN_DATA | jq -r '.returns.cutData.value')
    if [ "$FACET_CUT" != "0x" ]; then
      CUTS+=("$FACET_CUT")
    fi
  done

  # Convert the array of cuts to a JSON array
  CUTS_JSON=$(jq --compact-output --null-input '$ARGS.positional' --args -- "${CUTS[@]}")

  if [ "$CUTS_JSON" == "[]" ]; then
    echo "Nothing to upgrade"
    exit 0
  fi

  # Get the diamondAddress
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")

  # Call the proposeTx script ts-node proposeTx.ts diamondAddress cuts network rpcUrl
  yarn ts-node script/deploy/gnosisSAFE/proposeTx.ts "$DIAMOND_ADDRESS" "$CUTS_JSON" "$NETWORK" $(getRPCUrl $NETWORK) "$PRIVATE_KEY"
  exit 0
}

# deployUpgradesToSAFE
