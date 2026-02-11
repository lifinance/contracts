#!/bin/bash
# VIOLATION: Poor code quality - no usage/help, unclear exit codes, no TODOs documentation

# Bad: No usage/help text
# Bad: No clear exit codes documentation
# Bad: No TODOs/limits documentation

# Script without proper header or purpose
NETWORK=${1:-arbitrum}
CONTRACT=${2:-}

# Bad: Unclear exit codes (mixing 0/1 inconsistently)
if [[ -z "$CONTRACT" ]]; then
  echo "Contract address required"
  exit 0  # Should be exit 1 for error
fi

# Bad: No help/usage function
if [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
  echo "Usage: script.sh [network] [contract]"
  exit 0
fi

# Bad: Inconsistent error handling
cast call "$CONTRACT" "owner() returns (address)" --rpc-url "$RPC_URL"
if [[ $? -ne 0 ]]; then
  echo "Failed"
  # No exit code, script continues
fi

# Bad: Magic numbers without explanation
sleep 5  # Why 5 seconds?
timeout=30  # What is this timeout for?

# Bad: No indentation consistency
if [[ "$NETWORK" == "tron" ]]; then
bun troncast call "$CONTRACT" "owner() returns (address)" --env "$TRON_ENV"
else
  cast call "$CONTRACT" "owner() returns (address)" --rpc-url "$RPC_URL"
fi

# Bad: Inconsistent naming (mixing styles)
local_network=$NETWORK
LocalContract=$CONTRACT
LOCAL_ADDRESS=$ADDRESS

# Bad: No documentation of limits/constraints
# This script assumes RPC_URL is set but doesn't validate
cast call "$CONTRACT" "getValue() returns (uint256)" --rpc-url "$RPC_URL"

# Bad: Exit without clear success indication
echo "Done"
exit 0  # Is this success? What was accomplished?
