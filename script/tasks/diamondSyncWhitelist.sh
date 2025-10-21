#!/bin/bash

function diamondSyncWhitelist {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script syncWhitelist now...."

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
      printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] LiFiDiamond not deployed yet - skipping whitelist sync"
      return
    fi

    RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

    # Function to get contract-selector pairs from whitelist.json
    function getContractSelectorPairs {
      local NETWORK=$1
      local CONTRACT_SELECTOR_PAIRS=()
      
      # Get DEX contracts
      local DEX_CONTRACTS=$(jq -r --arg network "$NETWORK" '.DEXS[] | select(.contracts[$network] != null) | .contracts[$network][] | select(.address != null) | "\(.address)|\(.functions | keys | join(","))"' "$WHITELIST_JSON_FILE_PATH" 2>/dev/null)
      
      # Get PERIPHERY contracts
      local PERIPHERY_CONTRACTS=$(jq -r --arg network "$NETWORK" '.PERIPHERY[$network] // [] | .[] | select(.address != null) | "\(.address)|\(.selectors | map(.selector) | join(","))"' "$WHITELIST_JSON_FILE_PATH" 2>/dev/null)
      
      # Combine both sources
      local ALL_CONTRACTS="$DEX_CONTRACTS"$'\n'"$PERIPHERY_CONTRACTS"
      
      while IFS= read -r line; do
        if [[ -n "$line" ]]; then
          CONTRACT_SELECTOR_PAIRS+=("$line")
        fi
      done <<< "$ALL_CONTRACTS"
      
      printf '%s\n' "${CONTRACT_SELECTOR_PAIRS[@]}"
    }

    # Function to get current whitelisted contract-selector pairs from the diamond
    function getCurrentWhitelistedPairs {
      local ATTEMPT=1

      while [ $ATTEMPT -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]; do
        # Try the new efficient function first
        local result=$(cast call "$DIAMOND_ADDRESS" "getAllContractSelectorPairs() returns (address[],bytes4[][])" --rpc-url "$RPC_URL" 2>/dev/null)
        
        if [[ $? -eq 0 && -n "$result" ]]; then
          # Parse the complex return type: (address[],bytes4[][])
          # Format: (0x123...,0x456...,[[0x789...,0xabc...],[0xdef...,0x123...]])
          local pairs=()
          
          # Handle empty result
          if [[ "$result" == "()" ]]; then
            printf '%s\n' "${pairs[@]}"
            return 0
          fi
          
          # Extract addresses and selectors from the result
          # The result format is: (addr1,addr2,...,[[sel1,sel2,...],[sel3,sel4,...]])
          if [[ "$result" =~ ^\((.+)\)$ ]]; then
            local content="${BASH_REMATCH[1]}"
            
            # Find the last occurrence of ,[[ to separate addresses from selectors
            # This handles cases where addresses might contain commas in their representation
            local bracket_match=$(echo "$content" | grep -o ',\[\[.*$')
            if [[ -n "$bracket_match" ]]; then
              local bracket_length=${#bracket_match}
              local addresses_part="${content:0:${#content}-$bracket_length}"
              local selectors_part="${bracket_match:2}"  # Remove ,[[ prefix
              
              # Parse addresses (split by comma, but be careful with address formatting)
              local addresses=$(echo "$addresses_part" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
              
              # Parse selectors properly
              # Remove the outer brackets first: [[...]] -> ...
              local clean_selectors=$(echo "$selectors_part" | sed 's/^\[\[//;s/\]\]$//')
              
              # Split by ],[ to get individual selector groups: [sel1,sel2],[sel3] -> [sel1,sel2] and [sel3]
              # Use the correct pattern: \],\[ (comma between brackets)
              local selector_groups=$(echo "$clean_selectors" | sed 's/\],\[/\n/g')
              
              # Create arrays for addresses and selector groups
              local addr_array=()
              local selector_groups_array=()
              
              while IFS= read -r addr; do
                if [[ -n "$addr" && "$addr" != "" ]]; then
                  addr_array+=("$addr")
                fi
              done <<< "$addresses"
              
              while IFS= read -r group; do
                if [[ -n "$group" ]]; then
                  selector_groups_array+=("$group")
                fi
              done <<< "$selector_groups"
              
              # Create contract-selector pairs
              for i in "${!addr_array[@]}"; do
                local addr="${addr_array[$i]}"
                local group="${selector_groups_array[$i]}"
                
                if [[ -n "$group" && "$group" != "[]" && "$group" != "" && "$group" != "[" ]]; then
                  # Remove brackets from group: [sel1,sel2] -> sel1,sel2
                  local clean_group=$(echo "$group" | sed 's/^\[//;s/\]$//')
                  
                  # Skip if group is empty after removing brackets
                  if [[ -n "$clean_group" && "$clean_group" != "" ]]; then
                    # Parse selectors in this group
                    local selectors=$(echo "$clean_group" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
                    while IFS= read -r selector; do
                      if [[ -n "$selector" && "$selector" != "" ]]; then
                        pairs+=("$(echo "$addr" | tr '[:upper:]' '[:lower:]')|$selector")
                      fi
                    done <<< "$selectors"
                  fi
                fi
              done
            fi
          fi
          
          if [[ ${#pairs[@]} -gt 0 ]]; then
            printf '%s\n' "${pairs[@]}"
            return 0
          fi
        fi
        
        # Fallback to the original approach if the new function fails
        local addresses=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedAddresses() returns (address[])" --rpc-url "$RPC_URL" 2>/dev/null)
        
        if [[ $? -eq 0 && -n "$addresses" && "$addresses" != "[]" ]]; then
          local pairs=()
          local address_list=$(echo "${addresses:1:${#addresses}-2}" | tr ',' ' ')
          for addr in $address_list; do
            local selectors=$(cast call "$DIAMOND_ADDRESS" "getWhitelistedSelectorsForContract(address) returns (bytes4[])" "$addr" --rpc-url "$RPC_URL" 2>/dev/null)
            if [[ $? -eq 0 && -n "$selectors" && "$selectors" != "[]" ]]; then
              local selector_list=$(echo "${selectors:1:${#selectors}-2}" | tr ',' ' ')
              for selector in $selector_list; do
                pairs+=("$(echo "$addr" | tr '[:upper:]' '[:lower:]')|$selector")
              done
            fi
          done
          printf '%s\n' "${pairs[@]}"
          return 0
        fi

        sleep 3
        ATTEMPT=$((ATTEMPT + 1))
      done

      return 1
    }

    # Get required contract-selector pairs from whitelist.json
    REQUIRED_PAIRS=($(getContractSelectorPairs "$NETWORK"))
    
    if [[ ${#REQUIRED_PAIRS[@]} -eq 0 ]]; then
      printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] No contract-selector pairs found in whitelist.json for this network"
      return
    fi

    # Get current whitelisted pairs from diamond
    CURRENT_PAIRS=($(getCurrentWhitelistedPairs))
    if [[ $? -ne 0 ]]; then
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
      IFS='|' read -r ADDRESS SELECTORS_STR <<< "$REQUIRED_PAIR"
      
      # Check if address has code
      CHECKSUMMED=$(cast --to-checksum-address "$ADDRESS")
      CODE=$(cast code "$CHECKSUMMED" --rpc-url "$RPC_URL")
      if [[ "$CODE" == "0x" ]]; then
        continue
      fi
      
      # Parse selectors (comma-separated)
      IFS=',' read -ra SELECTORS <<< "$SELECTORS_STR"
      
      for SELECTOR in "${SELECTORS[@]}"; do
        if [[ -n "$SELECTOR" ]]; then
          PAIR_KEY="$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')|$SELECTOR"
          
          # Check if this pair is already whitelisted
          if [[ ! " ${CURRENT_PAIRS[*]} " == *" $PAIR_KEY "* ]]; then
            NEW_PAIRS+=("$PAIR_KEY")
            NEW_ADDRESSES+=("$CHECKSUMMED")
          fi
        fi
      done
    done

    # Check for token contracts in the new addresses that will be added
    if [[ ! ${#NEW_ADDRESSES[@]} -eq 0 ]]; then
      UNIQUE_ADDRESSES=($(printf '%s\n' "${NEW_ADDRESSES[@]}" | sort -u))
      TOKEN_CONTRACTS=($(detectTokenContracts "$RPC_URL" "${UNIQUE_ADDRESSES[@]}"))

      if [[ ${#TOKEN_CONTRACTS[@]} -gt 0 ]]; then
        if [[ "$ALLOW_TOKEN_CONTRACTS" == "true" ]]; then
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Token contracts detected but proceeding (ALLOW_TOKEN_CONTRACTS=true)"
          printf '\033[0;33m%s\033[0m\n' "Token addresses: ${TOKEN_CONTRACTS[*]}"
        else
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Token contracts detected in new addresses - aborting whitelist sync"
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

    # Add missing contract-selector pairs
    if [[ ! ${#NEW_PAIRS[@]} -eq 0 ]]; then
      # Group pairs by contract address for batch operations
      declare -A CONTRACT_SELECTORS
      for PAIR in "${NEW_PAIRS[@]}"; do
        IFS='|' read -r ADDRESS SELECTOR <<< "$PAIR"
        CHECKSUMMED=$(cast --to-checksum-address "$ADDRESS")
        CONTRACT_SELECTORS["$CHECKSUMMED"]+="$SELECTOR,"
      done

      # Process each contract's selectors
      for CONTRACT_ADDRESS in "${!CONTRACT_SELECTORS[@]}"; do
        SELECTORS_STR="${CONTRACT_SELECTORS[$CONTRACT_ADDRESS]}"
        SELECTORS_STR="${SELECTORS_STR%,}"  # Remove trailing comma
        
        # Convert to array format for cast
        SELECTORS_ARRAY=$(echo "$SELECTORS_STR" | tr ',' '\n' | sed 's/^/"/;s/$/"/' | tr '\n' ',' | sed 's/,$//')
        SELECTORS_ARRAY="[$SELECTORS_ARRAY]"
        
        local ATTEMPTS=1
        while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
          # Use batchSetContractSelectorWhitelist for efficiency
          cast send "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "[$CONTRACT_ADDRESS]" "$SELECTORS_ARRAY" "true" --rpc-url "$RPC_URL" --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --legacy >/dev/null

          sleep 5

          # Verify updated pairs
          UPDATED_PAIRS=($(getCurrentWhitelistedPairs))
          if [[ $? -ne 0 ]]; then
            printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Contract-selector pairs update verification failed"
            {
              echo "[$NETWORK] Error: Contract-selector pairs update verification failed"
              echo ""
            } >> "$FAILED_LOG_FILE"
            return
          fi

          # Check if all new pairs for this contract are now whitelisted
          MISSING_PAIRS=()
          for PAIR in "${NEW_PAIRS[@]}"; do
            IFS='|' read -r ADDRESS SELECTOR <<< "$PAIR"
            CHECKSUMMED=$(cast --to-checksum-address "$ADDRESS")
            if [[ "$CHECKSUMMED" == "$CONTRACT_ADDRESS" ]]; then
              PAIR_KEY="$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')|$SELECTOR"
              if [[ ! " ${UPDATED_PAIRS[*]} " == *" $PAIR_KEY "* ]]; then
                MISSING_PAIRS+=("$PAIR_KEY")
              fi
            fi
          done

          if [ ${#MISSING_PAIRS[@]} -eq 0 ]; then
            printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Success - All contract-selector pairs for $CONTRACT_ADDRESS added"
            break
          fi

          ATTEMPTS=$((ATTEMPTS + 1))
        done

        if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] - Could not whitelist all pairs for contract $CONTRACT_ADDRESS"
          {
            echo "[$NETWORK] Error: Could not whitelist all pairs for contract $CONTRACT_ADDRESS"
            echo "[$NETWORK] Attempted selectors: $SELECTORS_STR"
            echo ""
          } >> "$FAILED_LOG_FILE"
        fi
      done
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