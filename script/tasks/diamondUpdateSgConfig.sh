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

  echo "[info] Make sure you have sufficient funds in the deployer wallet to perform the operation"

  # execute script
  attempts=1 # initialize attempts to 0

  while [ $attempts -lt 11 ]; do
    echo "Trying to execute $SCRIPT now - attempt ${attempts}"
    
    # Execute, parse, and check return code
    if ! executeAndParse \
      "NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_DEF_DIAMOND forge script script/deploy/facets/$SCRIPT.s.sol -f $NETWORK --json --broadcast --skip-simulation --legacy" \
      "true" \
      "forge script failed for $SCRIPT on network $NETWORK" \
      "continue"; then
      attempts=$((attempts + 1))
      sleep 1
      continue
    fi

    # If we reach here, execution was successful
    break
  done

  if [ $attempts -eq 11 ]; then
    echo "Failed to execute $SCRIPT"
    exit 1
  fi

  echo "$SCRIPT successfully executed on network $NETWORK"
}


