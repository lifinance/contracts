#!/bin/bash


diamondUpdateFacet() {
  # load required resources
  source .env
  source scripts/config.sh
  source scripts/deploy/resources/deployHelperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"
  local SCRIPT="$4"
  local REPLACE_EXISTING_FACET="$5"

  # if no ENVIRONMENT was passed to this function, determine it
  if [[ -z "$ENVIRONMENT" ]]; then
    if [[ "$PRODUCTION" == "true" ]]; then
      # make sure that PRODUCTION was selected intentionally by user
      echo "    "
      echo "    "
      printf '\033[31m%s\031\n' "!!!!!!!!!!!!!!!!!!!!!!!! ATTENTION !!!!!!!!!!!!!!!!!!!!!!!!";
      printf '\033[33m%s\033[0m\n' "The config environment variable PRODUCTION is set to true";
      printf '\033[33m%s\033[0m\n' "This means you will be deploying contracts to production";
      printf '\033[31m%s\031\n' "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!";
      echo "    "
      printf '\033[33m%s\033[0m\n' "Last chance: Do you want to skip?";
      PROD_SELECTION=$(gum choose \
          "yes" \
          "no" \
          )

      if [[ $PROD_SELECTION != "no" ]]; then
        echo "...exiting script"
        exit 0
      fi

      ENVIRONMENT="production"
    else
      ENVIRONMENT="staging"
    fi
  fi

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    NETWORK=$(getUserSelectedNetwork)

    # check the return code the last call
    if [ $? -ne 0 ]; then
      echo "$NETWORK" # will contain an error message
      exit 1
    fi
    # get deployer wallet balance
    BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")

    echo "[info] selected network: $NETWORK"
    echo "[info] deployer wallet balance in this network: $BALANCE"
    echo ""
  fi

  # if no DIAMOND_CONTRACT_NAME was passed to this function, ask user to select diamond type
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to update:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
    echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # get diamond address from deployments script
  DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "./deployments/${NETWORK}.${FILE_SUFFIX}json")

  # if no diamond address was found, throw an error and exit the script
  if [[ "$DIAMOND_ADDRESS" == "null" ]]; then
    error "could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file './deployments/${NETWORK}.${FILE_SUFFIX}json' - exiting diamondUpdatePeripheryscript now"
    return 1
  fi


  # if no SCRIPT was passed to this function, ask user to select it
  if [[ -z "$SCRIPT" ]]; then
    echo "Please select which facet you would like to update"
    SCRIPT=$(ls -1 "$DEPLOY_SCRIPT_DIRECTORY" | sed -e 's/\.s.sol$//' | grep 'Update' | gum filter --placeholder "Update Script")
  fi

  # determine full (relative) path of deploy script
  SCRIPT_PATH=$DEPLOY_SCRIPT_DIRECTORY"$SCRIPT.s.sol"

  # set flag for mutable/immutable diamond
  USE_MUTABLE_DIAMOND=$( [[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]] && echo true || echo false )

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo "[debug] updating $DIAMOND_CONTRACT_NAME on $NETWORK with address $DIAMOND_ADDRESS in $ENVIRONMENT environment with script $SCRIPT (FILE_SUFFIX=$FILE_SUFFIX, USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND)"
  fi

  # check if update script exists
  local FULL_SCRIPT_PATH=""$DEPLOY_SCRIPT_DIRECTORY""$SCRIPT"".s.sol""
  if ! checkIfFileExists "$FULL_SCRIPT_PATH" >/dev/null; then
    error "could not find update script for $CONTRACT in this path: $FULL_SCRIPT_PATH". Aborting update.
    return 1
  fi

  # update diamond with new facet address (remove/replace of existing selectors happens in update script)
  attempts=1
  while [ $attempts -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to execute $SCRIPT on $DIAMOND_CONTRACT_NAME now - attempt ${attempts} (max attempts:$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"
    # try to execute call
    if [[ "$DEBUG" == *"true"* ]]; then
      # print output to console
      RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND forge script "$SCRIPT_PATH" -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy)
    else
      # do not print output to console
      RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND forge script "$SCRIPT_PATH" -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy) 2>/dev/null
    fi
    # check the return code the last call
    if [ $? -eq 0 ]; then
        # extract the "logs" property and its contents from return data
        CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
        if [[ "$DEBUG" == *"true"* ]]; then
          echo "[debug] CLEAN_RETURN_DATA: $CLEAN_RETURN_DATA"
        fi

        # extract the "returns" property and its contents from logs
        RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2> /dev/null)
        #echo "[debug] RETURN_DATA: $RETURN_DATA"

        # get the facet addresses that are known to the diamond from the return data
        FACETS=$(echo $RETURN_DATA | jq -r '.facets.value')
        if [[ $FACETS != "{}" ]]; then
          break # exit the loop if the operation was successful
        fi
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all attempts
  if [ $attempts -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    error "failed to execute $SCRIPT on network $NETWORK in $ENVIRONMENT environment"
    return 1
  fi

  # save facet addresses
  saveDiamondFacets "$NETWORK" "$ENVIRONMENT" "$USE_MUTABLE_DIAMOND" "$FACETS"

  echo "[info] $SCRIPT successfully executed on network $NETWORK in $ENVIRONMENT environment"
  return 0
}
