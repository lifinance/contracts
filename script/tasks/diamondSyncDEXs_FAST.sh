#!/bin/bash

function diamondSyncDEXs_FAST {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncDEXs now...."

  # Load environment variables
  source .env

  # Load configuration & helper functions
  source script/helperFunctions.sh

  # Read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"

  # Limit the number of concurrent processes
  MAX_CONCURRENT_JOBS=5

  # Temp file to track failed logs
  FAILED_LOG_FILE=$(mktemp)

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    # find out if script should be executed for one network or for all networks
    checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
    echo ""
    echo "Should the script be executed on one network or all networks?"
    NETWORK=$(echo -e "All (non-excluded) Networks\n$(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH")" | gum filter --placeholder "Network")
    echo "[info] selected network: $NETWORK"
    echo ""
    echo ""

    if [[ "$NETWORK" != "All (non-excluded) Networks" ]]; then
      checkRequiredVariablesInDotEnv $NETWORK
    fi
  fi

  # no need to distinguish between mutable and immutable anymore
  DIAMOND_CONTRACT_NAME="LiFiDiamond"

  # Determine which networks to process
  if [[ "$NETWORK" == "All (non-excluded) Networks" ]]; then
    NETWORKS=($(getIncludedNetworksArray))
  else
    NETWORKS=($NETWORK)
  fi

  # Function to process a network in parallel
  function processNetwork {
    local NETWORK=$1  # Network name as argument

    # Skip non-active mainnets
    if ! isActiveMainnet "$NETWORK"; then
      printf '\033[0;33m%s\033[0m\n' "[$NETWORK] network is not an active mainnet >> continuing without syncing on this network"
      return
    fi

    # Fetch contract address
    DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")

    # Check if contract address exists
    if [[ "$DIAMOND_ADDRESS" == "null" || -z "$DIAMOND_ADDRESS" ]]; then
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Missing contract address"
      echo "[$NETWORK] Error: Missing contract address" >> "$FAILED_LOG_FILE"
      return
    fi

    RPC_URL=$(getRPCUrl "$NETWORK")

    # Fetch required DEX addresses from configuration
    CFG_DEXS=$(jq -r --arg network "$NETWORK" '.[$network][]' "./config/dexs.json")

    # Function to get approved DEXs from the contract
    function getApprovedDEXs {
      local ATTEMPT=1
      local result=""

      while [ $ATTEMPT -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]; do
        result=$(cast call "$DIAMOND_ADDRESS" "approvedDexs() returns (address[])" --rpc-url "$RPC_URL" 2>/dev/null)

        if [[ $? -eq 0 && ! -z "$result" ]]; then
          if [[ "$result" == "[]" ]]; then
            echo ""
          else
            echo $(echo ${result:1:${#result}-2} | tr ',' '\n' | tr '[:upper:]' '[:lower:]')
          fi
          return 0
        fi

        sleep 3
        ATTEMPT=$((ATTEMPT + 1))
      done

      return 1
    }

    # Get approved DEXs
    DEXS=($(getApprovedDEXs))
    if [[ $? -ne 0 ]]; then
      # Report failure
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Unable to fetch approved DEXs"
      {
        echo "[$NETWORK] Error: Unable to fetch approved DEXs"
        echo ""
      } >> "$FAILED_LOG_FILE"
      return
    fi

    # Determine missing DEXs
    NEW_DEXS=()
    for DEX_ADDRESS in $CFG_DEXS; do
      if [[ ! " ${DEXS[*]} " == *" $(echo "$DEX_ADDRESS" | tr '[:upper:]' '[:lower:]')"* ]]; then
        CHECKSUMMED=$(cast --to-checksum-address "$DEX_ADDRESS")
        CODE=$(cast code $CHECKSUMMED --rpc-url "$RPC_URL")
        if [[ "$CODE" == "0x" ]]; then
          continue
        fi
        NEW_DEXS+=("$CHECKSUMMED")
      fi
    done

    # Add missing DEXs
    if [[ ! ${#NEW_DEXS[@]} -eq 0 ]]; then
      ADDRESS_STRING=$(printf "%s," "${NEW_DEXS[@]}")
      PARAMS="[${ADDRESS_STRING%,}]"

      local ATTEMPTS=1
      while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
        cast send "$DIAMOND_ADDRESS" "batchAddDex(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy >/dev/null

        sleep 5

        # Verify updated DEX list
        DEXS_UPDATED=($(getApprovedDEXs))
        if [[ $? -ne 0 ]]; then
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] DEX update verification failed"

          {
            echo "[$NETWORK] Error: DEX update verification failed"
            echo ""
          } >> "$FAILED_LOG_FILE"
          return
        fi

        MISSING_DEXS=()
        for DEX in "${NEW_DEXS[@]}"; do
          if [[ ! " ${DEXS_UPDATED[*]} " == *" $(echo "$DEX" | tr '[:upper:]' '[:lower:]')"* ]]; then
            MISSING_DEXS+=("$DEX")
          fi
        done

        if [ ${#MISSING_DEXS[@]} -eq 0 ]; then
          printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Success - All DEXs added"
          return
        fi

        ATTEMPTS=$((ATTEMPTS + 1))
      done

      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] - Could not whitelist all addresses"
      {
        echo "[$NETWORK] Error: Could not whitelist all addresses"
        echo "[$NETWORK] Attempted to add: ${NEW_DEXS[*]}"
        echo ""
      } >> "$FAILED_LOG_FILE"
    else
      printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] - All addresses are whitelisted"
    fi
  }

  # Run networks in parallel with concurrency control
  for NETWORK in "${NETWORKS[@]}"; do
    while [[ $(jobs | wc -l) -ge $MAX_CONCURRENT_JOBS ]]; do
      sleep 1
    done
    processNetwork "$NETWORK" &
  done

  wait

  # Summary of failures
  if [ -s "$FAILED_LOG_FILE" ]; then
    echo ""
    printf '\033[0;31m%s\033[0m\n' "The following networks failed to sync:"

    awk '/^\[.*\] Error: /' "$FAILED_LOG_FILE" | while read -r line; do
      echo -e "❌ ${line}"
    done

    echo ""
    echo "Full error logs for all failed networks:"
    cat "$FAILED_LOG_FILE"

    rm "$FAILED_LOG_FILE"
    return 1
  else
    rm "$FAILED_LOG_FILE"
    echo ""
    echo "✅ All active networks updated successfully"
    return 0
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncDEXs completed"
}
