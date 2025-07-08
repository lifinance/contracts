#!/bin/bash

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

# Extract network names from config/networks.json, filtering out zkEVM networks
NETWORKS=$(jq -r 'to_entries[] | select(.value.isZkEVM == false) | .key' config/networks.json | sort)

# Use gum to select networks with all networks pre-selected
SELECTED_NETWORKS=$(echo "$NETWORKS" | gum choose \
  --no-limit \
  --selected="*" \
  --header="Select networks to deploy to:" \
  --output-delimiter=",")

# Check if any networks were selected
if [ -z "$SELECTED_NETWORKS" ]; then
  echo "No networks selected. Exiting."
  exit 1
fi

echo "Selected networks: $SELECTED_NETWORKS"

# Run dagger command with selected contract and networks
dagger -c "deploy-to-all-networks . $SELECTED_CONTRACT $SELECTED_NETWORKS env:PRIVATE_KEY | export ./deployments"
