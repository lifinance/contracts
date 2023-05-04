#!/bin/bash


update() {
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

  # get user-selected network from list
	NETWORK=$(cat ./networks | gum filter --placeholder "Network...")
	# get user-selected script from list
	SCRIPT="UpdateConfigForStargate"

  # execute script
  attempts=1 # initialize attempts to 0

  while [ $attempts -lt 11 ]; do
    echo "Trying to execute $SCRIPT now - attempt ${attempts}"
    # try to execute call
    NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_DEF_DIAMOND forge script scripts/deploy/facets/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy

    # check the return code the last call
    if [ $? -eq 0 ]; then
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

update
