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
    checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
    echo ""
    echo "Should the script be executed on one network or all networks?"
    NETWORK=$(echo -e "All (non-excluded) Networks\n$(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH")" | gum filter --placeholder "Network")
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

    # get diamond address from deployments script
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")

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

    # Skip for localanvil or any testnet
    if [[ "$NETWORK" == "localanvil" || \
          "$NETWORK" == "bsc-testnet" || \
          "$NETWORK" == "lineatest" || \
          "$NETWORK" == "mumbai" || \
          "$NETWORK" == "sepolia" ]]; then
        continue
    fi

    # get RPC URL for given network
    RPC_URL=$(getRPCUrl "$NETWORK")

    # call batchSetFunctionApprovalBySignature function in diamond to add function selectors
    local ATTEMPTS=1
    while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
      echo "----------------------------------------------------------------------------------------"
      echo "[info] trying to add function selectors now - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION) "

      # ensure that gas price is below maximum threshold (for mainnet only)
      doNotContinueUnlessGasIsBelowThreshold "$NETWORK"

      # try to run the typescript script (will fail if the network is not yet supported by viem)
      bun ./script/tasks/diamondSyncSigs.ts --project ../../tsconfig.json --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --environment "$ENVIRONMENT"
      RETURN_CODE=$?

      # check the typescript script failed
      if [ $RETURN_CODE -ne 0 ]; then
        echoDebug "diamondSyncSigs.ts was not successful, trying the old approach now"

        # do this stuff only on the first iteration to prepare the params for the call
        if [[ $ATTEMPTS == 1 ]]; then
          # get function selectors (sigs) from config files
          local CFG_SIGS=($(jq -r '.[] | @sh' "./config/sigs.json" | tr -d \' | tr '[:upper:]' '[:lower:]' ))

          # prepare parameter for batchSetFunctionApprovalBySignature call (=add all sigs to an array)
          for d in "${CFG_SIGS[@]}"; do
            local PARAMS+="${d},"
          done
        fi

        # call diamond using the old approach (just registering all signatures)
        if [[ "$DEBUG" == *"true"* ]]; then
          # print output to console
          cast send "$DIAMOND_ADDRESS" "batchSetFunctionApprovalBySignature(bytes4[],bool)" "[${PARAMS::${#PARAMS}-1}]" true --rpc-url $RPC_URL --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy
        else
          # do not print output to console
          cast send "$DIAMOND_ADDRESS" "batchSetFunctionApprovalBySignature(bytes4[],bool)" "[${PARAMS::${#PARAMS}-1}]" true --rpc-url $RPC_URL --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy >/dev/null 2>&1
        fi
        RETURN_CODE=$?
      fi

      # check the return code of the last call
      if [ $RETURN_CODE -eq 0 ]; then
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
