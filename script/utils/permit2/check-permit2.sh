#!/bin/bash

# Require: <rpc_url> <chainId> [permit2Address]
if [ $# -lt 2 ]; then
  echo "Usage: $0 <rpc_url> <chainId> [permit2Address]"
  exit 1
fi

RPC_URL="$1"
CHAIN_ID="$2"
ADDRESS="$3"
# Run Permit2Code to get the bytecode
CODE=$(forge script Permit2Code --sig "getCode(uint256)" "$CHAIN_ID" \
  | grep -oE 'bytes 0x[0-9a-fA-F]+' \
  | sed 's/bytes //')

# Check if address was provided
if [ -z "$ADDRESS" ]; then
  # Only chainId: run checkCode with code only
  forge script Permit2Check --sig "checkCode(bytes)" "$CODE" --rpc-url $RPC_URL -vvvv
else
  # Both chainId and address: run checkCode with address and code
  forge script Permit2Check --sig "checkCode(address,bytes)" "$ADDRESS" "$CODE" --rpc-url $RPC_URL -vvvv
fi
