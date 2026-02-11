# VIOLATION: Missing shebang, poor structure, not organized into functions
# Should start with: #!/bin/bash
# Should organize into functions with proper sourcing of helpers

# Bad: No shebang
# Bad: No sourcing of helperFunctions.sh or universalCast.sh

# Inline script without functions
NETWORK="arbitrum"
CONTRACT="0x1234567890123456789012345678901234567890"

# Direct execution without function organization
cast call "$CONTRACT" "owner() returns (address)" --rpc-url "$RPC_URL"
owner=$(cast call "$CONTRACT" "owner() returns (address)" --rpc-url "$RPC_URL")
echo "Owner: $owner"

# More inline code
if [[ "$NETWORK" == "tron" ]]; then
  bun troncast call "$CONTRACT" "balance() returns (uint256)" --env "$TRON_ENV"
else
  cast call "$CONTRACT" "balance() returns (uint256)" --rpc-url "$RPC_URL"
fi

# No function separation
result=$(cast send "$CONTRACT" "setValue(uint256)" "100" --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY")
if [[ $? -eq 0 ]]; then
  echo "Success"
else
  echo "Failed"
fi

# Mixed concerns without separation
for network in arbitrum ethereum polygon; do
  rpc=$(get_rpc_for_network "$network")
  cast call "$CONTRACT" "owner() returns (address)" --rpc-url "$rpc"
done

# No main function, no proper script structure
echo "Starting deployment"
deploy_contract
echo "Deployment complete"
