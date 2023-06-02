#!/bin/bash

deployUpgradesToSAFE() {
  source .env
  source scripts/config.sh
  source scripts/deploy/resources/deployHelperFunctions.sh

  NETWORK=$(getUserSelectedNetwork)
  DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
  if [ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]; then
    USE_MUTABLE_DIAMOND=true
  else
    USE_MUTABLE_DIAMOND=false

  fi
  echo $DIAMOND_CONTRACT_NAME
  echo $DEPLOY_SCRIPT_DIRECTORY
  # Get list of Update scripts from ./scripts/deploy/facets where file name starts with "Update" and ends in ".sol" strip path, the worf "Update" and ".s.sol" from the file name
  # separate by new line

  SCRIPTS=$(ls -1 "$DEPLOY_SCRIPT_DIRECTORY" | sed -e 's/\.s.sol$//' | grep 'Update' | sed 's/Update//g' | gum choose --no-limit)

  # Loop through each script and call "forge script" to get the cut calldata
  declare -a CUTS
  for script in $SCRIPTS; do
    UPDATE_SCRIPT=$(echo "$DEPLOY_SCRIPT_DIRECTORY"Update"$script".s.sol)
    echo "Fetching Cuts for $script"
    RAW_RETURN_DATA=$(NO_BROADCAST=true NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$(getPrivateKey "$ENVIRONMENT") forge script "$UPDATE_SCRIPT" -f $NETWORK -vvvv --json --silent --skip-simulation --legacy)
    FACET_CUT=$(echo $RAW_RETURN_DATA | jq -r '.returns.cutData.value')
    if [ "$FACET_CUT" != "[]" ]; then
      CUTS+=("$FACET_CUT")
    fi
  done

  # Convert the array of cuts to a JSON array
  CUTS_JSON=$(jq --compact-output --null-input '$ARGS.positional' --args -- "${CUTS[@]}")

  # Call the proposeTx script ts-node proposeTx.ts diamondAddress cuts rpcUrl
  ts-node scripts/deploy/gnosisSAFE/proposeTx.ts 0x "$CUTS_JSON" $(getRPCUrl $NETWORK)
}

deployUpgradesToSAFE
