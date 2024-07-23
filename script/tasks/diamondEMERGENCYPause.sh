#!/bin/bash

#TODO:
# - who can execute this script?
# - who has access to the PauserWallet privKey (or should it be the tester wallet so every employee can pause our contract)?
# - replace pauserWallet address in global config
# - how can we make sure that the user log info is being sent to Discord (webhook URL must be in config.sh which most people wont have set up)

function diamondEMERGENCYPause {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script diamondEMERGENCYPause now...."
  # load env variables
  source .env

  # load config & helper functions
  source script/helperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local DIAMOND_CONTRACT_NAME="$3"
  local EXIT_ON_ERROR="$4"
  local ENVIRONMENT="production" # this script is only meant to be used on PROD diamond

    # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    # find out if script should be executed for one network or for all networks
    echo ""
    echo "Should the script be executed on one network or all networks?"
    NETWORK=$(echo -e "All (non-excluded) Networks\n$(cat ./networks)" | gum filter --placeholder "Network")
    echo "[info] selected network: $NETWORK"

    if [[ "$NETWORK" != "All (non-excluded) Networks" ]]; then
      checkRequiredVariablesInDotEnv $NETWORK
    fi
  fi

    # create array with network/s for which the script should be executed
  if [[ "$NETWORK" == "All (non-excluded) Networks" ]]; then
    # get array with all network names
    NETWORKS=($(getAllNetworksArray))
  else
    NETWORKS=($NETWORK)
  fi

  # if no DIAMOND_CONTRACT_NAME was passed to this function, ask user to select it
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to sync:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
    echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi


  # remove just one facet or pause the whole diamond
  echo ""
  echo "Please select what you want to do:"
  local ACTION=$(
    gum choose \
      "pause the diamond contract entirely" \
      "unpause the diamond" \
      "remove a single facet"
  )
  echo "[info] selected action: $ACTION"


  if [[ "$ACTION" == "remove a single facet" ]]; then
    echo "Please select which facet you would like to remove"
    local FACET_CONTRACT_NAME=$(ls -1 script/deploy/facets/ | sed -e 's/\.s.sol$//' | grep 'Deploy' | grep 'Facet' | sed -e 's/Deploy//' | gum filter --placeholder "Pick a Facet")
  fi

  if [[ "$ACTION" == "unpause the diamond" ]]; then
    echo ""
    echo ""
    echo "Please enter the addresses of all facets that SHOULD NOT be reactivated while unpausing the diamond:"
    echo "Required format (including brackets and quotes):   ["0x123...", "0xbeb..."] (or press ENTER to reactivate all facets)"
    read -r BLACKLIST
    if [[ -z "$BLACKLIST" ]]; then
    BLACKLIST="[]"
    fi
  fi

  # logging for debug purposes
  echo ""
  echoDebug "in function diamondEMERGENCYPause"
  echoDebug "NETWORKS=$NETWORKS"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echoDebug "DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
  echoDebug "ACTION=$ACTION"
  echo ""

  # get user info and send message to discord server
  local USER_INFO=$(getUserInfo)
  sendMessageToDiscordSmartContractsChannel "WARNING: an emergency diamond action was just triggered (action: $ACTION, user info: $USER_INFO). Please immediately investigate if this action was not planned."

  # Initialize return status
  local RETURN=0

  # go through all networks and start background tasks for each network (to execute in parallel)
  for NETWORK in "${NETWORKS[@]}"; do
      handleNetwork "$NETWORK" "$ACTION" "$FACET_CONTRACT_NAME" "$BLACKLIST" &
  done

  # Wait for all background jobs to finish
  wait

  # Check exit status of each background job
  for JOB in `jobs -p`
  do
    wait $JOB || let "RETURN=1"
  done

  # end script according to return status
  if [ "$RETURN" == 1 ]; then
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  else
    return 0
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script diamondEMERGENCYPause completed"
}


# Define function to handle each network operation
function handleNetwork() {
  local NETWORK=$1
  local ACTION=$2
  local FACET_CONTRACT_NAME=$3
  local BLACKLIST=$4 # a list of facet addresses that should not be reactivated when unpausing the diamond

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK")

  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond")

  if [[ $? -ne 0 ]]; then
    error "[network: $NETWORK] could not find diamond address in PROD deploy log. Cannot continue for this network."
    return 1
  fi

  # logging for debug purposes
  echo ""
  echoDebug "in function handleNetwork"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ACTION=$ACTION"
  echoDebug "RPC_URL=$RPC_URL"
  echoDebug "DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
  echoDebug "FACET_CONTRACT_NAME=$FACET_CONTRACT_NAME"
  echoDebug "BLACKLIST=$BLACKLIST"
  echo ""

  # execute the requested action
  local ATTEMPTS=1
  while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to $ACTION now - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"

    # if a facet address is given, remove that facet, otherwise pause the diamond
    if [ -z "$FACET_CONTRACT_NAME"  ]; then
      if [ "$ACTION" == "pause the diamond contract entirely" ]; then
        echoDebug "[network: $NETWORK] pausing diamond $DIAMOND_ADDRESS now from wallet $DEPLOYER"
        cast send "$DIAMOND_ADDRESS" "pauseDiamond()" --private-key "$PRIVATE_KEY_PAUSER_WALLET" --rpc-url "$RPC_URL" --legacy >/dev/null
      else
        echoDebug "[network: $NETWORK] proposing an unpause transaction to diamond owner multisig now"

        local CALLDATA=$(cast calldata "unpauseDiamond(address[])" "$BLACKLIST")
        ts-node script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl $RPC_URL --privateKey "$SAFE_SIGNER_PRIVATE_KEY"
      fi
    else
      echoDebug "[network: $NETWORK] removing $FACET_CONTRACT_NAME now"

      # get facet address
      FACET_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "$FACET_CONTRACT_NAME")

      if [[ $? -ne 0 ]]; then
        error "[network: $NETWORK] could not find address for facet $FACET_CONTRACT_NAME in PROD deploy log. Cannot continue for this network."
        return 1
      fi

      cast send "$DIAMOND_ADDRESS" "removeFacet(address)" "$FACET_ADDRESS" --private-key "$PRIVATE_KEY_PAUSER_WALLET" --rpc-url "$RPC_URL" --legacy
    fi

    # check the return code of the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    ATTEMPTS=$((ATTEMPTS + 1)) # increment ATTEMPTS
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all ATTEMPTS
  if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    error "[network: $NETWORK] failed to $ACTION on network $NETWORK (diamond address: $DIAMOND_ADDRESS)"
    return 1
  fi

  success "[network: $NETWORK] successfully executed action '$ACTION'"
  echo ""
  return 0
}


