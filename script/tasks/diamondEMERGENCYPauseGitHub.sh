#!/bin/bash

# this script is designed to be called by a Github action
# it can only pause the main PROD diamond on all networks
# for all other actions the diamondEMERGENCYPause.sh script should be called
# via scriptMaster.sh in local CLI for more flexibility

# load helper functions
source ./script/helperFunctions.sh


# the number of attempts the script will max try to execute the pause transaction
MAX_ATTEMPTS=10


# Define function to handle each network operation
function handleNetwork() {
  echo ""
  echo ">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start network $1 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>"
  local NETWORK=$1
  local PRIVATE_KEY=$2


  # skip any non-prod networks
  case "$NETWORK" in
    "bsc-testnet" | "localanvil" | "sepolia" | "mumbai" | "lineatest")
      echo "skipping $NETWORK (Testnet)"
      return 0
      ;;
  esac

  # convert the provided private key of the pauser wallet (from github) to an address
  PRIV_KEY_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")

  # get RPC URL for given network
  RPC_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

  echo "[network: $NETWORK] getting RPC_URL from Github secrets"
  # Use eval to read the environment variable named like the RPC_KEY (our normal syntax like 'RPC_URL=${!RPC_URL}' doesnt work on Github)
  eval "RPC_URL=\$$(echo "$RPC_KEY" | tr '-' '_')"

  # make sure RPC_URL is available
  if [[ -z "$RPC_URL" ]]; then
    error "[network: $NETWORK] could not find RPC_URL for this network in Github secrets (key: $RPC_KEY). Cannot continue."
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi

  # ensure PauserWallet has positive balance
  echo "[network: $NETWORK] checking balance of pauser wallet ($PRIV_KEY_ADDRESS)"
  BALANCE_PAUSER_WALLET=$(cast balance "$PRIV_KEY_ADDRESS" --rpc-url "$RPC_URL")
  echo "[network: $NETWORK] balance pauser wallet: $BALANCE_PAUSER_WALLET"
  if [[ "$BALANCE_PAUSER_WALLET" == 0 ]]; then
    error "[network: $NETWORK] PauserWallet has no balance. Cannot continue"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi

  # get diamond address for this network
  echo "[network: $NETWORK] getting diamond address from deploy log files"
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond")
  # DIAMOND_ADDRESS="0xbEbCDb5093B47Cd7add8211E4c77B6826aF7bc5F"  # TODO: remove <<<<<<<<<---------------------------
  if [[ $? -ne 0 ]]; then
    error "[network: $NETWORK] could not find diamond address in PROD deploy log. Cannot continue for this network."
    return 1
  fi

  echo "[network: $NETWORK] matching registered pauser wallet $PRIV_KEY_ADDRESS in diamond ($DIAMOND_ADDRESS) with private key supplied"
  # this fails currently since the EmergencyPauseFacet is not yet deployed to all diamonds
  DIAMOND_PAUSER_WALLET=$(cast call "$DIAMOND_ADDRESS" "pauserWallet() external returns (address)" --rpc-url "$RPC_URL")

  # compare addresses in lowercase format
  if [[ "$(echo "$DIAMOND_PAUSER_WALLET" | tr '[:upper:]' '[:lower:]')" != "$(echo "$PRIV_KEY_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]]; then
    error "[network: $NETWORK] The private key in PRIVATE_KEY_PAUSER_WALLET (address: $PRIV_KEY_ADDRESS) on Github does not match with the registered PauserWallet in the diamond ($DIAMOND_PAUSER_WALLET)"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi

  # repeatedly try to pause the diamond until it's done (or attempts are exhausted)
  local ATTEMPTS=1
  while [ $ATTEMPTS -le $MAX_ATTEMPTS ]; do
    echo ""
    echo "[network: $NETWORK] pausing diamond $DIAMOND_ADDRESS now from PauserWallet: $PRIV_KEY_ADDRESS (attempt: $ATTEMPTS)"
    echo ""
    cast send "$DIAMOND_ADDRESS" "pauseDiamond()" --private-key "$PRIVATE_KEY_PAUSER_WALLET" --rpc-url "$RPC_URL" --legacy

    # check the return code of the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    ATTEMPTS=$((ATTEMPTS + 1)) # increment attempts
    sleep 3                    # wait for 3 seconds before trying the operation again
  done

  # check if call was executed successfully or used all attempts
  if [ $ATTEMPTS -gt "$MAX_ATTEMPTS" ]; then
    error "[network: $NETWORK] failed to pause diamond ($DIAMOND_ADDRESS)"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi

  # try to call the diamond
  echo "trying to call the diamond now to see if it's actually paused:"
  OWNER=$(cast call "$DIAMOND_ADDRESS" "owner() external returns (address)" --rpc-url "$RPC_URL")

  # check if last call was successful and throw error if it was (it should not be successful, we expect the diamond to be paused now)
  if [ $? -eq 0 ]; then
    error "[network: $NETWORK] final pause check failed - please check the status of diamond ($DIAMOND_ADDRESS) manually"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi

  success "[network: $NETWORK] diamond ($DIAMOND_ADDRESS) successfully paused"
  echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
  return 0
}


function main {
  # create array with network/s for which the script should be executed
  local NETWORKS=()

  # loop through networks list and add each network to ARRAY that is not excluded
  while IFS= read -r line; do
    NETWORKS+=("$line")
  done <"./networks"
  # NETWORKS=("bsc" "polygon")

  echo "networks found: $NETWORKS"

  PRIV_KEY_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  echo "Address PauserWallet: $PRIV_KEY_ADDRESS"


  # go through all networks and start background tasks for each network (to execute in parallel)
  RETURN=0
  for NETWORK in "${NETWORKS[@]}"; do
      handleNetwork "$NETWORK" "$PRIVATE_KEY_PAUSER_WALLET" &
  done

  # Wait for all background jobs to finish
  wait
  # Check exit status of each background job
  for JOB in $(jobs -p); do
    wait $JOB || RETURN=1
  done

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script diamondEMERGENCYPause completed"
}

# call main function with all parameters the script was called with
main "$@"

