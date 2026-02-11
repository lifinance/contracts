#!/bin/bash
# VIOLATION: Reimplements logic that should use existing helpers
# Should use: isTronNetwork, getTronEnv, getRPCUrl, getPrivateKey from helperFunctions.sh

# Bad: Reimplementing network detection
is_tron() {
  if [[ "$1" == "tron" ]] || [[ "$1" == "tronshasta" ]]; then
    return 0
  fi
  return 1
}

# Bad: Reimplementing RPC URL retrieval
get_rpc() {
  local net=$1
  if [[ "$net" == "arbitrum" ]]; then
    echo "$ARBITRUM_RPC_URL"
  elif [[ "$net" == "ethereum" ]]; then
    echo "$ETHEREUM_RPC_URL"
  elif [[ "$net" == "polygon" ]]; then
    echo "$POLYGON_RPC_URL"
  fi
}

# Bad: Reimplementing private key retrieval
get_key() {
  local net=$1
  local env=$2
  if [[ "$env" == "production" ]]; then
    if [[ "$net" == "arbitrum" ]]; then
      echo "$ARBITRUM_PRIVATE_KEY_PROD"
    elif [[ "$net" == "ethereum" ]]; then
      echo "$ETHEREUM_PRIVATE_KEY_PROD"
    fi
  else
    if [[ "$net" == "arbitrum" ]]; then
      echo "$ARBITRUM_PRIVATE_KEY_STAGING"
    elif [[ "$net" == "ethereum" ]]; then
      echo "$ETHEREUM_PRIVATE_KEY_STAGING"
    fi
  fi
}

# Bad: Reimplementing address validation
validate_address() {
  if [[ ${#1} -eq 42 ]] && [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    return 0
  fi
  return 1
}

# Bad: Reimplementing selector validation
validate_selector() {
  if [[ ${#1} -eq 10 ]] && [[ "$1" =~ ^0x[0-9a-fA-F]{8}$ ]]; then
    return 0
  fi
  return 1
}
