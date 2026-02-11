#!/bin/bash
# VIOLATION: Incorrect variable usage
# Should use: UPPERCASE, safe expansions ${VAR:-}, always quote "$VAR"

# Bad: Lowercase variable names
network="arbitrum"
contract_address=0x1234567890123456789012345678901234567890
private_key=$PRIVATE_KEY

# Bad: Unquoted variables (risky with set -u)
echo $network
echo $contract_address
echo $private_key

# Bad: No safe expansion (will fail with set -u if unset)
if [[ -z $RPC_URL ]]; then
  echo "RPC URL not set"
fi

# Bad: Array access without safe expansion
for item in ${array[@]}; do
  echo $item
done

# Bad: Variable expansion without quotes in command substitution
result=$(cast call $contract_address "owner() returns (address)" --rpc-url $RPC_URL)

# Bad: Mixing quoted and unquoted
echo "Network: $network, Address: $contract_address, Key: $private_key"

# Bad: Using $VAR directly without checking if set
if [[ $NETWORK == "tron" ]]; then
  echo "Tron network"
fi

# Bad: No safe expansion for optional variables
TIMEOUT=${TIMEOUT}  # Should be ${TIMEOUT:-default}

# Bad: Unquoted variable in arithmetic
count=$count+1

# Bad: Unquoted variable in test
if [[ $status == "success" ]]; then
  echo "Done"
fi
