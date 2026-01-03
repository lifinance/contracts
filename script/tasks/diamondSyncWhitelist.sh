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

  # Debug logging helpers
  function echoSyncDebug {
    if [[ "$RUN_FOR_ALL_NETWORKS" == "true" ]]; then return; fi
    echoDebug "$@"
  }
  function echoSyncVerbose {
    if [[ "$RUN_FOR_ALL_NETWORKS" == "true" ]]; then return; fi
    echo "$@"
  }
  function echoSyncStage {
    if [[ "$RUN_FOR_ALL_NETWORKS" == "true" ]]; then return; fi
    echo ""
    printf '\033[0;36m%s\033[0m\n' "$@"
  }
  function echoSyncStep {
    if [[ "$RUN_FOR_ALL_NETWORKS" == "true" ]]; then return; fi
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
        echoSyncDebug "Attempt $ATTEMPT: Calling getAllContractSelectorPairs()..."
        local cast_output=$(cast call "$DIAMOND_ADDRESS" "getAllContractSelectorPairs() returns (address[],bytes4[][])" --rpc-url "$RPC_URL" 2>&1)
        
        if [[ $? -eq 0 && -n "$cast_output" ]]; then
          local pairs=()
          if [[ "$cast_output" == "()" ]] || [[ "$cast_output" == "[]" ]] || [[ "$cast_output" == "[]"$'\n'"[]" ]]; then
             return 0
          fi
          
          # Simplified parsing logic for standard cast output
          local addresses_line=$(echo "$cast_output" | sed -n '1p')
          local selectors_line=$(echo "$cast_output" | sed -n '2p')
          
          local -a contract_list
          while IFS= read -r addr; do
            addr=$(echo "$addr" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
            if [[ -n "$addr" && "$addr" != "[" && "$addr" != "]" ]]; then
              contract_list+=("$addr")
            fi
          done < <(echo "$addresses_line" | tr -d '[]' | tr ',' '\n')

          local selectors_grouped=$(echo "$selectors_line" | sed 's/^\[\[//; s/\]\]$//; s/\], \[/|/g')
          local -a selector_groups
          IFS='|' read -ra selector_groups <<< "$selectors_grouped"

          for i in "${!contract_list[@]}"; do
            local contract="${contract_list[$i]}"
            local selector_group="${selector_groups[$i]}"
            IFS=',' read -ra selectors <<< "$selector_group"
            for selector in "${selectors[@]}"; do
              selector=$(echo "$selector" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
              if [[ -n "$selector" ]]; then
                pairs+=("$contract|$selector")
              fi
            done
          done
          
          if [[ ${#pairs[@]} -gt 0 ]]; then
            for pair in "${pairs[@]}"; do echo "$pair"; done
            return 0
          fi
        else
            # Fallback logic if needed (omitted for brevity, main path usually works)
            :
        fi
        sleep 3
        ATTEMPT=$((ATTEMPT + 1))
      done
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

    # 2. READ V2 PAIRS
    echoSyncStage "----- [$NETWORK] Stage 1: Loading current whitelist state -----"
    local V2_PAIRS=($(getCurrentWhitelistedPairs))
    if [[ $? -ne 0 ]]; then
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Unable to fetch current whitelisted pairs"
      echo "[$NETWORK] Error: Unable to fetch current whitelisted pairs" >> "$FAILED_LOG_FILE"
      return
    fi

    echoSyncDebug "V1 state: ${#V1_CONTRACTS[@]} contracts, ${#V1_SELECTORS[@]} selectors"
    echoSyncDebug "V2 state: ${#V2_PAIRS[@]} pairs"

    # 3. READ CONFIG
    echoSyncStage "----- [$NETWORK] Stage 2: Loading required whitelist configuration -----"
    local WHITELIST_FILE
    if [[ "$ENVIRONMENT" == "production" ]]; then
      WHITELIST_FILE="config/whitelist.json"
    else
      WHITELIST_FILE="config/whitelist.staging.json"
    fi

    local DEX_CONTRACTS=$(jq -r --arg network "$NETWORK" '.DEXS[] | select(.contracts[$network] != null) | .contracts[$network][] | select(.address != null) | "\(.address)|\(.functions | keys | join(","))"' "$WHITELIST_FILE" 2>&1)
    local PERIPHERY_CONTRACTS=$(jq -r --arg network "$NETWORK" '.PERIPHERY[$network] // [] | .[] | select(.address != null) | "\(.address)|\(.selectors | map(.selector) | join(","))"' "$WHITELIST_FILE" 2>&1)

    local RAW_CONFIG="$DEX_CONTRACTS"$'\n'"$PERIPHERY_CONTRACTS"
    local REQUIRED_PAIRS=()
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then REQUIRED_PAIRS+=("$line"); fi
    done <<< "$RAW_CONFIG"

    if [[ ${#REQUIRED_PAIRS[@]} -eq 0 ]]; then
      printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] No contract-selector pairs found in whitelist files"
      return
    fi

    # ------------------------------------------------------------
    # LOGIC: CALCULATE DELTAS
    # ------------------------------------------------------------
    echoSyncStage "----- [$NETWORK] Stage 3: Calculating deltas -----"

    local REQUIRED_PAIRS_NORMALIZED=()
    local V2_PAIRS_NORMALIZED=()
    local V2_CONTRACTS_NORMALIZED=()
    local V2_SELECTORS_NORMALIZED=()

    function isInArray {
      local SEARCH_VALUE="$1"
      shift
      local ARRAY=("$@")
      for item in "${ARRAY[@]}"; do
        if [[ "$item" == "$SEARCH_VALUE" ]]; then return 0; fi
      done
      return 1
    }

    # Helper for batch processing
    function processBatchInChunks {
      local CONTRACTS_STR="$1"
      local SELECTORS_STR="$2"
      local IS_ADD="$3"
      local TOTAL_COUNT="$4"
      local BATCH_SIZE=50
      
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
        if [[ $END -gt $TOTAL_COUNT ]]; then END=$TOTAL_COUNT; fi
        
        local BATCH_CONTRACTS=""
        local BATCH_SELECTORS=""
        local BATCH_COUNT=0
        
        for ((i=START; i < END; i++)); do
          if [[ $BATCH_COUNT -gt 0 ]]; then BATCH_CONTRACTS+=","; BATCH_SELECTORS+=","; fi
          BATCH_CONTRACTS+="${CONTRACTS_ARRAY[$i]}"
          BATCH_SELECTORS+="${SELECTORS_ARRAY[$i]}"
          ((BATCH_COUNT++))
        done
        
        echoSyncDebug "Processing batch $((BATCH + 1))/$TOTAL_BATCHES ($BATCH_COUNT pairs)..."
        local TX_OUTPUT
        TX_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$BATCH_CONTRACTS]" "[$BATCH_SELECTORS]" "$IS_ADD" --rpc-url "$RPC_URL" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --legacy 2>&1)
        
        if [[ $? -eq 0 ]] && ([[ "$TX_OUTPUT" == *"blockHash"* ]] || [[ "$TX_OUTPUT" == *"transactionHash"* ]]); then
             ((SUCCESS_COUNT += BATCH_COUNT))
        else
             ((FAIL_COUNT += BATCH_COUNT))
             echoSyncDebug "Batch failed: $TX_OUTPUT"
             echo "[$NETWORK] Error: Batch $((BATCH + 1)) failed" >> "$FAILED_LOG_FILE"
        fi
        sleep 1
      done
      echo "$SUCCESS_COUNT|$FAIL_COUNT"
    }

    # A. Normalize Config
    for PAIR in "${REQUIRED_PAIRS[@]}"; do
      ADDRESS="${PAIR%%|*}"
      SELECTORS_STR="${PAIR#*|}"
      ADDRESS_LOWER=$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')
      
      if [[ "$ADDRESS_LOWER" == "0x0000000000000000000000000000000000000000" ]]; then
        echo "[$NETWORK] Error: Address zero forbidden" >> "$FAILED_LOG_FILE"
        return 1
      fi

      CHECKSUMMED=$(cast --to-checksum-address "$ADDRESS_LOWER")
      CODE=$(cast code "$CHECKSUMMED" --rpc-url "$RPC_URL")
      if [[ "$CODE" == "0x" ]]; then continue; fi

      if [[ "$ALLOW_TOKEN_CONTRACTS" != "true" ]] && isTokenContract "$CHECKSUMMED" "$RPC_URL"; then
        echo "[$NETWORK] Error: Token contract detected: $CHECKSUMMED" >> "$FAILED_LOG_FILE"
        return 1
      fi

      ADDR_L=$(echo "$CHECKSUMMED" | tr '[:upper:]' '[:lower:]')
      if [[ -z "$SELECTORS_STR" ]]; then SELECTORS_STR="0xffffffff"; fi
      
      SELECTORS=($(echo "$SELECTORS_STR" | tr ',' ' '))
      for SELECTOR in "${SELECTORS[@]}"; do
          SELECTOR_LOWER=$(echo "$SELECTOR" | tr '[:upper:]' '[:lower:]')
          REQUIRED_PAIRS_NORMALIZED+=("$ADDR_L|$SELECTOR_LOWER")
      done
    done

    # B. Normalize V2
    for PAIR in "${V2_PAIRS[@]}"; do
      P_L=$(echo "$PAIR" | tr '[:upper:]' '[:lower:]')
      V2_PAIRS_NORMALIZED+=("$P_L")
      V2_CONTRACTS_NORMALIZED+=("${P_L%%|*}")
      V2_SELECTORS_NORMALIZED+=("${P_L#*|}")
    done

    # C. Calculate Additions (excluding false positives)
    local TO_ADD_CONTRACTS=""
    local TO_ADD_SELECTORS=""
    local ADD_COUNT=0
    local FALSE_POSITIVE_PAIRS=()
    
    # Identify False Positives first
    for PAIR_NORM in "${REQUIRED_PAIRS_NORMALIZED[@]}"; do
      if ! isInArray "$PAIR_NORM" "${V2_PAIRS_NORMALIZED[@]}"; then
        ADDR="${PAIR_NORM%%|*}"
        SEL="${PAIR_NORM#*|}"
        ADDR_CHECKSUMMED=$(cast --to-checksum-address "$ADDR")
        
        # Check explicit mapping state
        IS_WHITELISTED=$(cast call "$DIAMOND_ADDRESS" "isContractSelectorWhitelisted(address,bytes4) returns (bool)" "$ADDR_CHECKSUMMED" "$SEL" --rpc-url "$RPC_URL" 2>/dev/null)
        
        # cast returns hex: 0x0000...0001 for true, 0x0000...0000 for false
        # Some versions may return "true"/"false" strings
        local IS_WHITELISTED_BOOL=false
        if [[ -n "$IS_WHITELISTED" ]]; then
           # Check for hex true value (0x0000...0001)
           if [[ "$IS_WHITELISTED" == "0x0000000000000000000000000000000000000000000000000000000000000001" ]]; then
              IS_WHITELISTED_BOOL=true
           # Check for string "true"
           elif [[ "$IS_WHITELISTED" == "true" ]]; then
              IS_WHITELISTED_BOOL=true
           # Check for any non-zero hex value (more lenient check)
           elif [[ "$IS_WHITELISTED" =~ ^0x[0-9a-fA-F]+$ ]] && [[ "$IS_WHITELISTED" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]] && [[ "$IS_WHITELISTED" != "0x0" ]]; then
              IS_WHITELISTED_BOOL=true
           fi
        fi
        
        if [[ "$IS_WHITELISTED_BOOL" == "true" ]]; then
           FALSE_POSITIVE_PAIRS+=("$PAIR_NORM")
        else
           # True addition
           if [[ "$ADD_COUNT" -gt 0 ]]; then TO_ADD_CONTRACTS+="," ; TO_ADD_SELECTORS+="," ; fi
           TO_ADD_CONTRACTS+="$ADDR_CHECKSUMMED"
           TO_ADD_SELECTORS+="$SEL"
           ((ADD_COUNT++))
        fi
      fi
    done

    # ------------------------------------------------------------
    # STAGE 3.5: GHOST REPAIR PROTOCOL (MERGED SAFE VERSION)
    # ------------------------------------------------------------
    # This section implements the critical Safety Check to prevent regression loops.
    
    if [[ ${#FALSE_POSITIVE_PAIRS[@]} -gt 0 ]]; then
      echoSyncStage "----- [$NETWORK] Stage 3.5: Repairing false positive pairs (Ghost Repair Protocol) -----"
      echoSyncStep "🔧 [$NETWORK] Repairing ${#FALSE_POSITIVE_PAIRS[@]} ghost pairs..."
      
      local DUMMY_SELECTOR="0x00000001"
      local UNIQUE_REPAIR_CONTRACTS=()
      
      # Group by contract using standard arrays (compatible with Bash 3.2 on macOS)
      for PAIR_NORM in "${FALSE_POSITIVE_PAIRS[@]}"; do
         ADDR="${PAIR_NORM%%|*}"
         ADDR_CHECKSUMMED=$(cast --to-checksum-address "$ADDR")
         
         # Check if already in unique list
         local exists=false
         for U in "${UNIQUE_REPAIR_CONTRACTS[@]}"; do
             if [[ "$U" == "$ADDR_CHECKSUMMED" ]]; then exists=true; break; fi
         done
         
         if [[ "$exists" == "false" ]]; then
             UNIQUE_REPAIR_CONTRACTS+=("$ADDR_CHECKSUMMED")
         fi
      done
      
      local PK=$(getPrivateKey "$NETWORK" "$ENVIRONMENT")
      local TOTAL_SCENARIO_B=0
      
      for CONTRACT in "${UNIQUE_REPAIR_CONTRACTS[@]}"; do
         echoSyncDebug "Repairing contract: $CONTRACT"
         
         # Gather selectors for this contract
         local SELS_ARRAY=()
         for PAIR_NORM in "${FALSE_POSITIVE_PAIRS[@]}"; do
             ADDR="${PAIR_NORM%%|*}"
             SEL="${PAIR_NORM#*|}"
             ADDR_CHECKSUMMED=$(cast --to-checksum-address "$ADDR")
             if [[ "$ADDR_CHECKSUMMED" == "$CONTRACT" ]]; then
                 SELS_ARRAY+=("$SEL")
             fi
         done
         
         # Build parallel arrays for batch calls
         local REAL_CONTRACTS=""
         local REAL_SELECTORS=""
         local first=true
         for S in "${SELS_ARRAY[@]}"; do
             if [[ "$first" == "true" ]]; then first=false; else REAL_CONTRACTS+=","; REAL_SELECTORS+=","; fi
             REAL_CONTRACTS+="$CONTRACT"
             REAL_SELECTORS+="$S"
         done
         
         # Step 1: ANCHOR (Add Dummy)
         echoSyncDebug "  Step 1/5: Anchor (Add Dummy)"
         local ANCHOR_OUTPUT
         ANCHOR_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$CONTRACT]" "[$DUMMY_SELECTOR]" true --rpc-url "$RPC_URL" --private-key "$PK" --legacy 2>&1)
         local ANCHOR_EXIT=$?
         
         if [[ $ANCHOR_EXIT -ne 0 ]] || ! ([[ "$ANCHOR_OUTPUT" == *"blockHash"* ]] || [[ "$ANCHOR_OUTPUT" == *"transactionHash"* ]]); then
            echoSyncDebug "  ❌ Anchor failed: $ANCHOR_OUTPUT"
            echo "[$NETWORK] Error: Anchor failed for contract $CONTRACT" >> "$FAILED_LOG_FILE"
            continue
         fi
         echoSyncDebug "  ✅ Anchor successful"
         sleep 3 # Wait for RPC propagation
         
         # Step 2: FLUSH (Remove Real - Set False)
         echoSyncDebug "  Step 2/5: Flush (Clear Mapping)"
         local FLUSH_OUTPUT
         FLUSH_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$REAL_CONTRACTS]" "[$REAL_SELECTORS]" false --rpc-url "$RPC_URL" --private-key "$PK" --legacy 2>&1)
         local FLUSH_EXIT=$?
         
         if [[ $FLUSH_EXIT -ne 0 ]] || ! ([[ "$FLUSH_OUTPUT" == *"blockHash"* ]] || [[ "$FLUSH_OUTPUT" == *"transactionHash"* ]]); then
            echoSyncDebug "  ❌ Flush failed: $FLUSH_OUTPUT"
            echo "[$NETWORK] Error: Flush failed for contract $CONTRACT" >> "$FAILED_LOG_FILE"
            continue
         fi
         echoSyncDebug "  ✅ Flush successful"
         sleep 3 # Wait for RPC propagation
         
         # Verify Flush: Check that mapping is now false
         echoSyncDebug "  Verifying Flush: Checking mapping state..."
         local FLUSH_VERIFY_FAILED=false
         for S in "${SELS_ARRAY[@]}"; do
            local MAPPING_STATE=$(cast call "$DIAMOND_ADDRESS" "isContractSelectorWhitelisted(address,bytes4) returns (bool)" "$CONTRACT" "$S" --rpc-url "$RPC_URL" 2>/dev/null)
            # Check if mapping is false (0x0000...0000 or empty)
            if [[ -n "$MAPPING_STATE" ]] && [[ "$MAPPING_STATE" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]] && [[ "$MAPPING_STATE" != "0x0" ]] && [[ "$MAPPING_STATE" != "false" ]]; then
               echoSyncDebug "  ⚠️  Flush verification failed: Selector $S still whitelisted in mapping"
               FLUSH_VERIFY_FAILED=true
            fi
         done
         if [[ "$FLUSH_VERIFY_FAILED" == "true" ]]; then
            echoSyncDebug "  ⚠️  Flush verification: Some selectors still whitelisted, but continuing..."
         else
            echoSyncDebug "  ✅ Flush verification: All selectors removed from mapping"
         fi
         
         # Step 3: RESTORE (Add Real - Set True)
         echoSyncDebug "  Step 3/5: Restore (Sync State)"
         local RESTORE_OUTPUT
         RESTORE_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$REAL_CONTRACTS]" "[$REAL_SELECTORS]" true --rpc-url "$RPC_URL" --private-key "$PK" --legacy 2>&1)
         local RESTORE_EXIT=$?
         
         if [[ $RESTORE_EXIT -ne 0 ]] || ! ([[ "$RESTORE_OUTPUT" == *"blockHash"* ]] || [[ "$RESTORE_OUTPUT" == *"transactionHash"* ]]); then
            echoSyncDebug "  ❌ Restore failed: $RESTORE_OUTPUT"
            echo "[$NETWORK] Error: Restore failed for contract $CONTRACT" >> "$FAILED_LOG_FILE"
            continue
         fi
         echoSyncDebug "  ✅ Restore successful"
         sleep 5 # Wait for RPC propagation before safety check
         
         # Verify Restore: Check that mapping is true AND selectors are in array
         echoSyncDebug "  Verifying Restore: Checking mapping and array state..."
         local RESTORE_VERIFY_FAILED=false
         for S in "${SELS_ARRAY[@]}"; do
            local MAPPING_STATE=$(cast call "$DIAMOND_ADDRESS" "isContractSelectorWhitelisted(address,bytes4) returns (bool)" "$CONTRACT" "$S" --rpc-url "$RPC_URL" 2>/dev/null)
            # Check if mapping is true
            local IS_MAPPING_TRUE=false
            if [[ "$MAPPING_STATE" == "0x0000000000000000000000000000000000000000000000000000000000000001" ]] || [[ "$MAPPING_STATE" == "true" ]]; then
               IS_MAPPING_TRUE=true
            elif [[ "$MAPPING_STATE" =~ ^0x[0-9a-fA-F]+$ ]] && [[ "$MAPPING_STATE" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]] && [[ "$MAPPING_STATE" != "0x0" ]]; then
               IS_MAPPING_TRUE=true
            fi
            
            if [[ "$IS_MAPPING_TRUE" != "true" ]]; then
               echoSyncDebug "  ⚠️  Restore verification failed: Selector $S not whitelisted in mapping"
               RESTORE_VERIFY_FAILED=true
            fi
         done
         
         # Check if selectors are in the array
         local CURRENT_SELECTORS=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedSelectorsForContract(address) returns (bytes4[])" "$CONTRACT" --rpc-url "$RPC_URL" 2>/dev/null)
         local ARRAY_VERIFY_FAILED=false
         for S in "${SELS_ARRAY[@]}"; do
            local S_CLEAN="${S#0x}"
            if ! echo "$CURRENT_SELECTORS" | grep -iq "$S_CLEAN"; then
               echoSyncDebug "  ⚠️  Restore verification failed: Selector $S not found in array"
               ARRAY_VERIFY_FAILED=true
            fi
         done
         
         if [[ "$RESTORE_VERIFY_FAILED" == "true" ]] || [[ "$ARRAY_VERIFY_FAILED" == "true" ]]; then
            echoSyncDebug "  ⚠️  Restore verification: Some selectors not properly restored"
         else
            echoSyncDebug "  ✅ Restore verification: All selectors in mapping and array"
         fi
         
         # Step 4: SAFETY CHECK (IMPROVED FOR RPC LAG)
         echoSyncDebug "  Step 4/5: Safety Check (Verifying state...)"
         local CURRENT_SELECTORS=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedSelectorsForContract(address) returns (bytes4[])" "$CONTRACT" --rpc-url "$RPC_URL" 2>/dev/null)
         
         if [[ "$CURRENT_SELECTORS" == *"$DUMMY_SELECTOR"* ]]; then
            # We found the dummy. Now check if it's the ONLY thing there.
            # If the output essentially only contains the dummy selector, it's unsafe to remove it.
            
            # Use grep to check if AT LEAST ONE real selector is present
            local REAL_SELECTOR_FOUND=false
            for S in "${SELS_ARRAY[@]}"; do
                # remove 0x prefix for grep
                local S_CLEAN="${S#0x}"
                if echo "$CURRENT_SELECTORS" | grep -iq "$S_CLEAN"; then
                    REAL_SELECTOR_FOUND=true
                    break
                fi
            done

            if [[ "$REAL_SELECTOR_FOUND" == "true" ]]; then
                # Scenario A: Dummy + Real selectors exist. Safe to remove.
                echoSyncDebug "  Step 5/5: Cleanup (Remove Dummy)"
                local CLEANUP_OUTPUT
                CLEANUP_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$CONTRACT]" "[$DUMMY_SELECTOR]" false --rpc-url "$RPC_URL" --private-key "$PK" --legacy 2>&1)
                local CLEANUP_EXIT=$?
                
                if [[ $CLEANUP_EXIT -eq 0 ]] && ([[ "$CLEANUP_OUTPUT" == *"blockHash"* ]] || [[ "$CLEANUP_OUTPUT" == *"transactionHash"* ]]); then
                   echoSyncDebug "  ✅ Cleanup successful"
                   sleep 5 # Wait for RPC propagation
                   
                   # Final verification: Check that real selectors are still in array and contract appears in getAllContractSelectorPairs
                   echoSyncDebug "  Final verification: Checking array state and getAllContractSelectorPairs..."
                   local FINAL_SELECTORS=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedSelectorsForContract(address) returns (bytes4[])" "$CONTRACT" --rpc-url "$RPC_URL" 2>/dev/null)
                   
                   # Check if real selectors are still in array
                   local REAL_SELECTORS_STILL_PRESENT=true
                   for S in "${SELS_ARRAY[@]}"; do
                      local S_CLEAN="${S#0x}"
                      if ! echo "$FINAL_SELECTORS" | grep -iq "$S_CLEAN"; then
                         echoSyncDebug "  ⚠️  Final verification: Selector $S missing from array after cleanup"
                         REAL_SELECTORS_STILL_PRESENT=false
                      fi
                   done
                   
                   # Check if contract appears in getAllContractSelectorPairs
                   local FINAL_V2_PAIRS=($(getCurrentWhitelistedPairs))
                   local CONTRACT_FOUND_IN_V2=false
                   local PAIRS_FOUND_IN_V2=0
                   for FINAL_PAIR in "${FINAL_V2_PAIRS[@]}"; do
                      FINAL_PAIR_L=$(echo "$FINAL_PAIR" | tr '[:upper:]' '[:lower:]')
                      FINAL_ADDR="${FINAL_PAIR_L%%|*}"
                      if [[ "$FINAL_ADDR" == "$(echo "$CONTRACT" | tr '[:upper:]' '[:lower:]')" ]]; then
                         CONTRACT_FOUND_IN_V2=true
                         # Count how many pairs for this contract are in V2
                         FINAL_SEL="${FINAL_PAIR_L#*|}"
                         for S in "${SELS_ARRAY[@]}"; do
                            if [[ "$(echo "$S" | tr '[:upper:]' '[:lower:]')" == "$FINAL_SEL" ]]; then
                               ((PAIRS_FOUND_IN_V2++))
                            fi
                         done
                      fi
                   done
                   
                   if [[ "$REAL_SELECTORS_STILL_PRESENT" == "true" ]] && [[ "$CONTRACT_FOUND_IN_V2" == "true" ]] && [[ $PAIRS_FOUND_IN_V2 -eq ${#SELS_ARRAY[@]} ]]; then
                      echoSyncDebug "  ✅ Final verification: All selectors in array and all pairs found in getAllContractSelectorPairs"
                   else
                      echoSyncDebug "  ⚠️  Final verification issues:"
                      echoSyncDebug "    - Real selectors in array: $REAL_SELECTORS_STILL_PRESENT"
                      echoSyncDebug "    - Contract in getAllContractSelectorPairs: $CONTRACT_FOUND_IN_V2"
                      echoSyncDebug "    - Pairs found: $PAIRS_FOUND_IN_V2/${#SELS_ARRAY[@]}"
                      printf '\033[0;33m%s\033[0m\n' "  ⚠️  [$NETWORK] Contract $CONTRACT repair verification failed - may need manual intervention"
                   fi
                else
                   echoSyncDebug "  ⚠️  Cleanup failed: $CLEANUP_OUTPUT"
                fi
            else
                # Scenario C: Only Dummy exists (Restore hasn't propagated or failed).
                # Skip cleanup to keep contract in global list.
                # It is better to have [Dummy] than [] (which removes the contract).
                ((TOTAL_SCENARIO_B++))
                printf '\033[0;33m%s\033[0m\n' "  ⚠️  Restore Verification Failed: Array only contains Dummy. Real selectors not found yet. Skipping cleanup to keep contract anchored."
            fi
         else
            # Scenario B: Dummy missing (Auto-removed).
            ((TOTAL_SCENARIO_B++))
            printf '\033[0;33m%s\033[0m\n' "  ⚠️  Scenario B Detected: Dummy was auto-removed during Flush. Skipping cleanup."
         fi
      done
      
      # Verify repairs were successful
      echoSyncDebug "Verifying repairs were successful..."
      sleep 5 # Wait for all transactions to propagate
      
      local REPAIRED_COUNT=0
      local STILL_MISSING=0
      local UPDATED_V2_PAIRS=($(getCurrentWhitelistedPairs))
      
      if [[ $? -ne 0 ]] || [[ ${#UPDATED_V2_PAIRS[@]} -eq 0 ]]; then
         printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Could not verify repairs - failed to fetch updated pairs"
      else
         for PAIR_NORM in "${FALSE_POSITIVE_PAIRS[@]}"; do
            # Check if pair is now in getAllContractSelectorPairs
            local IS_IN_ARRAY=false
            for UPDATED_PAIR in "${UPDATED_V2_PAIRS[@]}"; do
               UPDATED_PAIR_L=$(echo "$UPDATED_PAIR" | tr '[:upper:]' '[:lower:]')
               if [[ "$UPDATED_PAIR_L" == "$PAIR_NORM" ]]; then
                  IS_IN_ARRAY=true
                  break
               fi
            done
            
            if [[ "$IS_IN_ARRAY" == "true" ]]; then
               ((REPAIRED_COUNT++))
            else
               ((STILL_MISSING++))
               echoSyncDebug "  ⚠️  Pair still missing from getAllContractSelectorPairs: $PAIR_NORM"
            fi
         done
      fi
      
      if [[ $STILL_MISSING -gt 0 ]]; then
         printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Repair verification: $REPAIRED_COUNT/${#FALSE_POSITIVE_PAIRS[@]} pairs repaired, $STILL_MISSING still missing from getAllContractSelectorPairs"
      else
         printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Repair verification: All ${#FALSE_POSITIVE_PAIRS[@]} pairs successfully repaired and appear in getAllContractSelectorPairs"
      fi
      
      echoSyncDebug "Refreshing V2 state after repair..."
      V2_PAIRS=($(getCurrentWhitelistedPairs))
      # Re-normalize V2 arrays
      V2_PAIRS_NORMALIZED=()
      V2_SELECTORS_NORMALIZED=() # Needed for zombie cleanup later
      V2_CONTRACTS_NORMALIZED=()
      for PAIR in "${V2_PAIRS[@]}"; do
        P_L=$(echo "$PAIR" | tr '[:upper:]' '[:lower:]')
        V2_PAIRS_NORMALIZED+=("$P_L")
        V2_CONTRACTS_NORMALIZED+=("${P_L%%|*}")
        V2_SELECTORS_NORMALIZED+=("${P_L#*|}")
      done
    fi

    # ------------------------------------------------------------
    # D. Determine REMOVALS (Obsolete & Zombies)
    # ------------------------------------------------------------
    local TO_REMOVE_CONTRACTS=""
    local TO_REMOVE_SELECTORS=""
    local REMOVE_COUNT=0
    
    function queueForRemoval {
      local A=$1
      local S=$2
      A=$(cast --to-checksum-address "$A")
      if [[ "$REMOVE_COUNT" -gt 0 ]]; then TO_REMOVE_CONTRACTS+="," ; TO_REMOVE_SELECTORS+="," ; fi
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
        queueForRemoval "$C_L" "0xffffffff"
      fi
    done

    # Bucket 3: Zombie Selectors (In V1, Not in V2)
    local CORE_FACETS=($(getCoreFacetsArray 2>/dev/null))
    local DUMMY_TARGET=""
    if [[ ${#CORE_FACETS[@]} -gt 0 ]]; then
        DUMMY_TARGET=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "${CORE_FACETS[0]}" 2>/dev/null)
    fi
    # Fallback to a valid V2 contract if core facet check fails
    if [[ -z "$DUMMY_TARGET" || "$DUMMY_TARGET" == "null" ]] && [[ ${#V2_PAIRS[@]} -gt 0 ]]; then
        DUMMY_TARGET=$(echo "${V2_PAIRS[0]}" | cut -d'|' -f1 | tr '[:upper:]' '[:lower:]')
    fi
    
    if [[ -n "$DUMMY_TARGET" && "$DUMMY_TARGET" != "null" ]]; then
       for S in "${V1_SELECTORS[@]}"; do
         S_L=$(echo "$S" | tr '[:upper:]' '[:lower:]')
         if [[ "$S_L" == "0x00000000" ]]; then continue; fi
         if ! isInArray "$S_L" "${V2_SELECTORS_NORMALIZED[@]}"; then
            echoSyncDebug "Found Zombie Selector: $S"
            queueForRemoval "$DUMMY_TARGET" "$S_L"
         fi
       done
    fi

    # ------------------------------------------------------------
    # EXECUTION
    # ------------------------------------------------------------

    # 1. PROCESS REMOVALS
    if [[ "$REMOVE_COUNT" -gt 0 ]]; then
      echoSyncStage "----- [$NETWORK] Stage 4a: Processing $REMOVE_COUNT removals -----"
      
      # Temp Add (Fix broken states)
      echoSyncStep "🔄 [$NETWORK] Step 1/2: Temp adding pairs..."
      cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$TO_REMOVE_CONTRACTS]" "[$TO_REMOVE_SELECTORS]" true --rpc-url "$RPC_URL" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --legacy > /dev/null

      # Permanent Remove
      echoSyncStep "🗑️  [$NETWORK] Step 2/2: Permanently removing pairs..."
      local REMOVE_TX_OUTPUT
      REMOVE_TX_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$TO_REMOVE_CONTRACTS]" "[$TO_REMOVE_SELECTORS]" false --rpc-url "$RPC_URL" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --legacy 2>&1)
      
      if [[ $? -eq 0 ]] && ([[ "$REMOVE_TX_OUTPUT" == *"blockHash"* ]] || [[ "$REMOVE_TX_OUTPUT" == *"transactionHash"* ]]); then
        printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Removal successful"
      else
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Removal failed"
        echo "[$NETWORK] Error: Removal failed. Output: $REMOVE_TX_OUTPUT" >> "$FAILED_LOG_FILE"
      fi
    fi

    # 2. PROCESS ADDITIONS (Batch Chunking)
    if [[ "$ADD_COUNT" -gt 0 ]]; then
      echoSyncStage "----- [$NETWORK] Stage 4b: Adding $ADD_COUNT new pairs -----"
      local BATCH_RESULT
      BATCH_RESULT=$(processBatchInChunks "$TO_ADD_CONTRACTS" "$TO_ADD_SELECTORS" "true" "$ADD_COUNT")
      local SUCCESS=$(echo "$BATCH_RESULT" | cut -d'|' -f1)
      local FAIL=$(echo "$BATCH_RESULT" | cut -d'|' -f2)
      
      if [[ "$SUCCESS" -gt 0 ]]; then
         printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Additions successful ($SUCCESS/$ADD_COUNT pairs)"
         
         # Final Verification
         echoSyncDebug "Verifying..."
         sleep 3
         local FINAL_PAIRS=($(getCurrentWhitelistedPairs))
         local MISSING=0
         
         # Normalize final for check
         local FINAL_NORM=()
         for P in "${FINAL_PAIRS[@]}"; do FINAL_NORM+=("$(echo "$P" | tr '[:upper:]' '[:lower:]')"); done
         
         for REQ in "${REQUIRED_PAIRS_NORMALIZED[@]}"; do
             if ! isInArray "$REQ" "${FINAL_NORM[@]}"; then ((MISSING++)); fi
         done
         
         if [[ $MISSING -eq 0 ]]; then
             printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Verified: All required pairs are whitelisted"
         else
             printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Verification found $MISSING missing pairs"
         fi
      else
         printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] All additions failed"
         echo "[$NETWORK] Error: All additions failed" >> "$FAILED_LOG_FILE"
      fi
    else
      if [[ "$REMOVE_COUNT" -eq 0 ]]; then
        printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Skipped - state already in sync"
      fi
    fi
  }

  # --- RUN LOOP ---
  if [[ -z $MAX_CONCURRENT_JOBS ]]; then echo "Config missing MAX_CONCURRENT_JOBS"; exit 1; fi

  for NETWORK in "${NETWORKS[@]}"; do
    while [[ $(jobs | wc -l) -ge $MAX_CONCURRENT_JOBS ]]; do sleep 1; done
    processNetwork "$NETWORK" &
  done
  wait

  # --- SUMMARY ---
  if [ -s "$FAILED_LOG_FILE" ]; then
    echo ""
    printf '\033[0;31m%s\033[0m\n' "Summary of failures:"
    cat "$FAILED_LOG_FILE"
    rm -f "$FAILED_LOG_FILE"
    return 1
  else
    echo ""
    echo "✅ All active networks updated successfully"
    rm -f "$FAILED_LOG_FILE"
    return 0
  fi
}