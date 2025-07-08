#!/bin/bash

# Parse command line arguments
SELECT_ALL_NETWORKS=true
NETWORKS_ARG=""
UPDATE_DIAMOND=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-select-all)
      if [ -n "$NETWORKS_ARG" ]; then
        echo "Error: --no-select-all and --networks are mutually exclusive"
        exit 1
      fi
      SELECT_ALL_NETWORKS=false
      shift
      ;;
    --networks)
      if [ "$SELECT_ALL_NETWORKS" = false ]; then
        echo "Error: --no-select-all and --networks are mutually exclusive"
        exit 1
      fi
      NETWORKS_ARG="$2"
      shift 2
      ;;
    --update-diamond)
      UPDATE_DIAMOND=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--no-select-all | --networks network1,network2,...] [--update-diamond]"
      exit 1
      ;;
  esac
done

source .env
source script/config.sh

# Extract contract names from script/deploy/facets/ directory
CONTRACTS=$(find script/deploy/facets/ -name "Deploy*.s.sol" -exec basename {} \; | sed 's/^Deploy//; s/\.s\.sol$//' | sort)

# Use gum filter to select a single contract with fuzzy search
SELECTED_CONTRACT=$(echo "$CONTRACTS" | gum filter \
  --limit=1 \
  --select-if-one \
  --header="Select contract to deploy:" \
  --placeholder="Type to filter contracts..." \
  --fuzzy)

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

# Handle network selection
if [ -n "$NETWORKS_ARG" ]; then
  # Validate provided networks against available networks
  AVAILABLE_NETWORKS=$(jq -r 'to_entries[] | select(.value.isZkEVM == false) | .key' config/networks.json | sort)
  
  # Convert comma-separated list to array and validate each network
  IFS=',' read -ra NETWORK_ARRAY <<< "$NETWORKS_ARG"
  INVALID_NETWORKS=()
  
  for network in "${NETWORK_ARRAY[@]}"; do
    if ! echo "$AVAILABLE_NETWORKS" | grep -q "^$network$"; then
      INVALID_NETWORKS+=("$network")
    fi
  done
  
  if [ ${#INVALID_NETWORKS[@]} -gt 0 ]; then
    echo "Error: Invalid networks specified: ${INVALID_NETWORKS[*]}"
    echo "Available networks:"
    echo "$AVAILABLE_NETWORKS"
    exit 1
  fi
  
  SELECTED_NETWORKS="$NETWORKS_ARG"
  echo "Using provided networks: $SELECTED_NETWORKS"
else
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
fi

echo "Selected networks: $SELECTED_NETWORKS"

# Ask about diamond update if not specified via flag
if [ "$UPDATE_DIAMOND" = false ]; then
  UPDATE_DIAMOND_SELECTION=$(echo -e "no\nyes" | gum choose \
    --limit=1 \
    --header="Update diamond after deployment (for facets only)?")
  
  if [ "$UPDATE_DIAMOND_SELECTION" = "yes" ]; then
    UPDATE_DIAMOND=true
  fi
fi

echo "Update diamond: $UPDATE_DIAMOND"

# Build dagger command with selected options
DAGGER_CMD="deploy-to-all-networks . $SELECTED_CONTRACT $SELECTED_NETWORKS env:PRIVATE_KEY --evm-version=$SELECTED_EVM_VERSION --solc-version=$SELECTED_SOLC_VERSION"

# Add update-diamond flag if requested
if [ "$UPDATE_DIAMOND" = true ]; then
  DAGGER_CMD="$DAGGER_CMD --update-diamond=true --safe-signer-private-key=env:SAFE_SIGNER_PRIVATE_KEY"
fi

# Run dagger command
dagger -c "$DAGGER_CMD | export ./deployments"
