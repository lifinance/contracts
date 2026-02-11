#!/bin/bash
# VIOLATION: Hardcodes network checks instead of using universalCast
# Should use: universalCast "call" NETWORK TARGET SIGNATURE [ARGS...]
# Should use: universalCast "send" NETWORK ENVIRONMENT TARGET SIGNATURE [ARGS] [TIMELOCK] [PRIVATE_KEY_OVERRIDE]

# Bad: Hardcoding network check
if [[ "$NETWORK" == "tron" ]]; then
  # Direct troncast call without abstraction
  bun troncast call "$CONTRACT" "owner() returns (address)" --env "$TRON_ENV"
else
  # Direct cast call without abstraction
  cast call "$CONTRACT" "owner() returns (address)" --rpc-url "$RPC_URL"
fi

# Bad: Another hardcoded check
if [[ "$NETWORK" == "tron" ]]; then
  bun troncast send "$CONTRACT" "setValue(uint256)" "100" --env "$TRON_ENV"
elif [[ "$ENVIRONMENT" == "production" ]]; then
  bun script/deploy/safe/propose-to-safe.ts "$NETWORK" "$CONTRACT" "$CALLDATA"
else
  cast send "$CONTRACT" "setValue(uint256)" "100" --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY"
fi

# Bad: Checking network name directly
case "$NETWORK" in
  "tron"|"tronshasta")
    bun troncast code "$ADDRESS" --env "$TRON_ENV"
    ;;
  *)
    cast code "$ADDRESS" --rpc-url "$RPC_URL"
    ;;
esac
