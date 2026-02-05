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
    
    # Execute, parse, and check return code
    executeAndParse \
      "NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_DEF_DIAMOND forge script script/deploy/facets/$SCRIPT.s.sol -f $NETWORK --json --broadcast --skip-simulation --legacy" \
      "true"

    # Handle errors using centralized helper function
    if handleForgeScriptError "forge script failed for $SCRIPT" "attempt $attempts/10" "$NETWORK"; then
      # If we reach here, execution was successful
      break
    fi

    attempts=$((attempts + 1))
    sleep 1
  done

  if [ $attempts -eq 11 ]; then
    error "Failed to execute $SCRIPT on network $NETWORK after 10 attempts"
    exit 1
  fi

  echo "$SCRIPT successfully executed on network $NETWORK"
}


