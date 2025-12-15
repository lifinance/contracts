#!/usr/bin/env bash

## Load env
source .env

# This script is created to assist with throughput testing of Pioneer through the LI.FI diamond.

# Get from network.
NETWORK=$1  # "optimism"
# Get to networks
TO_NETWORKS=$2  # ["optimism", "arbitrum", "polygon"]
# Get the token
TOKEN=$3  # 0x...
NUM_TRANSACTIONS=$4 # 10

# Convert network to lowercase
NETWORK=$(echo $NETWORK | tr '[:upper:]' '[:lower:]')
UPPER_NETWORK=$(echo $NETWORK | tr '[:lower:]' '[:upper:]')

# Get the diamond address for the network (stored at ./deployments/<network>.json)
DEPLOY_FILE="./deployments/${NETWORK}.staging.json"
test -f "$DEPLOY_FILE" || { echo "Missing $DEPLOY_FILE"; exit 1; }
DIAMOND=$(jq -r '.LiFiDiamond' "$DEPLOY_FILE")
echo "Using LiFi Diamond at $DIAMOND"

# Get the RPC_URL for the network ($ETH_NODE_URI_<NETWORK>)
RPC_ENV="ETH_NODE_URI_${UPPER_NETWORK}"
RPC_URL=$(eval "echo \${$RPC_ENV:-}")
[ -n "$RPC_URL" ] || { echo "Missing $RPC_ENV"; exit 1; }

# Get from network id.
FROM_NETWORK_ID=$(cast chain-id --rpc-url "$RPC_URL")

# Convert to_networks to array of ids.
TO_NETWORKS_IDS=()
for NET in $(echo $TO_NETWORKS | tr -d '[]"' | tr ',' '\n');
do
  UPPER_NET=$(echo "$NET" | tr '[:lower:]' '[:upper:]')
  NET_RPC_ENV="ETH_NODE_URI_${UPPER_NET}"
  NET_RPC=$(eval "echo \${$NET_RPC_ENV:-}")
  [ -n "$NET_RPC" ] || { echo "Missing $NET_RPC_ENV"; exit 1; }
  NET_ID=$(cast chain-id --rpc-url "$NET_RPC")
  TO_NETWORKS_IDS+=("$NET_ID")
done

[[ -n "${PRIVATE_KEY:-}" ]] || { echo "Missing PRIVATE_KEY in env" >&2; exit 1; }
# Compute the user's address
USER_ADDRESS=$(cast wallet address $PRIVATE_KEY)

# Assert that the token is address(0)
ADDRESS_0=$(cast address-zero)
if [ "$TOKEN" != "$ADDRESS_0" ]; then
  echo "This script only supports the native token (address(0))."
  exit 1
fi

# # Get the balance of the user of the tokens.
USER_BALANCE=$(cast balance $USER_ADDRESS --rpc-url $RPC_URL)
# Divide user balance by 10
USER_BALANCE=$((USER_BALANCE / 10))

# Compute the amount we want to use, 10000000000000000 or user balance / 10 whatever is smallest.
OP_AMOUNT=100000000000000000
if [ "$USER_BALANCE" -lt "$OP_AMOUNT" ]; then
  OP_AMOUNT=$USER_BALANCE
fi
echo "Operating Amount: $OP_AMOUNT"
[ "$OP_AMOUNT" -gt 0 ] || { echo "OP_AMOUNT computed as 0"; exit 1; }

# Collect quotes from Pioneer
# Initialize an empty array to hold responses
RESPONSES=()
# Enter a for loop to perform multiple transactions
for i in $(seq 1 $NUM_TRANSACTIONS);
do
  echo "Processing transaction $i of $NUM_TRANSACTIONS..."

  # Generate a random 32-byte transaction ID (hex string)
  TRANSACTION_ID="0x$(openssl rand -hex 32)"

  # Prepare query parameters
  FROM_CHAIN="$FROM_NETWORK_ID"
  FROM_TOKEN="$TOKEN"
  TO_TOKEN="$TOKEN"
  TO_ADDRESS="$USER_ADDRESS"
  # Divide the OP_AMOUNT by number of operations
  FROM_AMOUNT=$(($OP_AMOUNT / $NUM_TRANSACTIONS))
  [ "$FROM_AMOUNT" -gt 0 ] || { echo "Per-tx FROM_AMOUNT computed as 0" >&2; exit 1; }
  SLIPPAGE="0"
  EXTERNAL_ID="$TRANSACTION_ID"

  # Select random to_chain
  TO_CHAIN=${TO_NETWORKS_IDS[$(($RANDOM % ${#TO_NETWORKS_IDS[@]}))]}

  # Construct query string
  QUERY_STRING="fromChain=$FROM_CHAIN&toChain=$TO_CHAIN&fromToken=$FROM_TOKEN&toToken=$TO_TOKEN&toAddress=$TO_ADDRESS&fromAmount=$FROM_AMOUNT&slippage=$SLIPPAGE&externalId=$EXTERNAL_ID"

  echo $QUERY_STRING

  # Set the Pioneer endpoint
  PIONEER_ENDPOINT="https://solver-dev.li.fi"

  # Fetch quote from Pioneer
  RESPONSE=$(curl -s -G "$PIONEER_ENDPOINT/quote?$QUERY_STRING" -H "Content-Type: application/json")

  echo "$PIONEER_ENDPOINT/quote?$QUERY_STRING"
  echo "Response: $RESPONSE"

  # # Check if the response is valid
  if [ -z "$RESPONSE" ] || echo "$RESPONSE" | grep -q '"error"'; then
    echo "Quote request failed: $RESPONSE"
    exit 1
  fi

  # Extract necessary fields from the response
  TO_CHAIN_ID=$(echo "$RESPONSE" | jq -r '.toChainId')

  RESPONSES+=("$(echo "$TRANSACTION_ID, $TOKEN, $USER_ADDRESS, $FROM_AMOUNT, $TO_CHAIN_ID")")
done

echo "All quote responses collected."
echo "${RESPONSES[@]}";

# Convert RESPONSES array into a flattened string for the script
FLATTENED_RESPONSES=$(printf "(%s)," "${RESPONSES[@]}")
FLATTENED_RESPONSES="[${FLATTENED_RESPONSES%,}]"

# Execute transactions:
forge script PioneerQA --sig "run(address,address,(bytes32,address,address,uint256,uint256)[])" "$DIAMOND" "$USER_ADDRESS" "$FLATTENED_RESPONSES" --private-key "$PRIVATE_KEY" --rpc-url "$RPC_URL" --broadcast -vvvv