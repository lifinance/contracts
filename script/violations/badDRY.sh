#!/bin/bash

# VIOLATION: Duplicate code - should be extracted to function
NETWORK="ethereum"
CONTRACT="0x123"

# First occurrence
if [[ "$NETWORK" == "tron" ]]; then
    troncast call "$CONTRACT" "owner()"
else
    cast call "$CONTRACT" "owner()"
fi

# Second occurrence - exact duplicate
if [[ "$NETWORK" == "tron" ]]; then
    troncast call "$CONTRACT" "owner()"
else
    cast call "$CONTRACT" "owner()"
fi

# VIOLATION: Not using existing helpers from helperFunctions.sh
# Reimplementing functionality that already exists
function myOwnCheckFailure() {
    if [[ $? -ne 0 ]]; then
        echo "Command failed"
        exit 1
    fi
}

# VIOLATION: Not using universalCast - reimplementing routing
function myCallFunction() {
    local network=$1
    local contract=$2
    local method=$3
    
    if [[ "$network" == "tron" ]]; then
        troncast call "$contract" "$method"
    else
        cast call "$contract" "$method"
    fi
}

# VIOLATION: Not sourcing playgroundHelpers.sh and reimplementing logging
function myDebug() {
    echo "[DEBUG] $1"
}

function myError() {
    echo "[ERROR] $1" >&2
}

# VIOLATION: Duplicate validation logic
address1="0x123"
if [[ "$address1" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "Valid EVM address"
fi

address2="0x456"
if [[ "$address2" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "Valid EVM address"
fi

# VIOLATION: Not checking if getRPCUrl exists before reimplementing
function getMyRpcUrl() {
    local network=$1
    case "$network" in
        ethereum) echo "https://eth.llamarpc.com" ;;
        arbitrum) echo "https://arb1.arbitrum.io/rpc" ;;
        *) echo "Unknown network" ;;
    esac
}

# VIOLATION: Triple duplicate - should extract to function immediately
echo "Deploying to $NETWORK"
forge create Contract --rpc-url "$RPC_URL"

echo "Deploying to $NETWORK"
forge create Contract --rpc-url "$RPC_URL"

echo "Deploying to $NETWORK"
forge create Contract --rpc-url "$RPC_URL"
