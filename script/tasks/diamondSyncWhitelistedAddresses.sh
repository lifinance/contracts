#!/bin/bash

function diamondSyncWhitelistedAddresses {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncWhitelistedAddresses now...."

  # Load environment variables
  source .env

  # Load configuration & helper functions
  source script/helperFunctions.sh

  # Configuration flag - set to true to allow token contracts in DEX lists
  ALLOW_TOKEN_CONTRACTS=${ALLOW_TOKEN_CONTRACTS:-false}

  # Read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="${2:-production}"  # Default to production if not specified
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
      checkRequiredVariablesInDotEnv "$NETWORK"
    fi
  fi

  # no need to distinguish between mutable and immutable anymore
  DIAMOND_CONTRACT_NAME="LiFiDiamond"

  # Determine which networks to process
  if [[ "$NETWORK" == "All (non-excluded) Networks" ]]; then
    NETWORKS=($(getIncludedNetworksArray))
  else
    NETWORKS=("$NETWORK")
  fi

  # Function to check if an address is a token contract
  # tries to call decimals() function and returns true if a number value is returned
  function isTokenContract {
    local ADDRESS=$1
    local RPC_URL=$2
    local RESULT
    # Try to call decimals() function
    if RESULT=$(cast call "$ADDRESS" "decimals() returns (uint8)" --rpc-url "$RPC_URL" 2>/dev/null); then
      # Validate 0–255 strictly
      if [[ "$RESULT" =~ ^([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$ ]]; then
        return 0
      fi
    fi
    return 1
  }

  # Function to detect token contracts in DEX list
  function detectTokenContracts {
    local RPC_URL=$1
    shift
    local ADDRESSES=("$@")

    local TOKEN_CONTRACTS=()

    for ADDRESS in "${ADDRESSES[@]}"; do
      if isTokenContract "$ADDRESS" "$RPC_URL"; then
        TOKEN_CONTRACTS+=("$ADDRESS")
      fi
    done

    echo "${TOKEN_CONTRACTS[@]}"
  }

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
      printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] LiFiDiamond not deployed yet - skipping DEX sync"
      return
    fi

    RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

    # Fetch required whitelisted addresses from configuration
    CFG_WHITELISTED_ADDRESSES=$(jq -r --arg network "$NETWORK" '.[$network][]' "./config/whitelistedAddresses.json")

    # Function to get whitelisted addresses from the contract
    function getWhitelistedAddresses {
      local ATTEMPT=1
      local result=""

      while [ $ATTEMPT -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]; do
        result=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedAddresses() returns (address[])" --rpc-url "$RPC_URL" 2>/dev/null)

        if [[ $? -eq 0 && -n "$result" ]]; then
          if [[ "$result" == "[]" ]]; then
            echo ""
          else
            echo "${result:1:${#result}-2}" | tr ',' '\n' | tr '[:upper:]' '[:lower:]'
          fi
          return 0
        fi

        sleep 3
        ATTEMPT=$((ATTEMPT + 1))
      done

      return 1
    }

    # Get whitelisted addresses
    WHITELISTED_ADDRESSES=($(getWhitelistedAddresses))
    if [[ $? -ne 0 ]]; then
      # Report failure
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Unable to fetch whitelisted addresses"
      {
        echo "[$NETWORK] Error: Unable to fetch whitelisted addresses"
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

    # Check for token contracts in the new addresses that will be added
    if [[ ! ${#NEW_WHITELISTED_ADDRESSES[@]} -eq 0 ]]; then
      TOKEN_CONTRACTS=($(detectTokenContracts "$RPC_URL" "${NEW_WHITELISTED_ADDRESSES[@]}"))

      if [[ ${#TOKEN_CONTRACTS[@]} -gt 0 ]]; then
        if [[ "$ALLOW_TOKEN_CONTRACTS" == "true" ]]; then
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Token contracts detected but proceeding (ALLOW_TOKEN_CONTRACTS=true)"
          printf '\033[0;33m%s\033[0m\n' "Token addresses: ${TOKEN_CONTRACTS[*]}"
        else
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Token contracts detected in new addresses - aborting DEX sync"
          printf '\033[0;31m%s\033[0m\n' "Token addresses: ${TOKEN_CONTRACTS[*]}"
          echo ""
          printf '\033[0;33m%s\033[0m\n' "💡 To bypass this check, set ALLOW_TOKEN_CONTRACTS=true and run again:"
          echo ""
          {
            echo "[$NETWORK] Error: Token contracts detected in new addresses"
            echo "[$NETWORK] Token addresses: ${TOKEN_CONTRACTS[*]}"
          } >> "$FAILED_LOG_FILE"
          return
        fi
      fi
    fi

    # Add missing whitelisted addresses
    if [[ ! ${#NEW_WHITELISTED_ADDRESSES[@]} -eq 0 ]]; then
      ADDRESS_STRING=$(printf "%s," "${NEW_WHITELISTED_ADDRESSES[@]}")
      PARAMS="[${ADDRESS_STRING%,}]"

      local ATTEMPTS=1
      while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
        cast send "$DIAMOND_ADDRESS" "batchAddToWhitelist(address[])" "${PARAMS[@]}" --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy >/dev/null

        sleep 5

        # Verify updated whitelisted addresses list
        WHITELISTED_ADDRESSES_UPDATED=($(getWhitelistedAddresses))
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
      printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] - All addresses are whitelisted already"
    fi
  }

    # Note: Token contract detection now happens per-network during processing
  # to check only the addresses that will actually be added

  # Run networks in parallel with concurrency control
  if [[ -z $MAX_CONCURRENT_JOBS ]]; then
    echo "Your config.sh file is missing the key MAX_CONCURRENT_JOBS. Please add it and run this script again."
    exit 1
  fi

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
    printf '\033[0;31m%s\033[0m\n' "Summary of failures:"

    # Extract unique error types and show count
    awk '/^\[.*\] Error: /' "$FAILED_LOG_FILE" | sort | uniq -c | while read -r count line; do
      printf '\033[0;31m%s\033[0m\n' "❌ $line (${count} network(s))"
    done



    # Store failure status before cleanup
    HAS_FAILURES=true
  else
    HAS_FAILURES=false
  fi

  # Cleanup temp files
  rm -f "$FAILED_LOG_FILE"

  if [[ "$HAS_FAILURES" == "true" ]]; then
    echo ""
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncWhitelistedAddresses completed"
    return 1
  else
    echo ""
    echo "✅ All active networks updated successfully"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncWhitelistedAddresses completed"
    return 0
  fi
}
