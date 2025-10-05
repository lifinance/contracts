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

  VERSION=$(getHighestDeployedContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$CONTRACT")

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
  # Function: createMultisigProposalForContract
  # Description: Creates a multisig proposal for a contract-related action
  # Arguments:
  #   $1 - NETWORK: The network name
  #   $2 - ENVIRONMENT: The environment (production/staging)
  #   $3 - CONTRACT: The contract name
  #   $4 - LOG_DIR: The log directory for storing proposal details
  # Returns:
  #   0 on success, 1 on failure
  # Example:
  #   createMultisigProposalForContract "mainnet" "production" "GlacisFacet" "/tmp/logs"

  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local CONTRACT="$3"
  local LOG_DIR="$4"

  # Validate required parameters
  if [[ -z "$NETWORK" || -z "$ENVIRONMENT" || -z "$CONTRACT" || -z "$LOG_DIR" ]]; then
    error "Usage: createMultisigProposalForContract NETWORK ENVIRONMENT CONTRACT LOG_DIR"
    return 1
  fi

  # Get RPC URL
  local RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")
  if [[ $? -ne 0 || -z "$RPC_URL" ]]; then
    error "[$NETWORK] Failed to get RPC URL"
    return 1
  fi

  # Get diamond address
  local DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")
  if [[ $? -ne 0 || -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" || "$DIAMOND_ADDRESS" == "0x" ]]; then
    error "[$NETWORK] No LiFiDiamond address found"
    return 1
  fi

  # Get contract address
  local CONTRACT_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$CONTRACT")
  if [[ $? -ne 0 || -z "$CONTRACT_ADDRESS" || "$CONTRACT_ADDRESS" == "null" || "$CONTRACT_ADDRESS" == "0x" ]]; then
    error "[$NETWORK] No address found for $CONTRACT"
    return 1
  fi

  # Get private key for the environment
  local PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT")
  if [[ $? -ne 0 || -z "$PRIVATE_KEY" ]]; then
    error "[$NETWORK] Failed to get private key for $ENVIRONMENT"
    return 1
  fi

  # Create log file for this proposal
  local PROPOSAL_LOG="$LOG_DIR/${NETWORK}_${CONTRACT}_proposal.log"

  echo "[$NETWORK] Creating multisig proposal for $CONTRACT ($CONTRACT_ADDRESS) on diamond ($DIAMOND_ADDRESS)"
  echo "Network: $NETWORK" > "$PROPOSAL_LOG"
  echo "Environment: $ENVIRONMENT" >> "$PROPOSAL_LOG"
  echo "Contract: $CONTRACT" >> "$PROPOSAL_LOG"
  echo "Contract Address: $CONTRACT_ADDRESS" >> "$PROPOSAL_LOG"
  echo "Diamond Address: $DIAMOND_ADDRESS" >> "$PROPOSAL_LOG"
  echo "RPC URL: $RPC_URL" >> "$PROPOSAL_LOG"
  echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$PROPOSAL_LOG"

  # Check if we should use timelock controller
  local USE_TIMELOCK_CONTROLLER="false"
  if [[ "$ENVIRONMENT" == "production" ]]; then
    # Check if timelock controller is available
    local TIMELOCK_ADDRESS=$(jq -r '.LiFiTimelockController // "0x"' "./deployments/${NETWORK}.$(getFileSuffix "$ENVIRONMENT")json")
    if [[ -n "$TIMELOCK_ADDRESS" && "$TIMELOCK_ADDRESS" != "0x" && "$TIMELOCK_ADDRESS" != "null" ]]; then
      USE_TIMELOCK_CONTROLLER="true"
      echo "Timelock Address: $TIMELOCK_ADDRESS" >> "$PROPOSAL_LOG"
    fi
  fi

  # For now, this is a placeholder implementation
  # In a real implementation, you would:
  # 1. Determine what kind of proposal to create based on the contract
  # 2. Generate appropriate calldata
  # 3. Call the propose-to-safe.ts script with the appropriate parameters

  echo "[$NETWORK] Proposal creation is a placeholder - implement specific proposal logic based on contract type"
  echo "Proposal Type: Placeholder" >> "$PROPOSAL_LOG"
  echo "Status: Placeholder - Not Implemented" >> "$PROPOSAL_LOG"

  # Example of how to call propose-to-safe.ts (commented out):
  # local CALLDATA="0x1234567890abcdef"  # Replace with actual calldata
  # if [[ "$USE_TIMELOCK_CONTROLLER" == "true" ]]; then
  #   bunx tsx ./script/deploy/safe/propose-to-safe.ts \
  #     --to "$DIAMOND_ADDRESS" \
  #     --calldata "$CALLDATA" \
  #     --network "$NETWORK" \
  #     --rpcUrl "$RPC_URL" \
  #     --privateKey "$PRIVATE_KEY" \
  #     --timelock
  # else
  #   bunx tsx ./script/deploy/safe/propose-to-safe.ts \
  #     --to "$DIAMOND_ADDRESS" \
  #     --calldata "$CALLDATA" \
  #     --network "$NETWORK" \
  #     --rpcUrl "$RPC_URL" \
  #     --privateKey "$PRIVATE_KEY"
  # fi

  success "[$NETWORK] Multisig proposal placeholder created for $CONTRACT"
  return 0
}

# =============================================================================
# EXPORT FUNCTIONS FOR USE IN OTHER SCRIPTS
# =============================================================================

# Make functions available to other scripts
export -f getContractVerified
export -f getNetworksByEvmVersionAndContractDeployment
export -f createMultisigProposalForContract
export -f getNetworkEvmVersion
export -f getNetworkSolcVersion
export -f isZkEvmNetwork
export -f getNetworkGroup
export -f isContractAlreadyDeployed
export -f isContractAlreadyVerified
export -f logWithTimestamp
export -f logNetworkResult
