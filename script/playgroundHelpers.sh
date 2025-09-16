#!/bin/bash

# =============================================================================
# PLAYGROUND HELPER FUNCTIONS
# =============================================================================
# This file contains helper functions specific to playground operations
# such as contract verification, deployment, and other playground-specific tasks
# =============================================================================

# Load required dependencies
source script/helperFunctions.sh

# =============================================================================
# CONTRACT VERIFICATION FUNCTIONS
# =============================================================================

function getContractVerified() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local CONTRACT="$3"

  local VERSION
  local CONTRACT_ADDRESS
  local ADDRESS_RETURN_CODE
  local ARGS
  local ARGS_RETURN_CODE

  VERSION=$(getCurrentContractVersion "$CONTRACT")

  CONTRACT_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$CONTRACT")
  ADDRESS_RETURN_CODE=$?

  if [[ $ADDRESS_RETURN_CODE -ne 0 || -z "$CONTRACT_ADDRESS" || "$CONTRACT_ADDRESS" == "null" || "$CONTRACT_ADDRESS" == "0x" ]]; then
    error "[$NETWORK] No address found for $CONTRACT"
    return 1
  fi

  ARGS=$(getConstructorArgsFromMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT")
  ARGS_RETURN_CODE=$?

  if [[ $ARGS_RETURN_CODE -ne 0 || -z "$ARGS" ]]; then
    error "[$NETWORK] No constructor args found for $CONTRACT"
    return 1
  fi

  # extract values from existing log entry
  LOG_ENTRY=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION")
  local LOG_ENTRY_RETURN_CODE=$?

  if [[ $LOG_ENTRY_RETURN_CODE -ne 0 || -z "$LOG_ENTRY" ]]; then
    error "[$NETWORK] No log entry found for $CONTRACT in master log"
    return 1
  fi

  CURRENT_ADDRESS=$(echo "$LOG_ENTRY" | jq -r ".ADDRESS")
  CURRENT_OPTIMIZER=$(echo "$LOG_ENTRY" | jq -r ".OPTIMIZER_RUNS")
  CURRENT_TIMESTAMP=$(echo "$LOG_ENTRY" | jq -r ".TIMESTAMP")
  CURRENT_CONSTRUCTOR_ARGS=$(echo "$LOG_ENTRY" | jq -r ".CONSTRUCTOR_ARGS")
  CURRENT_SALT=$(echo "$LOG_ENTRY" | jq -r ".SALT")
  CURRENT_VERIFIED=$(echo "$LOG_ENTRY" | jq -r ".VERIFIED")

  if [[ "$CURRENT_ADDRESS" != "$CONTRACT_ADDRESS" ]]; then
    error "[$NETWORK] Address mismatch: $CURRENT_ADDRESS != $CONTRACT_ADDRESS"
    return 1
  fi

  if [[ "$CURRENT_VERIFIED" == "true" ]]; then
    success "[$NETWORK] $CONTRACT is already verified"
    return 0
  fi

  echo "[$NETWORK] Verifying $CONTRACT with address $CONTRACT_ADDRESS and constructor args: $ARGS"
  verifyContract "$NETWORK" "$CONTRACT" "$CONTRACT_ADDRESS" "$ARGS"

  if [[ $? -eq 0 ]]; then
    success "[$NETWORK] Successfully verified $CONTRACT with address $CONTRACT_ADDRESS. Updating VERIFIED flag in log entry now."

    logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$CURRENT_TIMESTAMP" "$VERSION" "$CURRENT_OPTIMIZER" "$CURRENT_CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$CONTRACT_ADDRESS" "true" "$CURRENT_SALT"
    return 0
  else
    error "[$NETWORK] Failed to verify $CONTRACT with address $CONTRACT_ADDRESS"
    return 1
  fi
}

# =============================================================================
# NETWORK QUERY FUNCTIONS
# =============================================================================

function getNetworksByEvmVersionAndContractDeployment() {
  # Function: getNetworksByEvmVersionAndContractDeployment
  # Description: Gets a list of networks where a contract is deployed, optionally filtered by EVM version
  # Arguments:
  #   $1 - CONTRACT: The contract name to check for deployment
  #   $2 - ENVIRONMENT: The environment to check (production/staging)
  #   $3 - EVM_VERSION: (Optional) The EVM version to filter by (e.g., "london", "cancun", "shanghai")
  # Returns:
  #   Array of network names that match the criteria
  # Example:
  #   getNetworksByEvmVersionAndContractDeployment "GlacisFacet" "production"  # all networks with contract deployed
  #   getNetworksByEvmVersionAndContractDeployment "GlacisFacet" "production" "cancun"  # only cancun networks with contract deployed

  # read function arguments into variables
  local CONTRACT="$1"
  local ENVIRONMENT="$2"
  local EVM_VERSION="$3"

  # validate required parameters
  if [[ -z "$CONTRACT" || -z "$ENVIRONMENT" ]]; then
    echo "Error: CONTRACT and ENVIRONMENT parameters are required for getNetworksByEvmVersionAndContractDeployment function" >&2
    return 1
  fi

  local ARRAY=()
  local NETWORKS=()

  # get initial list of networks based on EVM version
  if [[ -n "$EVM_VERSION" ]]; then
    # get networks with specific EVM version
    NETWORKS=($(getIncludedNetworksByEvmVersionArray "$EVM_VERSION"))
  else
    # get all included networks
    NETWORKS=($(getIncludedNetworksArray))
  fi

  # iterate through networks and check if contract is deployed
  for network in "${NETWORKS[@]}"; do
    # check if contract is deployed on this network
    if getContractAddressFromDeploymentLogs "$network" "$ENVIRONMENT" "$CONTRACT" >/dev/null 2>&1; then
      ARRAY+=("$network")
    fi
  done

  # return ARRAY
  printf '%s\n' "${ARRAY[@]}"
}

# =============================================================================
# EXPORT FUNCTIONS FOR USE IN OTHER SCRIPTS
# =============================================================================

# Make functions available to other scripts
export -f getContractVerified
export -f getNetworksByEvmVersionAndContractDeployment
