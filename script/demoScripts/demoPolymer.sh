#!/bin/bash

# Check if required arguments are provided
if [ "$#" -lt 5 ]; then
  echo "Usage: $0 <API_URL> <ADDRESSES_FILE> <FROM_RPC_URL> <TO_RPC_URL> <PRIVATE_KEY>"
  echo "Example: $0 http://localhost:8080 testnet-addresses.json https://sepolia.optimism.io https://sepolia.base.org 0x..."
  exit 1
fi

# Parse command line arguments
API_URL="$1"
ADDRESSES_FILE="$2"
FROM_RPC_URL="$3"
TO_RPC_URL="$4"
PRIVATE_KEY="$5"

# Validate addresses file exists
if [ ! -f "$ADDRESSES_FILE" ]; then
  echo "Error: Addresses file '$ADDRESSES_FILE' not found"
  exit 1
fi

# Query chain IDs from RPC URLs using cast
echo "Querying chain IDs from RPC URLs..."
FROM_CHAIN_ID=$(cast chain-id -r "$FROM_RPC_URL")
TO_CHAIN_ID=$(cast chain-id -r "$TO_RPC_URL")

# Validate that chain IDs were retrieved
if [ -z "$FROM_CHAIN_ID" ]; then
  echo "Error: Failed to retrieve chain ID from $FROM_RPC_URL"
  exit 1
fi

if [ -z "$TO_CHAIN_ID" ]; then
  echo "Error: Failed to retrieve chain ID from $TO_RPC_URL"
  exit 1
fi

echo "From Chain ID: $FROM_CHAIN_ID"
echo "To Chain ID: $TO_CHAIN_ID"
echo ""

# Extract USDC addresses from the addresses file using jq
FROM_TOKEN=$(jq -r ".\"$FROM_CHAIN_ID\".usdc" "$ADDRESSES_FILE")
TO_TOKEN=$(jq -r ".\"$TO_CHAIN_ID\".usdc" "$ADDRESSES_FILE")

# Validate that USDC addresses were found
if [ "$FROM_TOKEN" = "null" ] || [ -z "$FROM_TOKEN" ]; then
  echo "Error: USDC address not found for chain ID $FROM_CHAIN_ID in $ADDRESSES_FILE"
  exit 1
fi

if [ "$TO_TOKEN" = "null" ] || [ -z "$TO_TOKEN" ]; then
  echo "Error: USDC address not found for chain ID $TO_CHAIN_ID in $ADDRESSES_FILE"
  exit 1
fi

# Derive wallet address from private key
USER_ADDRESS=$(cast wallet address "$PRIVATE_KEY")
echo "Wallet Address: $USER_ADDRESS"
echo ""

# Configuration
FROM_AMOUNT="${FROM_AMOUNT:-1000000}"

# Query and log USDC balances before transaction
echo "==================== Balances Before Transaction ===================="
FROM_BALANCE_BEFORE=$(cast call "$FROM_TOKEN" "balanceOf(address)(uint256)" "$USER_ADDRESS" -r "$FROM_RPC_URL")
TO_BALANCE_BEFORE=$(cast call "$TO_TOKEN" "balanceOf(address)(uint256)" "$USER_ADDRESS" -r "$TO_RPC_URL")
echo "From Chain ($FROM_CHAIN_ID) USDC Balance: $FROM_BALANCE_BEFORE"
echo "To Chain ($TO_CHAIN_ID) USDC Balance:     $TO_BALANCE_BEFORE"
echo "====================================================================="
echo ""

echo "Fetching calldata from CCTP service..."
echo "From Chain: $FROM_CHAIN_ID -> To Chain: $TO_CHAIN_ID"
echo "Amount: $FROM_AMOUNT"
echo ""

# Step 1: Get routes
echo "Step 1: Getting available routes..."
ROUTES_RESPONSE=$(curl -s -X POST "${API_URL}/v1/routes" \
  -H "Content-Type: application/json" \
  -d "{
    \"fromChainId\": ${FROM_CHAIN_ID},
    \"toChainId\": ${TO_CHAIN_ID},
    \"fromTokenAddress\": \"${FROM_TOKEN}\",
    \"toTokenAddress\": \"${TO_TOKEN}\",
    \"fromAmount\": \"${FROM_AMOUNT}\",
    \"fromAddress\": \"${USER_ADDRESS}\",
    \"toAddress\": \"${USER_ADDRESS}\"
  }")

# Check if routes request failed
if echo "$ROUTES_RESPONSE" | grep -q "error"; then
  echo "Error fetching routes:"
  echo "$ROUTES_RESPONSE" | jq .
  exit 1
fi

echo response gotten: $ROUTES_RESPONSE

# Extract the first route and its first step
FIRST_STEP=$(echo "$ROUTES_RESPONSE" | jq -r '.routes[0].steps[0]')

if [ "$FIRST_STEP" = "null" ]; then
  echo "No routes found"
  exit 1
fi

echo "✓ Routes retrieved successfully"
echo ""

# Step 2: Get transaction calldata for the step
echo "Step 2: Getting transaction calldata..."
STEP_TX_RESPONSE=$(curl -s -X POST "${API_URL}/v1/stepTransaction" \
  -H "Content-Type: application/json" \
  -d "$FIRST_STEP")

# Check if step transaction request failed
if echo "$STEP_TX_RESPONSE" | grep -q "error"; then
  echo "Error fetching step transaction:"
  echo "$STEP_TX_RESPONSE" | jq .
  exit 1
fi

echo "✓ Transaction calldata retrieved successfully"
echo ""

# Extract transaction details
TX_TO=$(echo "$STEP_TX_RESPONSE" | jq -r '.transactionRequest.to')
TX_DATA=$(echo "$STEP_TX_RESPONSE" | jq -r '.transactionRequest.data')
TX_CHAIN_ID=$(echo "$STEP_TX_RESPONSE" | jq -r '.transactionRequest.chainId')
TX_GAS_LIMIT=$(echo "$STEP_TX_RESPONSE" | jq -r '.transactionRequest.gasLimit')

# Step 3: Submit the transaction
echo "Step 3: Submitting transaction..."
echo "To Address:  $TX_TO"
echo "Gas Limit:   $TX_GAS_LIMIT"
echo ""

TX_HASH=$(cast send "$TX_TO" \
  --private-key "$PRIVATE_KEY" \
  --gas-limit "$TX_GAS_LIMIT" \
  --rpc-url "$FROM_RPC_URL" \
  "$TX_DATA" | grep "transactionHash" | awk '{print $2}')

if [ -z "$TX_HASH" ]; then
  echo "Error: Transaction submission failed"
  exit 1
fi

echo "✓ Transaction submitted successfully"
echo "Transaction Hash: $TX_HASH"
echo ""

# Wait for transaction to be mined
echo "Waiting for transaction to be mined..."
cast receipt "$TX_HASH" --rpc-url "$FROM_RPC_URL" > /dev/null 2>&1
echo "✓ Transaction mined"
echo ""

# Step 4: Monitor CCTP transfer status
echo "Step 4: Monitoring CCTP transfer status..."
MAX_RETRIES=60
RETRY_INTERVAL=10
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  STATUS_RESPONSE=$(curl -s -X GET "${API_URL}/v1/status/${TX_HASH}")

  STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.status')
  SUBSTATUS=$(echo "$STATUS_RESPONSE" | jq -r '.substatus')
  SUBSTATUS_MESSAGE=$(echo "$STATUS_RESPONSE" | jq -r '.substatusMessage')

  echo "Status: $STATUS | Substatus: $SUBSTATUS"

  if [ "$STATUS" = "DONE" ]; then
    echo "✓ CCTP transfer completed successfully"
    echo ""
    break
  elif [ "$STATUS" = "FAILED" ] || [ "$STATUS" = "INVALID" ]; then
    echo "✗ CCTP transfer failed: $SUBSTATUS_MESSAGE"
    echo "Full response:"
    echo "$STATUS_RESPONSE" | jq .
    exit 1
  elif [ "$STATUS" = "PENDING" ] || [ "$STATUS" = "NOT_FOUND" ]; then
    echo "  Message: $SUBSTATUS_MESSAGE"
    echo "  Waiting ${RETRY_INTERVAL}s before next check..."
    sleep $RETRY_INTERVAL
    RETRY_COUNT=$((RETRY_COUNT + 1))
  else
    echo "  Unknown status: $STATUS"
    sleep $RETRY_INTERVAL
    RETRY_COUNT=$((RETRY_COUNT + 1))
  fi
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
  echo "✗ Timeout: CCTP transfer did not complete within the expected time"
  exit 1
fi

# Query and log USDC balances after transaction
echo "==================== Balances After Transaction ====================="
FROM_BALANCE_AFTER=$(cast call "$FROM_TOKEN" "balanceOf(address)(uint256)" "$USER_ADDRESS" -r "$FROM_RPC_URL")
TO_BALANCE_AFTER=$(cast call "$TO_TOKEN" "balanceOf(address)(uint256)" "$USER_ADDRESS" -r "$TO_RPC_URL")
echo "From Chain ($FROM_CHAIN_ID) USDC Balance: $FROM_BALANCE_AFTER"
echo "To Chain ($TO_CHAIN_ID) USDC Balance:     $TO_BALANCE_AFTER"
echo "====================================================================="
echo ""
