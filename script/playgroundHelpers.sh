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

# =============================================================================
# EXPORT FUNCTIONS FOR USE IN OTHER SCRIPTS
# =============================================================================

# Make functions available to other scripts
export -f getContractVerified
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
