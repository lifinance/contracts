#!/bin/bash

function syncDEXs {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncDEXs now...."
  # load env variables
	source .env

	# load config & helper functions
  source scripts/deploy/deployHelperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local FILE_SUFFIX="$2"
  local DIAMOND_CONTRACT_NAME="$3"
  local EXIT_ON_ERROR="$4"

  # if no FILE_SUFFIX was passed to this function, define it
  if [[ -z "$FILE_SUFFIX" ]]; then
    if [[ -z "$PRODUCTION" ]]; then #TODO: improve
      FILE_SUFFIX="staging."
    fi
  fi

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    NETWORK=$(cat ./networks | gum filter --placeholder "Network")
    checkRequiredVariablesInDotEnv $NETWORK
  fi

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

  echo "RPC: $RPC_URL"

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function syncDEXs"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
    echo "[debug] DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
    echo "[debug] DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
    echo ""
  fi

  echo "[info] now syncing DEXs for $DIAMOND_CONTRACT_NAME on network $NETWORK with address $DIAMOND_ADDRESS"

  # get list of DEX addresses from config file
  CFG_DEXS=$(jq -r --arg network "$NETWORK" '.[$network][]' "./config/dexs.json")

  # get addresses of DEXs that are already approved in the diamond contract
  RESULT=$(cast call "$DIAMOND_ADDRESS" "approvedDexs() returns (address[])" --rpc-url "$RPC_URL")
  DEXS=($(echo ${RESULT:1:${#RESULT}-1} | tr ',' '\n' | tr '[:upper:]' '[:lower:]'))

  if [[ $DEBUG == "true" ]]; then
    echo "[debug] approved DEXs from diamond with address $DIAMOND_ADDRESS: $DEXS"
  fi

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

      # call diamond
      if [[ "$DEBUG" == *"true"* ]]; then
        # print output to console
        cast send "$DIAMOND_ADDRESS" "batchAddDex(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key ${PRIVATE_KEY} --legacy
      else
        # do not print output to console
        cast send "$DIAMOND_ADDRESS" "batchAddDex(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key ${PRIVATE_KEY} --legacy
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
