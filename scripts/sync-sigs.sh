#!/bin/bash

function syncSIGs {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncSIGs now...."
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
    echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi

  # get diamond address from deployments script
  DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "./deployments/${NETWORK}.${FILE_SUFFIX}json")

  # if no diamond address was found, throw an error and exit the script
  if [[ "$DIAMOND_ADDRESS" == "null" ]]; then
    echo "[error] could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file './deployments/${NETWORK}.${FILE_SUFFIX}json' - exiting syncSIGs script now"
    return 1
  fi

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function syncSIGs"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
    echo "[debug] DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
    echo "[debug] DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
    echo ""
  fi

  # get function selectors (sigs) from config files
  CFG_SIGS=($(jq -r '.[] | @sh' "./config/sigs.json" | tr -d \' | tr '[:upper:]' '[:lower:]' ))

  # get RPC URL for given network
  RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")"

  # prepare parameter for batchSetFunctionApprovalBySignature call (=add all sigs to an array)
  for d in "${CFG_SIGS[@]}"; do
    local PARAMS+="${d},"
  done

  # call batchSetFunctionApprovalBySignature function in diamond to add function selectors
  local ATTEMPTS=1
  while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to add function selectors now - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION) "

    # call diamond
    if [[ "$DEBUG" == *"true"* ]]; then
      # print output to console
      cast send "$DIAMOND_ADDRESS" "batchSetFunctionApprovalBySignature(bytes4[],bool)" "[${PARAMS::${#PARAMS}-1}]" true --rpc-url ${!RPC} --private-key ${PRIVATE_KEY} --legacy
    else
      # do not print output to console
      cast send "$DIAMOND_ADDRESS" "batchSetFunctionApprovalBySignature(bytes4[],bool)" "[${PARAMS::${#PARAMS}-1}]" true --rpc-url ${!RPC} --private-key ${PRIVATE_KEY} --legacy >/dev/null 2>&1
    fi

    # check the return code of the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    ATTEMPTS=$((ATTEMPTS + 1)) # increment ATTEMPTS
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all ATTEMPTS
  if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    echo "[error] failed to add function selectors to $DIAMOND_CONTRACT_NAME with $DIAMOND_ADDRESS on network $NETWORK"
    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncSIGs completed"
}
