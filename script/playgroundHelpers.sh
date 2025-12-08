#!/bin/bash

# =============================================================================
# PLAYGROUND HELPER FUNCTIONS
# =============================================================================
# This file contains helper functions specific to playground operations
# such as contract verification, deployment, and other playground-specific tasks
# =============================================================================

# Load required dependencies
source script/helperFunctions.sh
source script/tasks/diamondUpdateFacet.sh
source script/tasks/diamondUpdatePeriphery.sh
source script/deploy/deploySingleContract.sh
source script/tasks/diamondSyncSigs.sh
source script/tasks/diamondSyncDEXs.sh

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

  VERSION=$(getHighestDeployedContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$CONTRACT")

  CONTRACT_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$CONTRACT")
  ADDRESS_RETURN_CODE=$?

  if [[ $ADDRESS_RETURN_CODE -ne 0 || -z "$CONTRACT_ADDRESS" || "$CONTRACT_ADDRESS" == "null" || "$CONTRACT_ADDRESS" == "0x" ]]; then
    error "[$NETWORK] No address found for $CONTRACT"
    return 1
  fi

  ARGS=$(getConstructorArgsFromMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT")
  ARGS_RETURN_CODE=$?

  if [[ $ARGS_RETURN_CODE -ne 0 || -z "$ARGS" || "$ARGS" == "null" ]]; then
    error "[$NETWORK] No constructor args found for $CONTRACT - this indicates a problem with the deployment log entry"
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

  # Extract compiler versions from log entry, or get from network config if not present
  CURRENT_SOLC_VERSION=$(echo "$LOG_ENTRY" | jq -r ".SOLC_VERSION // empty")
  CURRENT_EVM_VERSION=$(echo "$LOG_ENTRY" | jq -r ".EVM_VERSION // empty")
  CURRENT_ZK_SOLC_VERSION=$(echo "$LOG_ENTRY" | jq -r ".ZK_SOLC_VERSION // empty")

  # If not in log entry, get from network config
  if [[ -z "$CURRENT_SOLC_VERSION" || "$CURRENT_SOLC_VERSION" == "null" ]]; then
    CURRENT_SOLC_VERSION=$(getSolcVersion "$NETWORK" 2>/dev/null || echo "")
  fi
  if [[ -z "$CURRENT_EVM_VERSION" || "$CURRENT_EVM_VERSION" == "null" ]]; then
    CURRENT_EVM_VERSION=$(getEvmVersion "$NETWORK" 2>/dev/null || echo "")
  fi
  if [[ -z "$CURRENT_ZK_SOLC_VERSION" || "$CURRENT_ZK_SOLC_VERSION" == "null" ]]; then
    if isZkEvmNetwork "$NETWORK"; then
      CURRENT_ZK_SOLC_VERSION=$(getZkSolcVersion "$NETWORK" 2>/dev/null || echo "")
    else
      CURRENT_ZK_SOLC_VERSION=""
    fi
  fi

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

    logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$CURRENT_TIMESTAMP" "$VERSION" "$CURRENT_OPTIMIZER" "$CURRENT_CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$CONTRACT_ADDRESS" "true" "$CURRENT_SALT" "$CURRENT_SOLC_VERSION" "$CURRENT_EVM_VERSION" "$CURRENT_ZK_SOLC_VERSION"
    return 0
  else
    error "[$NETWORK] Failed to verify $CONTRACT with address $CONTRACT_ADDRESS"
    return 1
  fi
}

function verifyAllContractsForNetwork() {
  # Function: verifyAllContractsForNetwork
  # Description: Iterates through all contracts deployed on a given network and verifies them
  # Arguments:
  #   $1 - NETWORK: The network name (e.g., "monad", "mainnet")
  #   $2 - ENVIRONMENT: The environment (e.g., "production", "staging")
  # Returns:
  #   Exit code 0 if all contracts processed (regardless of verification status)
  #   Exit code 1 if critical error occurred
  # Example:
  #   verifyAllContractsForNetwork "monad" "production"             # verify only unverified (default mode)
  #   verifyAllContractsForNetwork "monad" "production" --verify-all # retry verification for all contracts

  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local MODE="${3:-}"

  local VERIFY_ALL=false
  if [[ "$MODE" == "--verify-all" ]]; then
    VERIFY_ALL=true
  fi

  # Validate required parameters
  if [[ -z "$NETWORK" || -z "$ENVIRONMENT" ]]; then
    error "Usage: verifyAllContractsForNetwork <network> <environment>"
    error "Example: verifyAllContractsForNetwork monad production"
    return 1
  fi

  echo "=========================================="
  echo "  CONTRACT VERIFICATION FOR NETWORK"
  echo "=========================================="
  echo "Network: $NETWORK"
  echo "Environment: $ENVIRONMENT"
  echo ""

  # Get deployment log file path
  local LOG_FILE_PATH="${LOG_FILE_PATH:-./deployments/_deployments_log_file.json}"

  if [ ! -f "$LOG_FILE_PATH" ]; then
    error "Deployment log file not found: $LOG_FILE_PATH"
    return 1
  fi

  # Extract all contract names that have deployments on the specified network
  echo "[$NETWORK] Extracting contracts deployed on $NETWORK ($ENVIRONMENT)..."
  local CONTRACTS
  CONTRACTS=$(jq -r --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" '
    to_entries[] |
    select(.value[$NETWORK][$ENVIRONMENT] != null) |
    .key
  ' "$LOG_FILE_PATH" 2>/dev/null)

  if [ -z "$CONTRACTS" ]; then
    warning "[$NETWORK] No contracts found for $NETWORK ($ENVIRONMENT) in deployment log"
    return 0
  fi

  # Convert to array
  local CONTRACT_ARRAY=()
  while IFS= read -r contract; do
    if [ -n "$contract" ] && [ "$contract" != "null" ]; then
      CONTRACT_ARRAY+=("$contract")
    fi
  done <<< "$CONTRACTS"

  local TOTAL_CONTRACTS=${#CONTRACT_ARRAY[@]}
  echo "[$NETWORK] Found $TOTAL_CONTRACTS contracts with deployments"
  if [[ "$VERIFY_ALL" == true ]]; then
    echo "[$NETWORK] Mode: verify ALL contracts (including those already marked as verified)"
  else
    echo "[$NETWORK] Mode: verify ONLY unverified contracts (skip already verified)"
  fi
  echo ""

  # Determine concurrency (fallback to 10 if not configured)
  local CONCURRENCY=${MAX_CONCURRENT_JOBS:-10}
  if [[ -z "$CONCURRENCY" || "$CONCURRENCY" -le 0 ]]; then
    CONCURRENCY=10
  fi

  echo "[$NETWORK] Using parallel verification with max $CONCURRENCY concurrent jobs"
  echo ""

  # Temporary directory to collect per-contract metadata and results
  local TEMP_DIR
  TEMP_DIR=$(mktemp -d)

  # Pre-check: determine current verification status for each contract and decide which to verify
  local ALREADY_VERIFIED_COUNT=0
  local PRECHECK_ERROR_COUNT=0
  local TO_VERIFY_CONTRACTS=()
  local PRECHECK_ERROR_CONTRACTS=()

  for CONTRACT in "${CONTRACT_ARRAY[@]}"; do
    # Determine current verification status from master log
    local VERSION
    VERSION=$(getHighestDeployedContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$CONTRACT")

    local LOG_ENTRY
    LOG_ENTRY=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" 2>/dev/null)

    if [[ -z "$LOG_ENTRY" || "$LOG_ENTRY" == "null" ]]; then
      warning "[$NETWORK] Pre-check: no master log entry found for $CONTRACT - skipping from verification set"
      PRECHECK_ERROR_COUNT=$((PRECHECK_ERROR_COUNT + 1))
      PRECHECK_ERROR_CONTRACTS+=("$CONTRACT")
      # Mark initial status as unknown
      echo "unknown" >"$TEMP_DIR/${CONTRACT}.initial_verified"
      continue
    fi

    local CURRENT_VERIFIED
    CURRENT_VERIFIED=$(echo "$LOG_ENTRY" | jq -r ".VERIFIED // empty" 2>/dev/null)
    if [[ "$CURRENT_VERIFIED" == "true" ]]; then
      ALREADY_VERIFIED_COUNT=$((ALREADY_VERIFIED_COUNT + 1))
      echo "true" >"$TEMP_DIR/${CONTRACT}.initial_verified"

      if [[ "$VERIFY_ALL" == true ]]; then
        TO_VERIFY_CONTRACTS+=("$CONTRACT")
      else
        echo "[$NETWORK] $CONTRACT is already marked as verified - skipping in default mode"
      fi
    else
      echo "false" >"$TEMP_DIR/${CONTRACT}.initial_verified"
      TO_VERIFY_CONTRACTS+=("$CONTRACT")
    fi
  done

  local TOTAL_TO_VERIFY=${#TO_VERIFY_CONTRACTS[@]}
  echo "[$NETWORK] Contracts that will be actively verified in this run: $TOTAL_TO_VERIFY"
  echo "[$NETWORK] Contracts already marked as verified before this run: $ALREADY_VERIFIED_COUNT"
  if [[ $PRECHECK_ERROR_COUNT -gt 0 ]]; then
    echo "[$NETWORK] Contracts with pre-check errors (no usable master log entry): $PRECHECK_ERROR_COUNT"
  fi
  echo ""

  # If there is nothing to verify, print summary and exit early
  if [[ $TOTAL_TO_VERIFY -eq 0 ]]; then
    echo "[$NETWORK] Nothing to verify in this run."
    echo ""
    echo "=========================================="
    echo "  SUMMARY - $NETWORK ($ENVIRONMENT)"
    echo "=========================================="
    echo "Total contracts (with deployments): $TOTAL_CONTRACTS"
    echo "✅ Already verified before run: $ALREADY_VERIFIED_COUNT"
    echo "⚠️  Pre-check errors (no master log entry): $PRECHECK_ERROR_COUNT"
    echo "=========================================="
    echo ""
    rm -rf "$TEMP_DIR"
    return 0
  fi

  # Iterate through each contract that should be verified and run in parallel with concurrency control
  for CONTRACT in "${TO_VERIFY_CONTRACTS[@]}"; do
    echo "----------------------------------------"
    echo "[$NETWORK] Checking: $CONTRACT"
    echo "----------------------------------------"

    # Throttle background jobs
    while [[ $(jobs | wc -l | tr -d ' ') -ge $CONCURRENCY ]]; do
      sleep 0.1
    done

    (
      local CONTRACT_NAME="$CONTRACT"
      local RESULT_FILE="$TEMP_DIR/${CONTRACT_NAME}.result"

      getContractVerified "$NETWORK" "$ENVIRONMENT" "$CONTRACT_NAME"
      local EXIT_CODE=$?

      case $EXIT_CODE in
        0)
          echo "VERIFIED" >"$RESULT_FILE"
          ;;
        *)
          echo "ERROR" >"$RESULT_FILE"
          ;;
      esac
    ) &
  done

  # Wait for all background jobs to finish (do not fail early if some verifications fail)
  wait || true

  # Track results
  local NEWLY_VERIFIED_COUNT=0
  local FAILED_UNVERIFIED_COUNT=0
  local FAILED_MARKED_VERIFIED_COUNT=0
  local UNKNOWN_RESULT_COUNT=0

  local FAILED_UNVERIFIED_CONTRACTS=()
  local FAILED_MARKED_VERIFIED_CONTRACTS=()
  local UNKNOWN_RESULT_CONTRACTS=()

  # Aggregate results using initial verification status and per-contract results
  for CONTRACT in "${CONTRACT_ARRAY[@]}"; do
    local INITIAL_FILE="$TEMP_DIR/${CONTRACT}.initial_verified"
    local RESULT_FILE="$TEMP_DIR/${CONTRACT}.result"

    local INITIAL_STATUS="unknown"
    if [[ -f "$INITIAL_FILE" ]]; then
      INITIAL_STATUS=$(<"$INITIAL_FILE")
    fi

    local RESULT_STATUS="none"
    if [[ -f "$RESULT_FILE" ]]; then
      RESULT_STATUS=$(<"$RESULT_FILE")
    fi

    if [[ "$VERIFY_ALL" == true ]]; then
      # In verify-all mode, highlight verified-but-failing separately
      if [[ "$RESULT_STATUS" == "VERIFIED" ]]; then
        if [[ "$INITIAL_STATUS" == "false" || "$INITIAL_STATUS" == "unknown" ]]; then
          NEWLY_VERIFIED_COUNT=$((NEWLY_VERIFIED_COUNT + 1))
        fi
      elif [[ "$RESULT_STATUS" == "ERROR" ]]; then
        if [[ "$INITIAL_STATUS" == "true" ]]; then
          FAILED_MARKED_VERIFIED_COUNT=$((FAILED_MARKED_VERIFIED_COUNT + 1))
          FAILED_MARKED_VERIFIED_CONTRACTS+=("$CONTRACT")
        else
          FAILED_UNVERIFIED_COUNT=$((FAILED_UNVERIFIED_COUNT + 1))
          FAILED_UNVERIFIED_CONTRACTS+=("$CONTRACT")
        fi
      fi
    else
      # Default mode: verify only previously unverified contracts
      if [[ "$INITIAL_STATUS" == "false" || "$INITIAL_STATUS" == "unknown" ]]; then
        if [[ "$RESULT_STATUS" == "VERIFIED" ]]; then
          NEWLY_VERIFIED_COUNT=$((NEWLY_VERIFIED_COUNT + 1))
        elif [[ "$RESULT_STATUS" == "ERROR" ]]; then
          FAILED_UNVERIFIED_COUNT=$((FAILED_UNVERIFIED_COUNT + 1))
          FAILED_UNVERIFIED_CONTRACTS+=("$CONTRACT")
        else
          UNKNOWN_RESULT_COUNT=$((UNKNOWN_RESULT_COUNT + 1))
          UNKNOWN_RESULT_CONTRACTS+=("$CONTRACT")
        fi
      fi
    fi
  done

  # Clean up temporary directory
  rm -rf "$TEMP_DIR"

  # Print summary (even if some verifications failed)
  echo ""
  echo "=========================================="
  echo "  SUMMARY - $NETWORK ($ENVIRONMENT)"
  echo "=========================================="
  echo "Total contracts (with deployments): $TOTAL_CONTRACTS"
  echo "✅ Already verified before run: $ALREADY_VERIFIED_COUNT"
  echo "✅ Newly verified in this run: $NEWLY_VERIFIED_COUNT"
  echo "❌ Still unverified / failed verifications: $FAILED_UNVERIFIED_COUNT"
  if [[ "$VERIFY_ALL" == true ]]; then
    echo "⚠️  Marked verified in log BUT verification failed in this run: $FAILED_MARKED_VERIFIED_COUNT"
  fi
  if [[ "$VERIFY_ALL" == false && $PRECHECK_ERROR_COUNT -gt 0 ]]; then
    echo "⚠️  Pre-check errors (no usable master log entry): $PRECHECK_ERROR_COUNT"
  fi
  if [[ "$VERIFY_ALL" == false && $UNKNOWN_RESULT_COUNT -gt 0 ]]; then
    echo "⚠️  Contracts with unknown verification result (no status recorded): $UNKNOWN_RESULT_COUNT"
  fi
  echo "=========================================="
  echo ""

  # Detailed lists for easier follow-up
  if [[ $FAILED_UNVERIFIED_COUNT -gt 0 ]]; then
    echo "❌ Contracts still unverified / failed verifications:"
    for CONTRACT in "${FAILED_UNVERIFIED_CONTRACTS[@]}"; do
      echo "  - $CONTRACT"
    done
    echo ""
  fi

  if [[ "$VERIFY_ALL" == true && $FAILED_MARKED_VERIFIED_COUNT -gt 0 ]]; then
    echo "⚠️  Contracts marked verified in log BUT failed verification in this run:"
    for CONTRACT in "${FAILED_MARKED_VERIFIED_CONTRACTS[@]}"; do
      echo "  - $CONTRACT"
    done
    echo ""
  fi

  if [[ $UNKNOWN_RESULT_COUNT -gt 0 ]]; then
    echo "⚠️  Contracts with unknown verification result (no status recorded):"
    for CONTRACT in "${UNKNOWN_RESULT_CONTRACTS[@]}"; do
      echo "  - $CONTRACT"
    done
    echo ""
  fi

  if [[ $PRECHECK_ERROR_COUNT -gt 0 ]]; then
    echo "⚠️  Contracts with pre-check errors (no usable master log entry, not sent for verification):"
    for CONTRACT in "${PRECHECK_ERROR_CONTRACTS[@]}"; do
      echo "  - $CONTRACT"
    done
    echo ""
  fi


  return 0
}

# -----------------------------------------------------------------------------
# verifyContractAcrossAllNetworks
# -----------------------------------------------------------------------------

function verifyContractAcrossAllNetworks() {
  # Function: verifyContractAcrossAllNetworks
  # Description: Verifies a specific contract across all included networks.
  #              Skips contracts that are already verified by default and
  #              provides a detailed summary at the end.
  # Arguments:
  #   $1 - ENVIRONMENT: The environment (e.g., "production", "staging")
  #   $2 - CONTRACT: The contract name (e.g., "LiFiDiamond", "Permit2Proxy")
  #   $3 - MODE (optional):
  #        --verify-all  Retry verification even if already marked as verified
  # Returns:
  #   Exit code 0 if all networks processed (regardless of verification status)
  #   Exit code 1 if a critical error occurred
  # Example:
  #   verifyContractAcrossAllNetworks "production" "Permit2Proxy"
  #   verifyContractAcrossAllNetworks "production" "Permit2Proxy" --verify-all

  local ENVIRONMENT="$1"
  local CONTRACT="$2"
  local MODE="${3:-}"

  local VERIFY_ALL=false
  if [[ "$MODE" == "--verify-all" ]]; then
    VERIFY_ALL=true
  fi

  # Validate required parameters
  if [[ -z "$ENVIRONMENT" || -z "$CONTRACT" ]]; then
    error "Usage: verifyContractAcrossAllNetworks <environment> <contract> [--verify-all]"
    error "Example: verifyContractAcrossAllNetworks production Permit2Proxy"
    return 1
  fi

  echo "=========================================="
  echo "  CONTRACT VERIFICATION ACROSS NETWORKS"
  echo "=========================================="
  echo "Contract: $CONTRACT"
  echo "Environment: $ENVIRONMENT"
  echo ""

  # Get list of all included networks
  local NETWORKS=($(getIncludedNetworksArray))
  local TOTAL_NETWORKS=${#NETWORKS[@]}

  if [[ $TOTAL_NETWORKS -eq 0 ]]; then
    warning "No networks found to process"
    return 0
  fi

  if [[ "$VERIFY_ALL" == true ]]; then
    echo "Mode: verify ALL deployments (including those already marked as verified)"
  else
    echo "Mode: verify ONLY unverified deployments (skip already verified)"
  fi
  echo ""

  # Temporary directory to collect per-network metadata and results
  local TEMP_DIR
  TEMP_DIR=$(mktemp -d)

  # Pre-check: determine deployment and verification status for each network
  local DEPLOYED_NETWORK_COUNT=0
  local NOT_DEPLOYED_COUNT=0
  local ALREADY_VERIFIED_COUNT=0
  local PRECHECK_ERROR_COUNT=0

  local TO_VERIFY_NETWORKS=()
  local NOT_DEPLOYED_NETWORKS=()
  local PRECHECK_ERROR_NETWORKS=()

  for NETWORK in "${NETWORKS[@]}"; do
    # Determine highest deployed version for this network
    local VERSION=""
    if ! VERSION=$(getHighestDeployedContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$CONTRACT" 2>/dev/null); then
      VERSION=""
    fi

    if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
      # Treat as not deployed on this network
      NOT_DEPLOYED_COUNT=$((NOT_DEPLOYED_COUNT + 1))
      NOT_DEPLOYED_NETWORKS+=("$NETWORK")
      echo "not_deployed" >"$TEMP_DIR/${NETWORK}.initial_status"
      continue
    fi

    # Try to get log entry for this deployment
    local LOG_ENTRY=""
    if ! LOG_ENTRY=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" 2>/dev/null); then
      LOG_ENTRY=""
    fi

    if [[ -z "$LOG_ENTRY" || "$LOG_ENTRY" == "null" || "$LOG_ENTRY" == *"No matching entry found"* ]]; then
      PRECHECK_ERROR_COUNT=$((PRECHECK_ERROR_COUNT + 1))
      PRECHECK_ERROR_NETWORKS+=("$NETWORK")
      echo "precheck_error" >"$TEMP_DIR/${NETWORK}.initial_status"
      continue
    fi

    DEPLOYED_NETWORK_COUNT=$((DEPLOYED_NETWORK_COUNT + 1))

    local CURRENT_VERIFIED
    CURRENT_VERIFIED=$(echo "$LOG_ENTRY" | jq -r ".VERIFIED // empty" 2>/dev/null)

    if [[ "$CURRENT_VERIFIED" == "true" ]]; then
      ALREADY_VERIFIED_COUNT=$((ALREADY_VERIFIED_COUNT + 1))
      echo "true" >"$TEMP_DIR/${NETWORK}.initial_status"

      if [[ "$VERIFY_ALL" == true ]]; then
        TO_VERIFY_NETWORKS+=("$NETWORK")
      else
        echo "[$NETWORK] $CONTRACT is already marked as verified - skipping in default mode"
      fi
    else
      echo "false" >"$TEMP_DIR/${NETWORK}.initial_status"
      TO_VERIFY_NETWORKS+=("$NETWORK")
    fi
  done

  local TOTAL_TO_VERIFY=${#TO_VERIFY_NETWORKS[@]}

  echo ""
  echo "Networks to process: $TOTAL_NETWORKS"
  echo "Networks where contract is deployed: $DEPLOYED_NETWORK_COUNT"
  echo "Networks where contract is not deployed: $NOT_DEPLOYED_COUNT"
  if [[ $PRECHECK_ERROR_COUNT -gt 0 ]]; then
    echo "Networks with pre-check errors (no usable master log entry): $PRECHECK_ERROR_COUNT"
  fi
  echo "Deployments that will be actively verified in this run: $TOTAL_TO_VERIFY"
  echo "Deployments already marked as verified before this run: $ALREADY_VERIFIED_COUNT"
  echo ""

  # If there is nothing to verify, print summary and exit early
  if [[ $TOTAL_TO_VERIFY -eq 0 ]]; then
    echo "Nothing to verify in this run."
    echo ""
    echo "=========================================="
    echo "  SUMMARY - $CONTRACT ($ENVIRONMENT)"
    echo "=========================================="
    echo "Total networks checked: $TOTAL_NETWORKS"
    echo "Networks where contract is deployed: $DEPLOYED_NETWORK_COUNT"
    echo "Networks where contract is not deployed: $NOT_DEPLOYED_COUNT"
    echo "✅ Already verified before run: $ALREADY_VERIFIED_COUNT"
    echo "⚠️  Pre-check errors (no usable master log entry): $PRECHECK_ERROR_COUNT"
    echo "=========================================="
    echo ""
    rm -rf "$TEMP_DIR"
    return 0
  fi

  # Determine concurrency (fallback to 10 if not configured)
  local CONCURRENCY=${MAX_CONCURRENT_JOBS:-10}
  if [[ -z "$CONCURRENCY" || "$CONCURRENCY" -le 0 ]]; then
    CONCURRENCY=10
  fi

  echo "Using parallel verification with max $CONCURRENCY concurrent jobs"
  echo ""

  # Iterate through each network that should be verified and run in parallel with concurrency control
  for NETWORK in "${TO_VERIFY_NETWORKS[@]}"; do
    echo "----------------------------------------"
    echo "Checking: $CONTRACT on $NETWORK"
    echo "----------------------------------------"

    # Throttle background jobs
    while [[ $(jobs | wc -l | tr -d ' ') -ge $CONCURRENCY ]]; do
      sleep 0.1
    done

    (
      # Disable 'set -e' inside this subshell so we always record a result,
      # even if underlying verification commands fail.
      set +e

      local NETWORK_NAME="$NETWORK"
      local RESULT_FILE="$TEMP_DIR/${NETWORK_NAME}.result"

      getContractVerified "$NETWORK_NAME" "$ENVIRONMENT" "$CONTRACT"
      local EXIT_CODE=$?

      case $EXIT_CODE in
        0)
          echo "VERIFIED" >"$RESULT_FILE"
          ;;
        *)
          echo "ERROR" >"$RESULT_FILE"
          ;;
      esac
    ) &
  done

  # Wait for all background jobs to finish (do not fail early if some verifications fail)
  wait || true

  # Track results
  local NEWLY_VERIFIED_COUNT=0
  local FAILED_UNVERIFIED_COUNT=0
  local FAILED_MARKED_VERIFIED_COUNT=0
  local UNKNOWN_RESULT_COUNT=0

  local FAILED_UNVERIFIED_NETWORKS=()
  local FAILED_MARKED_VERIFIED_NETWORKS=()
  local UNKNOWN_RESULT_NETWORKS=()

  # Aggregate results using initial verification status and per-network results
  for NETWORK in "${NETWORKS[@]}"; do
    local INITIAL_FILE="$TEMP_DIR/${NETWORK}.initial_status"
    local RESULT_FILE="$TEMP_DIR/${NETWORK}.result"

    local INITIAL_STATUS="unknown"
    if [[ -f "$INITIAL_FILE" ]]; then
      INITIAL_STATUS=$(<"$INITIAL_FILE")
    fi

    # Skip networks where contract is not deployed or had pre-check errors
    if [[ "$INITIAL_STATUS" == "not_deployed" || "$INITIAL_STATUS" == "precheck_error" ]]; then
      continue
    fi

    local RESULT_STATUS="none"
    if [[ -f "$RESULT_FILE" ]]; then
      RESULT_STATUS=$(<"$RESULT_FILE")
    fi

    if [[ "$VERIFY_ALL" == true ]]; then
      # In verify-all mode, highlight verified-but-failing separately
      if [[ "$RESULT_STATUS" == "VERIFIED" ]]; then
        if [[ "$INITIAL_STATUS" == "false" || "$INITIAL_STATUS" == "unknown" ]]; then
          NEWLY_VERIFIED_COUNT=$((NEWLY_VERIFIED_COUNT + 1))
        fi
      elif [[ "$RESULT_STATUS" == "ERROR" ]]; then
        if [[ "$INITIAL_STATUS" == "true" ]]; then
          FAILED_MARKED_VERIFIED_COUNT=$((FAILED_MARKED_VERIFIED_COUNT + 1))
          FAILED_MARKED_VERIFIED_NETWORKS+=("$NETWORK")
        else
          FAILED_UNVERIFIED_COUNT=$((FAILED_UNVERIFIED_COUNT + 1))
          FAILED_UNVERIFIED_NETWORKS+=("$NETWORK")
        fi
      else
        # No clear result recorded (e.g. job crashed) – treat conservatively as failed/unverified
        FAILED_UNVERIFIED_COUNT=$((FAILED_UNVERIFIED_COUNT + 1))
        FAILED_UNVERIFIED_NETWORKS+=("$NETWORK")
        UNKNOWN_RESULT_COUNT=$((UNKNOWN_RESULT_COUNT + 1))
        UNKNOWN_RESULT_NETWORKS+=("$NETWORK")
      fi
    else
      # Default mode: verify only previously unverified deployments
      if [[ "$INITIAL_STATUS" == "false" || "$INITIAL_STATUS" == "unknown" ]]; then
        if [[ "$RESULT_STATUS" == "VERIFIED" ]]; then
          NEWLY_VERIFIED_COUNT=$((NEWLY_VERIFIED_COUNT + 1))
        elif [[ "$RESULT_STATUS" == "ERROR" ]]; then
          FAILED_UNVERIFIED_COUNT=$((FAILED_UNVERIFIED_COUNT + 1))
          FAILED_UNVERIFIED_NETWORKS+=("$NETWORK")
        else
          # No clear result recorded – treat conservatively as failed/unverified
          FAILED_UNVERIFIED_COUNT=$((FAILED_UNVERIFIED_COUNT + 1))
          FAILED_UNVERIFIED_NETWORKS+=("$NETWORK")
          UNKNOWN_RESULT_COUNT=$((UNKNOWN_RESULT_COUNT + 1))
          UNKNOWN_RESULT_NETWORKS+=("$NETWORK")
        fi
      fi
    fi
  done

  # Clean up temporary directory
  rm -rf "$TEMP_DIR"

  # Print summary (even if some verifications failed)
  echo ""
  echo "=========================================="
  echo "  SUMMARY - $CONTRACT ($ENVIRONMENT)"
  echo "=========================================="
  echo "Total networks checked: $TOTAL_NETWORKS"
  echo "Networks where contract is deployed: $DEPLOYED_NETWORK_COUNT"
  echo "Networks where contract is not deployed: $NOT_DEPLOYED_COUNT"
  echo "✅ Already verified before run: $ALREADY_VERIFIED_COUNT"
  echo "✅ Newly verified in this run: $NEWLY_VERIFIED_COUNT"
  echo "❌ Still unverified / failed verifications: $FAILED_UNVERIFIED_COUNT"
  if [[ "$VERIFY_ALL" == true ]]; then
    echo "⚠️  Marked verified in log BUT verification failed in this run: $FAILED_MARKED_VERIFIED_COUNT"
  fi
  if [[ $PRECHECK_ERROR_COUNT -gt 0 ]]; then
    echo "⚠️  Pre-check errors (no usable master log entry): $PRECHECK_ERROR_COUNT"
  fi
  if [[ "$VERIFY_ALL" == false && $UNKNOWN_RESULT_COUNT -gt 0 ]]; then
    echo "⚠️  Networks with unknown verification result (no status recorded): $UNKNOWN_RESULT_COUNT"
  fi
  echo "=========================================="
  echo ""

  # Detailed lists for easier follow-up
  if [[ $FAILED_UNVERIFIED_COUNT -gt 0 ]]; then
    echo "❌ Networks where verification failed or deployment remains unverified:"
    for NETWORK in "${FAILED_UNVERIFIED_NETWORKS[@]}"; do
      echo "  - $NETWORK"
    done
    echo ""
  fi

  if [[ "$VERIFY_ALL" == true && $FAILED_MARKED_VERIFIED_COUNT -gt 0 ]]; then
    echo "⚠️  Networks marked verified in log BUT failed verification in this run:"
    for NETWORK in "${FAILED_MARKED_VERIFIED_NETWORKS[@]}"; do
      echo "  - $NETWORK"
    done
    echo ""
  fi

  if [[ $UNKNOWN_RESULT_COUNT -gt 0 ]]; then
    echo "⚠️  Networks with unknown verification result (no status recorded):"
    for NETWORK in "${UNKNOWN_RESULT_NETWORKS[@]}"; do
      echo "  - $NETWORK"
    done
    echo ""
  fi

  if [[ $NOT_DEPLOYED_COUNT -gt 0 ]]; then
    echo "❌ Networks where contract is not deployed:"
    for NETWORK in "${NOT_DEPLOYED_NETWORKS[@]}"; do
      echo "  - $NETWORK"
    done
    echo ""
  fi

  if [[ $PRECHECK_ERROR_COUNT -gt 0 ]]; then
    echo "⚠️  Networks with pre-check errors (no usable master log entry, not sent for verification):"
    for NETWORK in "${PRECHECK_ERROR_NETWORKS[@]}"; do
      echo "  - $NETWORK"
    done
    echo ""
  fi

  return 0
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
# NETWORK UTILITY FUNCTIONS
# =============================================================================

function getNetworkEvmVersion() {
    local NETWORK="$1"

    if [[ -z "$NETWORK" ]]; then
        error "Network name is required"
        return 1
    fi

    # Check if network exists in networks.json
    if ! jq -e --arg network "$NETWORK" '.[$network] != null' "$NETWORKS_JSON_FILE_PATH" > /dev/null; then
        error "Network '$NETWORK' not found in networks.json"
        return 1
    fi

    # Get EVM version
    local EVM_VERSION=$(jq -r --arg network "$NETWORK" '.[$network].deployedWithEvmVersion // empty' "$NETWORKS_JSON_FILE_PATH")

    if [[ -z "$EVM_VERSION" || "$EVM_VERSION" == "null" ]]; then
        error "EVM version not defined for network '$NETWORK' in networks.json"
        return 1
    fi

    echo "$EVM_VERSION"
}

function getNetworkSolcVersion() {
    local NETWORK="$1"

    if [[ -z "$NETWORK" ]]; then
        error "Network name is required"
        return 1
    fi

    # Check if network exists in networks.json
    if ! jq -e --arg network "$NETWORK" '.[$network] != null' "$NETWORKS_JSON_FILE_PATH" > /dev/null; then
        error "Network '$NETWORK' not found in networks.json"
        return 1
    fi

    # Get Solidity version
    local SOLC_VERSION=$(jq -r --arg network "$NETWORK" '.[$network].deployedWithSolcVersion // empty' "$NETWORKS_JSON_FILE_PATH")

    if [[ -z "$SOLC_VERSION" || "$SOLC_VERSION" == "null" ]]; then
        error "Solc version not defined for network '$NETWORK' in networks.json"
        return 1
    fi

    echo "$SOLC_VERSION"
}

function isZkEvmNetwork() {
    local NETWORK="$1"

    if [[ -z "$NETWORK" ]]; then
        error "Network name is required"
        return 1
    fi

    # Check if network exists in networks.json
    if ! jq -e --arg network "$NETWORK" '.[$network] != null' "$NETWORKS_JSON_FILE_PATH" > /dev/null; then
        error "Network '$NETWORK' not found in networks.json"
        return 1
    fi

    # Get isZkEVM value
    local IS_ZKEVM=$(jq -r --arg network "$NETWORK" '.[$network].isZkEVM // false' "$NETWORKS_JSON_FILE_PATH")

    if [[ "$IS_ZKEVM" == "true" ]]; then
        return 0  # Success (true)
    else
        return 1  # Failure (false)
    fi
}

function getNetworkGroup() {
    local NETWORK="$1"

    if [[ -z "$NETWORK" ]]; then
        error "Network name is required"
        return 1
    fi

    # Check if it's a zkEVM network first
    if isZkEvmNetwork "$NETWORK"; then
        echo "zkevm"
        return 0
    fi

    # Get EVM version
    local EVM_VERSION=$(getNetworkEvmVersion "$NETWORK")
    if [[ $? -ne 0 ]]; then
        return 1
    fi

    case "$EVM_VERSION" in
        "london")
            echo "london"
            ;;
        "cancun")
            echo "cancun"
            ;;
        *)
            error "Unsupported EVM version '$EVM_VERSION' for network '$NETWORK'"
            return 1
            ;;
    esac
}

function isContractAlreadyDeployed() {
    # Check if a contract is already deployed to a network
    local CONTRACT="$1"
    local NETWORK="$2"
    local ENVIRONMENT="$3"

    # Check if contract address exists in deployments file
    local FILE_SUFFIX
    FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")
    local DEPLOYMENT_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"
    if [[ -f "$DEPLOYMENT_FILE" ]]; then
        local CONTRACT_ADDRESS=$(jq -r --arg contract "$CONTRACT" '.[$contract] // empty' "$DEPLOYMENT_FILE")
        if [[ -n "$CONTRACT_ADDRESS" && "$CONTRACT_ADDRESS" != "null" && "$CONTRACT_ADDRESS" != "" ]]; then
            return 0  # Contract is deployed
        fi
    fi

    return 1  # Contract is not deployed
}

function isContractAlreadyVerified() {
    # Check if a contract is already verified on a network
    local CONTRACT="$1"
    local NETWORK="$2"
    local ENVIRONMENT="$3"

    # Get the highest deployed version for this contract
    local VERSION=$(getHighestDeployedContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$CONTRACT")
    if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
        return 1  # No deployed version found
    fi

    # Check if contract is verified in master log
    local LOG_ENTRY=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION")
    if [[ $? -ne 0 || -z "$LOG_ENTRY" || "$LOG_ENTRY" == "null" ]]; then
        return 1  # No log entry found
    fi

    # Extract verification status
    local VERIFIED=$(echo "$LOG_ENTRY" | jq -r ".VERIFIED" 2>/dev/null)
    if [[ "$VERIFIED" == "true" ]]; then
        return 0  # Contract is verified
    fi

    return 1  # Contract is not verified
}

# =============================================================================
# LOGGING UTILITY FUNCTIONS
# =============================================================================

function logWithTimestamp() {
    local MESSAGE="$1"
    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$TIMESTAMP] $MESSAGE"
}

function logNetworkResult() {
    local NETWORK="$1"
    local STATUS="$2"
    local MESSAGE="$3"
    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$TIMESTAMP] [$NETWORK] $STATUS: $MESSAGE"
}

# =============================================================================
# MULTISIG PROPOSAL FUNCTIONS
# =============================================================================

function createMultisigProposalForContract() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local CONTRACT="$3"

  # Check if this proposal has already been successfully created for this network
  local PROPOSAL_TRACKING_FILE=".proposal_tracking_${CONTRACT}_${ENVIRONMENT}.json"

  # Initialize tracking file if it doesn't exist
  if [[ ! -f "$PROPOSAL_TRACKING_FILE" ]]; then
    echo '{}' >"$PROPOSAL_TRACKING_FILE"
  fi

  # Check if this network already has a successful proposal for this contract
  local ALREADY_PROPOSED=$(jq -r --arg network "$NETWORK" '.[$network] // false' "$PROPOSAL_TRACKING_FILE")

  if [[ "$ALREADY_PROPOSED" == "true" ]]; then
    echo "[$NETWORK] ✅ Proposal for $CONTRACT already successfully created - skipping"
    return 0
  fi

  # Check if contract name contains "Facet"
  if [[ "$CONTRACT" == *"Facet"* ]]; then
    echo "[$NETWORK] Detected facet contract: $CONTRACT"
    proposeDiamondCutForContract "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$PROPOSAL_TRACKING_FILE"
  else
    echo "[$NETWORK] Detected periphery contract: $CONTRACT"
    proposePeripheryContractRegistration "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$PROPOSAL_TRACKING_FILE"
  fi

  if [[ $? -eq 0 ]]; then
    return 0
  else
    return 1
  fi
}

function proposeDiamondCutForContract() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local CONTRACT="$3"
  local PROPOSAL_TRACKING_FILE="$4"

  echo "[$NETWORK] 🔄 Creating diamond cut proposal for $CONTRACT..."

  # Execute the diamond cut proposal
  diamondUpdateFacet "$NETWORK" "$ENVIRONMENT" "LiFiDiamond" "Update$CONTRACT" false

  local PROPOSAL_STATUS=$?

  if [[ $PROPOSAL_STATUS -eq 0 ]]; then
    # Mark this network as successfully proposed
    jq --arg network "$NETWORK" --argjson value true '.[$network] = $value' "$PROPOSAL_TRACKING_FILE" >"${PROPOSAL_TRACKING_FILE}.tmp" && mv "${PROPOSAL_TRACKING_FILE}.tmp" "$PROPOSAL_TRACKING_FILE"

    success "[$NETWORK] Successfully created diamond cut proposal for $CONTRACT"
    return 0
  fi

  error "[$NETWORK] Failed to create diamond cut proposal for $CONTRACT"
  return 1
}

function proposePeripheryContractRegistration() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local CONTRACT="$3"
  local PROPOSAL_TRACKING_FILE="$4"

  # Validate dependencies
  if ! validateDependencies; then
    error "[$NETWORK] Dependency validation failed"
    return 1
  fi

  echo "[$NETWORK] 🔄 Creating periphery registration proposal for $CONTRACT..."

  # Get contract address and diamond address
  local CONTRACT_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$CONTRACT")
  local DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")
  local RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")

  if [[ -z "$CONTRACT_ADDRESS" || "$CONTRACT_ADDRESS" == "null" ]]; then
    error "[$NETWORK] No address found for $CONTRACT"
    return 1
  fi

  if [[ -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" ]]; then
    error "[$NETWORK] No diamond address found"
    return 1
  fi

  # Create calldata for registerPeripheryContract
  local CALLDATA=$(cast calldata "registerPeripheryContract(string,address)" "$CONTRACT" "$CONTRACT_ADDRESS")

  # Propose to safe
  bunx tsx ./script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl "$RPC_URL" --timelock --privateKey "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")"

  local PROPOSAL_STATUS=$?

  if [[ $PROPOSAL_STATUS -eq 0 ]]; then
    # Mark this network as successfully proposed
    jq --arg network "$NETWORK" --argjson value true '.[$network] = $value' "$PROPOSAL_TRACKING_FILE" >"${PROPOSAL_TRACKING_FILE}.tmp" && mv "${PROPOSAL_TRACKING_FILE}.tmp" "$PROPOSAL_TRACKING_FILE"

    success "[$NETWORK] Successfully created periphery registration proposal for $CONTRACT"
    return 0
  fi

  error "[$NETWORK] Failed to create periphery registration proposal for $CONTRACT"
  return 1
}

# =============================================================================
# DEPENDENCY VALIDATION FUNCTIONS
# =============================================================================

function validateDependencies() {
  local missing_deps=()

  command -v cast >/dev/null 2>&1 || missing_deps+=("cast")
  command -v bunx >/dev/null 2>&1 || missing_deps+=("bunx")
  command -v jq >/dev/null 2>&1 || missing_deps+=("jq")

  if [[ ${#missing_deps[@]} -gt 0 ]]; then
    error "Missing required dependencies: ${missing_deps[*]}"
    return 1
  fi

  if [[ ! -f "./script/deploy/safe/propose-to-safe.ts" ]]; then
    error "Missing propose-to-safe.ts script"
    return 1
  fi

  return 0
}

# =============================================================================
# DEPLOYMENT AND VERIFICATION FUNCTIONS
# =============================================================================

function deployContract() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local CONTRACT="$3"

  local VERSION=$(getCurrentContractVersion "$CONTRACT")
  if [[ -z "$VERSION" ]]; then
    error "[$NETWORK] No version found for $CONTRACT"
    return 1
  fi

  deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION"

  if [[ $? -eq 0 ]]; then
    success "[$NETWORK] Successfully deployed $CONTRACT"
    return 0
  else
    error "[$NETWORK] Failed to deploy $CONTRACT"
    return 1
  fi
}

function getContractDeploymentStatusSummary() {
  local ENVIRONMENT="$1"
  local CONTRACT="$2"
  local VERSION="$3"

  # Validate required parameters
  if [[ -z "$ENVIRONMENT" || -z "$CONTRACT" ]]; then
    error "Usage: getContractDeploymentStatusSummary ENVIRONMENT CONTRACT [VERSION]"
    error "Example: getContractDeploymentStatusSummary production Permit2Proxy 1.0.4"
    return 1
  fi

  # If no version provided, get current version
  if [[ -z "$VERSION" ]]; then
    VERSION=$(getCurrentContractVersion "$CONTRACT")
    if [[ -z "$VERSION" ]]; then
      error "Could not determine version for contract $CONTRACT"
      return 1
    fi
  fi

  # Get list of all supported networks
  local NETWORKS=($(getIncludedNetworksArray))

  echo ""
  echo "=========================================="
  echo "  DEPLOYMENT STATUS SUMMARY"
  echo "=========================================="
  echo "Contract: $CONTRACT"
  echo "Version: $VERSION"
  echo "Environment: $ENVIRONMENT"
  echo "Networks to check: ${#NETWORKS[@]}"
  echo ""

  # Initialize arrays to track results
  local DEPLOYED_VERIFIED=()
  local DEPLOYED_UNVERIFIED=()
  local NOT_DEPLOYED=()
  local TOTAL_NETWORKS=${#NETWORKS[@]}

  # Print table header
  printf "%-20s %-10s %-10s %-42s\n" "NETWORK" "DEPLOYED" "VERIFIED" "ADDRESS"
  printf "%-20s %-10s %-10s %-42s\n" "--------------------" "----------" "----------" "------------------------------------------"

  # Check each network
  for network in "${NETWORKS[@]}"; do
    # Check if contract is deployed - use a more robust approach
    local LOG_ENTRY=""
    local FIND_RESULT=1

    # Try to find the contract and capture both output and exit code
    LOG_ENTRY=$(findContractInMasterLog "$CONTRACT" "$network" "$ENVIRONMENT" "$VERSION" 2>/dev/null)
    FIND_RESULT=$?

    # Additional check: if LOG_ENTRY contains error message, treat as not found
    if [[ "$LOG_ENTRY" == *"No matching entry found"* ]]; then
      FIND_RESULT=1
    fi

    if [[ $FIND_RESULT -eq 0 && -n "$LOG_ENTRY" && "$LOG_ENTRY" != "null" ]]; then
      # Contract is deployed
      local ADDRESS=$(echo "$LOG_ENTRY" | jq -r ".ADDRESS" 2>/dev/null)
      local VERIFIED=$(echo "$LOG_ENTRY" | jq -r ".VERIFIED" 2>/dev/null)

      # Handle cases where jq fails or returns null
      if [[ "$ADDRESS" == "null" || -z "$ADDRESS" ]]; then
        ADDRESS="N/A"
      fi
      if [[ "$VERIFIED" == "null" || -z "$VERIFIED" ]]; then
        VERIFIED="false"
      fi

      if [[ "$VERIFIED" == "true" ]]; then
        printf "%-20s %-10s %-10s %-42s\n" "$network" "✅" "✅" "$ADDRESS"
        DEPLOYED_VERIFIED+=("$network")
      else
        printf "%-20s %-10s %-10s %-42s\n" "$network" "✅" "❌" "$ADDRESS"
        DEPLOYED_UNVERIFIED+=("$network")
      fi
    else
      # Contract is not deployed
      printf "%-20s %-10s %-10s %-42s\n" "$network" "❌" "N/A" "N/A"
      NOT_DEPLOYED+=("$network")
    fi
  done

  echo ""
  echo "=========================================="
  echo "  SUMMARY STATISTICS"
  echo "=========================================="
  echo "Total networks: $TOTAL_NETWORKS"
  echo "✅ Deployed & Verified: ${#DEPLOYED_VERIFIED[@]}"
  echo "⚠️  Deployed but Unverified: ${#DEPLOYED_UNVERIFIED[@]}"
  echo "❌ Not Deployed: ${#NOT_DEPLOYED[@]}"
  echo ""

  # Show detailed lists
  if [[ ${#DEPLOYED_VERIFIED[@]} -gt 0 ]]; then
    echo "✅ NETWORKS WITH DEPLOYED & VERIFIED CONTRACTS (${#DEPLOYED_VERIFIED[@]}):"
    printf "  %s\n" "${DEPLOYED_VERIFIED[@]}"
    echo ""
  fi

  if [[ ${#DEPLOYED_UNVERIFIED[@]} -gt 0 ]]; then
    echo "⚠️  NETWORKS WITH DEPLOYED BUT UNVERIFIED CONTRACTS (${#DEPLOYED_UNVERIFIED[@]}):"
    printf "  %s\n" "${DEPLOYED_UNVERIFIED[@]}"
    echo ""
  fi

  if [[ ${#NOT_DEPLOYED[@]} -gt 0 ]]; then
    echo "❌ NETWORKS WHERE CONTRACT IS NOT DEPLOYED (${#NOT_DEPLOYED[@]}):"
    printf "  %s\n" "${NOT_DEPLOYED[@]}"
    echo ""

    # Provide retry command for networks that need deployment
    echo "🔄 To deploy to remaining networks, use:"
    echo "  local NETWORKS=($(printf '"%s" ' "${NOT_DEPLOYED[@]}" | sed 's/ $//'))"
    echo ""
  fi

  echo "=========================================="
}

function compareContractBytecode() {
  # Function: compareContractBytecode
  # Description: Compares bytecode of a contract deployed on two different networks
  # Arguments:
  #   $1 - CONTRACT_NAME: The contract name to compare (optional, defaults to "Permit2Proxy")
  #   $2 - ENVIRONMENT: The environment (optional, defaults to "production")
  #   $3 - NETWORK1: First network to compare (optional, defaults to "mainnet")
  #   $4 - NETWORK2: Second network to compare (optional, defaults to "arbitrum")
  # Returns:
  #   0 on success, 1 on failure
  # Example:
  #   compareContractBytecode "Permit2Proxy" "production" "mainnet" "arbitrum"
  #   compareContractBytecode  # Uses defaults

  # Validate dependencies
  if ! validateDependencies; then
    error "Dependency validation failed"
    return 1
  fi

  # Set default values if not provided
  local CONTRACT_NAME="${1:-Permit2Proxy}"
  local ENVIRONMENT="${2:-production}"
  local NETWORK1="${3:-mainnet}"
  local NETWORK2="${4:-arbitrum}"

  # Get contract addresses
  local ADDRESS1=$(getContractAddressFromDeploymentLogs "$NETWORK1" "$ENVIRONMENT" "$CONTRACT_NAME")
  if [[ -z "$ADDRESS1" || "$ADDRESS1" == "null" ]]; then
    error "[$NETWORK1] No address found for $CONTRACT_NAME"
    return 1
  fi

  local ADDRESS2=$(getContractAddressFromDeploymentLogs "$NETWORK2" "$ENVIRONMENT" "$CONTRACT_NAME")
  if [[ -z "$ADDRESS2" || "$ADDRESS2" == "null" ]]; then
    error "[$NETWORK2] No address found for $CONTRACT_NAME"
    return 1
  fi

  # --------- FETCH RPC URLS ---------
  local RPC_URL1=$(getRPCUrl "$NETWORK1" "$ENVIRONMENT")
  local RPC_URL2=$(getRPCUrl "$NETWORK2" "$ENVIRONMENT")

  # --------- FETCH BYTECODES ---------
  local CODE1=$(cast code "$ADDRESS1" --rpc-url "$RPC_URL1")
  local CODE2=$(cast code "$ADDRESS2" --rpc-url "$RPC_URL2")

  echo ""
  echo "===== BYTECODE COMPARISON ====="
  echo "Contract 1: $CONTRACT_NAME ($NETWORK1) at $ADDRESS1"
  echo "Contract 2: $CONTRACT_NAME ($NETWORK2) at $ADDRESS2"
  echo ""
  echo "--- BYTECODE 1 (first 64 chars): ${CODE1:0:64}..."
  echo "--- BYTECODE 2 (first 64 chars): ${CODE2:0:64}..."
  echo ""

  # --------- COMPARE (CASE-INSENSITIVE) ---------
  local CODE1_NORM=$(echo "$CODE1" | tr '[:upper:]' '[:lower:]')
  local CODE2_NORM=$(echo "$CODE2" | tr '[:upper:]' '[:lower:]')

  echo ""
  echo "CODE1_NORM: $CODE1_NORM"
  echo ""
  echo "CODE2_NORM: $CODE2_NORM"
  echo ""

  if [[ "$CODE1_NORM" == "$CODE2_NORM" ]]; then
    echo "✅ Bytecode matches (case-insensitive)"
  else
    echo "❌ Bytecode does not match (case-insensitive)"
  fi

  # --------- STRIP SOLIDITY METADATA AND COMPARE ---------
  strip_metadata() {
    echo "$1" | sed -E 's/a26[0-9a-f]{2}.*$//' | sed -E 's/a16[0-9a-f]{2}.*$//'
  }
  local CODE1_STRIPPED=$(strip_metadata "$CODE1_NORM")
  local CODE2_STRIPPED=$(strip_metadata "$CODE2_NORM")

  if [[ "$CODE1_STRIPPED" == "$CODE2_STRIPPED" ]]; then
    echo "✅ Bytecode matches after stripping metadata"
  else
    echo "❌ Bytecode does not match after stripping metadata"
  fi

  # --------- COMPUTE KECCAK HASHES AND COMPARE ---------
  local HASH1=$(echo -n "$CODE1_NORM" | cast keccak)
  local HASH2=$(echo -n "$CODE2_NORM" | cast keccak)

  echo ""
  echo "HASH1 ($NETWORK1): $HASH1"
  echo "HASH2 ($NETWORK2): $HASH2"
  echo ""

  if [[ "$HASH1" == "$HASH2" ]]; then
    echo "✅ Bytecode (keccak hash) matches"
  else
    echo "❌ Bytecode (keccak hash) does not match"
  fi

  echo ""
  echo "(Full bytecodes are available in CODE1 and CODE2 variables for further inspection)"
}

function analyzeFailingTx() {
  # Function: analyzeFailingTx
  # Description: Analyzes a failing transaction hash using cast run, receipt fetch, and trace attempts
  # Arguments:
  #   $1 - TX_HASH: Transaction hash to analyze
  #   $2 - RPC_URL: RPC URL for the transaction (required)
  # Returns:
  #   0 on success, 1 on failure
  # Example:
  #   analyzeFailingTx "0xedc3d7580e0b333f7c232649b0506aa3e811b0f5060d84e75a91b0dec68b4cc9" "<RPC_URL>"

  local TX_HASH="$1"
  local RPC_URL="$2"

  # Validate required parameters
  if [[ -z "$TX_HASH" ]]; then
    error "Usage: analyzeFailingTx TX_HASH RPC_URL"
    error "Example: analyzeFailingTx 0xedc3d7580e0b333f7c232649b0506aa3e811b0f5060d84e75a91b0dec68b4cc9 <RPC_URL>"
    return 1
  fi

  if [[ -z "$RPC_URL" ]]; then
    error "RPC_URL is required"
    error "Usage: analyzeFailingTx TX_HASH RPC_URL"
    error "Example: analyzeFailingTx 0xedc3d7580e0b333f7c232649b0506aa3e811b0f5060d84e75a91b0dec68b4cc9 <RPC_URL>"
    return 1
  fi

  echo "Analyzing transaction: $TX_HASH with RPC URL: $RPC_URL"
  echo ""

  # Step 1: Run cast run
  echo "------- Step 1: Running cast run -------"
  echo ""
  cast run "$TX_HASH" --rpc-url "$RPC_URL" || true
  # cast run "$TX_HASH" --rpc-url "$RPC_URL" --trace-printer|| true
  echo ""
  echo "-------"
  echo ""

  # Step 2: Fetch transaction receipt
  echo "------- Step 2: Fetching transaction receipt -------"
  echo ""
  local RECEIPT_RESPONSE
  RECEIPT_RESPONSE=$(curl -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    --data "{
      \"jsonrpc\":\"2.0\",
      \"method\":\"eth_getTransactionReceipt\",
      \"params\":[\"$TX_HASH\"],
      \"id\":1
    }" 2>&1)

  if [[ $? -eq 0 ]]; then
    echo "$RECEIPT_RESPONSE" | jq '.' 2>/dev/null || echo "$RECEIPT_RESPONSE"
  else
    error "Failed to fetch transaction receipt: $RECEIPT_RESPONSE"
  fi
  echo ""
  echo "-------"
  echo ""

  # Step 3: Attempt to fetch traces
  echo "------- Step 3: Attempting to fetch traces -------"
  echo ""
  local TRACE_RESPONSE
  TRACE_RESPONSE=$(curl -X POST "$RPC_URL" \
    -H "Content-Type: application/json" \
    --data "{
      \"jsonrpc\":\"2.0\",
      \"method\":\"debug_traceTransaction\",
      \"params\":[
        \"$TX_HASH\",
        {
          \"tracer\": \"callTracer\",
          \"timeout\": \"30s\"
        }
      ],
      \"id\":1
    }" 2>&1)

  if [[ $? -eq 0 ]]; then
    echo "$TRACE_RESPONSE" | jq '.' 2>/dev/null || echo "$TRACE_RESPONSE"
    # Check if response contains an error field
    if echo "$TRACE_RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
      error "Trace fetch returned error: $(echo "$TRACE_RESPONSE" | jq -r '.error')"
    fi
  else
    error "Failed to fetch traces: $TRACE_RESPONSE"
  fi
  echo ""
  echo "-------"
  echo ""
}

# =============================================================================
# SYNC FUNCTIONS
# =============================================================================

function syncSigsAndDEXsForNetwork() {
  local NETWORK="${1}"
  local ENVIRONMENT="${2:-production}"

  if [[ -z "$NETWORK" ]]; then
    error "Network is required"
    echo "Usage: syncSigsAndDEXsForNetwork <network> [environment]"
    return 1
  fi

  echo "=========================================="
  echo "Syncing Sigs and DEXs for network"
  echo "Network: $NETWORK"
  echo "Environment: $ENVIRONMENT"
  echo "=========================================="
  echo ""

  # Run both syncs in parallel
  echo "[$NETWORK] Starting syncSigs and syncDEXs in parallel..."
  diamondSyncSigs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond" "" &
  SIGS_PID=$!
  diamondSyncDEXs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond" &
  DEXS_PID=$!

  # Wait for both to complete
  wait $SIGS_PID
  local SIGS_RESULT=$?
  wait $DEXS_PID
  local DEXS_RESULT=$?

  echo ""
  if [[ $SIGS_RESULT -eq 0 && $DEXS_RESULT -eq 0 ]]; then
    success "[$NETWORK] Both syncSigs and syncDEXs completed successfully"
    return 0
  else
    if [[ $SIGS_RESULT -ne 0 ]]; then
      error "[$NETWORK] syncSigs failed with exit code $SIGS_RESULT"
    fi
    if [[ $DEXS_RESULT -ne 0 ]]; then
      error "[$NETWORK] syncDEXs failed with exit code $DEXS_RESULT"
    fi
    return 1
  fi
}

# =============================================================================
# EXPORT FUNCTIONS FOR USE IN OTHER SCRIPTS
# =============================================================================

# Make functions available to other scripts
export -f getContractVerified
export -f verifyAllContractsForNetwork
export -f verifyContractAcrossAllNetworks
export -f getNetworksByEvmVersionAndContractDeployment
export -f createMultisigProposalForContract
export -f proposeDiamondCutForContract
export -f proposePeripheryContractRegistration
export -f validateDependencies
export -f deployContract
export -f getContractDeploymentStatusSummary
export -f compareContractBytecode
export -f getNetworkEvmVersion
export -f getNetworkSolcVersion
export -f isZkEvmNetwork
export -f getNetworkGroup
export -f isContractAlreadyDeployed
export -f isContractAlreadyVerified
export -f logWithTimestamp
export -f logNetworkResult
export -f analyzeFailingTx
export -f syncSigsAndDEXsForNetwork
