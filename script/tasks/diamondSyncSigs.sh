#!/bin/bash

function diamondSyncSigs {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncSIGs now...."
  # load env variables
  source .env

  # load config & helper functions
  source script/helperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"
  local EXIT_ON_ERROR="$4"

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    # find out if script should be executed for one network or for all networks
    echo ""
    echo "Should the script be executed on one network or all networks?"
    NETWORK=$(echo -e "All (non-excluded) Networks\n$(cat ./networks)" | gum filter --placeholder "Network")
    echo "[info] selected network: $NETWORK"

    if [[ "$NETWORK" != "All (non-excluded) Networks" ]]; then
      checkRequiredVariablesInDotEnv $NETWORK
    fi
  fi

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # if no DIAMOND_CONTRACT_NAME was passed to this function, ask user to select it
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to sync:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
    echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi

  # create array with network/s for which the script should be executed
  if [[ "$NETWORK" == "All (non-excluded) Networks" ]]; then
    # get array with all network names
    NETWORKS=($(getIncludedNetworksArray))
  else
    NETWORKS=($NETWORK)
  fi

  # logging for debug purposes
  echo ""
  echoDebug "in function syncSIGs"
  echoDebug "NETWORKS=$NETWORKS"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echoDebug "DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
  echoDebug "DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
  echo ""

  # go through all networks and execute the script
  for NETWORK in "${NETWORKS[@]}"; do

    # get RPC URL for given network
    RPC_URL=$(getRPCUrl "$NETWORK")

    # call batchSetFunctionApprovalBySignature function in diamond to add function selectors
    local ATTEMPTS=1
    while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
      echo "[info] trying to add function selectors now - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION) "

      # ensure that gas price is below maximum threshold (for mainnet only)
      doNotContinueUnlessGasIsBelowThreshold "$NETWORK"

      ts-node ./script/tasks/diamondSyncSigs.ts --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$PRIVATE_KEY"

      # check the return code of the last call
      if [ $? -eq 0 ]; then
        break # exit the loop if the operation was successful
      fi

      ATTEMPTS=$((ATTEMPTS + 1)) # increment ATTEMPTS
      sleep 1                    # wait for 1 second before trying the operation again
    done

    # check if call was executed successfully or used all ATTEMPTS
    if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
      error "failed to add function selectors to $DIAMOND_CONTRACT_NAME with $DIAMOND_ADDRESS on network $NETWORK"
      local RETURN=1
    fi
  done

  # end script according to return status
  if [ "$RETURN" == 1 ]; then
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  else
    return 0
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncSIGs completed"
}
