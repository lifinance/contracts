#!/bin/bash

function diamondSyncDEXs {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncDEXs now...."
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
    echo "Should the script be executed on one network or all networks"
    NETWORK=$(echo -e "All (non-excluded) Networks\n$(cat ./networks)" | gum filter --placeholder "Network")
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
  echoDebug "in function syncDEXs"
  echoDebug "NETWORKS=$NETWORKS"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echoDebug "DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
  echoDebug "DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
  echo ""


  # go through all networks and execute the script
  for NETWORK in "${NETWORKS[@]}"; do
    # get diamond address from deployments script
  #  DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "./deployments/${NETWORK}.${FILE_SUFFIX}json")
    DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")

    # if no diamond address was found, throw an error and exit the script
    if [[ "$DIAMOND_ADDRESS" == "null" || -z "$DIAMOND_ADDRESS" ]]; then
      error "could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file './deployments/${NETWORK}.${FILE_SUFFIX}json' - exiting syncDEXs script now"
      local RETURN=1
      continue
    fi

    # get RPC URL for given network
    RPC_URL=$(getRPCUrl "$NETWORK")

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
          cast send "$DIAMOND_ADDRESS" "batchAddDex(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy
        else
          # do not print output to console
          cast send "$DIAMOND_ADDRESS" "batchAddDex(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy >/dev/null
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
        error "failed to add missing DEXs to $DIAMOND_CONTRACT_NAME with address $DIAMOND_ADDRESS on network $NETWORK"
        RETURN=1
      fi
    else
      echo '[info] no new DEXs to add'
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

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncDEXs completed"
}
