#!/bin/bash
# VIOLATION: Function documentation doesn't follow consistent format
# Should follow format: function name, brief description, usage with parameter descriptions, routing/behavior, returns, examples

# Bad: No documentation
function getOwner() {
  local contract=$1
  cast call "$contract" "owner() returns (address)" --rpc-url "$RPC_URL"
}

# Bad: Incomplete documentation (missing usage, parameters, returns, examples)
# Gets the owner of a contract
function getBalance() {
  local contract=$1
  cast call "$contract" "balance() returns (uint256)" --rpc-url "$RPC_URL"
}

# Bad: Wrong format (using : instead of -)
# Usage: sendTransaction network: network name, contract: contract address, signature: function signature
function sendTransaction() {
  local network=$1
  local contract=$2
  local signature=$3
  cast send "$contract" "$signature" --rpc-url "$RPC_URL"
}

# Bad: Missing routing/behavior section for network-specific logic
# Calls a contract function
# Usage: callContract network contract signature
function callContract() {
  local network=$1
  local contract=$2
  local signature=$3
  if [[ "$network" == "tron" ]]; then
    bun troncast call "$contract" "$signature" --env "$TRON_ENV"
  else
    cast call "$contract" "$signature" --rpc-url "$RPC_URL"
  fi
}

# Bad: Lowercase parameter names in documentation
# Usage: deployContract network contractName constructorArgs
function deployContract() {
  local network=$1
  local contract=$2
  local args=$3
  forge create "$contract" --constructor-args "$args" --rpc-url "$RPC_URL"
}

# Bad: No examples
# Validates an address
# Usage: validateAddress address
function validateAddress() {
  local addr=$1
  [[ ${#addr} -eq 42 ]] && [[ "$addr" =~ ^0x[0-9a-fA-F]{40}$ ]]
}

# Bad: Missing optional parameter documentation
# Usage: getRPC network
function getRPC() {
  local network=$1
  local env=${2:-production}  # Optional parameter not documented
  echo "${network}_RPC_URL_${env}"
}
