#!/bin/bash

updateERC20Proxy() {
	source .env
  source script/helperFunctions.sh

  local NETWORK=$1
  local ENVIRONMENT=$2

  local RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  ERC20PROXY=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "ERC20Proxy" )
	EXECUTOR=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "Executor" )

  if [[ -z "$ERC20PROXY" || -z "$EXECUTOR" ]]; then
    error "Missing address (ERC20Proxy=$ERC20PROXY, Executor=$EXECUTOR)"
    exit 1
  fi

	echo ""
	echo "Verifying Executor authorization in ERC20Proxy on $NETWORK..."

  local IS_AUTHORIZED
  IS_AUTHORIZED=$(universalCast "call" "$NETWORK" "$ERC20PROXY" "authorizedCallers(address)(bool)" "$EXECUTOR")

  if [[ "$IS_AUTHORIZED" == "true" ]]; then
    echo "[info] Executor is already authorized in ERC20Proxy"
  else
    error "Executor is not authorized in ERC20Proxy (ERC20Proxy=$ERC20PROXY, Executor=$EXECUTOR)"
    error "New deployments (ERC20Proxy >= 1.2.0) pre-authorize Executor at deploy time via predicted CREATE3 address."
    error "For legacy deployments, refundWallet must call setAuthorizedCaller(executor, true) on ERC20Proxy."
    exit 1
  fi

	echo ""
}

