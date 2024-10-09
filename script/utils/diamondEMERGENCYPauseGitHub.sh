#!/bin/bash

# this script is designed to be called by a Github action
# it can only pause the main PROD diamond on all networks
# for all other actions the diamondEMERGENCYPause.sh script should be called
# via scriptMaster.sh in local CLI for more flexibility
#   FunctionDoesNotExist.selector: 0xa9ad62f8
#   DiamondIsPaused.selector: 0x0149422e


# load helper functions
source ./script/helperFunctions.sh

DIAMOND_IS_PAUSED_SELECTOR="0x0149422e"
FUNCTION_DOES_NOT_EXIST_SELECTOR="0xa9ad62f8"

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
  PRIV_KEY_ADDRESS=$(cast wallet address "$PRIVATE_KEY")

  # get RPC URL for given network
  RPC_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

  # Use eval to read the environment variable named like the RPC_KEY (our normal syntax like 'RPC_URL=${!RPC_URL}' doesnt work on Github)
  eval "RPC_URL=\$$(echo "$RPC_KEY" | tr '-' '_')"

  # make sure RPC_URL is available
  if [[ -z "$RPC_URL" ]]; then
    error "[network: $NETWORK] could not find RPC_URL for this network in Github secrets (key: $RPC_KEY). Cannot continue."
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  else
    echo "[network: $NETWORK] RPC URL found"
  fi

  # get diamond address for this network
  # DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond")
  DIAMOND_ADDRESS="0xD3b2b0aC0AFdd0d166a495f5E9fca4eCc715a782"  # TODO: remove <<<<<<<<<---------------------------------------------------------------------------------------- (STAGING DIAMOND ON POL, ARB, OPT)
  if [[ $? -ne 0 ]]; then
    error "[network: $NETWORK] could not find diamond address in PROD deploy log. Cannot continue for this network."
    return 1
  else
    echo "[network: $NETWORK] diamond address found in deploy log file: $DIAMOND_ADDRESS"
  fi

  # check if the diamond is already paused by calling owner() function and analyzing the response
  local RESPONSE=$(cast call "$DIAMOND_ADDRESS" "owner()" --rpc-url "$RPC_URL")
  if [[ "$RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* || "$RESPONSE" == *"DiamondIsPaused"* ]]; then
      success "[network: $NETWORK] The diamond is already paused."
      echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
      exit 0
  fi

  # ensure PauserWallet has positive balance
  BALANCE_PAUSER_WALLET=$(cast balance "$PRIV_KEY_ADDRESS" --rpc-url "$RPC_URL")
  if [[ "$BALANCE_PAUSER_WALLET" == 0 ]]; then
    error "[network: $NETWORK] PauserWallet has no balance. Cannot continue"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  else
    echo "[network: $NETWORK] balance pauser wallet: $BALANCE_PAUSER_WALLET"
  fi

  # this fails currently since the EmergencyPauseFacet is not yet deployed to all diamonds
  DIAMOND_PAUSER_WALLET=$(cast call "$DIAMOND_ADDRESS" "pauserWallet() external returns (address)" --rpc-url "$RPC_URL")

  # compare addresses in lowercase format
  if [[ "$(echo "$DIAMOND_PAUSER_WALLET" | tr '[:upper:]' '[:lower:]')" != "$(echo "$PRIV_KEY_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]]; then
    error "[network: $NETWORK] The private key in PRIVATE_KEY_PAUSER_WALLET (address: $PRIV_KEY_ADDRESS) on Github does not match with the registered PauserWallet in the diamond ($DIAMOND_PAUSER_WALLET)"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  else
    echo "[network: $NETWORK] registered pauser wallet matches with stored private key (= ready to execute)"
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
  OWNER=$(cast call "$DIAMOND_ADDRESS" "owner() external returns (address)" --rpc-url "$RPC_URL")

  # check if last call was successful and throw error if it was (it should not be successful, we expect the diamond to be paused now)
  if [ $? -eq 0 ]; then
    error "[network: $NETWORK] final pause check failed - please check the status of diamond ($DIAMOND_ADDRESS) manually"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  else
    success "[network: $NETWORK] diamond ($DIAMOND_ADDRESS) successfully paused"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 0
  fi
}

function printStatus() {
  local NETWORK="$1"

  # get RPC URL for given network
  local RPC_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"
  # Use eval to read the environment variable named like the RPC_KEY (our normal syntax like 'RPC_URL=${!RPC_URL}' doesnt work on Github)
  eval "RPC_URL=\$$(echo "$RPC_KEY" | tr '-' '_')"

    # skip any non-prod networks
  case "$NETWORK" in
    "bsc-testnet" | "localanvil" | "sepolia" | "mumbai" | "lineatest")
      echo "skipping $NETWORK (Testnet)"
      return 0
      ;;
  esac

  # get diamond address for this network
  # DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond")
  DIAMOND_ADDRESS="0xD3b2b0aC0AFdd0d166a495f5E9fca4eCc715a782"  # TODO: remove <<<<<<<<<---------------------------------------------------------------------------------------- (STAGING DIAMOND ON POL, ARB, OPT)

  # check if the diamond is paused by calling owner() function and analyzing the response
  local RESPONSE=$(cast call "$DIAMOND_ADDRESS" "owner()" --rpc-url "$RPC_URL")
  if [[ "$RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* || "$RESPONSE" == *"DiamondIsPaused"* ]]; then
      success "[network: $NETWORK] The diamond is paused."
      exit 0
  else
      error "[network: $NETWORK] The diamond is not paused."
      exit 1
  else

  fi
}

function main {
  # create array with network/s for which the script should be executed
  local NETWORKS=()

  # loop through networks list and add each network to ARRAY that is not excluded
  # while IFS= read -r line; do
  #   NETWORKS+=("$line")
  # done <"./networks"
  NETWORKS=("arbitrum" "polygon" "optimism") # TODO: remove <<<<<<<<<---------------------------------------------------------------------------------------- (WILL MAKE SURE THAT THE TEST RUNS ONLY ON THREE

  echo "networks found: ${NETWORKS[@]}"

  PRIV_KEY_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  echo "Address PauserWallet: $PRIV_KEY_ADDRESS"
  echo "Networks will be executed in parallel, therefore the log might appear messy."
  echo "Watch out for red and green colored entries as they mark endpoints of each network thread"
  echo "A summary will be printed after all jobs/networks have been completed"

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

  # run through all networks to print a easy-to-read summary
  for NETWORK in "${NETWORKS[@]}"; do
      echo "-------------------------------------------------------------------------------------"
      echo "--------------------------------ALL JOBS DONE----------------------------------------"
      echo "-------------------------------------------------------------------------------------"
      echo "[info] all jobs completed, now going through all networks again to print their status"
      printStatus "$NETWORK" &
  done

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script diamondEMERGENCYPause completed"
}

# call main function with all parameters the script was called with
main "$@"

