#!/bin/bash

function diamondSyncSigs_FAST {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncSIGs now...."

  # Load environment variables
  source .env

  # Load configuration and helper functions
  source script/helperFunctions.sh

  # Read function arguments
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"
  local EXIT_ON_ERROR="$4"

  # Set max number of concurrent jobs
  local MAX_CONCURRENT_JOBS=5

  # Validate required config path
  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"

  # no need to distinguish between mutable and immutable anymore
  DIAMOND_CONTRACT_NAME="LiFiDiamond"

  # Get a list of all networks
  NETWORKS=($(getIncludedNetworksArray))

  # Determine file suffix based on environment
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # Temp file to track any failed network logs from background jobs
  FAILED_LOG_FILE=$(mktemp)

  # Define function to process a single network
  function processNetwork {
    local NETWORK=$1

    # Skip local/test networks
    if [[ "$NETWORK" == "localanvil" || "$NETWORK" == "bsc-testnet" || "$NETWORK" == "lineatest" || "$NETWORK" == "mumbai" || "$NETWORK" == "sepolia" ]]; then
      return
    fi

    local DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")
    local RPC_URL=$(getRPCUrl "$NETWORK")

    if [[ -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" ]]; then
      echo -e "❌ [\e[31m$NETWORK\e[0m] Failed - Missing contract address"
      echo "[$NETWORK] Error: Missing contract address" >> "$FAILED_LOG_FILE"
      return
    fi

    local ATTEMPTS=1
    local RETURN_CODE=1

    while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
      # Try TypeScript version first
      TX_OUTPUT=$(bun ./script/tasks/diamondSyncSigs.ts \
        --project ../../tsconfig.json \
        --network "$NETWORK" \
        --rpcUrl "$RPC_URL" \
        --privateKey "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" \
        --environment "$ENVIRONMENT" 2>&1)

      RETURN_CODE=$?

      # ❗ If output contains a multicall failure (i.e. issue with RPC), override the return code
      if echo "$TX_OUTPUT" | grep -q "The multicall failed"; then
        RETURN_CODE=99
      fi

      if [ $RETURN_CODE -eq 0 ]; then
        if echo "$TX_OUTPUT" | grep -q 'Transaction:'; then
          local TX_HASH=$(echo "$TX_OUTPUT" | grep -i 'transaction hash' | awk '{print $NF}')
          if [[ -n "$TX_HASH" ]]; then
            printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Signatures synced (tx: $TX_HASH)"
          else
            printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Signatures synced"
          fi
        else
          printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Signatures already approved"
        fi
        return
      fi

      # Fallback to cast send
      if [[ $ATTEMPTS == 1 ]]; then
        CFG_SIGS=($(jq -r '.[] | @sh' "./config/sigs.json" | tr -d \' | tr '[:upper:]' '[:lower:]'))
        PARAMS=""
        for d in "${CFG_SIGS[@]}"; do
          PARAMS+="${d},"
        done
      fi

      TX_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetFunctionApprovalBySignature(bytes4[],bool)" \
        "[${PARAMS::${#PARAMS}-1}]" true \
        --rpc-url "$RPC_URL" \
        --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" \
        --legacy 2>&1)

      RETURN_CODE=$?

      if [ $RETURN_CODE -eq 0 ]; then
        local TX_HASH=$(echo "$TX_OUTPUT" | grep -i 'transaction hash' | awk '{print $NF}')
        if [[ -n "$TX_HASH" ]]; then
          printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Signatures synced (tx: $TX_HASH)"
        else
          printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Signatures synced"
        fi
        return
      fi

      ATTEMPTS=$((ATTEMPTS + 1))
      sleep 2
    done

    # Report failure
    printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Max sync attempts reached without success"
    {
      echo "[$NETWORK] Error: Max sync attempts reached"
      echo "[$NETWORK] Last TX_OUTPUT:"
      echo "$TX_OUTPUT"
      echo ""
    } >> "$FAILED_LOG_FILE"
  }

  # Run all networks in parallel with concurrency control
  for NETWORK in "${NETWORKS[@]}"; do
    while [[ $(jobs | wc -l) -ge $MAX_CONCURRENT_JOBS ]]; do
      sleep 1
    done
    processNetwork "$NETWORK" &
  done

  # Wait for all background jobs to finish
  wait

  # Print summary of failures
  if [ -s "$FAILED_LOG_FILE" ]; then
    echo ""
    echo "[error] The following networks failed to sync:"
    awk '/^\[.*\] Error: /' "$FAILED_LOG_FILE" | while read -r line; do
      echo -e "❌ ${line}"
    done

    echo ""
    echo "[debug] Full error logs:"
    cat "$FAILED_LOG_FILE"

    rm "$FAILED_LOG_FILE"

    if [[ -n "$EXIT_ON_ERROR" ]]; then
      exit 1
    else
      return 1
    fi
  else
    rm "$FAILED_LOG_FILE"
    echo ""
    echo "[info] ✅ All networks synced successfully"
    return 0
  fi
}
