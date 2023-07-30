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
    # get user-selected network from list
    local NETWORK=$(cat ./networks | gum filter --placeholder "Network")
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
      # try to execute call
      RAW_RETURN_DATA=$(NETWORK=$CURRENT_NETWORK FILE_SUFFIX=$FILE_SUFFIX forge script script/tasks/solidity/AcceptOwnershipTransferPeriphery.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy --tc DeployScript)
      RETURN_CODE=$?

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



