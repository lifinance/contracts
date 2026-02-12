#!/bin/bash

# VIOLATION: Hardcoded network checks everywhere (CRITICAL)

NETWORK="tron"
CONTRACT="TXYZabc123"

# VIOLATION: Should use universalCast instead of hardcoded if/else
if [[ "$NETWORK" == "tron" ]]; then
    echo "Calling Tron contract"
    troncast call "$CONTRACT" "balanceOf(address)" "0x123"
elif [[ "$NETWORK" == "arbitrum" ]]; then
    echo "Calling Arbitrum contract"
    cast call "$CONTRACT" "balanceOf(address)" "0x123" --rpc-url "$ARB_RPC"
else
    echo "Calling EVM contract"
    cast call "$CONTRACT" "balanceOf(address)" "0x123"
fi

# VIOLATION: Not using validation helpers
# Should use: isValidTronAddress, isValidEvmAddress, isZeroAddress
address="0x0000000000000000000000000000000000000000"
if [[ "$address" == "0x0000000000000000000000000000000000000000" ]]; then
    echo "Zero address"
fi

# VIOLATION: Not using getRPCUrl helper
if [[ "$NETWORK" == "tron" ]]; then
    RPC_URL="https://api.trongrid.io"
else
    RPC_URL="https://eth-mainnet.alchemyapi.io/v2/YOUR-API-KEY"
fi

# VIOLATION: Not using getPrivateKey helper
if [[ "$NETWORK" == "tron" ]]; then
    PRIVATE_KEY="$TRON_PRIVATE_KEY"
else
    PRIVATE_KEY="$ETH_PRIVATE_KEY"
fi

# VIOLATION: Should use sendOrPropose for transactions
if [[ "$NETWORK" == "tron" ]]; then
    troncast send "$CONTRACT" "transfer(address,uint256)" "$ADDRESS" "1000000000000000000"
else
    cast send "$CONTRACT" "transfer(address,uint256)" "$ADDRESS" "1000000000000000000"
fi

# VIOLATION: Not using isTronNetwork helper
if [[ "$NETWORK" == "tron" ]]; then
    echo "It's Tron"
fi

# VIOLATION: Not using getTronEnv helper
if [[ "$NETWORK" == "tron" ]]; then
    ENV_VAR="TRON_PRIVATE_KEY"
else
    ENV_VAR="PRIVATE_KEY"
fi
