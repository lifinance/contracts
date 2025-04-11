#!/bin/bash

#TODO:
# - update script
# - call with ENVIRONMENT
# - add private key distinction

updateERC20Proxy() {
	source .env
  source script/helperFunctions.sh


  local NETWORK=$1
  local ENVIRONMENT=$2

  local RPC_URL=$(getRPCUrl "$NETWORK")

  # get relevant contract addresses from deploy log file
	ERC20PROXY=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "ERC20Proxy" )
	EXECUTOR=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "Executor" )

  if [[ -z "$ERC20PROXY" || -z "$EXECUTOR" ]]; then
    error "Missing address (ERC20Proxy=$ERC20PROXY, Executor=$EXECUTOR)"
    exit 1
  fi

	echo ""
	echo "Setting $EXECUTOR as authorized caller for $ERC20PROXY on $NETWORK..."

	cast send $ERC20PROXY "setAuthorizedCaller(address, bool)" $EXECUTOR true --private-key $PRIVATE_KEY_PRODUCTION --rpc-url "$RPC_URL" --legacy
	echo ""
}


