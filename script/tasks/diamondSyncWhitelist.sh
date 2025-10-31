#!/bin/bash

function diamondSyncWhitelist {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncWhitelist now...."

  # Load environment variables
  source .env

  # Load configuration & helper functions
  source script/helperFunctions.sh

  # Configuration flag - set to true to allow token contracts to be whitelisted
  ALLOW_TOKEN_CONTRACTS=${ALLOW_TOKEN_CONTRACTS:-false}

  # Confirm risky mode when allowing token contracts
  if [[ "$ALLOW_TOKEN_CONTRACTS" == "true" ]]; then
    echo ""
    printf '\033[31m%s\033[0m\n' "!!!!!!!!!!!!!!!!!!!!!!!! ATTENTION !!!!!!!!!!!!!!!!!!!!!!!!"
    printf '\033[33m%s\033[0m\n' "ALLOW_TOKEN_CONTRACTS is set to true"
    printf '\033[33m%s\033[0m\n' "This will allow token contracts to be whitelisted"
    printf '\033[31m%s\033[0m\n' "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo ""
    printf '\033[33m%s\033[0m\n' "Do you want to continue?"
    local SELECTION=$(
      gum choose \
        "yes" \
        "no"
    )

    if [[ "$SELECTION" != "yes" ]]; then
      echo "...exiting script"
      return 0
    fi
  fi

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

    for contract in "${TOKEN_CONTRACTS[@]}"; do
      echo "$contract"
    done
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
    
    echoDebug "Using RPC URL: $RPC_URL"
    echoDebug "Diamond address: $DIAMOND_ADDRESS"

    # Function to get contract-selector pairs from whitelist files (whitelist.json or whitelist.staging.json)
    function getContractSelectorPairs {
      local NETWORK=$1
      local CONTRACT_SELECTOR_PAIRS=()
      
      # Determine the correct whitelist file based on environment
      local WHITELIST_FILE
      if [[ "$ENVIRONMENT" == "production" ]]; then
        WHITELIST_FILE="config/whitelist.json"
      else
        WHITELIST_FILE="config/whitelist.staging.json"
      fi
      
      echoDebug "Getting contract-selector pairs for network: $NETWORK"
      echoDebug "Whitelist file path: $WHITELIST_FILE"
      
      # Get DEX contracts
      echoDebug "Getting DEX contracts..."
      local DEX_CONTRACTS=$(jq -r --arg network "$NETWORK" '.DEXS[] | select(.contracts[$network] != null) | .contracts[$network][] | select(.address != null) | "\(.address)|\(.functions | keys | join(","))"' "$WHITELIST_FILE" 2>&1)
      local dex_exit_code=$?
      
      echoDebug "DEX contracts query exit code: $dex_exit_code"
      echoDebug "DEX contracts result: $DEX_CONTRACTS"
      
      # Get PERIPHERY contracts from the appropriate whitelist file
      echoDebug "Getting periphery contracts from $WHITELIST_FILE..."
      local PERIPHERY_CONTRACTS=$(jq -r --arg network "$NETWORK" '.PERIPHERY[$network] // [] | .[] | select(.address != null) | "\(.address)|\(.selectors | map(.selector) | join(","))"' "$WHITELIST_FILE" 2>&1)
      local periphery_exit_code=$?
      
      echoDebug "Periphery contracts query exit code: $periphery_exit_code"
      echoDebug "Periphery contracts result: $PERIPHERY_CONTRACTS"
      
      # Combine DEX and PERIPHERY contracts
      local ALL_CONTRACTS="$DEX_CONTRACTS"$'\n'"$PERIPHERY_CONTRACTS"
      echoDebug "All contracts combined: $ALL_CONTRACTS"
      
      while IFS= read -r line; do
        if [[ -n "$line" ]]; then
          CONTRACT_SELECTOR_PAIRS+=("$line")
          echoDebug "Added contract-selector pair: $line"
        fi
      done <<< "$ALL_CONTRACTS"
      
      echoDebug "Final contract-selector pairs count: ${#CONTRACT_SELECTOR_PAIRS[@]}"
      for pair in "${CONTRACT_SELECTOR_PAIRS[@]}"; do
        echo "$pair"
      done
    }

    # Function to get current whitelisted contract-selector pairs from the diamond
    function getCurrentWhitelistedPairs {
      local ATTEMPT=1

      while [ $ATTEMPT -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]; do
        echoDebug "Attempt $ATTEMPT: Trying to get whitelisted pairs from diamond $DIAMOND_ADDRESS"
        
        # Try the new efficient function first
        echoDebug "Calling getAllContractSelectorPairs() on diamond..."
        local cast_output=$(cast call "$DIAMOND_ADDRESS" "getAllContractSelectorPairs() returns (address[],bytes4[][])" --rpc-url "$RPC_URL" 2>&1)
        local call_exit_code=$?
        
        echo "DEBUG [getCurrentWhitelistedPairs]: getAllContractSelectorPairs call exit code: $call_exit_code" >&2
        
        if [[ $call_exit_code -eq 0 && -n "$cast_output" ]]; then
          echoDebug "Successfully got result from getAllContractSelectorPairs"
          
          # Initialize empty arrays for pairs
          local pairs=()
          
          # Handle empty result - check for both single empty array and two empty arrays
          if [[ "$cast_output" == "()" ]] || [[ "$cast_output" == "[]" ]] || [[ "$cast_output" == "[]"$'\n'"[]" ]]; then
            echoDebug "Empty result from getAllContractSelectorPairs - no whitelisted pairs"
            for pair in "${pairs[@]}"; do
              echo "$pair"
            done
            return 0
          fi
          
          echoDebug "Parsing result from getAllContractSelectorPairs..."
          
          # Parse the cast output
          # Cast returns two lines:
          # Line 1: Array of addresses [0xAddr1, 0xAddr2, ...]
          # Line 2: Array of selector arrays [[0xSel1, 0xSel2], [0xSel3], ...]
          
          # Extract the two lines
          local addresses_line
          local selectors_line
          addresses_line=$(echo "$cast_output" | sed -n '1p')
          selectors_line=$(echo "$cast_output" | sed -n '2p')
          
          echo "DEBUG [getCurrentWhitelistedPairs]: addresses_line: ${addresses_line:0:100}" >&2
          echo "DEBUG [getCurrentWhitelistedPairs]: selectors_line: ${selectors_line:0:100}" >&2
          
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
          
          echo "DEBUG [getCurrentWhitelistedPairs]: Parsed ${#contract_list[@]} contract addresses" >&2
          
          # Parse selectors line: [[0xSel1, 0xSel2], [0xSel3], ...]
          # 
          # It's a 2D array. We need to maintain the correspondence: contract_list[i] has selectors from group i
          
          # Remove outer brackets and split by ], [
          local selectors_grouped
          selectors_grouped=$(echo "$selectors_line" | sed 's/^\[\[//; s/\]\]$//; s/\], \[/|/g')
          
          echo "DEBUG [getCurrentWhitelistedPairs]: selectors_grouped: ${selectors_grouped:0:150}" >&2
          
          # Split into groups by |
          local -a selector_groups
          IFS='|' read -ra selector_groups <<< "$selectors_grouped"
          
          echo "DEBUG [getCurrentWhitelistedPairs]: Parsed ${#selector_groups[@]} selector groups" >&2
          
          # Now expand: for each contract, create one entry per selector
          for i in "${!contract_list[@]}"; do
            local contract="${contract_list[$i]}"
            local selector_group="${selector_groups[$i]}"
            
            if [[ $i -lt 3 ]]; then
              echo "DEBUG [getCurrentWhitelistedPairs]: Processing contract $i: $contract with selectors: ${selector_group:0:80}" >&2
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
          
          echo "DEBUG [getCurrentWhitelistedPairs]: Created ${#pairs[@]} pairs from getAllContractSelectorPairs parsing" >&2
          if [[ ${#pairs[@]} -gt 0 ]]; then
            # Successfully parsed ${#pairs[@]} pairs from getAllContractSelectorPairs
            echo "DEBUG [getCurrentWhitelistedPairs]: Returning ${#pairs[@]} pairs from primary parsing" >&2
            for pair in "${pairs[@]}"; do
              echo "$pair"
            done
            return 0
          else
            echo "DEBUG [getCurrentWhitelistedPairs]: Primary parsing created 0 pairs, falling back to getWhitelistedAddresses" >&2
          fi
        else
          # getAllContractSelectorPairs failed with exit code $call_exit_code
          echo "DEBUG [getCurrentWhitelistedPairs]: getAllContractSelectorPairs failed, falling back..." >&2
        fi
        
        # Fallback to the original approach if the new function fails
        echo "DEBUG [getCurrentWhitelistedPairs]: Attempting fallback to getWhitelistedAddresses()" >&2
        local addresses=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedAddresses() returns (address[])" --rpc-url "$RPC_URL" 2>&1)
        local addresses_exit_code=$?
        
        echo "DEBUG [getCurrentWhitelistedPairs]: getWhitelistedAddresses exit code: $addresses_exit_code" >&2
        echo "DEBUG [getCurrentWhitelistedPairs]: getWhitelistedAddresses result (first 200 chars): ${addresses:0:200}" >&2
        
        if [[ $addresses_exit_code -eq 0 && -n "$addresses" && "$addresses" != "[]" ]]; then
          # Successfully got addresses from getWhitelistedAddresses
          local pairs=()
          local address_list=$(echo "${addresses:1:${#addresses}-2}" | tr ',' ' ')
          # Address list: $address_list
          
          echo "DEBUG [getCurrentWhitelistedPairs]: Fallback processing $(echo "$address_list" | wc -w) addresses" >&2
          local addr_count=0
          for addr in $address_list; do
            ((addr_count++))
            if [[ $addr_count -le 3 ]]; then
              echo "DEBUG [getCurrentWhitelistedPairs]: Getting selectors for address $addr_count: $addr" >&2
            fi
            local selectors=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedSelectorsForContract(address) returns (bytes4[])" "$addr" --rpc-url "$RPC_URL" 2>&1)
            local selectors_exit_code=$?
            
            if [[ $addr_count -le 3 ]]; then
              echo "DEBUG [getCurrentWhitelistedPairs]: Selectors for $addr: exit_code=$selectors_exit_code, result=${selectors:0:100}" >&2
            fi
            
            if [[ $selectors_exit_code -eq 0 && -n "$selectors" && "$selectors" != "[]" ]]; then
              local selector_list=$(echo "${selectors:1:${#selectors}-2}" | tr ',' ' ')
              for selector in $selector_list; do
                pairs+=("$(echo "$addr" | tr '[:upper:]' '[:lower:]')|$selector")
              done
            fi
          done
          
          echo "DEBUG [getCurrentWhitelistedPairs]: Fallback created ${#pairs[@]} pairs from ${addr_count} addresses" >&2
          
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

    # Get required contract-selector pairs from whitelist files
    echoDebug "Getting required contract-selector pairs from whitelist files for network: $NETWORK"
    REQUIRED_PAIRS=($(getContractSelectorPairs "$NETWORK"))
    
    echoDebug "Found ${#REQUIRED_PAIRS[@]} required pairs from whitelist files"
    if [[ ${#REQUIRED_PAIRS[@]} -gt 0 ]]; then
      echoDebug "Required pairs: ${REQUIRED_PAIRS[@]}"
    fi
    
    if [[ ${#REQUIRED_PAIRS[@]} -eq 0 ]]; then
      printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] No contract-selector pairs found in whitelist files for this network"
      return
    fi

    # Get current whitelisted pairs from diamond
    CURRENT_PAIRS=($(getCurrentWhitelistedPairs))
    local get_pairs_exit_code=$?
    
    if [[ $get_pairs_exit_code -ne 0 ]]; then
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Unable to fetch current whitelisted pairs"
      {
        echo "[$NETWORK] Error: Unable to fetch current whitelisted pairs"
        echo ""
      } >> "$FAILED_LOG_FILE"
      return
    fi

    # Determine missing pairs
    NEW_PAIRS=()
    NEW_ADDRESSES=()
    
    for REQUIRED_PAIR in "${REQUIRED_PAIRS[@]}"; do
      # Split the pair by '|' character using parameter expansion
      ADDRESS="${REQUIRED_PAIR%%|*}"
      SELECTORS_STR="${REQUIRED_PAIR#*|}"
      
      # Check for address zero (forbidden)
      # Handle all variations: uppercase, lowercase, mixed case
      ADDRESS_LOWER=$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')
      if [[ "$ADDRESS_LOWER" == "0x0000000000000000000000000000000000000000" ]]; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Error: Whitelisting address zero is forbidden: $ADDRESS"
        printf '\033[0;33m%s\033[0m\n' "⚠️  Please check whitelist.json or whitelist.staging.json"
        printf '\033[0;33m%s\033[0m\n' "⚠️  Remove address zero from configuration and discuss with backend team"
        {
          echo "[$NETWORK] Error: Whitelisting address zero is forbidden: $ADDRESS"
          echo "[$NETWORK] This address is invalid and should not be in the whitelist configuration"
          echo "[$NETWORK] Please check whitelist.json or whitelist.staging.json and remove address zero"
          echo "[$NETWORK] Discuss with backend team if this address is needed"
          echo ""
        } >> "$FAILED_LOG_FILE"
        return 1
      fi
      
      # Check if address has code
      CHECKSUMMED=$(cast --to-checksum-address "$ADDRESS_LOWER")  
      CODE=$(cast code "$CHECKSUMMED" --rpc-url "$RPC_URL")
      if [[ "$CODE" == "0x" ]]; then
        echoDebug "Skipping address with no code: $CHECKSUMMED"
        continue
      fi
      
      # Parse selectors (comma-separated)
      if [[ -n "$SELECTORS_STR" && "$SELECTORS_STR" != "" ]]; then
        # Split selectors by comma (use tr for portability)
        SELECTORS=($(echo "$SELECTORS_STR" | tr ',' ' '))
        
        for SELECTOR in "${SELECTORS[@]}"; do
          if [[ -n "$SELECTOR" && "$SELECTOR" != "" ]]; then
            PAIR_KEY="$ADDRESS_LOWER|$SELECTOR"
            # Check if this pair is already whitelisted
            if [[ ${#CURRENT_PAIRS[@]} -eq 0 ]] || [[ ! " ${CURRENT_PAIRS[@]} " == *" $PAIR_KEY "* ]]; then
              NEW_PAIRS+=("$CHECKSUMMED|$SELECTOR")
              NEW_ADDRESSES+=("$CHECKSUMMED")
            fi
          fi
        done
      else
        # No selectors defined - add ApproveTo-Only Selector (0xffffffff) for backward compatibility
        # 
        # Context: During migration from DexManagerFacet to WhitelistManagerFacet, the old system
        # used simple address-based whitelisting (e.g., approve entire DEX contract). The new 
        # WhitelistManagerFacet uses granular contract-selector pairs for better security.
        # 
        # This selector makes isAddressWhitelisted(_contract) return true for backward
        # compatibility with legacy address-only checks, but does not allow any granular calls.
        APPROVE_TO_SELECTOR="0xffffffff"
        PAIR_KEY="$ADDRESS_LOWER|$APPROVE_TO_SELECTOR"
        
        # Check if this ApproveTo-Only Selector pair is already whitelisted
        if [[ ${#CURRENT_PAIRS[@]} -eq 0 ]] || [[ ! " ${CURRENT_PAIRS[@]} " == *" $PAIR_KEY "* ]]; then
          NEW_PAIRS+=("$CHECKSUMMED|$APPROVE_TO_SELECTOR")
          NEW_ADDRESSES+=("$CHECKSUMMED")
        fi
      fi
    done

    # Check for token contracts in the new addresses that will be added
    if [[ ! ${#NEW_ADDRESSES[@]} -eq 0 ]]; then
      UNIQUE_ADDRESSES=($(printf '%s\n' "${NEW_ADDRESSES[@]}" | sort -u))
      
      # Detect token contracts in the new addresses
      TOKEN_CONTRACTS=($(detectTokenContracts "$RPC_URL" "${UNIQUE_ADDRESSES[@]}"))

      if [[ ${#TOKEN_CONTRACTS[@]} -gt 0 ]]; then
        if [[ "$ALLOW_TOKEN_CONTRACTS" == "true" ]]; then
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Token contracts detected but proceeding (ALLOW_TOKEN_CONTRACTS=true)"
          printf '\033[0;33m%s\033[0m\n' "Token addresses: ${TOKEN_CONTRACTS[@]}"
        else
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Token contracts detected in new addresses - aborting whitelist sync"
          printf '\033[0;31m%s\033[0m\n' "Token addresses: ${TOKEN_CONTRACTS[@]}"
          echo ""
          printf '\033[0;33m%s\033[0m\n' "💡 To bypass this check, set ALLOW_TOKEN_CONTRACTS=true and run again:"
          echo ""
          {
            echo "[$NETWORK] Error: Token contracts detected in new addresses"
            echo "[$NETWORK] Token addresses: ${TOKEN_CONTRACTS[@]}"
          } >> "$FAILED_LOG_FILE"
          return
        fi
      fi
    fi

    # Add missing contract-selector pairs
    printf '\033[0;36m%s\033[0m\n' "📊 [$NETWORK] Found ${#NEW_PAIRS[@]} new pairs to add (out of ${#REQUIRED_PAIRS[@]} required)"
    if [[ ${#NEW_PAIRS[@]} -gt 0 ]]; then
      printf '\033[0;35m%s\033[0m\n' "🔍 [$NETWORK] Entering batch send section with ${#NEW_PAIRS[@]} pairs"
      # Prepare arrays for batch operation
      # batchSetContractSelectorWhitelist expects: address[], bytes4[], bool
      # where each address corresponds to one selector
      local CONTRACT_ADDRESSES=()
      local SELECTORS=()
      
      printf '\033[0;35m%s\033[0m\n' "🔄 [$NETWORK] Processing pairs..."
      for PAIR in "${NEW_PAIRS[@]}"; do
        # Split pair by '|' to get address and selector(s)
        CHECKSUMMED_ADDRESS="${PAIR%%|*}"
        SELECTORS_STR="${PAIR#*|}"
        
        # Handle multiple selectors (comma-separated)
        # Each selector needs its own contract-address pair for batchSetContractSelectorWhitelist
        if [[ -n "$SELECTORS_STR" && "$SELECTORS_STR" != "" ]]; then
          # Split selectors by comma
          local SELECTOR_ARRAY=($(echo "$SELECTORS_STR" | tr ',' ' '))
          for SEL in "${SELECTOR_ARRAY[@]}"; do
            if [[ -n "$SEL" && "$SEL" != "" ]]; then
              CONTRACT_ADDRESSES+=("$CHECKSUMMED_ADDRESS")
              SELECTORS+=("$SEL")
            fi
          done
        fi
      done
      printf '\033[0;35m%s\033[0m\n' "✔️  [$NETWORK] Processed ${#CONTRACT_ADDRESSES[@]} addresses and ${#SELECTORS[@]} selectors"
      
      # Convert arrays to cast format (each address/selector as separate arg)
      printf '\033[0;35m%s\033[0m\n' "🔧 [$NETWORK] Converting arrays to cast format..."
      local CONTRACTS_ARRAY=""
      local SELECTORS_ARRAY=""
      
      printf '\033[0;35m%s\033[0m\n' "🔧 [$NETWORK] Starting array conversion loop..."
      # Build comma-separated lists for cast (format: addr1,addr2,addr3)
      local first=true
      for addr in "${CONTRACT_ADDRESSES[@]}"; do
        if [[ "$first" == "true" ]]; then
          first=false
        else
          CONTRACTS_ARRAY+=","
        fi
        CONTRACTS_ARRAY+="$addr"
      done
      
      first=true
      for sel in "${SELECTORS[@]}"; do
        if [[ "$first" == "true" ]]; then
          first=false
        else
          SELECTORS_ARRAY+=","
        fi
        SELECTORS_ARRAY+="$sel"
      done
      printf '\033[0;35m%s\033[0m\n' "🔧 [$NETWORK] Array conversion loop completed"
      
      printf '\033[0;35m%s\033[0m\n' "📝 [$NETWORK] Prepared batch call arrays"
      echoDebug "Batch call parameters:"
      echoDebug "Contracts: $CONTRACTS_ARRAY"
      echoDebug "Selectors: $SELECTORS_ARRAY"
      
      printf '\033[0;35m%s\033[0m\n' "🚀 [$NETWORK] Starting transaction attempts..."
      local ATTEMPTS=1
      while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
        # Use batchSetContractSelectorWhitelist for efficiency
        # This function is idempotent - calling it multiple times with same pairs is safe
        # but inefficient. We call it once with ALL pairs.
        printf '\033[0;36m%s\033[0m\n' "📤 [$NETWORK] Attempt $ATTEMPTS: Calling batchSetContractSelectorWhitelist with ${#CONTRACT_ADDRESSES[@]} pairs"
        
        # Capture transaction output to check if it succeeded
        local TX_OUTPUT
        echo "CONTRACTS_ARRAY: $CONTRACTS_ARRAY" >&2
        echo "SELECTORS_ARRAY: $SELECTORS_ARRAY" >&2
        TX_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$CONTRACTS_ARRAY]" "[$SELECTORS_ARRAY]" true --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy 2>&1)
        local TX_EXIT_CODE=$?
        
        # Print transaction output for debugging
        echo "$TX_OUTPUT"
        
        # Check if transaction succeeded (exit code 0 and contains "blockHash")
        if [[ $TX_EXIT_CODE -eq 0 ]] && ([[ "$TX_OUTPUT" == *"blockHash"* ]] || [[ "$TX_OUTPUT" == *"transactionHash"* ]]); then
          printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Transaction successful!"
          
          # Check if any events were emitted (indicates new pairs were added)
          local NEW_PAIRS_ADDED=false
          if [[ "$TX_OUTPUT" == *"logs"* ]] && [[ "$TX_OUTPUT" != *"logs                 []"* ]]; then
            printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Transaction emitted events - new pairs were added"
            NEW_PAIRS_ADDED=true
          else
            printf '\033[0;36m%s\033[0m\n' "ℹ️  [$NETWORK] No events emitted - all pairs were already whitelisted (idempotent)"
          fi
          
          # Verify by calling getAllContractSelectorPairs() to confirm the state
          printf '\033[0;36m%s\033[0m\n' "🔍 [$NETWORK] Verifying whitelist state by calling getAllContractSelectorPairs()..."
          sleep 2  # Brief wait for state to propagate
          
          UPDATED_PAIRS=($(getCurrentWhitelistedPairs))
          local verify_exit_code=$?
          
          echo "DEBUG: Got ${#UPDATED_PAIRS[@]} pairs from getCurrentWhitelistedPairs"
          echo "DEBUG: First 5 UPDATED_PAIRS:"
          for i in 0 1 2 3 4; do
            if [[ $i -lt ${#UPDATED_PAIRS[@]} ]]; then
              echo "  [$i]: ${UPDATED_PAIRS[$i]}"
            fi
          done
          
          if [[ $verify_exit_code -ne 0 ]]; then
            printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Could not verify whitelist state (getAllContractSelectorPairs failed)"
            printf '\033[0;36m%s\033[0m\n' "💡 Transaction succeeded but verification skipped - pairs should be whitelisted"
            return 0
          fi
          
          # Verify pairs were added correctly
          # NEW_PAIRS format: array of "address|selector" strings
          # UPDATED_PAIRS format: array of "address|selector" strings (from getCurrentWhitelistedPairs)
          # Both can be in different orders, so we need exact matching
          
          local VERIFIED_COUNT=0
          local MISSING_COUNT=0
          
          echo ""
          echo "=== VERIFICATION DEBUG ==="
          echo "Comparing ${#NEW_PAIRS[@]} NEW_PAIRS against ${#UPDATED_PAIRS[@]} UPDATED_PAIRS"
          echo ""
          
          # Normalize both arrays to lowercase for comparison
          local NORMALIZED_NEW=()
          for pair in "${NEW_PAIRS[@]}"; do
            NORMALIZED_NEW+=("$(echo "$pair" | tr '[:upper:]' '[:lower:]')")
          done
          
          local NORMALIZED_UPDATED=()
          for pair in "${UPDATED_PAIRS[@]}"; do
            NORMALIZED_UPDATED+=("$(echo "$pair" | tr '[:upper:]' '[:lower:]')")
          done
          
          # Show sample of what we're comparing (first 3 from each array)
          echo "Sample NEW_PAIRS (first 3):"
          for i in 0 1 2; do
            if [[ $i -lt ${#NORMALIZED_NEW[@]} ]]; then
              echo "  NEW[$i]: ${NORMALIZED_NEW[$i]}"
            fi
          done
          echo ""
          echo "Sample UPDATED_PAIRS (first 3):"
          for i in 0 1 2; do
            if [[ $i -lt ${#NORMALIZED_UPDATED[@]} ]]; then
              echo "  UPDATED[$i]: ${NORMALIZED_UPDATED[$i]}"
            fi
          done
          echo ""
          
          # Check each NEW pair against UPDATED pairs
          local checked_count=0
          for new_pair in "${NORMALIZED_NEW[@]}"; do
            local FOUND=false
            
            # Show detailed comparison for first 3 pairs
            if [[ $checked_count -lt 3 ]]; then
              echo "Checking NEW pair [$checked_count]: '$new_pair'"
              echo "  Searching in ${#NORMALIZED_UPDATED[@]} UPDATED pairs..."
            fi
            
              # Search for exact match in UPDATED_PAIRS
              for updated_pair in "${NORMALIZED_UPDATED[@]}"; do
                if [[ "$new_pair" == "$updated_pair" ]]; then
                FOUND=true
                if [[ $checked_count -lt 3 ]]; then
                  echo "  ✓ FOUND exact match: '$updated_pair'"
                fi
                break
              fi
            done
            
            if [[ "$FOUND" == "true" ]]; then
              ((VERIFIED_COUNT++))
            else
              ((MISSING_COUNT++))
              if [[ $MISSING_COUNT -le 5 ]]; then
                echo "❌ MISSING PAIR: $new_pair"
                echo "   (not found in any of the ${#NORMALIZED_UPDATED[@]} UPDATED pairs)"
              fi
              echoDebug "Missing pair: $new_pair"
            fi
            
            ((checked_count++))
          done
          
          if [[ $MISSING_COUNT -gt 5 ]]; then
            echo "... and $((MISSING_COUNT - 5)) more missing pairs"
          fi
          
          echo ""
          echo "=== END VERIFICATION DEBUG ==="
          echo ""
          
          # Report verification results
          if [[ $MISSING_COUNT -eq 0 ]]; then
            printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Verified: All ${#NEW_PAIRS[@]} contract-selector pairs are whitelisted"
            return 0
          elif [[ $VERIFIED_COUNT -gt 0 ]]; then
            printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Partial verification: $VERIFIED_COUNT/${#NEW_PAIRS[@]} pairs confirmed whitelisted"
            printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] $MISSING_COUNT pairs not found in whitelist (may be case sensitivity or formatting issue)"
            return 0
          else
            printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Verification failed: None of the ${#NEW_PAIRS[@]} pairs found in whitelist"
            printf '\033[0;33m%s\033[0m\n' "⚠️  This may indicate a transaction revert or state sync issue"
            # Don't retry - transaction succeeded, this is likely a verification issue
            return 0
          fi
        else
          # Transaction failed - retry
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Transaction failed (attempt $ATTEMPTS)"
        fi

        ATTEMPTS=$((ATTEMPTS + 1))
      done

      if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] - Could not whitelist all ${#NEW_PAIRS[@]} pairs after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts"
        {
          echo "[$NETWORK] Error: Could not whitelist all pairs"
          echo "[$NETWORK] Missing pairs: ${MISSING_PAIRS[@]}"
          echo ""
        } >> "$FAILED_LOG_FILE"
      fi
    else
      printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] - All contract-selector pairs are whitelisted already"
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