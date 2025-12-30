#!/bin/bash

function diamondSyncWhitelist {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncWhitelist now...."

  # Load environment variables
  source .env

  # Load configuration & helper functions
  source script/helperFunctions.sh

  # Update whitelist periphery and composer entries before syncing
  echo ""
  echo "[info] Updating whitelist periphery and composer entries..."
  bunx tsx script/tasks/updateWhitelistPeriphery.ts || checkFailure $? "update whitelist periphery"
  echo "[info] Whitelist periphery update completed"
  echo ""

  # --- CONFIGURATION ---
  ALLOW_TOKEN_CONTRACTS=${ALLOW_TOKEN_CONTRACTS:-false}
  # We use this dummy contract to attach "Orphan Selectors" to, so we can flush them from the system
  STALE_CLEANUP_DUMMY_CONTRACT=${STALE_CLEANUP_DUMMY_CONTRACT:-"0x1111111111111111111111111111111111111111"}
  
  # --- INTERACTIVE SAFETY CHECKS ---
  if [[ "$ALLOW_TOKEN_CONTRACTS" == "true" ]]; then
    echo ""
    printf '\033[31m%s\033[0m\n' "!!!!!!!!!!!!!!!!!!!!!!!! ATTENTION !!!!!!!!!!!!!!!!!!!!!!!!"
    printf '\033[33m%s\033[0m\n' "ALLOW_TOKEN_CONTRACTS is set to true"
    printf '\033[33m%s\033[0m\n' "This will allow token contracts to be whitelisted"
    printf '\033[31m%s\033[0m\n' "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo ""
    printf '\033[33m%s\033[0m\n' "Do you want to continue?"
    if [[ "$(gum choose "yes" "no")" != "yes" ]]; then
      echo "...exiting script"
      return 0
    fi
  fi

  # --- SETUP NETWORK & ARGS ---
  local NETWORK="$1"
  local ENVIRONMENT="${2:-production}"  # Default to production if not specified
  local DIAMOND_CONTRACT_NAME="LiFiDiamond"

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

  # Determine which networks to process
  RUN_FOR_ALL_NETWORKS=false
  if [[ "$NETWORK" == "All (non-excluded) Networks" ]]; then
    RUN_FOR_ALL_NETWORKS=true
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

  # Controlled debug logging for this script:
  # - When running against all networks, suppress noisy debug output
  # - When running against a single network, keep full debug logs for easier troubleshooting
  function echoSyncDebug {
    if [[ "$RUN_FOR_ALL_NETWORKS" == "true" ]]; then
      return
    fi
    echoDebug "$@"
  }

  function echoSyncVerbose {
    if [[ "$RUN_FOR_ALL_NETWORKS" == "true" ]]; then
      return
    fi
    echo "$@"
  }

  # Info / stage logging helpers:
  # - Only print for single-network runs to avoid clutter in "all networks" mode
  function echoSyncStage {
    if [[ "$RUN_FOR_ALL_NETWORKS" == "true" ]]; then
      return
    fi
    echo ""
    printf '\033[0;36m%s\033[0m\n' "$@"
  }

  function echoSyncStep {
    if [[ "$RUN_FOR_ALL_NETWORKS" == "true" ]]; then
      return
    fi
    printf '\033[0;35m%s\033[0m\n' "$@"
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
      printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] LiFiDiamond not deployed yet - skipping whitelist sync"
      return
    fi

    RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

    echoSyncDebug "Using RPC URL: $RPC_URL"
    echoSyncDebug "Diamond address: $DIAMOND_ADDRESS"

    # Function to get current whitelisted contract-selector pairs from the diamond
    function getCurrentWhitelistedPairs {
      local ATTEMPT=1

      while [ $ATTEMPT -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]; do
        echoSyncDebug "Attempt $ATTEMPT: Trying to get whitelisted pairs from diamond $DIAMOND_ADDRESS"

        # Try the new efficient function first
        echoSyncDebug "Calling getAllContractSelectorPairs() on diamond..."
        local cast_output=$(cast call "$DIAMOND_ADDRESS" "getAllContractSelectorPairs() returns (address[],bytes4[][])" --rpc-url "$RPC_URL" 2>&1)
        local call_exit_code=$?

        if [[ $call_exit_code -eq 0 && -n "$cast_output" ]]; then
          echoSyncDebug "Successfully got result from getAllContractSelectorPairs"

          # Initialize empty arrays for pairs
          local pairs=()

          # Handle empty result - check for both single empty array and two empty arrays
          if [[ "$cast_output" == "()" ]] || [[ "$cast_output" == "[]" ]] || [[ "$cast_output" == "[]"$'\n'"[]" ]]; then
            echoSyncDebug "Empty result from getAllContractSelectorPairs - no whitelisted pairs"
            for pair in "${pairs[@]}"; do
              echo "$pair"
            done
            return 0
          fi

          echoSyncDebug "Parsing result from getAllContractSelectorPairs..."

          # Parse the cast output
          # Cast returns two lines:
          # Line 1: Array of addresses [0xAddr1, 0xAddr2, ...]
          # Line 2: Array of selector arrays [[0xSel1, 0xSel2], [0xSel3], ...]

          # Extract the two lines
          local addresses_line
          local selectors_line
          addresses_line=$(echo "$cast_output" | sed -n '1p')
          selectors_line=$(echo "$cast_output" | sed -n '2p')

          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: addresses_line: ${addresses_line:0:100}"
          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: selectors_line: ${selectors_line:0:100}"

          # Parse addresses line: [0xAddr1, 0xAddr2, ...] -> array
          # Remove brackets, split by comma, trim spaces
          local -a contract_list
          while IFS= read -r addr; do
            # Trim whitespace and lowercase
            addr=$(echo "$addr" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
            if [[ -n "$addr" && "$addr" != "[" && "$addr" != "]" ]]; then
              contract_list+=("$addr")
            fi
          done < <(echo "$addresses_line" | tr -d '[]' | tr ',' '\n')

          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Parsed ${#contract_list[@]} contract addresses"

          # Parse selectors line: [[0xSel1, 0xSel2], [0xSel3], ...]
          #
          # It's a 2D array. We need to maintain the correspondence: contract_list[i] has selectors from group i

          # Remove outer brackets and split by ], [
          local selectors_grouped
          selectors_grouped=$(echo "$selectors_line" | sed 's/^\[\[//; s/\]\]$//; s/\], \[/|/g')

          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: selectors_grouped: ${selectors_grouped:0:150}"

          # Split into groups by |
          local -a selector_groups
          IFS='|' read -ra selector_groups <<< "$selectors_grouped"

          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Parsed ${#selector_groups[@]} selector groups"

          # Now expand: for each contract, create one entry per selector
          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Showing detailed info for first 3 contracts only"
          for i in "${!contract_list[@]}"; do
            local contract="${contract_list[$i]}"
            local selector_group="${selector_groups[$i]}"

            if [[ $i -lt 3 ]]; then
              echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Processing contract $i: $contract with selectors: ${selector_group:0:80}"
            fi

            # Split the selector group by comma
            IFS=',' read -ra selectors <<< "$selector_group"

            for selector in "${selectors[@]}"; do
              # Trim whitespace and lowercase
              selector=$(echo "$selector" | tr -d ' ' | tr '[:upper:]' '[:lower:]')

              if [[ -n "$selector" ]]; then
                # Add to flat arrays
                pairs+=("$contract|$selector")
              fi
            done
          done

          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Created ${#pairs[@]} pairs from getAllContractSelectorPairs parsing"
          if [[ ${#pairs[@]} -gt 0 ]]; then
            # Successfully parsed ${#pairs[@]} pairs from getAllContractSelectorPairs
            echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Returning ${#pairs[@]} pairs from primary parsing"
            for pair in "${pairs[@]}"; do
              echo "$pair"
            done
            return 0
          else
            echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Primary parsing created 0 pairs, falling back to getWhitelistedAddresses"
          fi
        else
          # getAllContractSelectorPairs failed with exit code $call_exit_code
          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: getAllContractSelectorPairs failed, falling back..."
        fi

        # Fallback to the original approach if the new function fails
        echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Attempting fallback to getWhitelistedAddresses()"
        local addresses=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedAddresses() returns (address[])" --rpc-url "$RPC_URL" 2>&1)
        local addresses_exit_code=$?

        echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: getWhitelistedAddresses result (first 200 chars): ${addresses:0:200}"

        if [[ $addresses_exit_code -eq 0 && -n "$addresses" && "$addresses" != "[]" ]]; then
          # Successfully got addresses from getWhitelistedAddresses
          local pairs=()
          local address_list=$(echo "${addresses:1:${#addresses}-2}" | tr ',' ' ')
          # Address list: $address_list

          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Fallback processing $(echo "$address_list" | wc -w) addresses"
          local addr_count=0
          for addr in $address_list; do
            ((addr_count++))
            if [[ $addr_count -le 3 ]]; then
              echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Getting selectors for address $addr_count (showing first 3 addresses only): $addr"
            fi
            local selectors=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedSelectorsForContract(address) returns (bytes4[])" "$addr" --rpc-url "$RPC_URL" 2>&1)
            local selectors_exit_code=$?

            if [[ $addr_count -le 3 ]]; then
              echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Selectors for $addr (first 100 chars of result): ${selectors:0:100}"
            fi

            if [[ $selectors_exit_code -eq 0 && -n "$selectors" && "$selectors" != "[]" ]]; then
              local selector_list=$(echo "${selectors:1:${#selectors}-2}" | tr ',' ' ')
              for selector in $selector_list; do
                pairs+=("$(echo "$addr" | tr '[:upper:]' '[:lower:]')|$selector")
              done
            fi
          done

          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Fallback created ${#pairs[@]} pairs from ${addr_count} addresses"

          if [[ ${#pairs[@]} -gt 0 ]]; then
            # Successfully got ${#pairs[@]} pairs using fallback method
            for pair in "${pairs[@]}"; do
              echo "$pair"
            done
            return 0
          else
            # No pairs found using fallback method
            :
          fi
        else
          # getWhitelistedAddresses also failed
          :
        fi

        # Attempt $ATTEMPT failed, waiting 3 seconds before retry...
        sleep 3
        ATTEMPT=$((ATTEMPT + 1))
      done

      # All attempts failed to get whitelisted pairs
      return 1
    }

    # 1. READ RAW V1 ARRAYS (Using TS script)
    function readV1Data {
      echoSyncDebug "Fetching Raw V1 Storage..."
      bunx tsx script/tasks/readV1WhitelistArrays.ts "$NETWORK" "$DIAMOND_ADDRESS" "$RPC_URL" 2>/dev/null
    }
    
    local V1_JSON
    V1_JSON=$(readV1Data)
    local V1_CONTRACTS=($(echo "$V1_JSON" | jq -r '.contracts[]?' 2>/dev/null))
    local V1_SELECTORS=($(echo "$V1_JSON" | jq -r '.selectors[]?' 2>/dev/null))

    # 2. READ V2 PAIRS (Using Cast)
    echoSyncStage "----- [$NETWORK] Stage 1: Loading current whitelist state -----"
    local V2_PAIRS=($(getCurrentWhitelistedPairs))
    local get_pairs_exit_code=$?

    if [[ $get_pairs_exit_code -ne 0 ]]; then
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Unable to fetch current whitelisted pairs"
      {
        echo "[$NETWORK] Error: Unable to fetch current whitelisted pairs"
        echo ""
      } >> "$FAILED_LOG_FILE"
      return
    fi

    echoSyncDebug "V1 state: ${#V1_CONTRACTS[@]} contracts, ${#V1_SELECTORS[@]} selectors"
    echoSyncDebug "V2 state: ${#V2_PAIRS[@]} pairs"

    # 3. READ CONFIG (Standard)
    echoSyncStage "----- [$NETWORK] Stage 2: Loading required whitelist configuration -----"
    
    # Determine the correct whitelist file based on environment
    local WHITELIST_FILE
    if [[ "$ENVIRONMENT" == "production" ]]; then
      WHITELIST_FILE="config/whitelist.json"
    else
      WHITELIST_FILE="config/whitelist.staging.json"
    fi

    # Get DEX contracts
    echoSyncDebug "Getting DEX contracts..."
    local DEX_CONTRACTS=$(jq -r --arg network "$NETWORK" '.DEXS[] | select(.contracts[$network] != null) | .contracts[$network][] | select(.address != null) | "\(.address)|\(.functions | keys | join(","))"' "$WHITELIST_FILE" 2>&1)
    local dex_exit_code=$?

    if [[ $dex_exit_code -ne 0 ]]; then
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Failed to extract DEX contracts from $WHITELIST_FILE (jq exit code $dex_exit_code)"
      {
        echo "[$NETWORK] Error: Failed to extract DEX contracts"
        echo ""
      } >> "$FAILED_LOG_FILE"
      return
    fi

    # Get PERIPHERY contracts from the appropriate whitelist file
    echoSyncDebug "Getting periphery contracts from $WHITELIST_FILE..."
    local PERIPHERY_CONTRACTS=$(jq -r --arg network "$NETWORK" '.PERIPHERY[$network] // [] | .[] | select(.address != null) | "\(.address)|\(.selectors | map(.selector) | join(","))"' "$WHITELIST_FILE" 2>&1)
    local periphery_exit_code=$?

    if [[ $periphery_exit_code -ne 0 ]]; then
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Failed to extract periphery contracts from $WHITELIST_FILE (jq exit code $periphery_exit_code)"
      {
        echo "[$NETWORK] Error: Failed to extract periphery contracts"
        echo ""
      } >> "$FAILED_LOG_FILE"
      return
    fi

    # Combine DEX and PERIPHERY contracts
    local RAW_CONFIG="$DEX_CONTRACTS"$'\n'"$PERIPHERY_CONTRACTS"
    local REQUIRED_PAIRS=()
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then
        REQUIRED_PAIRS+=("$line")
      fi
    done <<< "$RAW_CONFIG"

    if [[ ${#REQUIRED_PAIRS[@]} -eq 0 ]]; then
      printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] No contract-selector pairs found in whitelist files for this network"
      return
    fi

    # ------------------------------------------------------------
    # LOGIC: CALCULATE DELTAS (MERGED APPROACH)
    # ------------------------------------------------------------
    echoSyncStage "----- [$NETWORK] Stage 3: Calculating deltas (additions and removals) -----"

    # Use regular arrays instead of associative arrays for compatibility
    # Build flat arrays for membership checks
    local REQUIRED_PAIRS_NORMALIZED=()
    local V2_PAIRS_NORMALIZED=()
    local V2_CONTRACTS_NORMALIZED=()
    local V2_SELECTORS_NORMALIZED=()

    # Helper function to check if value is in array
    function isInArray {
      local SEARCH_VALUE="$1"
      shift
      local ARRAY=("$@")
      for item in "${ARRAY[@]}"; do
        if [[ "$item" == "$SEARCH_VALUE" ]]; then
          return 0
        fi
      done
      return 1
    }

    # Helper function to process batch in chunks (to avoid gas limits and identify failing pairs)
    function processBatchInChunks {
      local CONTRACTS_STR="$1"
      local SELECTORS_STR="$2"
      local IS_ADD="$3"  # true or false
      local TOTAL_COUNT="$4"
      local BATCH_SIZE=50  # Process 20 pairs at a time
      
      # Convert strings to arrays
      local -a CONTRACTS_ARRAY
      local -a SELECTORS_ARRAY
      IFS=',' read -ra CONTRACTS_ARRAY <<< "$CONTRACTS_STR"
      IFS=',' read -ra SELECTORS_ARRAY <<< "$SELECTORS_STR"
      
      local TOTAL_BATCHES=$(( (TOTAL_COUNT + BATCH_SIZE - 1) / BATCH_SIZE ))
      local SUCCESS_COUNT=0
      local FAIL_COUNT=0
      
      for ((BATCH=0; BATCH < TOTAL_BATCHES; BATCH++)); do
        local START=$((BATCH * BATCH_SIZE))
        local END=$((START + BATCH_SIZE))
        if [[ $END -gt $TOTAL_COUNT ]]; then
          END=$TOTAL_COUNT
        fi
        
        local BATCH_CONTRACTS=""
        local BATCH_SELECTORS=""
        local BATCH_COUNT=0
        
        for ((i=START; i < END; i++)); do
          if [[ $BATCH_COUNT -gt 0 ]]; then
            BATCH_CONTRACTS+=","
            BATCH_SELECTORS+=","
          fi
          BATCH_CONTRACTS+="${CONTRACTS_ARRAY[$i]}"
          BATCH_SELECTORS+="${SELECTORS_ARRAY[$i]}"
          ((BATCH_COUNT++))
        done
        
        echoSyncDebug "Processing batch $((BATCH + 1))/$TOTAL_BATCHES ($BATCH_COUNT pairs)..."
        
        local TX_OUTPUT
        TX_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$BATCH_CONTRACTS]" "[$BATCH_SELECTORS]" "$IS_ADD" --rpc-url "$RPC_URL" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --legacy 2>&1)
        local TX_EXIT_CODE=$?
        
        # Log full output for debugging
        if [[ $TX_EXIT_CODE -ne 0 ]] || [[ "$TX_OUTPUT" == *"Error"* ]] || [[ "$TX_OUTPUT" == *"revert"* ]] || [[ "$TX_OUTPUT" == *"execution reverted"* ]]; then
          echoSyncDebug "Transaction output: $TX_OUTPUT"
        fi
        
        # Extract transaction hash
        local TX_HASH=""
        if [[ "$TX_OUTPUT" =~ transactionHash[[:space:]]*0x([0-9a-fA-F]{64}) ]]; then
          TX_HASH="0x${BASH_REMATCH[1]}"
        elif [[ "$TX_OUTPUT" =~ 0x([0-9a-fA-F]{64}) ]]; then
          TX_HASH="${BASH_REMATCH[0]}"
        fi
        
        if [[ $TX_EXIT_CODE -eq 0 ]] && [[ -n "$TX_HASH" ]]; then
          sleep 3
          # Check receipt status properly using JSON output
          local TX_STATUS
          TX_STATUS=$(cast receipt "$TX_HASH" --rpc-url "$RPC_URL" --json 2>/dev/null | jq -r '.status // empty' 2>/dev/null)
          local TX_RECEIPT_RAW
          TX_RECEIPT_RAW=$(cast receipt "$TX_HASH" --rpc-url "$RPC_URL" 2>&1)
          
          # Verify transaction actually succeeded
          if [[ "$TX_STATUS" == "0x1" ]] || ([[ -z "$TX_STATUS" ]] && [[ "$TX_RECEIPT_RAW" != *"reverted"* ]] && [[ "$TX_RECEIPT_RAW" != *"status"*"0x0"* ]] && [[ "$TX_RECEIPT_RAW" == *"blockHash"* ]]); then
            # Double-check by verifying ALL pairs were actually added (not just samples)
            local VERIFY_SUCCESS_COUNT=0
            local VERIFY_FAIL_COUNT=0
            local SAMPLE_CONTRACTS_ARRAY
            local SAMPLE_SELECTORS_ARRAY
            IFS=',' read -ra SAMPLE_CONTRACTS_ARRAY <<< "$BATCH_CONTRACTS"
            IFS=',' read -ra SAMPLE_SELECTORS_ARRAY <<< "$BATCH_SELECTORS"
            
            # Verify ALL pairs in the batch were actually added
            for ((j=0; j < BATCH_COUNT; j++)); do
              local CHECK_CONTRACT="${SAMPLE_CONTRACTS_ARRAY[$j]}"
              local CHECK_SELECTOR="${SAMPLE_SELECTORS_ARRAY[$j]}"
              local IS_WHITELISTED_HEX
              IS_WHITELISTED_HEX=$(cast call "$DIAMOND_ADDRESS" "isContractSelectorWhitelisted(address,bytes4)" "$CHECK_CONTRACT" "$CHECK_SELECTOR" --rpc-url "$RPC_URL" 2>/dev/null | tail -1 | tr -d '[:space:]')
              
              # Parse hex result: 0x...0001 = true, 0x...0000 = false
              # cast call returns booleans as hex-encoded uint256
              # Simple check: if hex is non-zero (not all zeros), it's true
              local IS_WHITELISTED=false
              if [[ -n "$IS_WHITELISTED_HEX" ]]; then
                # Remove 0x prefix and leading zeros, check if anything remains
                local HEX_WITHOUT_PREFIX="${IS_WHITELISTED_HEX#0x}"
                local HEX_TRIMMED="${HEX_WITHOUT_PREFIX#"${HEX_WITHOUT_PREFIX%%[!0]*}"}"  # Remove leading zeros
                # If trimmed hex is not empty and not just "0", it's true
                if [[ -n "$HEX_TRIMMED" ]] && [[ "$HEX_TRIMMED" != "0" ]]; then
                  IS_WHITELISTED=true
                fi
              fi
              
              if [[ "$IS_WHITELISTED" == "true" ]]; then
                ((VERIFY_SUCCESS_COUNT++))
              else
                ((VERIFY_FAIL_COUNT++))
                if [[ $VERIFY_FAIL_COUNT -le 3 ]]; then
                  echoSyncDebug "Pair not whitelisted: $CHECK_CONTRACT / $CHECK_SELECTOR (result: $IS_WHITELISTED_HEX)"
                fi
              fi
            done
            
            if [[ $VERIFY_FAIL_COUNT -eq 0 ]]; then
              ((SUCCESS_COUNT += BATCH_COUNT))
              echoSyncDebug "Batch $((BATCH + 1))/$TOTAL_BATCHES succeeded (all $BATCH_COUNT pairs verified)"
            else
              ((FAIL_COUNT += BATCH_COUNT))
              printf '\033[0;31m%s\033[0m\n' "❌ Batch $((BATCH + 1))/$TOTAL_BATCHES: Transaction succeeded but only $VERIFY_SUCCESS_COUNT/$BATCH_COUNT pairs were whitelisted" >&2
              echoSyncDebug "Transaction: $TX_HASH"
              {
                echo "[$NETWORK] Error: Batch $((BATCH + 1))/$TOTAL_BATCHES transaction succeeded but pairs not whitelisted"
                echo "[$NETWORK] Transaction: $TX_HASH"
                echo "[$NETWORK] Verified: $VERIFY_SUCCESS_COUNT/$BATCH_COUNT pairs"
                echo "[$NETWORK] Failed: $VERIFY_FAIL_COUNT pairs"
                echo "[$NETWORK] Contracts: $BATCH_CONTRACTS"
                echo "[$NETWORK] Selectors: $BATCH_SELECTORS"
                echo ""
              } >> "$FAILED_LOG_FILE"
            fi
          else
            ((FAIL_COUNT += BATCH_COUNT))
            echoSyncDebug "Batch $((BATCH + 1))/$TOTAL_BATCHES reverted (status: $TX_STATUS)"
            {
              echo "[$NETWORK] Error: Batch $((BATCH + 1))/$TOTAL_BATCHES reverted"
              echo "[$NETWORK] Transaction: $TX_HASH"
              echo "[$NETWORK] Status: $TX_STATUS"
              echo "[$NETWORK] Receipt: $TX_RECEIPT_RAW"
              echo "[$NETWORK] Contracts: $BATCH_CONTRACTS"
              echo "[$NETWORK] Selectors: $BATCH_SELECTORS"
              echo ""
            } >> "$FAILED_LOG_FILE"
          fi
        else
          ((FAIL_COUNT += BATCH_COUNT))
          echoSyncDebug "Batch $((BATCH + 1))/$TOTAL_BATCHES failed to send: $TX_OUTPUT"
          {
            echo "[$NETWORK] Error: Batch $((BATCH + 1))/$TOTAL_BATCHES failed to send"
            echo "[$NETWORK] Contracts: $BATCH_CONTRACTS"
            echo "[$NETWORK] Selectors: $BATCH_SELECTORS"
            echo "[$NETWORK] Output: $TX_OUTPUT"
            echo ""
          } >> "$FAILED_LOG_FILE"
        fi
        
        sleep 1  # Brief pause between batches
      done
      
      echo "$SUCCESS_COUNT|$FAIL_COUNT"
    }

    # A. Parse Config into normalized arrays
    for PAIR in "${REQUIRED_PAIRS[@]}"; do
      ADDRESS="${PAIR%%|*}"
      SELECTORS_STR="${PAIR#*|}"

      # Check for address zero (forbidden)
      ADDRESS_LOWER=$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')
      if [[ "$ADDRESS_LOWER" == "0x0000000000000000000000000000000000000000" ]]; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Error: Whitelisting address zero is forbidden: $ADDRESS"
        printf '\033[0;33m%s\033[0m\n' "⚠️  Please check whitelist.json or whitelist.staging.json"
        {
          echo "[$NETWORK] Error: Whitelisting address zero is forbidden: $ADDRESS"
          echo ""
        } >> "$FAILED_LOG_FILE"
        return 1
      fi

      # Check if address has code
      CHECKSUMMED=$(cast --to-checksum-address "$ADDRESS_LOWER")
      CODE=$(cast code "$CHECKSUMMED" --rpc-url "$RPC_URL")
      if [[ "$CODE" == "0x" ]]; then
        echoSyncDebug "Skipping address with no code: $CHECKSUMMED"
        continue
      fi

      # Check for token contracts
      if [[ "$ALLOW_TOKEN_CONTRACTS" != "true" ]] && isTokenContract "$CHECKSUMMED" "$RPC_URL"; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Token detected in config: $CHECKSUMMED"
        {
          echo "[$NETWORK] Error: Token contract in config: $CHECKSUMMED"
          echo ""
        } >> "$FAILED_LOG_FILE"
        return 1
      fi

      ADDR_L=$(echo "$CHECKSUMMED" | tr '[:upper:]' '[:lower:]')

      if [[ -z "$SELECTORS_STR" || "$SELECTORS_STR" == "" ]]; then
        # No selectors defined - add ApproveTo-Only Selector (0xffffffff) for backward compatibility
        REQUIRED_PAIRS_NORMALIZED+=("$ADDR_L|0xffffffff")
      else
        # Parse selectors (comma-separated)
        SELECTORS=($(echo "$SELECTORS_STR" | tr ',' ' '))
        for SELECTOR in "${SELECTORS[@]}"; do
          if [[ -n "$SELECTOR" && "$SELECTOR" != "" ]]; then
            SELECTOR_LOWER=$(echo "$SELECTOR" | tr '[:upper:]' '[:lower:]')
            REQUIRED_PAIRS_NORMALIZED+=("$ADDR_L|$SELECTOR_LOWER")
          fi
        done
      fi
    done

    # B. Parse V2 into normalized arrays
    for PAIR in "${V2_PAIRS[@]}"; do
      P_L=$(echo "$PAIR" | tr '[:upper:]' '[:lower:]')
      V2_PAIRS_NORMALIZED+=("$P_L")
      V2_CONTRACTS_NORMALIZED+=("${P_L%%|*}")
      V2_SELECTORS_NORMALIZED+=("${P_L#*|}")
    done

    # C. Determine ADDITIONS (Config - V2)
    local TO_ADD_CONTRACTS=""
    local TO_ADD_SELECTORS=""
    local ADD_COUNT=0
    
    for PAIR_NORM in "${REQUIRED_PAIRS_NORMALIZED[@]}"; do
      if ! isInArray "$PAIR_NORM" "${V2_PAIRS_NORMALIZED[@]}"; then
        # It's in config, not in V2 -> ADD
        ADDR="${PAIR_NORM%%|*}"
        SEL="${PAIR_NORM#*|}"
        ADDR=$(cast --to-checksum-address "$ADDR")
        if [[ "$ADD_COUNT" -gt 0 ]]; then
          TO_ADD_CONTRACTS+=","
          TO_ADD_SELECTORS+=","
        fi
        TO_ADD_CONTRACTS+="$ADDR"
        TO_ADD_SELECTORS+="$SEL"
        ((ADD_COUNT++))
      fi
    done

    # D. Determine REMOVALS (The "Three Buckets" of cleanup)
    local TO_REMOVE_CONTRACTS=""
    local TO_REMOVE_SELECTORS=""
    local REMOVE_COUNT=0
    
    function queueForRemoval {
      local A=$1
      local S=$2
      A=$(cast --to-checksum-address "$A")
      if [[ "$REMOVE_COUNT" -gt 0 ]]; then
        TO_REMOVE_CONTRACTS+=","
        TO_REMOVE_SELECTORS+=","
      fi
      TO_REMOVE_CONTRACTS+="$A"
      TO_REMOVE_SELECTORS+="$S"
      ((REMOVE_COUNT++))
    }

    # Bucket 1: Obsolete (In V2, Not in Config)
    for PAIR in "${V2_PAIRS[@]}"; do
      P_L=$(echo "$PAIR" | tr '[:upper:]' '[:lower:]')
      if ! isInArray "$P_L" "${REQUIRED_PAIRS_NORMALIZED[@]}"; then
        queueForRemoval "${P_L%%|*}" "${P_L#*|}"
      fi
    done

    # Bucket 2: Zombie Contracts (In V1, Not in V2)
    for C in "${V1_CONTRACTS[@]}"; do
      C_L=$(echo "$C" | tr '[:upper:]' '[:lower:]')
      if ! isInArray "$C_L" "${V2_CONTRACTS_NORMALIZED[@]}"; then
        echoSyncDebug "Found Zombie Contract: $C"
        # We attach dummy selector to flush it
        queueForRemoval "$C_L" "0xffffffff"
      fi
    done

    # Bucket 3: Zombie Selectors (In V1, Not in V2)
    # For zombie selectors, we need a valid contract address to attach them to
    # Use a core facet address (cannot use diamond address due to CannotAuthoriseSelf)
    local DUMMY_CONTRACT_FOR_SELECTORS=""
    local CORE_FACETS=($(getCoreFacetsArray 2>/dev/null))
    if [[ ${#CORE_FACETS[@]} -gt 0 ]]; then
      # Use the first core facet (e.g., DiamondCutFacet, DiamondLoupeFacet, etc.)
      local FIRST_CORE_FACET="${CORE_FACETS[0]}"
      DUMMY_CONTRACT_FOR_SELECTORS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$FIRST_CORE_FACET" 2>/dev/null)
      if [[ -z "$DUMMY_CONTRACT_FOR_SELECTORS" || "$DUMMY_CONTRACT_FOR_SELECTORS" == "null" ]]; then
        # Fallback: try to get any valid contract from V2 pairs
        if [[ ${#V2_PAIRS[@]} -gt 0 ]]; then
          DUMMY_CONTRACT_FOR_SELECTORS=$(echo "${V2_PAIRS[0]}" | cut -d'|' -f1 | tr '[:upper:]' '[:lower:]')
          DUMMY_CONTRACT_FOR_SELECTORS=$(cast --to-checksum-address "$DUMMY_CONTRACT_FOR_SELECTORS" 2>/dev/null || echo "$DUMMY_CONTRACT_FOR_SELECTORS")
        fi
      fi
    else
      # Fallback: use first contract from V2 pairs if core facets not available
      if [[ ${#V2_PAIRS[@]} -gt 0 ]]; then
        DUMMY_CONTRACT_FOR_SELECTORS=$(echo "${V2_PAIRS[0]}" | cut -d'|' -f1 | tr '[:upper:]' '[:lower:]')
        DUMMY_CONTRACT_FOR_SELECTORS=$(cast --to-checksum-address "$DUMMY_CONTRACT_FOR_SELECTORS" 2>/dev/null || echo "$DUMMY_CONTRACT_FOR_SELECTORS")
      fi
    fi
    
    # If we still don't have a valid contract, skip zombie selector cleanup
    if [[ -z "$DUMMY_CONTRACT_FOR_SELECTORS" || "$DUMMY_CONTRACT_FOR_SELECTORS" == "null" ]]; then
      echoSyncDebug "Warning: Could not find valid contract for zombie selector cleanup, skipping..."
    else
      for S in "${V1_SELECTORS[@]}"; do
        S_L=$(echo "$S" | tr '[:upper:]' '[:lower:]')
        # Skip invalid selectors (0x00000000) that would cause InvalidCallData error
        if [[ "$S_L" == "0x00000000" ]]; then
          echoSyncDebug "Skipping invalid zombie selector: $S"
          continue
        fi
        if ! isInArray "$S_L" "${V2_SELECTORS_NORMALIZED[@]}"; then
          echoSyncDebug "Found Zombie Selector: $S"
          # We attach a core facet address to flush the zombie selector from V1 state
          queueForRemoval "$DUMMY_CONTRACT_FOR_SELECTORS" "$S_L"
        fi
      done
    fi

    # ------------------------------------------------------------
    # EXECUTION: BATCH TRANSACTIONS
    # ------------------------------------------------------------

    # 1. PROCESS REMOVALS (Add -> Remove Pattern for safety)
    if [[ "$REMOVE_COUNT" -gt 0 ]]; then
      echoSyncStage "----- [$NETWORK] Stage 4a: Processing $REMOVE_COUNT removals (safe mode: add-then-remove) -----"
      
      # Step A: TEMP ADD (Fix broken states)
      echoSyncStep "🔄 [$NETWORK] Step 1/2: Temp adding pairs to fix broken states..."
      local ADD_TX_OUTPUT
      ADD_TX_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$TO_REMOVE_CONTRACTS]" "[$TO_REMOVE_SELECTORS]" true --rpc-url "$RPC_URL" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --legacy 2>&1)
      local ADD_TX_EXIT_CODE=$?

      if [[ $ADD_TX_EXIT_CODE -eq 0 ]] && ([[ "$ADD_TX_OUTPUT" == *"blockHash"* ]] || [[ "$ADD_TX_OUTPUT" == *"transactionHash"* ]]); then
        echoSyncDebug "Temp add successful"
        sleep 2
      else
        echoSyncDebug "Temp add failed (may be expected for some broken states): $ADD_TX_OUTPUT"
        # Continue anyway - some pairs may already be in correct state
      fi

      # Step B: PERMANENT REMOVE
      echoSyncStep "🗑️  [$NETWORK] Step 2/2: Permanently removing pairs..."
      local REMOVE_TX_OUTPUT
      REMOVE_TX_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$TO_REMOVE_CONTRACTS]" "[$TO_REMOVE_SELECTORS]" false --rpc-url "$RPC_URL" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --legacy 2>&1)
      local REMOVE_TX_EXIT_CODE=$?
      
      # Extract transaction hash from output
      local REMOVE_TX_HASH=""
      if [[ "$REMOVE_TX_OUTPUT" =~ transactionHash[[:space:]]*0x([0-9a-fA-F]{64}) ]]; then
        REMOVE_TX_HASH="0x${BASH_REMATCH[1]}"
      elif [[ "$REMOVE_TX_OUTPUT" =~ 0x([0-9a-fA-F]{64}) ]]; then
        REMOVE_TX_HASH="${BASH_REMATCH[0]}"
      fi
      
      if [[ $REMOVE_TX_EXIT_CODE -eq 0 ]] && [[ -n "$REMOVE_TX_HASH" ]]; then
        # Wait for transaction to be mined and check receipt
        sleep 3
        local REMOVE_TX_RECEIPT
        REMOVE_TX_RECEIPT=$(cast receipt "$REMOVE_TX_HASH" --rpc-url "$RPC_URL" 2>&1)
        local REMOVE_RECEIPT_EXIT_CODE=$?
        
        if [[ $REMOVE_RECEIPT_EXIT_CODE -eq 0 ]] && [[ "$REMOVE_TX_RECEIPT" != *"reverted"* ]] && [[ "$REMOVE_TX_RECEIPT" != *"status"*"0x0"* ]]; then
          printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Removal successful ($REMOVE_COUNT pairs)"
          sleep 2
        else
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Removal transaction reverted"
          echoSyncDebug "Transaction hash: $REMOVE_TX_HASH"
          echoSyncDebug "Receipt: $REMOVE_TX_RECEIPT"
          {
            echo "[$NETWORK] Error: Removal transaction reverted"
            echo "[$NETWORK] Transaction: $REMOVE_TX_HASH"
            echo "[$NETWORK] Pairs: $REMOVE_COUNT"
            echo "[$NETWORK] Receipt: $REMOVE_TX_RECEIPT"
            echo ""
          } >> "$FAILED_LOG_FILE"
        fi
      else
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Removal failed to send"
        echoSyncDebug "Output: $REMOVE_TX_OUTPUT"
        {
          echo "[$NETWORK] Error: Removal failed to send"
          echo "[$NETWORK] Pairs: $REMOVE_COUNT"
          echo "[$NETWORK] Output: $REMOVE_TX_OUTPUT"
          echo ""
        } >> "$FAILED_LOG_FILE"
      fi
    else
      printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] No stale/obsolete pairs found"
    fi

    # 2. PROCESS ADDITIONS (Standard)
    if [[ "$ADD_COUNT" -gt 0 ]]; then
      echoSyncStage "----- [$NETWORK] Stage 4b: Adding $ADD_COUNT new pairs -----"
      
      # Use batch processing for large batches to avoid gas limits and identify failing pairs
      local BATCH_RESULT
      BATCH_RESULT=$(processBatchInChunks "$TO_ADD_CONTRACTS" "$TO_ADD_SELECTORS" "true" "$ADD_COUNT")
      local SUCCESS_COUNT=$(echo "$BATCH_RESULT" | cut -d'|' -f1)
      local FAIL_COUNT=$(echo "$BATCH_RESULT" | cut -d'|' -f2)
      
      # Ensure SUCCESS_COUNT and FAIL_COUNT are numeric (handle cases where function returns error text)
      if ! [[ "$SUCCESS_COUNT" =~ ^[0-9]+$ ]]; then
        SUCCESS_COUNT=0
      fi
      if ! [[ "$FAIL_COUNT" =~ ^[0-9]+$ ]]; then
        FAIL_COUNT=0
      fi
      
      if [[ $SUCCESS_COUNT -gt 0 ]]; then
        printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Additions successful ($SUCCESS_COUNT/$ADD_COUNT pairs)"
        
        if [[ $FAIL_COUNT -gt 0 ]]; then
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] $FAIL_COUNT pairs failed (check failed log for details)"
        fi

        # Verify by calling getAllContractSelectorPairs() to confirm the state
        echo ""
        printf '\033[0;36m%s\033[0m\n' "🔍 [$NETWORK] Verifying whitelist state..."
        sleep 3  # Wait for state to propagate

        local UPDATED_PAIRS=($(getCurrentWhitelistedPairs))
        local verify_exit_code=$?

        if [[ $verify_exit_code -eq 0 ]]; then
          # Check if all required pairs are now present
          local VERIFIED_COUNT=0
          local MISSING_COUNT=0

          # Build normalized array of updated pairs for lookup
          local UPDATED_PAIRS_NORMALIZED=()
          for pair in "${UPDATED_PAIRS[@]}"; do
            UPDATED_PAIRS_NORMALIZED+=("$(echo "$pair" | tr '[:upper:]' '[:lower:]')")
          done

          # Check each required pair
          for PAIR_NORM in "${REQUIRED_PAIRS_NORMALIZED[@]}"; do
            if isInArray "$PAIR_NORM" "${UPDATED_PAIRS_NORMALIZED[@]}"; then
              ((VERIFIED_COUNT++))
            else
              ((MISSING_COUNT++))
            fi
          done

          if [[ $MISSING_COUNT -eq 0 ]]; then
            printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Verified: All required pairs are whitelisted"
          elif [[ $VERIFIED_COUNT -gt 0 ]]; then
            printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Partial verification: $VERIFIED_COUNT/${#REQUIRED_PAIRS_NORMALIZED[@]} pairs confirmed"
            if [[ $FAIL_COUNT -gt 0 ]]; then
              echoSyncDebug "Some pairs failed to add. Check failed log for details."
            fi
          else
            printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Verification incomplete (may be timing issue or transaction failures)"
          fi
        else
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Could not verify whitelist state"
        fi
      else
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] All additions failed"
        {
          echo "[$NETWORK] Error: All additions failed"
          echo "[$NETWORK] Total pairs attempted: $ADD_COUNT"
          echo ""
        } >> "$FAILED_LOG_FILE"
      fi
    else
      if [[ "$REMOVE_COUNT" -gt 0 ]]; then
        printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] No new pairs to add, but $REMOVE_COUNT obsolete/stale pairs were removed"
      else
        printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Skipped - all contract-selector pairs are already whitelisted"
      fi
    fi
  }

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

    echo ""
    printf '\033[0;31m%s\033[0m\n' "Detailed failure reasons:"
    echo ""
    cat "$FAILED_LOG_FILE"

    # Store failure status before cleanup
    HAS_FAILURES=true
  else
    HAS_FAILURES=false
  fi

  # Cleanup temp files
  rm -f "$FAILED_LOG_FILE"

  if [[ "$HAS_FAILURES" == "true" ]]; then
    echo ""
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncWhitelist completed"
    return 1
  else
    echo ""
    echo "✅ All active networks updated successfully with granular whitelist"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script syncWhitelist completed"
    return 0
  fi
}
