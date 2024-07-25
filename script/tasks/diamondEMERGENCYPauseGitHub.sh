#!/bin/bash

# this script is designed to be called by a Github action
# it can only pause the main PROD diamond on all networks
# for all other actions the diamondEMERGENCYPause.sh script should be called
# via scriptMaster.sh in local CLI for more flexibility


# load config & helper functions
source ./script/helperFunctions.sh


# the number of attempts the script will max try to execute the pause transaction
MAX_ATTEMPTS=5

function pauseDiamond() {
    local DIAMOND_ADDRESS=$1
  local PRIVATE_KEY_PAUSER_WALLET=$2
  local RPC_URL=$3

      RESULT=$(cast send "$DIAMOND_ADDRESS" "pauseDiamond()" --private-key "$PRIVATE_KEY_PAUSER_WALLET" --rpc-url "$RPC_URL" >/dev/null)

}


# Define function to handle each network operation
function handleNetwork() {
  echo ""
  echo ">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start network $1 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>"
  local NETWORK=$1
  local PAUSER_WALLET_ADDRESS=$2


  # skip any non-prod networks
  case "$NETWORK" in
    "bsc-testnet" | "localanvil" | "sepolia" | "mumbai" | "lineatest")
      echo "skipping $NETWORK"
      return 0
      ;;
  esac


  echo "now starting with network $NETWORK"
  DEPLOYER=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  echo "DEPLOYER_ADDRESS1: $DEPLOYER"

  # get RPC URL for given network
  RPC_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

   # Use eval to read the environment variable named like the RPC_KEY (our normal syntax like 'RPC_URL=${!RPC_URL}' doesnt work on Github)
  eval "RPC_URL=\$$(echo "$RPC_KEY" | tr '-' '_')"

  # get diamond address for this network
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond")
  if [[ $? -ne 0 ]]; then
    error "[network: $NETWORK] could not find diamond address in PROD deploy log. Cannot continue for this network."
    return 1
  fi
  echo "[$NETWORK] DIAMOND_ADDRESS found from log: $DIAMOND_ADDRESS"
  DIAMOND_ADDRESS="0xbEbCDb5093B47Cd7add8211E4c77B6826aF7bc5F" # TODO <<<<<----- REMOVE
  echo "[$NETWORK] manually overwritten diamond address to staging diamond to check if it works: $DIAMOND_ADDRESS"  # TODO <<<<<----- REMOVE

  # logging for debug purposes
  echo ""
  echo "in function handleNetwork"
  echo "NETWORK=$NETWORK"
  echo "RPC_URL=$RPC_URL"
  echo "DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
  echo "PAUSER_WALLET_ADDRESS=$PAUSER_WALLET_ADDRESS"
  echo ""

  # make sure pauserWallet is registered in this diamond and matches with the private key of the pauser wallet
  DIAMOND_PAUSER_WALLET=$(cast call "$DIAMOND_ADDRESS" "pauserWallet() external returns (address)" --rpc-url "$RPC_URL")

  # compare addresses in lowercase format
  if [[ "$(echo "$DIAMOND_PAUSER_WALLET" | tr '[:upper:]' '[:lower:]')" == "$(echo "$DEPLOYER" | tr '[:upper:]' '[:lower:]')" ]]; then
    echo "pauser wallets equal"
  else
    echo "pauser wallets not equal"
  fi

  # pause the diamond
  local ATTEMPTS=1
  while [ $ATTEMPTS -le $MAX_ATTEMPTS ]; do
    echo ""
    echo "[network: $NETWORK] pausing diamond $DIAMOND_ADDRESS now from PauserWallet: $PAUSER_WALLET_ADDRESS (attempt: $ATTEMPTS)"
    BALANCE_PAUSER_WALLET=$(cast balance "$DIAMOND_PAUSER_WALLET" --rpc-url "$RPC_URL")
    # echo "BALANCE_PAUSER_WALLET: $BALANCE_PAUSER_WALLET"
    # RESULT=$(cast send "$DIAMOND_ADDRESS" "pauseDiamond()" --private-key "$PRIVATE_KEY_PAUSER_WALLET" --rpc-url "$RPC_URL" >/dev/null)
    # RESULT=$(pauseDiamond "$DIAMOND_ADDRESS" "$PRIVATE_KEY_PAUSER_WALLET" "$RPC_URL")
    pauseDiamond "$DIAMOND_ADDRESS" "$PRIVATE_KEY_PAUSER_WALLET" "$RPC_URL"
    RETURN_VALUE=$?
    echo "Return value: $RETURN_VALUE"
    # cast send "$DIAMOND_ADDRESS" "pauseDiamond()" --private-key "$PRIVATE_KEY_PAUSER_WALLET" --rpc-url "$RPC_URL" --gas-limit 800000 >/dev/null

    # check the return code of the last call
    if [ $RETURN_VALUE -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    ATTEMPTS=$((ATTEMPTS + 1)) # increment ATTEMPTS
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all ATTEMPTS
  if [ $ATTEMPTS -gt "$MAX_ATTEMPTS" ]; then
    error "[network: $NETWORK] failed to pause diamond ($DIAMOND_ADDRESS)"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi

  #try to call the diamond
  echo "trying to call the diamond now to see if its paused:"
  OWNER=$(cast call "$DIAMOND_ADDRESS" "owner() external returns (address)" --rpc-url "$RPC_URL")

  # check if last call was successful and throw error if it was (it should not be as we expect the diamond to be paused)
  if [ $? -eq 0 ]; then
    echo "[network: $NETWORK] final pause check failed - please check if the diamond ($DIAMOND_ADDRESS) is paused indeed"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi

  echo "[network: $NETWORK] successfully executed"
  echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
  return 0

}


function main {
  # create array with network/s for which the script should be executed
  local NETWORKS=()

  # loop through networks list and add each network to ARRAY that is not excluded
  # while IFS= read -r line; do
  #   NETWORKS+=("$line")
  # done <"./networks"
    # NETWORKS+=("mainnet")
    NETWORKS+=("polygon" "bsc")

  # send message to DISCORD
  # TODO <<<<<<<<------------------------------------------------------------------------



  PAUSER_WALLET_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  echo "PAUSER_WALLET_ADDRESS1: $PAUSER_WALLET_ADDRESS"

  # go through all networks and start background tasks for each network (to execute in parallel)
  for NETWORK in "${NETWORKS[@]}"; do
      handleNetwork "$NETWORK" "$PAUSER_WALLET_ADDRESS"
  done

  #   # Wait for all background jobs to finish
  # wait

  # # Check exit status of each background job
  # for JOB in `jobs -p`
  # do
  #   wait $JOB || let "RETURN=1"
  # done

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

