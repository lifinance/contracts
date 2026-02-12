#!/bin/bash

# VIOLATION: No checkFailure helper usage
# VIOLATION: No retry logic for RPC-sensitive operations
# VIOLATION: No logging helpers

NETWORK="ethereum"
CONTRACT="0x123"

# VIOLATION: Command that might fail with no error handling
result=$(cast call "$CONTRACT" "owner()")
echo "Owner: $result"

# VIOLATION: No checkFailure after critical operation
cast send "$CONTRACT" "updateOwner(address)" "0xNewOwner" --private-key "$PRIVATE_KEY"

# VIOLATION: Using echo instead of logging helpers
echo "Starting deployment"  # Should use echoDebug
echo "ERROR: Failed to deploy"  # Should use error()
echo "WARNING: Network slow"  # Should use warning()
echo "SUCCESS: Deployed"  # Should use success()

# VIOLATION: No retry logic for flaky operations
troncast call "$CONTRACT" "facets()"  # Might fail due to rate limits

# VIOLATION: Silent failures with || true
cast call "$CONTRACT" "nonExistentFunction()" || true

# VIOLATION: No error context or actionable messages
if [[ $? -ne 0 ]]; then
    echo "Failed"
    exit 1
fi

# VIOLATION: Exposing inline secrets in error messages
PRIVATE_KEY="0xabcdef1234567890"
cast send "$CONTRACT" "transfer(address,uint256)" "0x123" "1000" --private-key "$PRIVATE_KEY" || echo "Failed with key: $PRIVATE_KEY"

# VIOLATION: No validation before operations
# Should validate addresses, selectors, etc.
cast call "$CONTRACT" "somethingRandom()"
