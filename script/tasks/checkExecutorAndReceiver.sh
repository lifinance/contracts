#!/bin/bash


checkExecutorAndReceiver() {
  # load env variables
	source .env

  # load config & helper functions
  source script/helperFunctions.sh

  # ask user if check Executor and Receiver for one network or for all networks
  echo "Would you like to check Executor and Receiver on all networks or on one specific network?"
  SELECTION_NETWORK=$(
    gum choose \
      "1) All networks" \
      "2) One specific network (selection in next screen)" \
  )
  echo "[info] selected option: $SELECTION_NETWORK"

  # prompt user to choose which diamond to check (standard or immutable)
	echo "Please select which diamond to check:"
	SELECTION_DIAMOND=$(gum choose "1) Mutable (default)" "2) Immutable")

  if [[ "$SELECTION_DIAMOND" == *"default"* ]]; then
      echo "Checking mutable diamond"
      USE_DEF_DIAMOND=true
  else
      echo "Checking immutable diamond"
      USE_DEF_DIAMOND=false
  fi

  # prompt user to choose which environment to check (production or staging)
	echo "Please select which environment to check:"
	SELECTION_ENV=$(gum choose "1) Production (default)" "2) Staging")

  if [[ "$SELECTION_ENV" == *"default"* ]]; then
      echo "Checking production"
      FILE_SUFFIX=""
  else
      echo "Checking staging"
      FILE_SUFFIX="staging."
  fi

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

  # go through all networks
  for NETWORK in "${NETWORKS[@]}"; do
    echo ""
    echo "[info] now check Executor and Receiver on network: $NETWORK"

    # Create temporary files to capture stdout and stderr separately
    # This ensures we can extract JSON from stdout while keeping stderr logs for debugging
    STDOUT_LOG=$(mktemp)
    STDERR_LOG=$(mktemp)
    trap "rm -f '$STDOUT_LOG' '$STDERR_LOG'" EXIT
    
    # try to execute call
    NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_DEF_DIAMOND forge script script/tasks/solidity/CheckExecutorAndReceiver.s.sol -f $NETWORK --json --skip-simulation --legacy --tc DeployScript >"$STDOUT_LOG" 2>"$STDERR_LOG"
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
        error "failed to check. Could not extract error message. RAW_RETURN_DATA: $RAW_RETURN_DATA"
      else
        error "failed to check with message: $ERROR_MESSAGE"
      fi

      FAILED_RESULTS="$FAILED_RESULTS\n[info] Failed to check on network: $NETWORK"

    # check the return code the last call
    elif [[ $RETURN_CODE -eq 0 && $RAW_RETURN_DATA != *"\"returns\":{}"* ]]; then
      # extract the "logs" property and its contents from return data
      CLEAN_RETURN_DATA=$(echo "$RAW_RETURN_DATA" | sed 's/^.*{\"logs/{\"logs/')

      # extract the "returns" property and its contents from logs
      RETURN_DATA=$(echo "$CLEAN_RETURN_DATA" | jq -r '.returns' 2>/dev/null)
      #echoDebug "RETURN_DATA: $RETURN_DATA"

      # get the status from the return data
      MATCH=$(echo "$RETURN_DATA" | jq -r '."0".value')

      if [[ $MATCH == "true" ]]; then
        RESULT="[info] Executor and Receiver match on network: $NETWORK"
        MATCH_RESULTS="$MATCH_RESULTS\n$RESULT"
      else
        RESULT="[warning] Executor and Receiver don't match on network: $NETWORK"
        DISMATCH_RESULTS="$DISMATCH_RESULTS\n$RESULT"
      fi

      echo $RESULT
    fi
  done

  echo "Executor and Receiver checks completed"
  echo ""
  echo "========================== Results =========================="
  echo -e $MATCH_RESULTS
  echo -e $DISMATCH_RESULTS
  echo -e $FAILED_RESULTS
}



