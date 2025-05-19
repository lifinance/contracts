#!/bin/bash

function diamondSyncWhitelistedAddresses {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncWhitelistedAddresses now...."

  # Load environment variables
  source .env

  # Load configuration & helper functions
  source script/helperFunctions.sh

  # Read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"

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

    RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

    # Fetch required whitelisted addresses from configuration
    CFG_WHITELISTED_ADDRESSES=$(jq -r --arg network "$NETWORK" '.[$network][]' "./config/whitelistedAddresses.json")

    # Function to get approved whitelisted addresses from the contract
    function getApprovedWhitelistedAddresses {
      local ATTEMPT=1
      local result=""

      while [ $ATTEMPT -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]; do
        result=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedAddresses() returns (address[])" --rpc-url "$RPC_URL" 2>/dev/null)

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

    # Get approved whitelisted addresses
    WHITELISTED_ADDRESSES=($(getApprovedWhitelistedAddresses))
    if [[ $? -ne 0 ]]; then
      # Report failure
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Unable to fetch approved whitelisted addresses"
      {
        echo "[$NETWORK] Error: Unable to fetch approved whitelisted addresses"
        echo ""
      } >> "$FAILED_LOG_FILE"
      return
    fi

    # Determine missing whitelisted addresses
    NEW_WHITELISTED_ADDRESSES=()
    for WHITELISTED_ADDRESS in $CFG_WHITELISTED_ADDRESSES; do
      if [[ ! " ${WHITELISTED_ADDRESSES[*]} " == *" $(echo "$WHITELISTED_ADDRESS" | tr '[:upper:]' '[:lower:]')"* ]]; then
        CHECKSUMMED=$(cast --to-checksum-address "$WHITELISTED_ADDRESS")
        CODE=$(cast code $CHECKSUMMED --rpc-url "$RPC_URL")
        if [[ "$CODE" == "0x" ]]; then
          continue
        fi
        NEW_WHITELISTED_ADDRESSES+=("$CHECKSUMMED")
      fi
    done

    # Add missing whitelisted addresses
    if [[ ! ${#NEW_WHITELISTED_ADDRESSES[@]} -eq 0 ]]; then
      ADDRESS_STRING=$(printf "%s," "${NEW_WHITELISTED_ADDRESSES[@]}")
      PARAMS="[${ADDRESS_STRING%,}]"

      local ATTEMPTS=1
      while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
        cast send "$DIAMOND_ADDRESS" "batchAddToWhitelist(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy >/dev/null

        sleep 5

        # Verify updated whitelisted addresses list
        WHITELISTED_ADDRESSES_UPDATED=($(getApprovedWhitelistedAddresses))
        if [[ $? -ne 0 ]]; then
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Whitelisted addresses update verification failed"

          {
            echo "[$NETWORK] Error: Whitelisted addresses update verification failed"
            echo ""
          } >> "$FAILED_LOG_FILE"
          return
        fi

        MISSING_WHITELISTED_ADDRESSES=()
        for WHITELISTED_ADDRESS in "${NEW_WHITELISTED_ADDRESSES[@]}"; do
          if [[ ! " ${WHITELISTED_ADDRESSES_UPDATED[*]} " == *" $(echo "$WHITELISTED_ADDRESS" | tr '[:upper:]' '[:lower:]')"* ]]; then
            MISSING_WHITELISTED_ADDRESSES+=("$WHITELISTED_ADDRESS")
          fi
        done

        if [ ${#MISSING_WHITELISTED_ADDRESSES[@]} -eq 0 ]; then
          printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Success - All whitelisted addresses added"
          return
        fi

        ATTEMPTS=$((ATTEMPTS + 1))
      done

      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] - Could not whitelist all addresses"
      {
        echo "[$NETWORK] Error: Could not whitelist all addresses"
        echo "[$NETWORK] Attempted to add: ${NEW_WHITELISTED_ADDRESSES[*]}"
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

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncWhitelistedAddresses completed"
}