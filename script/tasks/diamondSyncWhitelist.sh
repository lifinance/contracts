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
  RUN_FOR_ALL_NETWORKS=false
  if [[ "$NETWORK" == "All (non-excluded) Networks" ]]; then
    RUN_FOR_ALL_NETWORKS=true
    NETWORKS=($(getIncludedNetworksArray))
  else
    NETWORKS=("$NETWORK")
  fi

    # Execute a whitelist batch operation (add or remove)
  # Handles both Tron staging (direct troncast) and EVM/Tron production (calldata + sendOrPropose)
  function executeWhitelistBatch {
    local BATCH_CONTRACTS="$1"    # comma-separated
    local BATCH_SELECTORS="$2"    # comma-separated
    local IS_ADD="$3"             # "true" or "false"
    local BATCH_COUNT="$4"
    local NETWORK="$5"
    local DIAMOND_ADDRESS="$6"
    local IS_TRON="$7"
    local TRON_ENV="$8"
    
    local ATTEMPTS=1
    local BATCH_TX_SUCCESS=false

    while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
      # Wait before retries (except first attempt)
      if [ $ATTEMPTS -gt 1 ]; then
        echoSyncDebug "Waiting 3 seconds before retry..."
        sleep 3
      fi

      # Prepare arguments based on network type
      local CONTRACTS_FOR_SEND="$BATCH_CONTRACTS"
      local SEND_ARGS=""
      
      if [[ "$IS_TRON" == "true" ]]; then
        if [[ "$ENVIRONMENT" == "production" ]]; then
          # Tron production: convert base58 addresses to hex for calldata
          if ! CONTRACTS_FOR_SEND=$(convertTronAddressesToHex "$BATCH_CONTRACTS"); then
            printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Failed to convert Tron addresses to hex"
            echoSyncDebug "Original addresses: '$BATCH_CONTRACTS'"
            return 1
          fi
          
          if [[ -z "$CONTRACTS_FOR_SEND" ]]; then
            printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Address conversion returned empty result"
            echoSyncDebug "Original addresses: '$BATCH_CONTRACTS'"
            return 1
          fi
          # Production uses bracket notation for cast calldata
          SEND_ARGS="[$CONTRACTS_FOR_SEND] [$BATCH_SELECTORS] $IS_ADD"
        else
          # Tron staging: use JSON array format
          local TRON_CONTRACTS_JSON=$(formatCommaToJsonArray "$BATCH_CONTRACTS")
          local TRON_SELECTORS_JSON=$(formatCommaToJsonArray "$BATCH_SELECTORS")
          SEND_ARGS="$TRON_CONTRACTS_JSON,$TRON_SELECTORS_JSON,$IS_ADD"
          echoSyncDebug "Tron staging - params: $SEND_ARGS"
        fi
      else
        # EVM: use bracket notation for cast
        SEND_ARGS="[$CONTRACTS_FOR_SEND] [$BATCH_SELECTORS] $IS_ADD"
      fi
      
      local TIMELOCK_FLAG=$(getTimelockFlag "$NETWORK" "$ENVIRONMENT")
      echoSyncDebug "Send args: $SEND_ARGS"
      
      local OUTPUT
      OUTPUT=$(universalCast "send" "$NETWORK" "$ENVIRONMENT" "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "$SEND_ARGS" "$TIMELOCK_FLAG" 2>&1)
      local EXIT_CODE=$?

      if [[ "$RUN_FOR_ALL_NETWORKS" != "true" ]]; then echo "$OUTPUT"; fi

      if [[ $EXIT_CODE -eq 0 ]]; then
        BATCH_TX_SUCCESS=true
        break
      fi

      ATTEMPTS=$((ATTEMPTS + 1))
    done

    if [[ "$BATCH_TX_SUCCESS" == "true" ]]; then
      return 0
    else
      return 1
    fi
  }

  # Function to check if an address is a token contract
  # tries to call decimals() function and returns true if a number value is returned
  function isTokenContract {
    local ADDRESS=$1
    local RPC_URL=$2
    local NETWORK=$3  # Add network parameter
    local RESULT
    
    if RESULT=$(universalCast "call" "$NETWORK" "$ADDRESS" "decimals() returns (uint8)" 2>/dev/null); then
      # Validate 0-255 strictly
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
      if isTokenContract "$ADDRESS" "$RPC_URL" "$NETWORK"; then
        TOKEN_CONTRACTS+=("$ADDRESS")
        echo "$ADDRESS"
      fi
    done
  }

    # Convert comma-separated string to JSON array with quoted strings
  # Usage: formatCommaToJsonArray "a,b,c" => ["a","b","c"]
  function formatCommaToJsonArray {
    local INPUT="$1"
    local RESULT="["
    local FIRST=true
    IFS=',' read -ra ITEMS <<< "$INPUT"
    for ITEM in "${ITEMS[@]}"; do
      [[ "$FIRST" == "true" ]] && FIRST=false || RESULT+=","
      RESULT+="\"$ITEM\""
    done
    echo "${RESULT}]"
  }

  # Get whitelist file path based on environment
  function getWhitelistFilePath {
    local ENV="$1"
    if [[ "$ENV" == "production" ]]; then
      echo "config/whitelist.json"
    else
      echo "config/whitelist.staging.json"
    fi
  }

  # Determine timelock flag based on network and environment
  function getTimelockFlag {
    local NET="$1"
    local ENV="$2"
    if [[ "$ENV" == "production" ]] && ! isTronNetwork "$NET"; then
      echo "true"
    else
      echo "false"
    fi
  }

  # Function to convert comma-separated base58 addresses to hex addresses for calldata generation
  # This is needed because cast calldata expects hex addresses, but Tron uses base58
  function convertTronAddressesToHex {
    local ADDRESSES_STR="$1"
    
    # If empty, return empty
    if [[ -z "$ADDRESSES_STR" ]]; then
      echo ""
      return
    fi
    
    # Use troncast to convert addresses
    local HEX_ADDRESSES
    HEX_ADDRESSES=$(bun run script/troncast/index.ts address to-hex "$ADDRESSES_STR" 2>&1)
    local CONVERSION_EXIT_CODE=$?
    
    # Check if conversion was successful
    # Valid output should be comma-separated hex addresses (each starting with 0x)
    # Check that it doesn't contain error messages and contains at least one valid hex address
    if [[ $CONVERSION_EXIT_CODE -eq 0 && -n "$HEX_ADDRESSES" && ! "$HEX_ADDRESSES" =~ Error && "$HEX_ADDRESSES" =~ 0x ]]; then
      echo "$HEX_ADDRESSES"
    else
      # Conversion failed - return empty to signal error
      echo ""
      return 1
    fi
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

    # Cache Tron checks once at the start (avoids 30+ repeated function calls)
    local IS_TRON=false
    local TRON_ENV=""
    if isTronNetwork "$NETWORK"; then
      IS_TRON=true
      TRON_ENV=$(getTronEnv "$NETWORK")
    fi

    # Fetch contract address
    DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")
    local GET_ADDRESS_EXIT_CODE=$?

    # Check if contract address exists
    if [[ $GET_ADDRESS_EXIT_CODE -ne 0 || "$DIAMOND_ADDRESS" == "null" || -z "$DIAMOND_ADDRESS" ]]; then
      # Determine expected file path for better error message
      local FILE_SUFFIX
      if [[ "$ENVIRONMENT" == "production" ]]; then
        FILE_SUFFIX=""
      else
        FILE_SUFFIX="staging."
      fi
      local EXPECTED_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

      if [[ ! -f "$EXPECTED_FILE" ]]; then
        printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Deployment file not found: $EXPECTED_FILE - skipping whitelist sync"
      else
        # File exists but contract not found - check if it's a different issue
        local FILE_CONTENT
        FILE_CONTENT=$(jq -r ".$DIAMOND_CONTRACT_NAME // \"NOT_FOUND\"" "$EXPECTED_FILE" 2>/dev/null)
        if [[ "$FILE_CONTENT" == "NOT_FOUND" ]]; then
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Contract '$DIAMOND_CONTRACT_NAME' not found in $EXPECTED_FILE - skipping whitelist sync"
        elif [[ "$FILE_CONTENT" == "0x" || -z "$FILE_CONTENT" ]]; then
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Contract '$DIAMOND_CONTRACT_NAME' has invalid address (0x or empty) in $EXPECTED_FILE - skipping whitelist sync"
        else
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Failed to retrieve LiFiDiamond address from $EXPECTED_FILE (exit code: $GET_ADDRESS_EXIT_CODE) - skipping whitelist sync"
          echoSyncDebug "Found address in file: $FILE_CONTENT"
        fi
      fi
      return
    fi

    RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

    echoSyncDebug "Using RPC URL: $RPC_URL"
    echoSyncDebug "Diamond address: $DIAMOND_ADDRESS"

    # Function to get contract-selector pairs from whitelist files (whitelist.json or whitelist.staging.json)
    function getContractSelectorPairs {
      local NETWORK=$1
      local CONTRACT_SELECTOR_PAIRS=()

      # Use helper to get whitelist file path
      local WHITELIST_FILE=$(getWhitelistFilePath "$ENVIRONMENT")

      # Get DEX contracts
      echoSyncDebug "Getting DEX contracts..."
      local DEX_CONTRACTS=$(jq -r --arg network "$NETWORK" '.DEXS[] | select(.contracts[$network] != null) | .contracts[$network][] | select(.address != null) | "\(.address)|\(.functions | keys | join(","))"' "$WHITELIST_FILE" 2>&1)
      local DEX_EXIT_CODE=$?

      if [[ $DEX_EXIT_CODE -ne 0 ]]; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Failed to extract DEX contracts from $WHITELIST_FILE (jq exit code $DEX_EXIT_CODE)"
        return 1
      fi

      # Get PERIPHERY contracts from the appropriate whitelist file
      echo ""
      echoSyncDebug "Getting periphery contracts from $WHITELIST_FILE..."
      local PERIPHERY_CONTRACTS=$(jq -r --arg network "$NETWORK" '.PERIPHERY[$network] // [] | .[] | select(.address != null) | "\(.address)|\(.selectors | map(.selector) | join(","))"' "$WHITELIST_FILE" 2>&1)
      local PERIPHERY_EXIT_CODE=$?

      if [[ $PERIPHERY_EXIT_CODE -ne 0 ]]; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Failed to extract periphery contracts from $WHITELIST_FILE (jq exit code $PERIPHERY_EXIT_CODE)"
        return 1
      fi

      # Combine DEX and PERIPHERY contracts
      local ALL_CONTRACTS="$DEX_CONTRACTS"$'\n'"$PERIPHERY_CONTRACTS"

      while IFS= read -r line; do
        if [[ -n "$line" ]]; then
          CONTRACT_SELECTOR_PAIRS+=("$line")
          # Each line is a contract entry in the form "address|selector1,selector2,..."
          # The actual (contract, selector) pairs are derived later when splitting by comma.
        fi
      done <<< "$ALL_CONTRACTS"

      for PAIR in "${CONTRACT_SELECTOR_PAIRS[@]}"; do
        echo "$PAIR"
      done
    }

    # Function to get current whitelisted contract-selector pairs from the diamond
    # Uses IS_TRON and TRON_ENV from parent scope (processNetwork)
    function getCurrentWhitelistedPairs {
      local ATTEMPT=1

      while [ $ATTEMPT -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]; do
        echoSyncDebug "Attempt $ATTEMPT: Trying to get whitelisted pairs from diamond $DIAMOND_ADDRESS"

        echoSyncDebug "Calling getAllContractSelectorPairs() on diamond..."
        local CALL_OUTPUT
        local CALL_EXIT_CODE
        
        CALL_OUTPUT=$(universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "getAllContractSelectorPairs() returns (address[],bytes4[][])")
        CALL_EXIT_CODE=$?

        if [[ $CALL_EXIT_CODE -eq 0 && -n "$CALL_OUTPUT" ]]; then
          echoSyncDebug "Successfully got result from getAllContractSelectorPairs"

          # Initialize empty arrays for pairs
          local PAIRS=()

          # Handle empty result - single/two empty arrays (EVM) and Tron-style "[[] []]" / "[[]][]" / "[[],[]]"
          local CALL_NORMALIZED
          CALL_NORMALIZED=$(echo "$CALL_OUTPUT" | tr -d '\n' | xargs)
          local CALL_STRIP
          CALL_STRIP=$(echo "$CALL_NORMALIZED" | tr -d ' \t')
          if [[ "$CALL_OUTPUT" == "()" ]] || [[ "$CALL_OUTPUT" == "[]" ]] || [[ "$CALL_OUTPUT" == "[]"$'\n'"[]" ]] \
             || [[ "$CALL_NORMALIZED" == "[[] []]" ]] || [[ "$CALL_STRIP" == "[[]][]" ]] || [[ "$CALL_STRIP" == "[[],[]]" ]] \
             || [[ "$CALL_STRIP" == "[[]]" ]]; then
            echoSyncDebug "Empty result from getAllContractSelectorPairs - no whitelisted pairs"
            for PAIR in "${PAIRS[@]}"; do
              echo "$PAIR"
            done
            return 0
          fi

          echoSyncDebug "Parsing result from getAllContractSelectorPairs..."

          # Parse the output
          # Cast returns two lines (comma-separated): [0xAddr1, 0xAddr2, ...] and [[0xSel1, 0xSel2], [0xSel3], ...]
          # Troncast returns a single line with nested arrays: [[addresses...] [[selectors...]]]
          # Also need to filter out command echo lines that start with '$'

          local ADDRESSES_LINE
          local SELECTORS_LINE
          
          if [[ "$IS_TRON" == "true" ]]; then
            # Tron: Extract the line that starts with [[ (the actual result)
            # Filter out lines starting with $ (command echo) or containing "bun run"
            local RESULT_LINE=$(echo "$CALL_OUTPUT" | grep '^\[\[' | head -n 1)
            
            if [[ -z "$RESULT_LINE" ]]; then
              echoSyncDebug "No result line found starting with [["
              # Fallback: try to find any line with Tron addresses
              RESULT_LINE=$(echo "$CALL_OUTPUT" | grep -E '\[T[a-zA-Z0-9]{33}' | head -n 1)
            fi
            
            if [[ -n "$RESULT_LINE" ]]; then
              # Parse nested structure: [[addresses...] [[selectors...]]]
              # Format: [[addr1 addr2 ...] [[sel1 sel2] [sel3] ...]]
              # Example: [[TWEKQEE6... TCipFFZJk...] [[0xe0cbc5f2 0xeedd56e1] [0x0e8ae67f] ...]]
              # Raw: [[TWEKQEE6ejWAfF41t5KkHvk3comCLa2Qby TCipFFZJkZQ9Ny3W4y6kyZEKrU3FVnzbNQ TBfUqkmaBBMFA87ZCCu9aibjo2EZLTSJv2] [[0xe0cbc5f2 0xeedd56e1] [0x0e8ae67f 0x332d746b] [0x3ccfd60b 0xd0e30db0]]]
              
              # Remove outer brackets: [[...]] -> [...]
              local INNER=$(echo "$RESULT_LINE" | sed 's/^\[\[//; s/\]\]$//')
              # INNER is now: [TWEKQEE6... TCipFFZJk... TBfUqkma...] [[0xe0cbc5f2 0xeedd56e1] [0x0e8ae67f 0x332d746b] [0x3ccfd60b 0xd0e30db0]]
              
              # Extract addresses: first [...] part (content only, no brackets)
              # Use a more robust approach: find the first ] that's followed by space
              # Split on '] ' and take the first part, then remove the leading [
              local FIRST_PART=$(echo "$INNER" | cut -d']' -f1)
              ADDRESSES_LINE=$(echo "$FIRST_PART" | sed 's/^\[//')
              
              # Extract selectors: the [[...]] part (keep brackets for selector parsing)
              # Everything after the first '] ' (including the space)
              # Use awk to split on '] ' and get everything after the first occurrence
              # Then add back the final ']' that was part of the closing brackets
              SELECTORS_LINE=$(echo "$INNER" | awk -F'] ' '{for(i=2;i<=NF;i++){if(i>2)printf"] "; printf"%s",$i}}')
              # Add the final closing bracket if it's missing (it should end with ]])
              if [[ "$SELECTORS_LINE" != *"]]" ]]; then
                SELECTORS_LINE="${SELECTORS_LINE}]"
              fi
              
              # Validate extraction
              if [[ "$ADDRESSES_LINE" == *"["* ]] || [[ "$ADDRESSES_LINE" == *"]"* ]]; then
                echoSyncDebug "WARNING: Addresses line contains brackets, extraction may be wrong"
              fi
              if [[ "$SELECTORS_LINE" != *"["* ]]; then
                echoSyncDebug "WARNING: Selectors line doesn't start with bracket, extraction may be wrong"
              fi
              
              echoSyncDebug "Extracted addresses: $ADDRESSES_LINE"
              echoSyncDebug "Extracted selectors: $SELECTORS_LINE"
            else
              echoSyncDebug "ERROR: Could not extract result from troncast output"
            fi
          else
            # EVM: Extract the two lines - filter out any lines that don't start with [
            ADDRESSES_LINE=$(echo "$CALL_OUTPUT" | grep '^\[' | sed -n '1p')
            SELECTORS_LINE=$(echo "$CALL_OUTPUT" | grep '^\[' | sed -n '2p')
          fi
          
          echoSyncDebug "Addresses line: $ADDRESSES_LINE"
          echoSyncDebug "Selectors line: $SELECTORS_LINE"

          # Parse addresses line
          local -a CONTRACT_LIST
          local -a CONTRACT_LIST_original  # For Tron: store original case
          if [[ "$IS_TRON" == "true" ]]; then
            # Tron: space-separated, addresses are base58 (keep original case for operations)
            # Tron Base58 addresses start with 'T' and are 34 characters
            # ADDRESSES_LINE is already without brackets, just space-separated addresses
            for ADDR in $ADDRESSES_LINE; do
              # Trim whitespace
              ADDR=$(echo "$ADDR" | xargs)
              if isValidTronAddress "$ADDR"; then
                # Store both original and normalized versions
                CONTRACT_LIST_original+=("$ADDR")
                CONTRACT_LIST+=("$(echo "$ADDR" | tr '[:upper:]' '[:lower:]')")
              fi
            done
          else
            # EVM: comma-separated, addresses are hex
            while IFS= read -r ADDR; do
              ADDR=$(echo "$ADDR" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
              if [[ -n "$ADDR" && "$ADDR" != "[" && "$ADDR" != "]" ]]; then
                CONTRACT_LIST+=("$ADDR")
              fi
            done < <(echo "$ADDRESSES_LINE" | tr -d '[]' | tr ',' '\n')
          fi

          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Parsed ${#CONTRACT_LIST[@]} contract addresses"

          # If we have 0 contracts and selectors line is empty or only brackets, treat as empty result (e.g. Tron "[[] []]" that slipped past the early check)
          local SELECTORS_STRIP
          SELECTORS_STRIP=$(echo "$SELECTORS_LINE" | tr -d ' \t[]')
          if [[ ${#CONTRACT_LIST[@]} -eq 0 && ( -z "$SELECTORS_LINE" || -z "$SELECTORS_STRIP" ) ]]; then
            echoSyncDebug "Empty result from getAllContractSelectorPairs (0 contracts, no selectors) - no whitelisted pairs"
            for PAIR in "${PAIRS[@]}"; do
              echo "$PAIR"
            done
            return 0
          fi

          # Parse selectors line: [[0xSel1, 0xSel2], [0xSel3], ...] or [[0xSel1 0xSel2] [0xSel3] ...]
          # It's a 2D array. We need to maintain the correspondence: CONTRACT_LIST[i] has selectors from group i
          local SELECTORS_GROUPED
          if [[ "$IS_TRON" == "true" ]]; then
            # Tron: space-separated groups
            # Remove outer [[ and ]], then replace ] [ with |, and also remove any trailing ] from the last group
            SELECTORS_GROUPED=$(echo "$SELECTORS_LINE" | sed 's/^\[\[//; s/\]\]$//; s/\] \[/|/g; s/\]$//')
          else
            # EVM: comma-separated groups
            SELECTORS_GROUPED=$(echo "$SELECTORS_LINE" | sed 's/^\[\[//; s/\]\]$//; s/\], \[/|/g')
          fi

          # Split into groups by |
          local -a SELECTOR_GROUPS
          IFS='|' read -ra SELECTOR_GROUPS <<< "$SELECTORS_GROUPED"

          # Validate that we have matching counts
          if [[ ${#CONTRACT_LIST[@]} -ne ${#SELECTOR_GROUPS[@]} ]]; then
            echoSyncDebug "WARNING: Mismatch - ${#CONTRACT_LIST[@]} contracts but ${#SELECTOR_GROUPS[@]} selector groups"
            echoSyncDebug "Contracts: ${CONTRACT_LIST[*]}"
            echoSyncDebug "Selector groups: ${SELECTOR_GROUPS[*]}"
          fi

          # Now expand: for each contract, create one entry per selector
          for i in "${!CONTRACT_LIST[@]}"; do
            local CONTRACT_NORMALIZED="${CONTRACT_LIST[$i]}"
            local CONTRACT_ORIGINAL
            if [[ "$IS_TRON" == "true" && ${#CONTRACT_LIST_original[@]} -gt $i ]]; then
              CONTRACT_ORIGINAL="${CONTRACT_LIST_original[$i]}"
            else
              CONTRACT_ORIGINAL="$CONTRACT_NORMALIZED"
            fi
            
            # Skip if no selector group for this contract index
            if [[ $i -ge ${#SELECTOR_GROUPS[@]} ]]; then
              echoSyncDebug "WARNING: No selector group for contract index $i"
              continue
            fi
            
            local SELECTOR_GROUP="${SELECTOR_GROUPS[$i]}"

            # Split the selector group
            if [[ "$IS_TRON" == "true" ]]; then
              # Tron: space-separated
              IFS=' ' read -ra SELECTORS_ARR <<< "$SELECTOR_GROUP"
            else
              # EVM: comma-separated
              IFS=',' read -ra SELECTORS_ARR <<< "$SELECTOR_GROUP"
            fi

            for SELECTOR in "${SELECTORS_ARR[@]}"; do
              # Trim whitespace and lowercase
              SELECTOR=$(echo "$SELECTOR" | tr -d ' ' | tr '[:upper:]' '[:lower:]')
              if isValidSelector "$SELECTOR"; then
                # For Tron: store as "normalized_address|selector" but we'll use original for operations
                # Store in format that allows us to recover original: "normalized|original|selector"
                if [[ "$IS_TRON" == "true" ]]; then
                  PAIRS+=("$CONTRACT_NORMALIZED|$CONTRACT_ORIGINAL|$SELECTOR")
                else
                  PAIRS+=("$CONTRACT_NORMALIZED|$SELECTOR")
                fi
              elif [[ -n "$SELECTOR" ]]; then
                # Invalid selector: abort and return so caller can retry/fail
                echoSyncDebug "Invalid selector: $SELECTOR"
                return 1
              fi
            done
          done

          if [[ ${#PAIRS[@]} -gt 0 ]]; then
            # Successfully parsed ${#PAIRS[@]} pairs from getAllContractSelectorPairs
            for PAIR in "${PAIRS[@]}"; do
              echo "$PAIR"
            done
            return 0
          fi
        else
          # getAllContractSelectorPairs failed with exit code $call_exit_code
          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: getAllContractSelectorPairs failed, falling back..."
        fi

        # Fallback to the original approach if the new function fails
        echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Attempting fallback to getWhitelistedAddresses()"
        local addresses=$(universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "getWhitelistedAddresses() returns (address[])" 2>&1)
        local addresses_exit_code=$?

        if [[ $addresses_exit_code -eq 0 && -n "$addresses" && "$addresses" != "[]" ]]; then
          # Successfully got addresses from getWhitelistedAddresses
          local pairs=()
          local address_list=$(echo "${addresses:1:${#addresses}-2}" | tr ',' ' ')

          echoSyncDebug "DEBUG [getCurrentWhitelistedPairs]: Fallback processing $(echo "$address_list" | wc -w) addresses"
          local addr_count=0
          for addr in $address_list; do
            ((addr_count++))
            local selectors=$(universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "getWhitelistedSelectorsForContract(address) returns (bytes4[])" "$addr" 2>&1)
            local selectors_exit_code=$?

            if [[ $selectors_exit_code -eq 0 && -n "$selectors" && "$selectors" != "[]" ]]; then
              local selector_list=$(echo "${selectors:1:${#selectors}-2}" | tr ',' ' ')
              for selector in $selector_list; do
                pairs+=("$(echo "$addr" | tr '[:upper:]' '[:lower:]')|$selector")
              done
            fi
          done

          if [[ ${#pairs[@]} -gt 0 ]]; then
            # Successfully got ${#pairs[@]} pairs using fallback method
            for pair in "${pairs[@]}"; do
              echo "$pair"
            done
            return 0
          else
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
    echoSyncStage "----- [$NETWORK] Stage 1: Loading required whitelist configuration -----"
    REQUIRED_PAIRS=($(getContractSelectorPairs "$NETWORK"))

    echoSyncDebug "Found ${#REQUIRED_PAIRS[@]} required pairs from whitelist files"
    if [[ ${#REQUIRED_PAIRS[@]} -eq 0 ]]; then
      printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] No contract-selector pairs found in whitelist files for this network"
      return
    fi

    # Get current whitelisted pairs from diamond
    echoSyncStage "----- [$NETWORK] Stage 2: Fetching current whitelisted pairs from diamond -----"
    CURRENT_PAIRS=($(getCurrentWhitelistedPairs))
    local GET_PAIRS_EXIT_CODE=$?

    if [[ $GET_PAIRS_EXIT_CODE -ne 0 ]]; then
      printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Unable to fetch current whitelisted pairs"
      {
        echo "[$NETWORK] Error: Unable to fetch current whitelisted pairs"
        echo ""
      } >> "$FAILED_LOG_FILE"
      return
    fi

    # Determine missing pairs and pairs to remove
    echoSyncStage "----- [$NETWORK] Stage 3: Determining missing and obsolete contract-selector pairs -----"
    NEW_PAIRS=()
    NEW_ADDRESSES=()
    REMOVED_PAIRS=()

    # Normalize CURRENT_PAIRS to lowercase for consistent comparison
    # For Tron: pairs are in format "normalized|original|selector", extract normalized part
    # For EVM: pairs are in format "address|selector"
    NORMALIZED_CURRENT_PAIRS=()
    for CURRENT_PAIR in "${CURRENT_PAIRS[@]}"; do
      if isTronNetwork "$NETWORK"; then
        # Tron format: "normalized|original|selector" - extract normalized address and selector
        local NORMALIZED_PART="${CURRENT_PAIR%%|*}"  # First part (normalized address)
        local REST="${CURRENT_PAIR#*|}"  # "original|selector"
        local SELECTOR_PART="${REST#*|}"  # Selector part
        NORMALIZED_CURRENT_PAIRS+=("$NORMALIZED_PART|$SELECTOR_PART")
      else
        # EVM format: "address|selector"
        NORMALIZED_CURRENT_PAIRS+=("$(echo "$CURRENT_PAIR" | tr '[:upper:]' '[:lower:]')")
      fi
    done

    # First, normalize REQUIRED_PAIRS to lowercase addresses for comparison
    NORMALIZED_REQUIRED_PAIRS=()
    for REQUIRED_PAIR in "${REQUIRED_PAIRS[@]}"; do
      # Split the pair by '|' character using parameter expansion
      ADDRESS="${REQUIRED_PAIR%%|*}"
      SELECTORS_STR="${REQUIRED_PAIR#*|}"
      ADDRESS_LOWER=$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')

      # Check for address zero (forbidden)
      if isZeroAddress "$ADDRESS"; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Error: Whitelisting address zero is forbidden: $ADDRESS"
        {
          echo "[$NETWORK] Error: Whitelisting address zero is forbidden: $ADDRESS"
          echo "[$NETWORK] Please check whitelist.json or whitelist.staging.json and remove address zero"
          echo ""
        } >> "$FAILED_LOG_FILE"
        return 1
      fi

      # Check if address has code (universalCast routes Tron vs EVM internally)
      CODE=$(universalCast "code" "$NETWORK" "$ADDRESS" 2>/dev/null || echo "0x")
      if isTronNetwork "$NETWORK"; then
        CHECKSUMMED="$ADDRESS"
      else
        CHECKSUMMED=$(cast to-check-sum-address "$ADDRESS_LOWER")
      fi

      if [[ "$CODE" == "0x" ]]; then
        # Determine the correct whitelist file to check for contract name
        local WHITELIST_FILE_CHECK
        if [[ "$ENVIRONMENT" == "production" ]]; then
          WHITELIST_FILE_CHECK="config/whitelist.json"
        else
          WHITELIST_FILE_CHECK="config/whitelist.staging.json"
        fi

        # Check if this is a Composer contract
        local IS_COMPOSER=false
        local CONTRACT_NAME
        CONTRACT_NAME=$(jq -r --arg network "$NETWORK" --arg address "$CHECKSUMMED" '.PERIPHERY[$network] // [] | .[] | select(.address == $address) | .name' "$WHITELIST_FILE_CHECK" 2>/dev/null)

        if [[ "$CONTRACT_NAME" == "Composer" ]]; then
          IS_COMPOSER=true
        fi

        # Print warning about address with no code
        printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Address has no code: $CHECKSUMMED"

        if [[ "$IS_COMPOSER" == "true" ]]; then
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] This is a Composer contract. Please reach out to Leo."
        else
          printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Please reach out to the backend team about this address."
        fi

        echoSyncDebug "Skipping address with no code: $CHECKSUMMED"
        continue
      fi

      # Parse selectors: if selector is empty (e.g. pair "address|") use ApproveTo-Only; otherwise use comma-separated list
      if [[ -z "$SELECTORS_STR" ]]; then
        # No selectors defined (empty selector) - add ApproveTo-Only Selector (0xffffffff) for backward compatibility
        #
        # Context: During migration from DexManagerFacet to WhitelistManagerFacet, the old system
        # used simple address-based whitelisting (e.g., approve entire DEX contract). The new
        # WhitelistManagerFacet uses granular contract-selector pairs for better security.
        #
        # This selector makes isAddressWhitelisted(_contract) return true for backward
        # compatibility with legacy address-only checks, but does not allow any granular calls.
        APPROVE_TO_SELECTOR="0xffffffff"
        SELECTOR_LOWER="$APPROVE_TO_SELECTOR"
        PAIR_KEY="$ADDRESS_LOWER|$SELECTOR_LOWER"
        NORMALIZED_REQUIRED_PAIRS+=("$PAIR_KEY")

        # Check if this ApproveTo-Only Selector pair is already whitelisted
        FOUND_IN_CURRENT=false
        for NORMALIZED_CURRENT in "${NORMALIZED_CURRENT_PAIRS[@]}"; do
          if [[ "$PAIR_KEY" == "$NORMALIZED_CURRENT" ]]; then
            FOUND_IN_CURRENT=true
            break
          fi
        done

        if [[ "$FOUND_IN_CURRENT" == "false" ]]; then
          NEW_PAIRS+=("$CHECKSUMMED|$APPROVE_TO_SELECTOR")
          NEW_ADDRESSES+=("$CHECKSUMMED")
        fi
      else
        # Split selectors by comma (use tr for portability)
        SELECTORS=($(echo "$SELECTORS_STR" | tr ',' ' '))

        for SELECTOR in "${SELECTORS[@]}"; do
          if [[ -n "$SELECTOR" && "$SELECTOR" != "" ]]; then
            # Normalize selector to lowercase for comparison
            SELECTOR_LOWER=$(echo "$SELECTOR" | tr '[:upper:]' '[:lower:]')
            PAIR_KEY="$ADDRESS_LOWER|$SELECTOR_LOWER"
            NORMALIZED_REQUIRED_PAIRS+=("$PAIR_KEY")

            # Check if this pair is already whitelisted
            FOUND_IN_CURRENT=false
            for NORMALIZED_CURRENT in "${NORMALIZED_CURRENT_PAIRS[@]}"; do
              if [[ "$PAIR_KEY" == "$NORMALIZED_CURRENT" ]]; then
                FOUND_IN_CURRENT=true
                break
              fi
            done

            if [[ "$FOUND_IN_CURRENT" == "false" ]]; then
              NEW_PAIRS+=("$CHECKSUMMED|$SELECTOR")
              NEW_ADDRESSES+=("$CHECKSUMMED")
            fi
          fi
        done
      fi
    done

    echoSyncDebug "Determined ${#NEW_PAIRS[@]} new pairs to add and ${#NORMALIZED_REQUIRED_PAIRS[@]} required pairs"

    # Now determine pairs that need to be removed (in CURRENT_PAIRS but not in REQUIRED_PAIRS)
    if [[ ${#CURRENT_PAIRS[@]} -gt 0 ]]; then
      echoSyncDebug "Comparing ${#CURRENT_PAIRS[@]} current pairs against ${#NORMALIZED_REQUIRED_PAIRS[@]} required pairs"
      
      for CURRENT_PAIR in "${CURRENT_PAIRS[@]}"; do
        # Normalize current pair to lowercase for comparison
        # For Tron: pairs are "normalized|original|selector", extract normalized part
        # For EVM: pairs are "address|selector"
        if isTronNetwork "$NETWORK"; then
          # Extract normalized address and selector (skip original address in middle)
          local NORM_ADDR="${CURRENT_PAIR%%|*}"
          local REST="${CURRENT_PAIR#*|}"
          local SEL="${REST#*|}"
          CURRENT_PAIR_LOWER="$NORM_ADDR|$SEL"
        else
          CURRENT_PAIR_LOWER=$(echo "$CURRENT_PAIR" | tr '[:upper:]' '[:lower:]')
        fi

        # Check if this pair is in the required pairs
        FOUND_IN_REQUIRED=false
        for REQUIRED_PAIR_NORM in "${NORMALIZED_REQUIRED_PAIRS[@]}"; do
          if [[ "$CURRENT_PAIR_LOWER" == "$REQUIRED_PAIR_NORM" ]]; then
            FOUND_IN_REQUIRED=true
            break
          fi
        done

        # If not found in required pairs, mark for removal
        if [[ "$FOUND_IN_REQUIRED" == "false" ]]; then
          if isTronNetwork "$NETWORK"; then
            # Tron format: "normalized|original|selector"
            # Extract original address (middle part) and selector (last part)
            local NORMALIZED_PART="${CURRENT_PAIR%%|*}"
            local REST="${CURRENT_PAIR#*|}"  # "original|selector"
            local ORIGINAL_ADDR="${REST%%|*}"  # Original address
            local SEL_PART="${REST#*|}"  # Selector
            CHECKSUMMED_ADDR="$ORIGINAL_ADDR"
            SELECTOR_PART="$SEL_PART"
          else
            # EVM: Use lowercased address and convert to checksummed
            ADDRESS_PART="${CURRENT_PAIR_LOWER%%|*}"
            SELECTOR_PART="${CURRENT_PAIR_LOWER#*|}"
            echoSyncDebug "[Stage 3 removal] CURRENT_PAIR='$CURRENT_PAIR' CURRENT_PAIR_LOWER='$CURRENT_PAIR_LOWER' ADDRESS_PART='$ADDRESS_PART' SELECTOR_PART='$SELECTOR_PART'"
            if [[ -z "$ADDRESS_PART" ]]; then
              echoSyncDebug "Skipping pair with empty address part: CURRENT_PAIR='$CURRENT_PAIR'"
              continue
            fi
            CHECKSUMMED_ADDR=$(cast to-check-sum-address "$ADDRESS_PART")
          fi
          
          REMOVED_PAIRS+=("$CHECKSUMMED_ADDR|$SELECTOR_PART")
        fi
      done
    fi

    # Check for token contracts in the new addresses that will be added
    if [[ ! ${#NEW_ADDRESSES[@]} -eq 0 ]]; then
      UNIQUE_ADDRESSES=($(printf '%s\n' "${NEW_ADDRESSES[@]}" | sort -u))

      # Detect token contracts in the new addresses
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

    # Remove obsolete contract-selector pairs (process removals first)
    if [[ ${#REMOVED_PAIRS[@]} -gt 0 ]]; then
      echoSyncStage "----- [$NETWORK] Stage 4a: Removing obsolete contract-selector pairs -----"
      printf '\033[0;36m%s\033[0m\n' "📊 [$NETWORK] Found ${#REMOVED_PAIRS[@]} pairs to remove"
      echoSyncStep "🔍 [$NETWORK] Preparing removal of ${#REMOVED_PAIRS[@]} pairs"

      # Build comma-separated strings directly in cast format
      local REMOVE_CONTRACTS_ARRAY=""
      local REMOVE_SELECTORS_ARRAY=""
      local REMOVE_COUNT=0
      local FIRST=true

      echoSyncStep "🔄 [$NETWORK] Processing pairs for removal..."
      for PAIR in "${REMOVED_PAIRS[@]}"; do
        # Split pair by '|' to get address and selector
        CHECKSUMMED_ADDRESS="${PAIR%%|*}"
        SELECTOR="${PAIR#*|}"

        if [[ -n "$SELECTOR" && "$SELECTOR" != "" ]]; then
          if [[ "$FIRST" == "true" ]]; then
            FIRST=false
          else
            REMOVE_CONTRACTS_ARRAY+=","
            REMOVE_SELECTORS_ARRAY+=","
          fi
          REMOVE_CONTRACTS_ARRAY+="$CHECKSUMMED_ADDRESS"
          REMOVE_SELECTORS_ARRAY+="$SELECTOR"
          ((REMOVE_COUNT++))
        fi
      done
      echoSyncStep "✔️  [$NETWORK] Processed $REMOVE_COUNT pairs for removal"

      # Validate that we have arrays to process
      if [[ -z "$REMOVE_CONTRACTS_ARRAY" || -z "$REMOVE_SELECTORS_ARRAY" ]]; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Cannot execute removal: empty arrays"
        echoSyncDebug "REMOVE_CONTRACTS_ARRAY: '$REMOVE_CONTRACTS_ARRAY'"
        echoSyncDebug "REMOVE_SELECTORS_ARRAY: '$REMOVE_SELECTORS_ARRAY'"
        return
      fi

      # Prepare arguments based on network type and environment
      local CONTRACTS_FOR_SEND="$REMOVE_CONTRACTS_ARRAY"
      local SEND_ARGS=""
      local IS_TRON_NETWORK=false
      isTronNetwork "$NETWORK" && IS_TRON_NETWORK=true
      
      if [[ "$IS_TRON_NETWORK" == "true" ]]; then
        if [[ "$ENVIRONMENT" == "production" ]]; then
          # Tron production: convert base58 addresses to hex for calldata
          if ! CONTRACTS_FOR_SEND=$(convertTronAddressesToHex "$REMOVE_CONTRACTS_ARRAY"); then
            printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Failed to convert Tron addresses to hex"
            echoSyncDebug "Original addresses: '$REMOVE_CONTRACTS_ARRAY'"
            return
          fi
          
          if [[ -z "$CONTRACTS_FOR_SEND" ]]; then
            printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Address conversion returned empty result"
            echoSyncDebug "Original addresses: '$REMOVE_CONTRACTS_ARRAY'"
            return
          fi
          # Production uses bracket notation for cast calldata
          SEND_ARGS="[$CONTRACTS_FOR_SEND] [$REMOVE_SELECTORS_ARRAY] false"
        else
          # Tron staging: use JSON array format
          local TRON_CONTRACTS_JSON=$(formatCommaToJsonArray "$REMOVE_CONTRACTS_ARRAY")
          local TRON_SELECTORS_JSON=$(formatCommaToJsonArray "$REMOVE_SELECTORS_ARRAY")
          SEND_ARGS="$TRON_CONTRACTS_JSON,$TRON_SELECTORS_JSON,false"
          echoSyncDebug "Tron staging removal - params: $SEND_ARGS"
        fi
      else
        # EVM: use bracket notation for cast
        SEND_ARGS="[$CONTRACTS_FOR_SEND] [$REMOVE_SELECTORS_ARRAY] false"
      fi

      local TIMELOCK_FLAG=$(getTimelockFlag "$NETWORK" "$ENVIRONMENT")
      
      echoSyncStep "🚀 [$NETWORK] Starting removal execution..."
      local REMOVE_ATTEMPTS=1
      local REMOVE_SUCCESS=false

      while [ $REMOVE_ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
        printf '\033[0;36m%s\033[0m\n' "📤 [$NETWORK] Attempt $REMOVE_ATTEMPTS: Removing $REMOVE_COUNT pairs"

        if [ $REMOVE_ATTEMPTS -gt 1 ]; then
          echoSyncDebug "Waiting 3 seconds before retry..."
          sleep 3
        fi

        # sendOrPropose: propose vs send is decided by SEND_PROPOSALS_DIRECTLY_TO_DIAMOND and environment. TIMELOCK_FLAG only used when proposing (wrap in timelock).
        local TIMELOCK_FLAG="false"
        if [[ "$ENVIRONMENT" == "production" && "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" != "true" ]]; then
          TIMELOCK_FLAG="true"
        fi

        echoSyncDebug "Send args for removal: $SEND_ARGS"

        local REMOVE_OUTPUT
        REMOVE_OUTPUT=$(universalCast "send" "$NETWORK" "$ENVIRONMENT" "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "$SEND_ARGS" "$TIMELOCK_FLAG" 2>&1)
        local REMOVE_EXIT_CODE=$?

        # Print output in verbose mode
        if [[ "$RUN_FOR_ALL_NETWORKS" != "true" ]]; then echo "$REMOVE_OUTPUT"; fi

        if [[ $REMOVE_EXIT_CODE -eq 0 ]]; then
          printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Removal successful!"
          REMOVE_SUCCESS=true
          break
        else
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Removal failed (attempt $REMOVE_ATTEMPTS)"
        fi

        REMOVE_ATTEMPTS=$((REMOVE_ATTEMPTS + 1))
      done

      if [[ "$REMOVE_SUCCESS" == "false" ]]; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Could not remove ${#REMOVED_PAIRS[@]} pairs after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts"
        {
          echo "[$NETWORK] Error: Could not remove obsolete pairs"
          echo "[$NETWORK] Pairs to remove: ${REMOVED_PAIRS[*]}"
          echo ""
        } >> "$FAILED_LOG_FILE"
      else
        # Brief wait for state to propagate
        sleep 2
      fi
    fi

    # Add missing contract-selector pairs
    if [[ ${#NEW_PAIRS[@]} -gt 0 ]]; then
      if [[ ${#REMOVED_PAIRS[@]} -gt 0 ]]; then
        echoSyncStage "----- [$NETWORK] Stage 4b: Adding missing contract-selector pairs -----"
      else
        echoSyncStage "----- [$NETWORK] Stage 4: Processing whitelist additions -----"
      fi
      printf '\033[0;36m%s\033[0m\n' "📊 [$NETWORK] Found ${#NEW_PAIRS[@]} new pairs to add (out of ${#REQUIRED_PAIRS[@]} required)"
      echoSyncStep "🔍 [$NETWORK] Entering batch send section with ${#NEW_PAIRS[@]} pairs"

      # First, expand all pairs into flat arrays (contract, selector pairs)
      # batchSetContractSelectorWhitelist expects: address[], bytes4[], bool
      local ALL_CONTRACTS=()
      local ALL_SELECTORS=()
      local TOTAL_PAIR_COUNT=0

      echoSyncStep "🔄 [$NETWORK] Processing pairs..."
      for PAIR in "${NEW_PAIRS[@]}"; do
        # Split pair by '|' to get address and selector(s)
        CHECKSUMMED_ADDRESS="${PAIR%%|*}"
        SELECTORS_STR="${PAIR#*|}"

        # Handle multiple selectors (comma-separated)
        if [[ -n "$SELECTORS_STR" && "$SELECTORS_STR" != "" ]]; then
          # Split selectors by comma
          local SELECTOR_ARRAY=($(echo "$SELECTORS_STR" | tr ',' ' '))
          for SEL in "${SELECTOR_ARRAY[@]}"; do
            if [[ -n "$SEL" && "$SEL" != "" ]]; then
              ALL_CONTRACTS+=("$CHECKSUMMED_ADDRESS")
              ALL_SELECTORS+=("$SEL")
              ((TOTAL_PAIR_COUNT++))
            fi
          done
        fi
      done
      echoSyncStep "✔️  [$NETWORK] Processed $TOTAL_PAIR_COUNT pairs"

      # Process in batches to avoid gas limit issues
      local BATCH_SIZE=150
      local TOTAL_BATCHES=$(( (TOTAL_PAIR_COUNT + BATCH_SIZE - 1) / BATCH_SIZE ))
      echoSyncStep "📦 [$NETWORK] Processing $TOTAL_PAIR_COUNT pairs in $TOTAL_BATCHES batches (batch size: $BATCH_SIZE)"

      echoSyncStep ""
      echoSyncStep "🚀 [$NETWORK] Starting batch execution..."

      local BATCH_NUM=0
      local BATCH_SUCCESS=true

      for ((i=0; i<${#ALL_CONTRACTS[@]}; i+=BATCH_SIZE)); do
        BATCH_NUM=$((BATCH_NUM + 1))
        local BATCH_END=$((i + BATCH_SIZE))
        if [[ $BATCH_END -gt ${#ALL_CONTRACTS[@]} ]]; then
          BATCH_END=${#ALL_CONTRACTS[@]}
        fi

        # Build batch arrays
        local BATCH_CONTRACTS_ARRAY=""
        local BATCH_SELECTORS_ARRAY=""
        local BATCH_COUNT=$((BATCH_END - i))
        local FIRST=true

        for ((j=i; j<BATCH_END; j++)); do
          if [[ "$FIRST" == "true" ]]; then
            FIRST=false
          else
            BATCH_CONTRACTS_ARRAY+=","
            BATCH_SELECTORS_ARRAY+=","
          fi
          BATCH_CONTRACTS_ARRAY+="${ALL_CONTRACTS[$j]}"
          BATCH_SELECTORS_ARRAY+="${ALL_SELECTORS[$j]}"
        done

        # Validate that we have arrays to process
        if [[ -z "$BATCH_CONTRACTS_ARRAY" || -z "$BATCH_SELECTORS_ARRAY" ]]; then
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Cannot execute batch $BATCH_NUM: empty arrays"
          echoSyncDebug "BATCH_CONTRACTS_ARRAY: '$BATCH_CONTRACTS_ARRAY'"
          echoSyncDebug "BATCH_SELECTORS_ARRAY: '$BATCH_SELECTORS_ARRAY'"
          BATCH_SUCCESS=false
          continue
        fi

        # Prepare arguments based on network type and environment
        local CONTRACTS_FOR_SEND="$BATCH_CONTRACTS_ARRAY"
        local SEND_ARGS=""
        local IS_TRON_NETWORK=false
        isTronNetwork "$NETWORK" && IS_TRON_NETWORK=true
        
        if [[ "$IS_TRON_NETWORK" == "true" ]]; then
          if [[ "$ENVIRONMENT" == "production" ]]; then
            # Tron production: convert base58 addresses to hex for calldata
            if ! CONTRACTS_FOR_SEND=$(convertTronAddressesToHex "$BATCH_CONTRACTS_ARRAY"); then
              printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Failed to convert Tron addresses to hex for batch $BATCH_NUM"
              echoSyncDebug "Original addresses: '$BATCH_CONTRACTS_ARRAY'"
              BATCH_SUCCESS=false
              continue
            fi
            
            if [[ -z "$CONTRACTS_FOR_SEND" ]]; then
              printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Address conversion returned empty result for batch $BATCH_NUM"
              echoSyncDebug "Original addresses: '$BATCH_CONTRACTS_ARRAY'"
              BATCH_SUCCESS=false
              continue
            fi
            # Production uses bracket notation for cast calldata
            SEND_ARGS="[$CONTRACTS_FOR_SEND] [$BATCH_SELECTORS_ARRAY] true"
          else
            # Tron staging: use JSON array format
            local TRON_CONTRACTS_JSON=$(formatCommaToJsonArray "$BATCH_CONTRACTS_ARRAY")
            local TRON_SELECTORS_JSON=$(formatCommaToJsonArray "$BATCH_SELECTORS_ARRAY")
            SEND_ARGS="$TRON_CONTRACTS_JSON,$TRON_SELECTORS_JSON,true"
            echoSyncDebug "Tron staging batch addition - params: $SEND_ARGS"
          fi
        else
          # EVM: use bracket notation for cast
          SEND_ARGS="[$CONTRACTS_FOR_SEND] [$BATCH_SELECTORS_ARRAY] true"
        fi

        local TIMELOCK_FLAG=$(getTimelockFlag "$NETWORK" "$ENVIRONMENT")
        echoSyncStep "📤 [$NETWORK] Batch $BATCH_NUM/$TOTAL_BATCHES: Processing $BATCH_COUNT pairs..."

        local ATTEMPTS=1
        local BATCH_TX_SUCCESS=false

        while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
          # Wait before retries to allow base fee to stabilize (except first attempt)
          if [ $ATTEMPTS -gt 1 ]; then
            echoSyncDebug "Waiting 3 seconds before retry..."
            sleep 3
          fi

          # sendOrPropose: propose vs send from SEND_PROPOSALS_DIRECTLY_TO_DIAMOND and environment. TIMELOCK_FLAG only when proposing (wrap in timelock).
          local TIMELOCK_FLAG="false"
          if [[ "$ENVIRONMENT" == "production" && "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" != "true" ]]; then
            TIMELOCK_FLAG="true"
          fi

          echoSyncDebug "Send args for batch addition: $SEND_ARGS"

          local OUTPUT
          OUTPUT=$(universalCast "send" "$NETWORK" "$ENVIRONMENT" "$DIAMOND_ADDRESS" "batchSetContractSelectorWhitelist(address[],bytes4[],bool)" "$SEND_ARGS" "$TIMELOCK_FLAG" 2>&1)
          local EXIT_CODE=$?

          if [[ "$RUN_FOR_ALL_NETWORKS" != "true" ]]; then echo "$OUTPUT"; fi

          if [[ $EXIT_CODE -eq 0 ]]; then
            printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Batch $BATCH_NUM/$TOTAL_BATCHES successful!"
            BATCH_TX_SUCCESS=true
            break
          else
            printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Batch $BATCH_NUM/$TOTAL_BATCHES failed (attempt $ATTEMPTS)"
          fi

          ATTEMPTS=$((ATTEMPTS + 1))
        done

        if [[ "$BATCH_TX_SUCCESS" == "false" ]]; then
          printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Batch $BATCH_NUM/$TOTAL_BATCHES failed after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts"
          BATCH_SUCCESS=false
          {
            echo "[$NETWORK] Error: Batch $BATCH_NUM/$TOTAL_BATCHES failed"
            echo "[$NETWORK] Pairs in failed batch: $BATCH_COUNT"
            echo ""
          } >> "$FAILED_LOG_FILE"
          # Continue with remaining batches even if one fails
        else
          # Brief wait between batches for state to propagate
          sleep 1
        fi
      done

      if [[ "$BATCH_SUCCESS" == "false" ]]; then
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Some batches failed - check logs above"
        return 1
      fi

      # All batches succeeded - verify final state
      printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] All $TOTAL_BATCHES batches completed successfully!"

      # Skip verification when we proposed (production, SEND_PROPOSALS_DIRECTLY_TO_DIAMOND not true): state changes only after proposal is executed
      # Run verification when we sent directly (staging or SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true)
      if [[ "$ENVIRONMENT" == "production" && "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" != "true" ]]; then
        printf '\033[0;36m%s\033[0m\n' "ℹ️  [$NETWORK] Skipping verification - proposals require signing and execution before state changes"
        return 0
      fi

      # Verify by calling getAllContractSelectorPairs() to confirm the state
      echo ""
      printf '\033[0;36m%s\033[0m\n' "🔍 [$NETWORK] Verifying whitelist state..."
      sleep 2  # Brief wait for state to propagate

      UPDATED_PAIRS=($(getCurrentWhitelistedPairs))
      local VERIFY_EXIT_CODE=$?

      if [[ $VERIFY_EXIT_CODE -ne 0 ]]; then
        printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Could not verify whitelist state (getAllContractSelectorPairs failed)"
        return 0
      fi

      # Verify pairs were added correctly
      # Use file-based grep/comm comparison instead of loops
      local NEW_PAIRS_FILE=$(mktemp)
      local UPDATED_PAIRS_FILE=$(mktemp)

      # Write normalized arrays to temp files for fast comparison
      # Normalize and sort NEW pairs (format: "address|selector")
      for PAIR in "${NEW_PAIRS[@]}"; do
        echo "$PAIR" | tr '[:upper:]' '[:lower:]'
      done | sort > "$NEW_PAIRS_FILE"

      # Normalize and sort UPDATED pairs
      # For Tron: format is "normalized|original|selector" -> extract "normalized|selector"
      # For EVM: format is "address|selector" -> just lowercase
      for PAIR in "${UPDATED_PAIRS[@]}"; do
        if [[ "$IS_TRON" == "true" ]]; then
          # Tron format: "normalized|original|selector" -> "normalized|selector"
          local NORM="${PAIR%%|*}"
          local REST="${PAIR#*|}"
          local SEL="${REST#*|}"
          echo "$NORM|$SEL"
        else
          echo "$PAIR" | tr '[:upper:]' '[:lower:]'
        fi
      done | sort > "$UPDATED_PAIRS_FILE"

      # Find missing pairs (Lines in 'new' that are NOT in 'updated')
      # -F: Fixed strings (fast)
      # -x: Match whole line
      # -v: Invert match (show items in new that are NOT in updated)
      # -f: Read patterns from file
      local MISSING_PAIRS_LIST
      MISSING_PAIRS_LIST=$(grep -F -x -v -f "$UPDATED_PAIRS_FILE" "$NEW_PAIRS_FILE")

      # Count lines (grep -c might count 0 as 1 empty line sometimes, wc -l is safer with empty output check)
      local MISSING_COUNT=0
      if [[ -n "$MISSING_PAIRS_LIST" ]]; then
         MISSING_COUNT=$(echo "$MISSING_PAIRS_LIST" | wc -l)
      fi

      # Calculate verified count
      local TOTAL_NEW_COUNT=${#NEW_PAIRS[@]}
      local VERIFIED_COUNT=$((TOTAL_NEW_COUNT - MISSING_COUNT))

      # Cleanup temp files
      rm -f "$NEW_PAIRS_FILE" "$UPDATED_PAIRS_FILE"

      # Report verification results
      if [[ $MISSING_COUNT -eq 0 ]]; then
        printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Verified: All $TOTAL_NEW_COUNT contract-selector pairs are whitelisted"
        return 0
      elif [[ $VERIFIED_COUNT -gt 0 ]]; then
        printf '\033[0;33m%s\033[0m\n' "⚠️  [$NETWORK] Partial verification: $VERIFIED_COUNT/$TOTAL_NEW_COUNT pairs confirmed whitelisted"
        echoSyncDebug "Missing pairs found:"
        echoSyncDebug "$MISSING_PAIRS_LIST"
        return 0
      else
        printf '\033[0;31m%s\033[0m\n' "❌ [$NETWORK] Verification failed: None of the $TOTAL_NEW_COUNT pairs found in whitelist"
        return 0
      fi
    else
      if [[ ${#REMOVED_PAIRS[@]} -gt 0 ]]; then
        printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] No new pairs to add, but ${#REMOVED_PAIRS[@]} obsolete pairs were removed"
      else
        printf '\033[0;32m%s\033[0m\n' "✅ [$NETWORK] Skipped - all contract-selector pairs are already whitelisted and no obsolete pairs found"
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

  # If production was synced, also sync staging using staging whitelist
  if [[ "$ENVIRONMENT" == "production" ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> Syncing staging..."
    echo ""
    ENVIRONMENT="staging"
    for NETWORK in "${NETWORKS[@]}"; do
      while [[ $(jobs | wc -l) -ge $MAX_CONCURRENT_JOBS ]]; do
        sleep 1
      done
      processNetwork "$NETWORK" &
    done
    wait
    echo ""
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< Staging sync completed"
    echo ""
  fi

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
