#!/bin/bash

function diamondSyncDEXs {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncDEXs now...."
  # load env variables
	source .env

	# load config & helper functions
  source script/deploy/resources/deployHelperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"
  local EXIT_ON_ERROR="$4"

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    NETWORK=$(cat ./networks | gum filter --placeholder "Network")
    checkRequiredVariablesInDotEnv $NETWORK
  fi

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

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # if no DIAMOND_CONTRACT_NAME was passed to this function, ask user to select it
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to sync:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
  fi

  # get diamond address from deployments script
  # todo: change to new log file?
  DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "./deployments/${NETWORK}.${FILE_SUFFIX}json")

  # if no diamond address was found, throw an error and exit the script
  if [[ "$DIAMOND_ADDRESS" == "null" ]]; then
    echo "[error] could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file './deployments/${NETWORK}.${FILE_SUFFIX}json' - exiting syncDEXs script now"
    return 1
  fi

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK")

  # logging for debug purposes
  echo ""
  echoDebug "in function syncDEXs"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
  echoDebug "DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
  echo ""

  echo "[info] now syncing DEXs for $DIAMOND_CONTRACT_NAME on network $NETWORK with address $DIAMOND_ADDRESS"

  # get list of DEX addresses from config file
  CFG_DEXS=$(jq -r --arg network "$NETWORK" '.[$network][]' "./config/dexs.json")

  # get addresses of DEXs that are already approved in the diamond contract
  RESULT=$(cast call "$DIAMOND_ADDRESS" "approvedDexs() returns (address[])" --rpc-url "$RPC_URL")
  DEXS=($(echo ${RESULT:1:${#RESULT}-1} | tr ',' '\n' | tr '[:upper:]' '[:lower:]'))

  echoDebug "approved DEXs from diamond with address $DIAMOND_ADDRESS: [$DEXS]"

  # Loop through all DEX addresses from config and check if they are already known by the diamond
  NEW_DEXS=()
  for DEX_ADDRESS in $CFG_DEXS
  do
    # if address is in config file but not in DEX addresses returned from diamond...
    if [[ ! " ${DEXS[*]} " == *" $(echo "$DEX_ADDRESS" | tr '[:upper:]' '[:lower:]')"* ]]; then
      CHECKSUMMED=$(cast --to-checksum-address "$DEX_ADDRESS")
      # ... add it to the array
      NEW_DEXS+=("$CHECKSUMMED")
    fi
  done

  echoDebug "new DEXs to be added: [${NEW_DEXS[*]}]"

  # add new DEXs to diamond
  if [[ ! ${#NEW_DEXS[@]} -eq 0 ]]; then
    # Convert the list of addresses to an array
    ADDRESS_ARRAY=($(echo "${NEW_DEXS[*]}"))

    # Convert the array to a string with comma-separated values
    ADDRESS_STRING=$(printf "%s," "${ADDRESS_ARRAY[@]}")
    PARAMS="[${ADDRESS_STRING%,}]"

    # call batchAddDex function in diamond to add DEXs
    local ATTEMPTS=1
    while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
      echo "[info] Trying to add missing DEXs now - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION) "

      # ensure that gas price is below maximum threshold (for mainnet only)
      doNotContinueUnlessGasIsBelowThreshold "$NETWORK"

      # call diamond
      if [[ "$DEBUG" == *"true"* ]]; then
        # print output to console
        cast send "$DIAMOND_ADDRESS" "batchAddDex(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$ENVIRONMENT") --legacy
      else
        # do not print output to console
        cast send "$DIAMOND_ADDRESS" "batchAddDex(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$ENVIRONMENT") --legacy >/dev/null
      fi

      # check the return code the last call
      if [ $? -eq 0 ]; then
        break # exit the loop if the operation was successful
      fi

      ATTEMPTS=$((ATTEMPTS + 1)) # increment ATTEMPTS
      sleep 1                    # wait for 1 second before trying the operation again
    done

    # check if call was executed successfully or used all ATTEMPTS
    if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
      echo "[error] failed to add missing DEXs to $DIAMOND_CONTRACT_NAME with address $DIAMOND_ADDRESS on network $NETWORK"
      # end this script according to flag
      if [[ -z "$EXIT_ON_ERROR" ]]; then
        return 1
      else
        exit 1
      fi
    fi
  else
    echo '[info] no new DEXs to add'
  fi


  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncDEXs completed"
}
