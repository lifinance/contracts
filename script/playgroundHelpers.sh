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
# EXPORT FUNCTIONS FOR USE IN OTHER SCRIPTS
# =============================================================================

# Make functions available to other scripts
export -f getContractVerified
