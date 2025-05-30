#!/bin/bash

updateFacetConfig() {
  # load deploy script & helper functions
  source .env
  source script/config.sh
  source script/helperFunctions.sh

  # read function arguments into variables
  ENVIRONMENT="$2"
  SCRIPT="$4"
  DIAMOND_CONTRACT_NAME="$5"

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$3" ]]; then
      # get user-selected network from list
      echo "Select Networks"
      if command -v gum >/dev/null 2>&1; then
          checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
          # Read the networks into an array, works on both Mac and Linux
          IFS=$'\n' read -r -d '' -a NETWORKS < <(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH" | gum choose --no-limit)

          if [[ ${#NETWORKS[@]} -eq 0 ]]; then
              error "No networks selected - exiting script"
              exit 1
          fi
          echo "[info] selected networks: ${NETWORKS[*]}"
      else
          error "gum is not installed"
          exit 1
      fi
  else
      NETWORKS=("$3")
  fi

    # if no SCRIPT was passed to this function, ask user to select it
  if [[ -z "$SCRIPT" ]]; then
    # select which script to execute
    local SCRIPT=$(ls -1 "$CONFIG_SCRIPT_DIRECTORY" | sed -e 's/\.s.sol$//' | gum filter --placeholder "Please select a script to execute")
    echo "[info] selected script: $SCRIPT"
  fi

  # determine full (relative) path of deploy script
  SCRIPT_PATH=$CONFIG_SCRIPT_DIRECTORY"$SCRIPT.s.sol"

  DIAMOND_CONTRACT_NAME="LiFiDiamond"

  # set flag for mutable/immutable diamond
  USE_MUTABLE_DIAMOND="true"

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  for NETWORK in "${NETWORKS[@]}"; do
    # get deployer wallet balance
    echo "[info] loading deployer wallet balance for network $NETWORK..."
    BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")
    echo "[info] deployer wallet balance in this network: $BALANCE"
    echo ""

    # ensure all required .env values are set
    checkRequiredVariablesInDotEnv $NETWORK


    # repeatedly call selected script until it's succeeded or out of attempts
    ATTEMPTS=1
    while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
      echo "[info] now executing $SCRIPT on $DIAMOND_CONTRACT_NAME in $ENVIRONMENT environment on $NETWORK (FILE_SUFFIX=$FILE_SUFFIX, USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND)"

      if [[ "$DEBUG" == *"true"* ]]; then
        # print output to console
        RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvvv --broadcast --legacy)
        RETURN_CODE=$?
      else
        # do not print output to console
        RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvvv --broadcast --legacy) 2>/dev/null
        RETURN_CODE=$?
      fi

      echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"
      # exit the loop if the operation was successful
      if [ "$RETURN_CODE" -eq 0 ]; then
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
  done
}


