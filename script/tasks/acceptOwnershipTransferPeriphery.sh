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
    echo "[info] now executing transfer ownership script in network: $CURRENT_NETWORK"

    # execute script
    attempts=1

    while [ $attempts -lt 11 ]; do
      # Execute, parse, and check return code
      executeAndParse \
        "NETWORK=$CURRENT_NETWORK FILE_SUFFIX=$FILE_SUFFIX forge script script/tasks/solidity/AcceptOwnershipTransferPeriphery.s.sol -f $CURRENT_NETWORK --json --broadcast --verify --skip-simulation --legacy --tc DeployScript" \
        "true"

      # Handle errors using centralized helper function
      if handleForgeScriptError "forge script failed for AcceptOwnershipTransferPeriphery" "attempt $attempts/10" "$CURRENT_NETWORK"; then
        break  # exit the loop if the operation was successful
      fi

      attempts=$((attempts + 1))
      sleep 1
    done

    # check if loop was ended because it ran out of attempts or because of success
    if [ $attempts -eq 11 ]; then
      error "ownership transfer was not successful on network $CURRENT_NETWORK. Script will continue with next network, if any."
      continue
    else
      echo "ownership transfer successful on network $CURRENT_NETWORK"
    fi

  done


  echo "Ownership transfer completed"
}



