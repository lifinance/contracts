#!/bin/bash

# Parse command line arguments
SELECT_ALL_NETWORKS=true
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-select-all)
      SELECT_ALL_NETWORKS=false
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--no-select-all]"
      exit 1
      ;;
  esac
done

source .env
source script/config.sh

# Extract contract names from script/deploy/facets/ directory
CONTRACTS=$(find script/deploy/facets/ -name "Deploy*.s.sol" -exec basename {} \; | sed 's/^Deploy//; s/\.s\.sol$//' | sort)

# Use gum to select a single contract
SELECTED_CONTRACT=$(echo "$CONTRACTS" | gum choose \
  --limit=1 \
  --select-if-one \
  --header="Select contract to deploy:")

# Check if a contract was selected
if [ -z "$SELECTED_CONTRACT" ]; then
  echo "No contract selected. Exiting."
  exit 1
fi

echo "Selected contract: $SELECTED_CONTRACT"

# Read defaults from foundry.toml (from [profile.default] section)
DEFAULT_SOLC_VERSION=$(awk '/^\[profile\.default\]/{flag=1; next} /^\[/{flag=0} flag && /^solc_version/{gsub(/['\''"]/, "", $3); print $3; exit}' foundry.toml)
DEFAULT_EVM_VERSION=$(awk '/^\[profile\.default\]/{flag=1; next} /^\[/{flag=0} flag && /^evm_version/{gsub(/['\''"]/, "", $3); print $3; exit}' foundry.toml)

# Fetch solc versions from GitHub API (0.8.17 to latest)
echo "Fetching available Solidity compiler versions..."
SOLC_VERSIONS=$(curl -s "https://api.github.com/repos/ethereum/solc-js/tags" | \
  jq -r '.[].name' | \
  grep -E '^v0\.(8\.(1[7-9]|[2-9][0-9])|9\.)' | \
  sed 's/^v//' | \
  sort -V -r)

# Ensure the foundry.toml default is in the list
if ! echo "$SOLC_VERSIONS" | grep -q "^$DEFAULT_SOLC_VERSION$"; then
  SOLC_VERSIONS="$DEFAULT_SOLC_VERSION
$SOLC_VERSIONS"
fi

# Check if we got versions
if [ -z "$SOLC_VERSIONS" ]; then
  echo "Failed to fetch Solidity versions. Using foundry.toml default: $DEFAULT_SOLC_VERSION"
  SOLC_VERSIONS="$DEFAULT_SOLC_VERSION"
fi

# Use gum to select Solidity compiler version
SELECTED_SOLC_VERSION=$(echo "$SOLC_VERSIONS" | gum choose \
  --limit=1 \
  --select-if-one \
  --selected="$DEFAULT_SOLC_VERSION" \
  --header="Select Solidity compiler version:")

# Check if a solc version was selected
if [ -z "$SELECTED_SOLC_VERSION" ]; then
  echo "No Solidity version selected. Exiting."
  exit 1
fi

echo "Selected Solidity version: $SELECTED_SOLC_VERSION"

# Use gum to select EVM version
EVM_VERSIONS="shanghai
london
cancun"

SELECTED_EVM_VERSION=$(echo "$EVM_VERSIONS" | gum choose \
  --limit=1 \
  --select-if-one \
  --selected="$DEFAULT_EVM_VERSION" \
  --header="Select EVM version:")

# Check if an EVM version was selected
if [ -z "$SELECTED_EVM_VERSION" ]; then
  echo "No EVM version selected. Exiting."
  exit 1
fi

echo "Selected EVM version: $SELECTED_EVM_VERSION"

# Extract network names from config/networks.json, filtering out zkEVM networks
NETWORKS=$(jq -r 'to_entries[] | select(.value.isZkEVM == false) | .key' config/networks.json | sort)

# Use gum to select networks (conditionally pre-select all)
if [ "$SELECT_ALL_NETWORKS" = true ]; then
  SELECTED_NETWORKS=$(echo "$NETWORKS" | gum choose \
    --no-limit \
    --selected="*" \
    --header="Select networks to deploy to:" \
    --output-delimiter=",")
else
  SELECTED_NETWORKS=$(echo "$NETWORKS" | gum choose \
    --no-limit \
    --header="Select networks to deploy to:" \
    --output-delimiter=",")
fi

# Check if any networks were selected
if [ -z "$SELECTED_NETWORKS" ]; then
  echo "No networks selected. Exiting."
  exit 1
fi

echo "Selected networks: $SELECTED_NETWORKS"

# Run dagger command with selected contract, networks, EVM version, and Solidity version
dagger -c "deploy-to-all-networks . $SELECTED_CONTRACT $SELECTED_NETWORKS env:PRIVATE_KEY --evm-version=$SELECTED_EVM_VERSION --solc-version=$SELECTED_SOLC_VERSION | export ./deployments"
