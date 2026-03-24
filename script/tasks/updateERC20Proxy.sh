#!/bin/bash

#TODO:
# - update script
# - add private key distinction

updateERC20Proxy() {
	source .env
  source script/helperFunctions.sh


  local NETWORK=$1
  local ENVIRONMENT=$2

  local RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  # get relevant contract addresses from deploy log file
	ERC20PROXY=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "ERC20Proxy" )
	EXECUTOR=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "Executor" )

  if [[ -z "$ERC20PROXY" || -z "$EXECUTOR" ]]; then
    error "Missing address (ERC20Proxy=$ERC20PROXY, Executor=$EXECUTOR)"
    exit 1
  fi

	echo ""
	echo "Setting $EXECUTOR as authorized caller for $ERC20PROXY on $NETWORK..."

	universalCast "send" "$NETWORK" "$ENVIRONMENT" "$ERC20PROXY" "setAuthorizedCaller(address,bool)" "$EXECUTOR true"
	echo ""
}


