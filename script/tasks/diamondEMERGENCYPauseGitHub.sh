#!/bin/bash

# this script is designed to be called by a Github action
# it can only pause the main PROD diamond on all networks
# for all other actions the diamondEMERGENCYPause.sh script should be called
# via scriptMaster.sh in local CLI for more flexibility


# load config & helper functions
source ./script/helperFunctions.sh

# Define function to handle each network operation
function handleNetwork() {
  local NETWORK=$1
  local ACTION=$2
  local FACET_CONTRACT_NAME=$3

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
  echo ""

  # execute the requested action
  # local ATTEMPTS=1
  # while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
  #   echo "[info] trying to $ACTION now - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"

  #   # if a facet address is given, remove that facet, otherwise pause the diamond
  #   if [ -z "$FACET_CONTRACT_NAME"  ]; then
  #     if [ "$ACTION" == "pause the diamond contract entirely" ]; then
  #       echoDebug "[network: $NETWORK] pausing diamond $DIAMOND_ADDRESS now from wallet $DEPLOYER"
  #       cast send "$DIAMOND_ADDRESS" "pauseDiamond()" --private-key "$PRIVATE_KEY_PAUSER_WALLET" --rpc-url "$RPC_URL" --legacy >/dev/null
  #     else
  #       echoDebug "[network: $NETWORK] proposing an unpause transaction to diamond owner multisig now"

  #       local CALLDATA=$(cast calldata "unpauseDiamond(address[])" "$BLACKLIST")
  #       ts-node script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl $RPC_URL --privateKey "$SAFE_SIGNER_PRIVATE_KEY"
  #     fi
  #   else
  #     echoDebug "[network: $NETWORK] removing $FACET_CONTRACT_NAME now"

  #     # get facet address
  #     FACET_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "$FACET_CONTRACT_NAME")

  #     if [[ $? -ne 0 ]]; then
  #       error "[network: $NETWORK] could not find address for facet $FACET_CONTRACT_NAME in PROD deploy log. Cannot continue for this network."
  #       return 1
  #     fi

  #     cast send "$DIAMOND_ADDRESS" "removeFacet(address)" "$FACET_ADDRESS" --private-key "$PRIVATE_KEY_PAUSER_WALLET" --rpc-url "$RPC_URL" --legacy
  #   fi

  #   # check the return code of the last call
  #   if [ $? -eq 0 ]; then
  #     break # exit the loop if the operation was successful
  #   fi

  #   ATTEMPTS=$((ATTEMPTS + 1)) # increment ATTEMPTS
  #   sleep 1                    # wait for 1 second before trying the operation again
  # done

  # # check if call was executed successfully or used all ATTEMPTS
  # if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
  #   error "[network: $NETWORK] failed to $ACTION on network $NETWORK (diamond address: $DIAMOND_ADDRESS)"
  #   return 1
  # fi

  # success "[network: $NETWORK] successfully executed action '$ACTION'"
  # echo ""
  # return 0
}


function main {
  # create array with network/s for which the script should be executed
  NETWORKS=($(getAllNetworksArray))
  echo "NETWORKS: $NETWORKS"
  echo ""

  # send message to DISCORD
  # TODO <<<<<<<<------------------------------------------------------------------------

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

  # # read function arguments into variables
  # local NETWORK="$1"
  # local DIAMOND_CONTRACT_NAME="$3"
  # local EXIT_ON_ERROR="$4"
  # local ENVIRONMENT="production" # this script is only meant to be used on PROD diamond

  #   # get file suffix based on value in variable ENVIRONMENT
  # local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")



  # echo "TEST_SECRET: $TEST_SECRET"
  # echo "DIAMOND_CONTRACT_NAME: $DIAMOND_CONTRACT_NAME"
  # echo "EXIT_ON_ERROR: $EXIT_ON_ERROR"
  # echo "ENVIRONMENT: $ENVIRONMENT"
  # echo "FILE_SUFFIX: $FILE_SUFFIX"
  # DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "mainnet" "production" "LiFiDiamond")

  # echo "DIAMOND_ADDRESS: $DIAMOND_ADDRESS"

  # if [[ "$PRIVATE_KEY_PAUSER_WALLET" == "TEST_SECRET_VALUE" ]]; then
  #   echo "TEST_SECRET_VALUE found"
  # else
  #   PAUSER_WALLET_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  # fi

  # echo "trying to print pauser wallet key now"
  # echo "PRIVATE_KEY_PAUSER_WALLET: $PRIVATE_KEY_PAUSER_WALLET"
  # PAUSER_WALLET_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  # echo "PAUSER_WALLET_ADDRESS: $PAUSER_WALLET_ADDRESS"




# call main function with all parameters the script was called with
main "$@"

