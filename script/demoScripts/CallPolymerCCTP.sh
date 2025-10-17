#!/bin/bash

# Exit on error
set -e

# Color codes for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to display usage
usage() {
    echo "Usage: $0 <RPC_URL> <PRIVATE_KEY> <DESTINATION_DOMAIN> <ADDRESSES_FILE>"
    echo ""
    echo "Required arguments:"
    echo "  RPC_URL              RPC endpoint URL"
    echo "  PRIVATE_KEY          Private key for deployment"
    echo "  DESTINATION_DOMAIN   Destination domain for CCTP bridge"
    echo "  ADDRESSES_FILE       Path to addresses json"
    echo ""
    echo "Example:"
    echo "  $0 https://arb-sepolia.g.alchemy.com/v2/KEY 0xYOURKEY 3 ./testnet-addresses.json"
    exit 1
}

# Check if we have the required number of arguments
if [ $# -lt 4 ]; then
    echo -e "${RED}Error: Missing required arguments${NC}\n"
    usage
fi

# Parse positional arguments
RPC_URL="$1"
PRIVATE_KEY="$2"
DESTINATION_DOMAIN="$3"
ADDRESSES_FILE="$4"

# Get chain ID from RPC
echo -e "${BLUE}Fetching chain ID from RPC...${NC}"
if ! CHAIN_ID=$(cast chain-id -r "$RPC_URL" 2>&1); then
    echo -e "${RED}Error: cast chain-id failed for $RPC_URL${NC}"
    echo "$CHAIN_ID"
    exit 1
fi
if [ -z "$CHAIN_ID" ]; then
    echo -e "${RED}Error: Could not fetch chain ID from RPC${NC}"
    exit 1
fi
echo -e "${GREEN}Chain ID: $CHAIN_ID${NC}"

# Read DIAMOND_ADDRESS and USDC from addresses.json
DIAMOND_ADDRESS=$(jq -r --arg chainId "$CHAIN_ID" '.[$chainId].diamondProxy // empty' "$ADDRESSES_FILE")
if [ -z "$DIAMOND_ADDRESS" ]; then
    echo -e "${RED}Error: DIAMOND_ADDRESS not found in $ADDRESSES_FILE for chain $CHAIN_ID${NC}"
    echo "Please deploy the diamond first using DeployPolymerContracts.sh"
    exit 1
fi
echo -e "${BLUE}Using DIAMOND_ADDRESS from $ADDRESSES_FILE: $DIAMOND_ADDRESS${NC}"

if [ -z "$USDC" ]; then
    USDC=$(jq -r --arg chainId "$CHAIN_ID" '.[$chainId].usdc // empty' "$ADDRESSES_FILE")
    if [ -z "$USDC" ]; then
        echo -e "${RED}Error: USDC not found in $ADDRESSES_FILE for chain $CHAIN_ID and not set in environment${NC}"
        echo "Please either:"
        echo "  1. Set USDC environment variable, or"
        echo "  2. Add it to $ADDRESSES_FILE under \"$CHAIN_ID\": { \"usdc\": \"0x...\" }"
        exit 1
    fi
    echo -e "${BLUE}Using USDC from $ADDRESSES_FILE: $USDC${NC}"
fi

# Export all variables for forge scripts
export RPC_URL
export CHAIN_ID
export PRIVATE_KEY
export DESTINATION_DOMAIN
export DIAMOND_ADDRESS
export USDC

echo -e "${BLUE}Calling PolymerCCTPFacet on chain $CHAIN_ID...${NC}"

# Run the call script
forge script ./script/demoScripts/PolymerCCTP.s.sol \
    --rpc-url "$RPC_URL" \
    --broadcast \
    --verify

echo -e "${GREEN}PolymerCCTP call complete!${NC}"