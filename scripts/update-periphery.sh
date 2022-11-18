#!/bin/bash
source .env


load() {

NETWORK=$(cat ./networks | gum filter --placeholder "Network")

ADDRS="deployments/$NETWORK.json"

DIAMOND=$(jq -r '.LiFiDiamond' $ADDRS)
ERC20PROXY=$(jq -r '.ERC20Proxy // "0x"' $ADDRS)
AXELAREXECUTOR=$(jq -r '.AxelarExecutor // "0x"' $ADDRS)
EXECUTOR=$(jq -r '.Executor // "0x"' $ADDRS)
RECEIVER=$(jq -r '.Receiver // "0x"' $ADDRS)
FEECOLLECTOR=$(jq -r '.FeeCollector // "0x"' $ADDRS)

echo "Diamond: $DIAMOND"

if [ "$ERC20PROXY" != "0x" ]; then
  echo "Updating ERC20Proxy $ERC20PROXY"
  register $NETWORK $DIAMOND 'ERC20Proxy' $ERC20PROXY
fi

if [ "$AXELAREXECUTOR" != "0x" ]; then
  echo "Updating AxelarExecutor $AXELAREXECUTOR"
  register $NETWORK $DIAMOND 'AxelarExecutor' $AXELAREXECUTOR
fi

if [ "$EXECUTOR" != "0x" ]; then
  echo "Updating Executor $EXECUTOR"
  register $NETWORK $DIAMOND 'Executor' $EXECUTOR
fi

if [ "$RECEIVER" != "0x" ]; then
  echo "Updating Receiver $RECEIVER"
  register $NETWORK $DIAMOND 'Receiver' $RECEIVER
fi

if [ "$FEECOLLECTOR" != "0x" ]; then
  echo "Updating FeeCollector $FEECOLLECTOR"
  register $NETWORK $DIAMOND 'FeeCollector' $FEECOLLECTOR
fi
}

register() {
	NETWORK=$(tr '[:lower:]' '[:upper:]' <<< $1)
  DIAMOND=$2
  NAME=$3
  ADDR=$4
  RPC="ETH_NODE_URI_$NETWORK"

  cast send $DIAMOND 'registerPeripheryContract(string,address)' "$NAME" "$ADDR" --private-key $PRIVATE_KEY --rpc-url "${!RPC}" --legacy
}

load
