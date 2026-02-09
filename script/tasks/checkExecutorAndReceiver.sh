#!/bin/bash


checkExecutorAndReceiver() {
  # load env variables
	source .env

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

    # Execute, parse, and check return code
    executeAndParse \
      "NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_DEF_DIAMOND forge script script/tasks/solidity/CheckExecutorAndReceiver.s.sol -f $NETWORK --json --skip-simulation --legacy --tc DeployScript" \
      "true"

    # Handle errors using centralized helper function
    if ! handleForgeScriptError "forge script failed for CheckExecutorAndReceiver" "" "$NETWORK"; then
      FAILED_RESULTS="${FAILED_RESULTS:-}"$'\n'"[info] Failed to check on network: ${NETWORK:-}"
      continue
    fi

    # Extract the "logs" property and its contents from return data
    CLEAN_RETURN_DATA=$(echo "${RAW_RETURN_DATA:-}" | sed 's/^.*{\"logs/{\"logs/')

    # Extract the "returns" property and its contents from logs
    RETURN_DATA=$(echo "$CLEAN_RETURN_DATA" | jq -r '.returns' 2>/dev/null)
    #echoDebug "RETURN_DATA: $RETURN_DATA"

    # Get the status from the return data
    MATCH=$(echo "$RETURN_DATA" | jq -r '."0".value')

    if [[ $MATCH == "true" ]]; then
      RESULT="[info] Executor and Receiver match on network: $NETWORK"
      MATCH_RESULTS="${MATCH_RESULTS:-}\n$RESULT"
    else
      RESULT="[warning] Executor and Receiver don't match on network: $NETWORK"
      DISMATCH_RESULTS="${DISMATCH_RESULTS:-}\n$RESULT"
    fi

    echo "$RESULT"
  done

  echo "Executor and Receiver checks completed"
  echo ""
  echo "========================== Results =========================="
  echo -e "${MATCH_RESULTS:-}"
  echo -e "${DISMATCH_RESULTS:-}"
  echo -e "${FAILED_RESULTS:-}"
}



