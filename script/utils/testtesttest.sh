#!/bin/bash

# this script is designed to be called by a Github action
# it can only pause the main PROD diamond on all networks
# for all other actions the diamondEMERGENCYPause.sh script should be called
# via scriptMaster.sh in local CLI for more flexibility


# load helper functions
source ./script/helperFunctions.sh

DIAMOND_IS_PAUSED_SELECTOR="0x0149422e"

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
  echo "RPC_KEY"
  echo $RPC_KEY
}

function main {
  # create array with network/s for which the script should be executed
  local NETWORKS=()

  # loop through networks.json list and add each network to ARRAY that is not excluded
  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
  while IFS= read -r network; do
    NETWORKS+=("$network")
  done < <(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH")

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
}

# call main function with all parameters the script was called with
main "$@"

