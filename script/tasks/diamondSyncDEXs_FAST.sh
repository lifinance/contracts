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
  local EXIT_ON_ERROR="$4"

  # List of failed networks
  FAILED_NETWORKS=()

  # Limit the number of concurrent processes
  MAX_CONCURRENT_JOBS=5

  # If no NETWORK was passed, prompt user
  if [[ -z "$NETWORK" ]]; then
    echo ""
    echo "Should the script be executed on one network or all networks?"
    NETWORK=$(echo -e "All (non-excluded) Networks\n$(cat ./networks)" | gum filter --placeholder "Network")
    if [[ "$NETWORK" != "All (non-excluded) Networks" ]]; then
      checkRequiredVariablesInDotEnv $NETWORK
    fi
  fi

  # Ask for contract name if not provided
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to sync:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
    echo "[info] Selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi

  # Determine which networks to process
  if [[ "$NETWORK" == "All (non-excluded) Networks" ]]; then
    NETWORKS=($(getIncludedNetworksArray))
  else
    NETWORKS=($NETWORK)
  fi

  # Function to process a network in parallel
  function processNetwork {
    local NETWORK=$1  # Network name as argument

    # Exclude test networks and local environments
    if [[ "$NETWORK" == "localanvil" || "$NETWORK" == "bsc-testnet" || "$NETWORK" == "lineatest" || "$NETWORK" == "mumbai" || "$NETWORK" == "sepolia" ]]; then
      return
    fi

    # Fetch contract address
    DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")

    # Print sync start message
    echo "[$NETWORK] Whitelisting addresses for $DIAMOND_CONTRACT_NAME with address $DIAMOND_ADDRESS"

    # Check if contract address exists
    if [[ "$DIAMOND_ADDRESS" == "null" || -z "$DIAMOND_ADDRESS" ]]; then
      FAILED_NETWORKS+=("$NETWORK")
      echo -e "❌ [\e[31m$NETWORK\e[0m] Failed - Missing contract address"
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
            echo $(echo ${result:1:${#result}-1} | tr ',' '\n' | tr '[:upper:]' '[:lower:]')
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
      FAILED_NETWORKS+=("$NETWORK")
      echo -e "❌ [\e[31m$NETWORK\e[0m] Failed - Unable to fetch approved DEXs"
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
          FAILED_NETWORKS+=("$NETWORK")
          echo -e "❌ [\e[31m$NETWORK\e[0m] Failed - DEX update verification failed"
          return
        fi

        MISSING_DEXS=()
        for DEX in "${NEW_DEXS[@]}"; do
          if [[ ! " ${DEXS_UPDATED[*]} " == *" $(echo "$DEX" | tr '[:upper:]' '[:lower:]')"* ]]; then
            MISSING_DEXS+=("$DEX")
          fi
        done

        if [ ${#MISSING_DEXS[@]} -eq 0 ]; then
          echo -e "✅ [\e[32m$NETWORK\e[0m] Success - All DEXs added"
          return
        fi

        ATTEMPTS=$((ATTEMPTS + 1))
      done

      FAILED_NETWORKS+=("$NETWORK")
      error "❌ [$NETWORK] - Could not whitelist all addresses"
    else
      success "✅ [$NETWORK] - All addresses are whitelisted"
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

  # Summary of failed networks
  if [ ${#FAILED_NETWORKS[@]} -ne 0 ]; then
    echo ""
    echo "[error] The following networks failed to update:"
    for NET in "${FAILED_NETWORKS[@]}"; do
      echo -e "❌ [\e[31m$NET\e[0m]"
    done
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncDEXs completed"
}
