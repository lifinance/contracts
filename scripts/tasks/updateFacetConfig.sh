#!/bin/bash

updateFacetConfig() {
  # load deploy scripts & helper functions
  source .env
  source scripts/config.sh
  source scripts/deploy/resources/deployHelperFunctions.sh

  # read function arguments into variables
  ENVIRONMENT="$2"

  # get user-selected network from list
  NETWORK=$(cat ./networks | gum filter --placeholder "Network")
  if [[ -z "$NETWORK" ]]; then
    error "invalid selection - exiting script"
    exit 1
  fi
  echo "[info] selected network: $NETWORK"

  # get deployer wallet balance
  echo "[info] loading deployer wallet balance for network $NETWORK..."
  BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")
  echo "[info] deployer wallet balance in this network: $BALANCE"
  echo ""

  # ensure all required .env values are set
  checkRequiredVariablesInDotEnv $NETWORK

  # select which script to execute
  local SCRIPT=$(ls -1 "$CONFIG_SCRIPT_DIRECTORY" | sed -e 's/\.s.sol$//' | grep 'Update' | gum filter --placeholder "Please select a script to execute")
  echo "[info] selected script: $SCRIPT"

  # determine full (relative) path of deploy script
  SCRIPT_PATH=$CONFIG_SCRIPT_DIRECTORY"$SCRIPT.s.sol"


  # ask user to select a diamond type for which to update the facet configuration
  echo "[info] Please select the diamond type to be updated:"
  DIAMOND_CONTRACT_NAME=$(gum choose \
    "LiFiDiamond"\
    "LiFiDiamondImmutable"\
    )

  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    error "invalid selection - exiting script"
    exit 1
  fi
  echo "[info] $DIAMOND_CONTRACT_NAME"
  echo ""

  # set flag for mutable/immutable diamond
  USE_MUTABLE_DIAMOND=$( [[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]] && echo true || echo false )

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # repeatedly call selected script until it's succeeded or out of attempts
  ATTEMPTS=1
  while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] now executing $SCRIPT on $DIAMOND_CONTRACT_NAME in $ENVIRONMENT environment on $NETWORK (FILE_SUFFIX=$FILE_SUFFIX, USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND)"

    if [[ "$DEBUG" == *"true"* ]]; then
      # print output to console
      RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$(getPrivateKey "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy)
      echo "[debug] RAW_RETURN_DATA: $RAW_RETURN_DATA"
    else
      # do not print output to console
      RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$(getPrivateKey "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy) 2>/dev/null
    fi

    # exit the loop if the operation was successful
    if [ $? -eq 0 ]; then
      break
    fi

    ATTEMPTS=$(($ATTEMPTS + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all attempts
  if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    error "failed to execute $SCRIPT on $DIAMOND_CONTRACT_NAME in $ENVIRONMENT environment on $NETWORK"
    return 1
  else
    echo "[info] script executed successfully"
    return 0
  fi

}


