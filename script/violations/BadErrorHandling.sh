#!/bin/bash
# VIOLATION: Poor error handling, not using helpers
# Should use: checkFailure, echoDebug, error, warning, success from helperFunctions.sh

# Bad: No error checking after command
cast call "$CONTRACT" "owner() returns (address)" --rpc-url "$RPC_URL"
echo "Owner retrieved"

# Bad: Using echo instead of error helper
if ! cast send "$CONTRACT" "setValue(uint256)" "100"; then
  echo "Error: Failed to send transaction"
fi

# Bad: Generic error message, no context
if [[ $? -ne 0 ]]; then
  echo "Error occurred"
  exit 1
fi

# Bad: No retry logic for RPC-sensitive operations
result=$(cast call "$CONTRACT" "getValue() returns (uint256)" --rpc-url "$RPC_URL")
if [[ -z "$result" ]]; then
  echo "Failed"
  exit 1
fi

# Bad: Using printf instead of logging helpers
printf "Warning: Low balance\n"
printf "Success: Transaction sent\n"

# Bad: Inline error handling without helper
if ! bun troncast send "$CONTRACT" "transfer(address,uint256)" "$TO" "$AMOUNT" --env "$TRON_ENV"; then
  echo "Transaction failed" >&2
  exit 1
fi

# Bad: No error context
deploy_result=$(forge create Contract --rpc-url "$RPC_URL")
if [[ $? -ne 0 ]]; then
  exit 1
fi

# Bad: Silent failure
cast send "$CONTRACT" "pause()" --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" >/dev/null 2>&1

# Bad: No validation before use
address=$1
cast call "$address" "owner() returns (address)" --rpc-url "$RPC_URL"
