#!/bin/bash

# load script
source script/helperFunctions.sh

# Require argument: <network>
if [ $# -lt 1 ]; then
  echo "Usage: $0 <network>"
  exit 1
fi

NETWORK="$1"

export NETWORKS_JSON_FILE_PATH="config/networks.json"

# Get RPC URL and chain ID for given network
RPC_URL=$(getRPCUrl "$NETWORK")
if [ -z "$RPC_URL" ]; then
  echo "[error] Could not find RPC URL for network '$NETWORK' in .env"
  exit 1
fi

CHAIN_ID=$(getChainId "$NETWORK")
if [ -z "$CHAIN_ID" ]; then
  echo "[error] Could not find chainId for network '$NETWORK' in networks.json"
  exit 1
fi


# read Permit2 address to be verified from permit2proxy.json
CONFIG_FILE_NAME="permit2Proxy.json"
ADDRESS=$(readJsonValueFromConfigFile "$CONFIG_FILE_NAME" ".$NETWORK")

if [ -z "$ADDRESS" ]; then
  echo "[error] No permit2 address found for network '$NETWORK' in $CONFIG_FILE_NAME"
  exit 1
fi

# Run Permit2Code to get the bytecode
CODE=$(forge script Permit2Code --sig "getCode(uint256)" "$CHAIN_ID" \
  | grep -oE 'bytes 0x[0-9a-fA-F]+' \
  | sed 's/bytes //')


# compare expected bytecode with actual bytecode at given address
forge script Permit2Check --sig "checkCode(address,bytes)" "$ADDRESS" "$CODE" --rpc-url "$RPC_URL" -vvvv
