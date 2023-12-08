#!/bin/bash

#TODO:
# - update script
# - call with ENVIRONMENT
# - add private key distinction

updateERC20Proxy() {
  source .env

  echo "here"
  read
  if [[ -z "$PRODUCTION" ]]; then
    FILE_SUFFIX="staging."
  fi

  NETWORK=$(cat ./networks | gum filter --placeholder "Network...")
  echo $RPC
  ERC20PROXY=$(jq -r '.ERC20Proxy' "./deployments/$NETWORK.${FILE_SUFFIX}json")
  EXECUTOR=$(jq -r '.Executor' "./deployments/$NETWORK.${FILE_SUFFIX}json")

  echo "Setting $EXECUTOR as authorized caller for $ERC20PROXY on $NETWORK..."

  NETWORK_UPPER=$(tr '[:lower:]' '[:upper:]' <<<$NETWORK)
  RPC="ETH_NODE_URI_$NETWORK_UPPER"

  cast send $ERC20PROXY "setAuthorizedCaller(address, bool)" $EXECUTOR true --account $PRIVATE_KEY --rpc-url "${!RPC}" --legacy
}
