#!/bin/bash

# TODO:
# - update script
# - call with environment
# - add private key distinction for call

diamondUpdateSgConfig() {
  # load env variables
	source .env
  
  # load config & helper functions
  source script/config.sh
  source script/helperFunctions.sh

  # check if env variable "PRODUCTION" is true, otherwise deploy as staging
	if [[ -z "$PRODUCTION" ]]; then
		FILE_SUFFIX="staging."
	fi

	# prompt user to choose which diamond to update (standard or immutable)
	echo "Please select which diamond to update:"
	SELECTION=$(gum choose "1) Mutable (default)" "2) Immutable")

  if [[ "$SELECTION" == *"default"* ]]; then
      echo "Updating mutable diamond"
      USE_DEF_DIAMOND=true
  else
      echo "Updating immutable diamond"
      USE_DEF_DIAMOND=false
  fi

  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
  # get user-selected network from list
	NETWORK=$(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH" | gum filter --placeholder "Network...")
	# get user-selected script from list
	SCRIPT="UpdateConfigForStargate"

  # execute script
  attempts=1 # initialize attempts to 0

  while [ $attempts -lt 11 ]; do
    echo "Trying to execute $SCRIPT now - attempt ${attempts}"
    
    # Create temporary files to capture stdout and stderr separately
    # This ensures we can extract JSON from stdout while keeping stderr logs for debugging
    STDOUT_LOG=$(mktemp)
    STDERR_LOG=$(mktemp)
    trap "rm -f '$STDOUT_LOG' '$STDERR_LOG'" EXIT
    
    # try to execute call
    NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_DEF_DIAMOND forge script script/deploy/facets/$SCRIPT.s.sol -f $NETWORK --json --broadcast --skip-simulation --legacy >"$STDOUT_LOG" 2>"$STDERR_LOG"
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

    # check the return code the last call
    if [ "$RETURN_CODE" -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq 11 ]; then
    echo "Failed to execute $SCRIPT"
    exit 1
  fi

  echo "$SCRIPT successfully executed on network $NETWORK"
}


