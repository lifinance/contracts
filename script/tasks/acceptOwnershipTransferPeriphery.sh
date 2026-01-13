#!/bin/bash


acceptOwnershipTransferPeriphery() {
  # read function arguments into variables
  # the first parameter is unused/empty
  ENVIRONMENT="$2"
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # load env variables
	source .env

  # load config & helper functions
  source script/helperFunctions.sh

  # ask user if logs should be updated only for one network or for all networks
  echo "Would you like to accept ownership transfer on all networks or on one specific network?"
  SELECTION_NETWORK=$(
    gum choose \
      "1) All networks" \
      "2) One specific network (selection in next screen)" \
  )
  echo "[info] selected option: $SELECTION_NETWORK"

  # get array of networks in which the script should be run
  if [[ "$SELECTION_NETWORK" == *"1)"* ]]; then
    # get array of all (not-excluded) networks
    NETWORKS=($(getIncludedNetworksArray))
  else
    checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
    # get user-selected network from list
    local NETWORK=$(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH" | gum filter --placeholder "Network")
    # create array with selected network as only entry
    NETWORKS=($NETWORK)
  fi

  # make sure that private keys for withdraw and refund wallet are available
  if [[ -z "$PRIVATE_KEY_WITHDRAW_WALLET" ]]; then
    error "your .env file is missing a PRIVATE_KEY_WITHDRAW_WALLET. The script cannot continue without this value."
    exit 1
  fi
  if [[ -z "$PRIVATE_KEY_REFUND_WALLET" ]]; then
    error "your .env file is missing a PRIVATE_KEY_REFUND_WALLET. The script cannot continue without this value."
    exit 1
  fi


  # go through all networks
  for CURRENT_NETWORK in "${NETWORKS[@]}"; do
    echo ""
    echo "[info] now executing transfer ownership script in network: $NETWORK"

    # execute script
    attempts=1

    while [ $attempts -lt 11 ]; do
      # Create temporary files to capture stdout and stderr separately
      # This ensures we can extract JSON from stdout while keeping stderr logs for debugging
      STDOUT_LOG=$(mktemp)
      STDERR_LOG=$(mktemp)
      trap "rm -f '$STDOUT_LOG' '$STDERR_LOG'" EXIT
      
      # try to execute call
      NETWORK=$CURRENT_NETWORK FILE_SUFFIX=$FILE_SUFFIX forge script script/tasks/solidity/AcceptOwnershipTransferPeriphery.s.sol -f $NETWORK --json --broadcast --verify --skip-simulation --legacy --tc DeployScript >"$STDOUT_LOG" 2>"$STDERR_LOG"
      RETURN_CODE=$?
      
      # Read stdout (should contain JSON) and stderr (warnings/errors) separately
      RAW_RETURN_DATA=$(cat "$STDOUT_LOG" 2>/dev/null || echo "")
      STDERR_CONTENT=$(cat "$STDERR_LOG" 2>/dev/null || echo "")
      
      # Debug: Show what we captured
      echoDebug "=== RAW_RETURN_DATA (stdout, first 1000 chars) ==="
      echoDebug "${RAW_RETURN_DATA:0:1000}"
      echoDebug "=== STDERR logs (first 500 chars) ==="
      echoDebug "${STDERR_CONTENT:0:500}"
      
      # Extract JSON from RAW_RETURN_DATA (it should already be JSON when using --json)
      # Try to find JSON object with "logs" key
      if ! echo "$RAW_RETURN_DATA" | jq empty 2>/dev/null; then
        # If not valid JSON, try to extract JSON object
        RAW_RETURN_DATA=$(echo "$RAW_RETURN_DATA" | grep -o '{"logs":.*}' | head -1)
        if [[ -z "$RAW_RETURN_DATA" ]] || ! echo "$RAW_RETURN_DATA" | jq empty 2>/dev/null; then
          RAW_RETURN_DATA=$(echo "$RAW_RETURN_DATA" | jq -c 'if type=="object" and has("logs") then . else empty end' 2>/dev/null | head -1)
        fi
      fi
      
      # Clean up temporary files
      rm -f "$STDOUT_LOG" "$STDERR_LOG"
      trap - EXIT

      # print return data only if debug mode is activated
      echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

      # check return data for error message (regardless of return code as this is not 100% reliable)
      if [[ $RAW_RETURN_DATA == *"\"logs\":[]"* && $RAW_RETURN_DATA == *"\"returns\":{}"* ]]; then
        # try to extract error message and throw error
        ERROR_MESSAGE=$(echo "$RAW_RETURN_DATA" | sed -n 's/.*0\\0\\0\\0\\0\(.*\)\\0\".*/\1/p')
        if [[ $ERROR_MESSAGE == "" ]]; then
          error "execution of script failed. Could not extract error message. RAW_RETURN_DATA: $RAW_RETURN_DATA"
        else
          error "execution of script failed with message: $ERROR_MESSAGE"
        fi

      # check the return code the last call
      elif [[ $RETURN_CODE -eq 0 && $RAW_RETURN_DATA != *"\"returns\":{}"* ]]; then
        break  # exit the loop if the operation was successful
      fi
    done

    # check if loop was ended because it ran out of attempts or because of success
    if [ $attempts -eq 11 ]; then
      error "ownership transfer was not successful on network $CURRENT_NETWORK. Script will continue with next network, if any."
      continue
    else
      echo "ownership transfer successful on network $NETWORK"
    fi

  done


  echo "Ownership transfer completed"
}



