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
    echo "Usage: $0 <RPC_URL> <PRIVATE_KEY> "
    echo ""
    echo "Required arguments:"
    echo "  RPC_URL              RPC endpoint URL"
    echo "  PRIVATE_KEY          Private key for deployment"
    echo "  ADDRESSES_FILE       Path to addresses json"  
    echo ""
    echo "Example:"
    echo "  $0 https://arb-sepolia.g.alchemy.com/v2/KEY 0xYOURKEY ./testnet-addresses.json"
    exit 1
}

# Check if we have the required number of arguments
if [ $# -lt 3 ]; then
    echo -e "${RED}Error: Missing required arguments${NC}\n"
    usage
fi

# Parse positional arguments
RPC_URL="$1"
PRIVATE_KEY="$2"
ADDRESSES_FILE="$3"

# Get chain ID from RPC
echo -e "${BLUE}Fetching chain ID from RPC...${NC}"
CHAIN_ID=$(cast chain-id -r "$RPC_URL")
if [ -z "$CHAIN_ID" ]; then
    echo -e "${RED}Error: Could not fetch chain ID from RPC${NC}"
    exit 1
fi
echo -e "${GREEN}Chain ID: $CHAIN_ID${NC}"

# # Use ADDRESSES_PATH env var or default to addresses.json

# Create addresses file if it doesn't exist
if [ ! -f "$ADDRESSES_FILE" ]; then
    echo "{}" > "$ADDRESSES_FILE"
    echo -e "${BLUE}Created $ADDRESSES_FILE${NC}"
fi

# Read TOKEN_MESSENGER, USDC, and POLYMER_FEE_RECIPIENT from addresses.json if not set in env
if [ -z "$TOKEN_MESSENGER" ]; then
    TOKEN_MESSENGER=$(jq -r --arg chainId "$CHAIN_ID" '.[$chainId].tokenMessenger // empty' "$ADDRESSES_FILE")
    if [ -z "$TOKEN_MESSENGER" ]; then
        echo -e "${RED}Error: TOKEN_MESSENGER not found in $ADDRESSES_FILE for chain $CHAIN_ID and not set in environment${NC}"
        echo "Please either:"
        echo "  1. Set TOKEN_MESSENGER environment variable, or"
        echo "  2. Add it to $ADDRESSES_FILE under \"$CHAIN_ID\": { \"tokenMessenger\": \"0x...\" }"
        exit 1
    fi
    echo -e "${BLUE}Using TOKEN_MESSENGER from $ADDRESSES_FILE: $TOKEN_MESSENGER${NC}"
fi

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

if [ -z "$POLYMER_FEE_RECIPIENT" ]; then
    POLYMER_FEE_RECIPIENT=$(jq -r --arg chainId "$CHAIN_ID" '.[$chainId].polymerFeeRecipient // empty' "$ADDRESSES_FILE")
    if [ -z "$POLYMER_FEE_RECIPIENT" ]; then
        echo -e "${RED}Error: POLYMER_FEE_RECIPIENT not found in $ADDRESSES_FILE for chain $CHAIN_ID and not set in environment${NC}"
        echo "Please either:"
        echo "  1. Set POLYMER_FEE_RECIPIENT environment variable, or"
        echo "  2. Add it to $ADDRESSES_FILE under \"$CHAIN_ID\": { \"usdc\": \"0x...\" }"
        exit 1
    fi
    echo -e "${BLUE}Using POLYMER_FEE_RECIPIENT from $ADDRESSES_FILE: $POLYMER_FEE_RECIPIENT${NC}"
fi

# Export all variables for forge scripts
export RPC_URL
export CHAIN_ID
export PRIVATE_KEY
export TOKEN_MESSENGER
export USDC
export POLYMER_FEE_RECIPIENT

echo -e "${BLUE}Deploying Diamond with PolymerCCTPFacet to chain $CHAIN_ID...${NC}"

# Create temp files for output
DEPLOY_OUTPUT_FILE=$(mktemp /tmp/forge-deploy-output.XXXXXX)
echo -e "${BLUE}Output will be saved to: $DEPLOY_OUTPUT_FILE${NC}"

# Run deployment script and save output to temp file
forge script ./script/deploy/facets/DeployDiamondWithPolymerCCTPFacet.s.sol \
    --rpc-url "$RPC_URL" \
    --broadcast \
    --verify \
    2>&1 | tee "$DEPLOY_OUTPUT_FILE"

DEPLOY_OUTPUT=$(cat "$DEPLOY_OUTPUT_FILE")

# Extract diamond address from output
DIAMOND_ADDRESS=$(echo "$DEPLOY_OUTPUT" | grep "LiFiDiamond deployed at: " | awk '{print $4}')

if [ -z "$DIAMOND_ADDRESS" ]; then
    echo -e "${RED}Error: Could not extract diamond address from deployment output${NC}"
    exit 1
fi

echo -e "${GREEN}Diamond deployed at: $DIAMOND_ADDRESS${NC}"

# Update addresses.json with the new deployment
jq --arg chainId "$CHAIN_ID" \
   --arg address "$DIAMOND_ADDRESS" \
   '.[$chainId].diamondProxy = $address' \
   "$ADDRESSES_FILE" > "$ADDRESSES_FILE.tmp" && mv "$ADDRESSES_FILE.tmp" "$ADDRESSES_FILE"

echo -e "${GREEN}Updated $ADDRESSES_FILE${NC}"
echo -e "${GREEN}Deployment complete!${NC}"
echo -e "${BLUE}To call the facet, run: ./script/deploy/CallPolymerCCTP.sh <RPC_URL> <PRIVATE_KEY> <DESTINATION_DOMAIN> $ADDRESSES_FILE${NC}"

echo -e "${BLUE}Initializing polymer facet ${NC}"
cast send "$DIAMOND_ADDRESS" "initPolymerCCTP()" --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY"