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
    NETWORKS=($(getAllNetworksArray))
  else
    # get user-selected network from list
    local NETWORK=$(cat ./networks | gum filter --placeholder "Network")
    # create array with selected network as only entry
    NETWORKS=($NETWORK)
  fi

  # go through all networks
  for NETWORK in "${NETWORKS[@]}"; do
    echo ""
    echo "[info] now check Executor and Receiver on network: $NETWORK"

    # try to execute call
    RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_DEF_DIAMOND forge script script/tasks/solidity/CheckExecutorAndReceiver.s.sol -f $NETWORK -vvvv --json --silent --skip-simulation --legacy --tc DeployScript)
    RETURN_CODE=$?

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
      CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')

      # extract the "returns" property and its contents from logs
      RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2>/dev/null)
      #echoDebug "RETURN_DATA: $RETURN_DATA"

      # get the status from the return data
      MATCH=$(echo $RETURN_DATA | jq -r '."0".value')

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



