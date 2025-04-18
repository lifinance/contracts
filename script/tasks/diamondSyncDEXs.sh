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

  # list of networks that failed to update
  FAILED_NETWORKS=()

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
    echo ""
    echo "Should the script be executed on one network or all networks"
    NETWORK=$(echo -e "All (non-excluded) Networks\n$(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH")" | gum filter --placeholder "Network")
    if [[ "$NETWORK" != "All (non-excluded) Networks" ]]; then
      checkRequiredVariablesInDotEnv $NETWORK
    fi
  fi

  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to sync:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
    echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi

  if [[ "$NETWORK" == "All (non-excluded) Networks" ]]; then
    NETWORKS=($(getIncludedNetworksArray))
  else
    NETWORKS=($NETWORK)
  fi

  for NETWORK in "${NETWORKS[@]}"; do
    if [[ "$NETWORK" == "localanvil" || \
          "$NETWORK" == "bsc-testnet" || \
          "$NETWORK" == "lineatest" || \
          "$NETWORK" == "mumbai" || \
          "$NETWORK" == "sepolia" ]]; then
        continue
    fi

    DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")

    echo ""
    echoDebug "in function syncDEXs"
    echoDebug "CURRENT NETWORK=$NETWORK"
    echoDebug "ENVIRONMENT=$ENVIRONMENT"
    echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
    echoDebug "DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
    echoDebug "DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
    echo ""

    # check if diamond address is available
    if [[ "$DIAMOND_ADDRESS" == "null" || -z "$DIAMOND_ADDRESS" ]]; then
      error "could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK - skipping network"
      FAILED_NETWORKS+=("$NETWORK")
      continue
    fi

    RPC_URL=$(getRPCUrl "$NETWORK")

    echo "[info] now syncing DEXs for $DIAMOND_CONTRACT_NAME on network $NETWORK with address $DIAMOND_ADDRESS"

    # get a list of all addresses that need to be whitelisted from dexs.json config file
    CFG_DEXS=$(jq -r --arg network "$NETWORK" '.[$network][]' "./config/dexs.json")

    # function to fetch approved DEXs
    function getApprovedDEXs {
      local RETRY_DELAY=3
      local ATTEMPT=1
      local result=""

      while [ $ATTEMPT -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]; do
        result=$(cast call "$DIAMOND_ADDRESS" "approvedDexs() returns (address[])" --rpc-url "$RPC_URL" 2>/dev/null)

        if [[ $? -eq 0 && ! -z "$result" ]]; then
          if [[ "$result" == "[]" ]]; then
            echo ""
          else
            echo $(echo ${result:1:${#result}-1} | tr ',' '\n' | tr '[:upper:]' '[:lower:]')
          fi
          return 0
        fi

        echo "[warn] Failed to fetch approved DEXs from $DIAMOND_ADDRESS on network $NETWORK (attempt $ATTEMPT/$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION). Retrying in $RETRY_DELAY seconds..."
        sleep $RETRY_DELAY
        ATTEMPT=$((ATTEMPT + 1))
      done

      echo "[error] Unable to fetch approved DEXs from $DIAMOND_ADDRESS on network $NETWORK after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts."
      return 1 # Indicate failure
    }

    # Fetch approved DEXs
    DEXS=($(getApprovedDEXs))
    if [[ $? -ne 0 ]]; then
      FAILED_NETWORKS+=("$NETWORK")
      continue
    fi

    if [ ${#DEXS[@]} -eq 0 ]; then
      echoDebug "0 approved DEXs found on diamond $DIAMOND_ADDRESS"
    else
      echoDebug "${#DEXS[@]} approved DEXs found on diamond $DIAMOND_ADDRESS: [${DEXS[*]}]"
    fi

    NEW_DEXS=()
    for DEX_ADDRESS in $CFG_DEXS; do
      if [[ ! " ${DEXS[*]} " == *" $(echo "$DEX_ADDRESS" | tr '[:upper:]' '[:lower:]')"* ]]; then
        CHECKSUMMED=$(cast --to-checksum-address "$DEX_ADDRESS")
        CODE=$(cast code $CHECKSUMMED --rpc-url "$RPC_URL")
        if [[ "$CODE" == "0x" ]]; then
          error "DEX $CHECKSUMMED is not deployed on network $NETWORK - skipping"
          echo "$NETWORK - $CHECKSUMMED" >>.invalid-dexs
          continue
        fi
        NEW_DEXS+=("$CHECKSUMMED")
      fi
    done

    echoDebug "${#NEW_DEXS[@]} new DEXs to be added: [${NEW_DEXS[*]}]"

    if [[ ! ${#NEW_DEXS[@]} -eq 0 ]]; then
      ADDRESS_STRING=$(printf "%s," "${NEW_DEXS[@]}")
      PARAMS="[${ADDRESS_STRING%,}]"

      local ATTEMPTS=1
      while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
        echo "[info] Trying to add missing DEXs now - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION) "
        doNotContinueUnlessGasIsBelowThreshold "$NETWORK"

        cast send "$DIAMOND_ADDRESS" "batchAddDex(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy >/dev/null

        sleep 5 # Wait for confirmation

        # Check on-chain state after transaction
        DEXS_UPDATED=($(getApprovedDEXs))
        if [[ $? -ne 0 ]]; then
          FAILED_NETWORKS+=("$NETWORK")
          break
        fi

        MISSING_DEXS=()
        for DEX in "${NEW_DEXS[@]}"; do
          if [[ ! " ${DEXS_UPDATED[*]} " == *" $(echo "$DEX" | tr '[:upper:]' '[:lower:]')"* ]]; then
            MISSING_DEXS+=("$DEX")
          fi
        done

        if [ ${#MISSING_DEXS[@]} -eq 0 ]; then
          echo "[info] Successfully added all DEXs."
          break
        fi

        ATTEMPTS=$((ATTEMPTS + 1))
      done
    fi
  done

  if [ ${#FAILED_NETWORKS[@]} -ne 0 ]; then
    echo ""
    echo "[error] The following networks failed to update:"
    for NET in "${FAILED_NETWORKS[@]}"; do
      echo "- $NET"
    done
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncDEXs completed"
}
