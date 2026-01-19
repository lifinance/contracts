#!/bin/bash

# TODO:
# - update script
# - call with environment
# - add private key distinction for call

diamondUpdateSgConfig() {
  # load env variables
	source .env

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
    
    # Execute forge script with stdout/stderr capture and JSON extraction
    local RESULT
    RESULT=$(executeCommandWithLogs \
      "NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_DEF_DIAMOND forge script script/deploy/facets/$SCRIPT.s.sol -f $NETWORK --json --broadcast --skip-simulation --legacy" \
      "true")
    local RAW_RETURN_DATA STDERR_CONTENT RETURN_CODE
    parseExecuteCommandResult "$RESULT"

    # Abort on non-zero return code before proceeding
    if ! checkCommandResult "$RETURN_CODE" "$STDERR_CONTENT" "$RAW_RETURN_DATA" \
      "forge script failed for $SCRIPT on network $NETWORK" "continue"; then
      attempts=$((attempts + 1))
      sleep 1
      continue
    fi

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


