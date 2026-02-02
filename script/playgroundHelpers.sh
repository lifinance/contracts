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

  CURRENT_ADDRESS=$(echo "$LOG_ENTRY" | jq -r ".address")
  CURRENT_OPTIMIZER=$(echo "$LOG_ENTRY" | jq -r ".optimizerRuns")
  CURRENT_TIMESTAMP=$(echo "$LOG_ENTRY" | jq -r ".timestamp")
  CURRENT_CONSTRUCTOR_ARGS=$(echo "$LOG_ENTRY" | jq -r ".CONSTRUCTOR_ARGS")
  CURRENT_SALT=$(echo "$LOG_ENTRY" | jq -r ".salt")
  CURRENT_VERIFIED=$(echo "$LOG_ENTRY" | jq -r ".verified")
  CURRENT_SOLC_VERSION=$(echo "$LOG_ENTRY" | jq -r ".solcVersion // empty")
  CURRENT_EVM_VERSION=$(echo "$LOG_ENTRY" | jq -r ".evmVersion // empty")
  CURRENT_ZK_SOLC_VERSION=$(echo "$LOG_ENTRY" | jq -r ".zkSolcVersion // empty")

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

# =============================================================================
# NETWORK QUERY FUNCTIONS
# =============================================================================

function getNetworksByEvmVersionAndContractDeployment() {
  # Function: getNetworksByEvmVersionAndContractDeployment
  # Description: Gets a list of networks where a contract is deployed, optionally filtered by EVM version.
  #              If EVM_VERSION is not provided, returns networks for all EVM versions.
  #              If EVM_VERSION is provided, returns only networks matching that EVM version.
  # Arguments:
  #   $1 - CONTRACT: The contract name to check for deployment
  #   $2 - ENVIRONMENT: The environment to check (production/staging)
  #   $3 - EVM_VERSION: (Optional) The EVM version to filter by (e.g., "london", "cancun", "shanghai").
  #                     If not set, returns networks for all EVM versions.
  # Returns:
  #   Array of network names that match the criteria
  # Example:
  #   getNetworksByEvmVersionAndContractDeployment "GlacisFacet" "production"  # all networks with contract deployed (all EVM versions)
  #   getNetworksByEvmVersionAndContractDeployment "GlacisFacet" "production" "cancun"  # only cancun networks with contract deployed

  # read function arguments into variables
  local CONTRACT="$1"
  local ENVIRONMENT="$2"
  local EVM_VERSION="${3:-}"

  # validate required parameters
  if [[ -z "$CONTRACT" || -z "$ENVIRONMENT" ]]; then
    echo "Error: CONTRACT and ENVIRONMENT parameters are required for getNetworksByEvmVersionAndContractDeployment function" >&2
    return 1
  fi

  local ARRAY=()
  local NETWORKS=()

  # get initial list of networks based on EVM version
  if [[ -n "$EVM_VERSION" ]]; then
    # get networks filtered by specific EVM version
    NETWORKS=($(getIncludedNetworksByEvmVersionArray "$EVM_VERSION"))
  else
    # get all included networks (all EVM versions)
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

  # Get contracts directory and use absolute path for bunx
  local contracts_dir
  contracts_dir=$(getContractsDirectory)
  if [[ $? -ne 0 ]]; then
    error "[$NETWORK] Could not determine contracts directory"
    return 1
  fi

  set +e  # Temporarily disable exit on error to capture exit code
  (cd "$contracts_dir" && bunx tsx ./script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl "$RPC_URL" --timelock --privateKey "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" >/dev/null 2>&1)
  local PROPOSAL_STATUS=$?
  set -e  # Re-enable exit on error

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

function getContractsDirectory() {
  # Get the absolute path to the contracts directory
  # This is critical for parallel execution where PWD might not be set correctly
  local script_file="${BASH_SOURCE[0]}"
  local contracts_dir

  if [[ -f "$script_file" ]]; then
    # Get absolute path to script, then go up one level to contracts root
    local script_dir
    if command -v realpath >/dev/null 2>&1; then
      script_dir=$(realpath "$(dirname "$script_file")")
    elif command -v readlink >/dev/null 2>&1; then
      script_dir=$(cd "$(dirname "$(readlink -f "$script_file" 2>/dev/null || echo "$script_file")")" && pwd)
    else
      script_dir=$(cd "$(dirname "$script_file")" && pwd)
    fi
    contracts_dir=$(cd "$script_dir/.." && pwd)
  else
    # Fallback: use absolute path from current directory
    contracts_dir=$(pwd)
  fi

  # Ensure contracts_dir is absolute and exists
  if [[ ! "$contracts_dir" =~ ^/ ]]; then
    contracts_dir=$(cd "$contracts_dir" && pwd)
  fi

  # Verify contracts directory exists and has required files
  if [[ ! -d "$contracts_dir" ]] || [[ ! -f "$contracts_dir/package.json" ]]; then
    return 1
  fi

  echo "$contracts_dir"
}

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
  #             Uses our premium RPC URL resolved from environment via getRPCUrl.
  # Arguments:
  #   $1 - NETWORK: Network name (must match our ENV var naming, e.g. mainnet, arbitrum, polygon)
  #   $2 - TX_HASH: Transaction hash to analyze
  # Returns:
  #   0 on success, 1 on failure
  # Example:
  #   analyzeFailingTx "<NETWORK>" "<TX_HASH>"

  local NETWORK="$1"
  local TX_HASH="$2"

  # Validate required parameters
  if [[ -z "$NETWORK" || -z "$TX_HASH" ]]; then
    error "Usage: analyzeFailingTx NETWORK TX_HASH"
    return 1
  fi

  # Resolve premium RPC URL from environment (.env / CI secrets) via helper
  local RPC_URL
  RPC_URL=$(getRPCUrl "$NETWORK")
  if [[ $? -ne 0 || -z "$RPC_URL" ]]; then
    error "[$NETWORK] Failed to resolve RPC URL via getRPCUrl"
    return 1
  fi

  echo "Analyzing transaction: $TX_HASH on network: $NETWORK with RPC URL: $RPC_URL"
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

function _createTimelockCancellerProposal() {
  # Internal helper function to create a single proposal
  # Arguments:
  #   $1 - NETWORK: Network name
  #   $2 - TIMELOCK_ADDRESS: Timelock contract address
  #   $3 - CANCELLER_ROLE: The bytes32 role value
  #   $4 - OPERATION: "grant" or "revoke"
  #   $5 - ADDRESS: Address to grant/revoke role from
  #   $6 - RPC_URL: RPC URL for the network
  #   $7 - SAFE_ADDRESS: Safe multisig address
  # Returns: 0 on success, 1 on failure

  local NETWORK="$1"
  local TIMELOCK_ADDRESS="$2"
  local CANCELLER_ROLE="$3"
  local OPERATION="$4"
  local ADDRESS="$5"
  local RPC_URL="$6"
  local SAFE_ADDRESS="$7"

  local CALLDATA=""
  case "$OPERATION" in
    "revoke")
      CALLDATA=$(cast calldata "revokeRole(bytes32,address)" "$CANCELLER_ROLE" "$ADDRESS" 2>&1)
      local CALLDATA_EXIT_CODE=$?
      ;;
    "grant")
      CALLDATA=$(cast calldata "grantRole(bytes32,address)" "$CANCELLER_ROLE" "$ADDRESS" 2>&1)
      local CALLDATA_EXIT_CODE=$?
      ;;
    *)
      error "[$NETWORK] Invalid operation: $OPERATION"
      return 1
      ;;
  esac

  if [[ $CALLDATA_EXIT_CODE -ne 0 || -z "$CALLDATA" || "$CALLDATA" =~ ^Error ]]; then
    error "[$NETWORK] Failed to create calldata for $OPERATION operation"
    error "[$NETWORK] CANCELLER_ROLE: $CANCELLER_ROLE"
    error "[$NETWORK] ADDRESS: $ADDRESS"
    error "[$NETWORK] Cast error: $CALLDATA"
    return 1
  fi

  # Verify calldata looks valid (should start with 0x and be a reasonable length)
  if [[ ! "$CALLDATA" =~ ^0x[0-9a-fA-F]+$ ]] || [[ ${#CALLDATA} -lt 10 ]]; then
    error "[$NETWORK] Invalid calldata generated: $CALLDATA"
    return 1
  fi

  # Verify Safe has PROPOSER_ROLE (required to call schedule())
  local PROPOSER_ROLE
  PROPOSER_ROLE=$(cast call "$TIMELOCK_ADDRESS" "PROPOSER_ROLE() returns (bytes32)" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]')
  if [[ -n "$PROPOSER_ROLE" ]]; then
    local SAFE_HAS_PROPOSER_ROLE
    SAFE_HAS_PROPOSER_ROLE=$(cast call "$TIMELOCK_ADDRESS" "hasRole(bytes32,address) returns (bool)" "$PROPOSER_ROLE" "$SAFE_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)
    if [[ "$SAFE_HAS_PROPOSER_ROLE" != "true" ]]; then
      error "[$NETWORK] Safe address ($SAFE_ADDRESS) does not have PROPOSER_ROLE on timelock"
      error "[$NETWORK] Safe needs PROPOSER_ROLE to schedule operations"
      return 1
    fi
  fi

  # The calldata needs to be wrapped in a timelock schedule operation
  # The Safe will call schedule() on the timelock, which will schedule the grantRole/revokeRole call
  # Use the --timelock flag which automatically wraps the calldata in a schedule call
  # Note: --to should be the timelock address (where schedule() will be called)
  # The inner calldata (grantRole/revokeRole) will target the timelock itself

  # Get contracts directory and use absolute path for bunx
  local contracts_dir
  contracts_dir=$(getContractsDirectory)
  if [[ $? -ne 0 ]]; then
    error "[$NETWORK] Could not determine contracts directory"
    return 1
  fi

  set +e  # Temporarily disable exit on error to capture exit code
  (cd "$contracts_dir" && bunx tsx ./script/deploy/safe/propose-to-safe.ts \
    --to "$TIMELOCK_ADDRESS" \
    --calldata "$CALLDATA" \
    --network "$NETWORK" \
    --rpcUrl "$RPC_URL" \
    --privateKey "$(getPrivateKey "$NETWORK" "production")" \
    --timelock >/dev/null 2>&1)
  local PROPOSAL_STATUS=$?
  set -e  # Re-enable exit on error

  return $PROPOSAL_STATUS
}

function manageTimelockCanceller() {
  # Function: manageTimelockCanceller
  # Description: Creates a multisig proposal to add, remove, or replace a CANCELLER_ROLE in LiFiTimelockController
  # Arguments:
  #   $1 - MODE: "remove", "replace", or "add"
  #   $2 - NETWORK: Network name
  #   $3 - REMOVE_ROLE_FROM_ADDRESS: Address of canceller to remove (required for remove/replace modes)
  #   $4 - GRANT_ROLE_TO_ADDRESS: Address of canceller to add (required for replace/add modes)
  # Returns:
  #   0 on success, 1 on failure
  # Example:
  #   manageTimelockCanceller "remove" "mainnet" "0x123..."
  #   manageTimelockCanceller "replace" "mainnet" "0x123..." "0x456..."
  #   manageTimelockCanceller "add" "mainnet" "" "0x456..."

  local MODE="$1"
  local NETWORK="$2"
  local REMOVE_ROLE_FROM_ADDRESS="${3:-}"
  local GRANT_ROLE_TO_ADDRESS="${4:-}"
  local ENVIRONMENT="production"

  # Validate required parameters
  if [[ -z "$MODE" || -z "$NETWORK" ]]; then
    error "Usage: manageTimelockCanceller MODE NETWORK [REMOVE_ROLE_FROM_ADDRESS] [GRANT_ROLE_TO_ADDRESS]"
    error "Modes: remove, replace, add"
    return 1
  fi

  # Validate mode
  if [[ "$MODE" != "remove" && "$MODE" != "replace" && "$MODE" != "add" ]]; then
    error "[$NETWORK] Invalid mode: $MODE. Must be 'remove', 'replace', or 'add'"
    return 1
  fi

  # Validate mode-specific parameters
  if [[ "$MODE" == "remove" || "$MODE" == "replace" ]]; then
    if [[ -z "$REMOVE_ROLE_FROM_ADDRESS" ]]; then
      error "[$NETWORK] REMOVE_ROLE_FROM_ADDRESS is required for mode: $MODE"
      return 1
    fi
  fi

  if [[ "$MODE" == "replace" || "$MODE" == "add" ]]; then
    if [[ -z "$GRANT_ROLE_TO_ADDRESS" ]]; then
      error "[$NETWORK] GRANT_ROLE_TO_ADDRESS is required for mode: $MODE"
      return 1
    fi
  fi

  # Get timelock controller address from deployments
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")
  local DEPLOYMENT_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
    error "[$NETWORK] Deployment file not found: $DEPLOYMENT_FILE"
    return 1
  fi

  local TIMELOCK_ADDRESS
  TIMELOCK_ADDRESS=$(getValueFromJSONFile "$DEPLOYMENT_FILE" "LiFiTimelockController")
  if [[ $? -ne 0 || -z "$TIMELOCK_ADDRESS" || "$TIMELOCK_ADDRESS" == "null" || "$TIMELOCK_ADDRESS" == "0x" ]]; then
    error "[$NETWORK] LiFiTimelockController address not found in deployment file: $DEPLOYMENT_FILE"
    return 1
  fi

  # Get RPC URL (always use production for timelock operations)
  local RPC_URL
  RPC_URL=$(getRPCUrl "$NETWORK" "production")
  if [[ $? -ne 0 || -z "$RPC_URL" ]]; then
    error "[$NETWORK] Failed to get RPC URL"
    return 1
  fi

  # Get Safe address from networks.json
  local SAFE_ADDRESS
  SAFE_ADDRESS=$(getValueFromJSONFile "./config/networks.json" "$NETWORK.safeAddress")
  if [[ $? -ne 0 || -z "$SAFE_ADDRESS" || "$SAFE_ADDRESS" == "null" ]]; then
    error "[$NETWORK] Safe address not found in networks.json"
    return 1
  fi

  # Get CANCELLER_ROLE bytes value from contract
  local CANCELLER_ROLE
  CANCELLER_ROLE=$(cast call "$TIMELOCK_ADDRESS" "CANCELLER_ROLE() returns (bytes32)" --rpc-url "$RPC_URL" 2>/dev/null)
  if [[ $? -ne 0 || -z "$CANCELLER_ROLE" ]]; then
    error "[$NETWORK] Failed to get CANCELLER_ROLE from timelock contract at $TIMELOCK_ADDRESS"
    return 1
  fi

  # Ensure CANCELLER_ROLE is properly formatted as a hex string (should be 0x followed by 64 hex chars = 66 total)
  # Remove all whitespace (including newlines, tabs, spaces) and ensure it starts with 0x
  CANCELLER_ROLE=$(echo -n "$CANCELLER_ROLE" | tr -d '[:space:]' | tr -d '\n' | tr -d '\r')
  if [[ ! "$CANCELLER_ROLE" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    error "[$NETWORK] Invalid CANCELLER_ROLE format: '$CANCELLER_ROLE' (expected 0x followed by 64 hex characters, got ${#CANCELLER_ROLE} chars)"
    error "[$NETWORK] Raw value (hex dump): $(echo -n "$CANCELLER_ROLE" | xxd -p -c 256)"
    return 1
  fi

  # For remove/replace modes: check if address has CANCELLER_ROLE
  local OLD_ADDRESS_HAS_ROLE=false
  if [[ "$MODE" == "remove" || "$MODE" == "replace" ]]; then
    local HAS_ROLE
    HAS_ROLE=$(cast call "$TIMELOCK_ADDRESS" "hasRole(bytes32,address) returns (bool)" "$CANCELLER_ROLE" "$REMOVE_ROLE_FROM_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)
    if [[ $? -eq 0 && "$HAS_ROLE" == "true" ]]; then
      OLD_ADDRESS_HAS_ROLE=true
    fi

    if [[ "$OLD_ADDRESS_HAS_ROLE" == "false" ]]; then
      # Address doesn't have the role - desired state already achieved
      if [[ "$MODE" == "remove" ]]; then
        warning "[$NETWORK] Address $REMOVE_ROLE_FROM_ADDRESS does not have CANCELLER_ROLE - no action needed"
        success "[$NETWORK] No proposal needed: address already does not have CANCELLER_ROLE"
        return 0
      elif [[ "$MODE" == "replace" ]]; then
        warning "[$NETWORK] Address $REMOVE_ROLE_FROM_ADDRESS does not have CANCELLER_ROLE - skipping revoke and proceeding with grant only"
      fi
    else
      # Address has the role - proceed with safety checks
      # Safety check: Warn if removing might leave no CANCELLER_ROLE holders
      # Note: TimelockController uses AccessControl (not AccessControlEnumerable), so we can't enumerate role members
      # We check if Safe has CANCELLER_ROLE as a safety measure
      local SAFE_HAS_ROLE
      SAFE_HAS_ROLE=$(cast call "$TIMELOCK_ADDRESS" "hasRole(bytes32,address) returns (bool)" "$CANCELLER_ROLE" "$SAFE_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)

      if [[ "$MODE" == "remove" ]]; then
        # For remove mode: check if Safe has the role as backup
        if [[ "$SAFE_HAS_ROLE" != "true" ]]; then
          warning "[$NETWORK] ⚠️  WARNING: Removing CANCELLER_ROLE from $REMOVE_ROLE_FROM_ADDRESS"
          warning "[$NETWORK] Safe address ($SAFE_ADDRESS) does not have CANCELLER_ROLE"
          warning "[$NETWORK] Ensure at least one other address has CANCELLER_ROLE before proceeding"
          warning "[$NETWORK] Otherwise, the timelock may be left without any cancellers"
          warning "[$NETWORK] The Safe (with TIMELOCK_ADMIN_ROLE) can grant CANCELLER_ROLE later, but this requires a proposal"
          echo ""
          read -p "[$NETWORK] Continue with removal? (yes/no): " CONFIRM
          if [[ "$CONFIRM" != "yes" ]]; then
            error "[$NETWORK] Operation cancelled by user"
            return 1
          fi
        else
          echo "[$NETWORK] ✓ Safe address has CANCELLER_ROLE - removal is safe"
        fi
      elif [[ "$MODE" == "replace" ]]; then
        # For replace mode: safer since we're adding a new one, but still warn if Safe doesn't have it
        if [[ "$SAFE_HAS_ROLE" != "true" ]]; then
          warning "[$NETWORK] ⚠️  NOTE: Safe address ($SAFE_ADDRESS) does not have CANCELLER_ROLE"
          warning "[$NETWORK] After replacement, ensure at least one address retains CANCELLER_ROLE"
        fi
      fi
    fi
  fi

  # For add/replace modes: check if new address already has CANCELLER_ROLE
  local NEW_ADDRESS_HAS_ROLE=false
  if [[ "$MODE" == "add" || "$MODE" == "replace" ]]; then
    local HAS_ROLE
    HAS_ROLE=$(cast call "$TIMELOCK_ADDRESS" "hasRole(bytes32,address) returns (bool)" "$CANCELLER_ROLE" "$GRANT_ROLE_TO_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null)
    if [[ $? -eq 0 && "$HAS_ROLE" == "true" ]]; then
      NEW_ADDRESS_HAS_ROLE=true
    fi

    if [[ "$NEW_ADDRESS_HAS_ROLE" == "true" ]]; then
      if [[ "$MODE" == "add" ]]; then
        warning "[$NETWORK] Address $GRANT_ROLE_TO_ADDRESS already has CANCELLER_ROLE"
        success "[$NETWORK] No proposal needed: address already has CANCELLER_ROLE"
        return 0
      elif [[ "$MODE" == "replace" ]]; then
        warning "[$NETWORK] Address $GRANT_ROLE_TO_ADDRESS already has CANCELLER_ROLE - skipping grant step"
      fi
    fi
  fi

  # Handle replace mode by creating proposals as needed
  if [[ "$MODE" == "replace" ]]; then
    local PROPOSALS_CREATED=0

    # First, remove the role from the old address (if it has the role)
    if [[ "$OLD_ADDRESS_HAS_ROLE" == "true" ]]; then
      echo "[$NETWORK] Replace mode: creating proposal to remove CANCELLER_ROLE from: $REMOVE_ROLE_FROM_ADDRESS"
      if ! _createTimelockCancellerProposal "$NETWORK" "$TIMELOCK_ADDRESS" "$CANCELLER_ROLE" "revoke" "$REMOVE_ROLE_FROM_ADDRESS" "$RPC_URL" "$SAFE_ADDRESS"; then
        error "[$NETWORK] Failed to create proposal to remove CANCELLER_ROLE from: $REMOVE_ROLE_FROM_ADDRESS"
        return 1
      fi
      PROPOSALS_CREATED=$((PROPOSALS_CREATED + 1))
    fi

    # Then, grant the role to the new address (if it doesn't already have it)
    if [[ "$NEW_ADDRESS_HAS_ROLE" == "false" ]]; then
      echo "[$NETWORK] Replace mode: creating proposal to grant CANCELLER_ROLE to: $GRANT_ROLE_TO_ADDRESS"
      if ! _createTimelockCancellerProposal "$NETWORK" "$TIMELOCK_ADDRESS" "$CANCELLER_ROLE" "grant" "$GRANT_ROLE_TO_ADDRESS" "$RPC_URL" "$SAFE_ADDRESS"; then
        error "[$NETWORK] Failed to create proposal to grant CANCELLER_ROLE to: $GRANT_ROLE_TO_ADDRESS"
        return 1
      fi
      PROPOSALS_CREATED=$((PROPOSALS_CREATED + 1))
    fi

    if [[ $PROPOSALS_CREATED -eq 0 ]]; then
      warning "[$NETWORK] Both addresses are already in the desired state"
      success "[$NETWORK] No proposals needed: $REMOVE_ROLE_FROM_ADDRESS does not have role, $GRANT_ROLE_TO_ADDRESS already has role"
      return 0
    elif [[ $PROPOSALS_CREATED -eq 1 ]]; then
      if [[ "$OLD_ADDRESS_HAS_ROLE" == "true" ]]; then
        success "[$NETWORK] Successfully created proposal to remove CANCELLER_ROLE from: $REMOVE_ROLE_FROM_ADDRESS @LiFiTimelockController: $TIMELOCK_ADDRESS"
      else
        success "[$NETWORK] Successfully created proposal to grant CANCELLER_ROLE to: $GRANT_ROLE_TO_ADDRESS @LiFiTimelockController: $TIMELOCK_ADDRESS"
      fi
    else
      success "[$NETWORK] Successfully created both proposals to replace CANCELLER_ROLE from $REMOVE_ROLE_FROM_ADDRESS to $GRANT_ROLE_TO_ADDRESS @LiFiTimelockController: $TIMELOCK_ADDRESS"
    fi
    return 0
  fi

  # Handle remove and add modes
  local OPERATION=""
  local ADDRESS=""
  case "$MODE" in
    "remove")
      OPERATION="revoke"
      ADDRESS="$REMOVE_ROLE_FROM_ADDRESS"
      ;;
    "add")
      OPERATION="grant"
      ADDRESS="$GRANT_ROLE_TO_ADDRESS"
      ;;
  esac

  if ! _createTimelockCancellerProposal "$NETWORK" "$TIMELOCK_ADDRESS" "$CANCELLER_ROLE" "$OPERATION" "$ADDRESS" "$RPC_URL" "$SAFE_ADDRESS"; then
    case "$MODE" in
      "remove")
        error "[$NETWORK] Failed to create proposal to remove CANCELLER_ROLE from: $REMOVE_ROLE_FROM_ADDRESS"
        ;;
      "add")
        error "[$NETWORK] Failed to create proposal to grant CANCELLER_ROLE to: $GRANT_ROLE_TO_ADDRESS"
        ;;
    esac
    return 1
  fi

  case "$MODE" in
    "remove")
      success "[$NETWORK] Successfully created proposal to remove CANCELLER_ROLE from: $REMOVE_ROLE_FROM_ADDRESS @LiFiTimelockController: $TIMELOCK_ADDRESS"
      ;;
    "add")
      success "[$NETWORK] Successfully created proposal to grant CANCELLER_ROLE to: $GRANT_ROLE_TO_ADDRESS @LiFiTimelockController: $TIMELOCK_ADDRESS"
      ;;
  esac
  return 0
}

# =============================================================================
# SAFE OWNER MANAGEMENT FUNCTIONS
# =============================================================================

function manageSafeOwner() {
  # Function: manageSafeOwner
  # Description: Creates a multisig proposal to add, remove, or replace a Safe owner
  # Arguments:
  #   $1 - MODE: "remove", "replace", or "add"
  #   $2 - NETWORK: Network name
  #   $3 - OWNER_TO_BE_REMOVED: Address of owner to remove (required for remove/replace modes)
  #   $4 - OWNER_TO_BE_ADDED: Address of owner to add (required for replace/add modes)
  # Returns:
  #   0 on success, 1 on failure
  # Example:
  #   manageSafeOwner "remove" "mainnet" "0x123..."
  #   manageSafeOwner "replace" "mainnet" "0x123..." "0x456..."
  #   manageSafeOwner "add" "mainnet" "" "0x456..."

  local MODE="$1"
  local NETWORK="$2"
  local OWNER_TO_BE_REMOVED="${3:-}"
  local OWNER_TO_BE_ADDED="${4:-}"
  local ENVIRONMENT="production"

  # Validate required parameters
  if [[ -z "$MODE" || -z "$NETWORK" ]]; then
    error "Usage: manageSafeOwner MODE NETWORK [OWNER_TO_BE_REMOVED] [OWNER_TO_BE_ADDED]"
    error "Modes: remove, replace, add"
    return 1
  fi

  # Validate mode
  if [[ "$MODE" != "remove" && "$MODE" != "replace" && "$MODE" != "add" ]]; then
    error "[$NETWORK] Invalid mode: $MODE. Must be 'remove', 'replace', or 'add'"
    return 1
  fi

  # Validate mode-specific parameters
  if [[ "$MODE" == "remove" || "$MODE" == "replace" ]]; then
    if [[ -z "$OWNER_TO_BE_REMOVED" ]]; then
      error "[$NETWORK] OWNER_TO_BE_REMOVED is required for mode: $MODE"
      return 1
    fi
  fi

  if [[ "$MODE" == "replace" || "$MODE" == "add" ]]; then
    if [[ -z "$OWNER_TO_BE_ADDED" ]]; then
      error "[$NETWORK] OWNER_TO_BE_ADDED is required for mode: $MODE"
      return 1
    fi

    if ! isValidEvmAddress "$OWNER_TO_BE_ADDED"; then
      error "[$NETWORK] OWNER_TO_BE_ADDED must be a valid Ethereum address (format: 0x followed by 40 hex characters)"
      return 1
    fi
  fi

  # Get Safe address from networks.json
  local SAFE_ADDRESS
  SAFE_ADDRESS=$(getValueFromJSONFile "./config/networks.json" "$NETWORK.safeAddress")
  if [[ $? -ne 0 || -z "$SAFE_ADDRESS" || "$SAFE_ADDRESS" == "null" ]]; then
    error "[$NETWORK] Safe address not found in networks.json"
    return 1
  fi

  # Get RPC URL (always use production for Safe operations)
  local RPC_URL
  RPC_URL=$(getRPCUrl "$NETWORK" "production")
  if [[ $? -ne 0 || -z "$RPC_URL" ]]; then
    error "[$NETWORK] Failed to get RPC URL"
    return 1
  fi

  # For add mode: check if address is already an owner (prevent duplicates)
  if [[ "$MODE" == "add" ]]; then
    local IS_ALREADY_OWNER
    IS_ALREADY_OWNER=$(cast call "$SAFE_ADDRESS" "isOwner(address) returns (bool)" "$OWNER_TO_BE_ADDED" --rpc-url "$RPC_URL" 2>/dev/null)
    if [[ $? -ne 0 ]]; then
      error "[$NETWORK] Failed to check if address is already an owner"
      return 1
    fi
    if [[ "$IS_ALREADY_OWNER" == "true" ]]; then
      error "[$NETWORK] Address $OWNER_TO_BE_ADDED is already an owner of the Safe"
      return 1
    fi
  fi

  # For remove/replace modes: check if owner exists and get prevOwner
  local PREV_OWNER=""
  if [[ "$MODE" == "remove" || "$MODE" == "replace" ]]; then
    # Check if owner is currently an owner
    local IS_OWNER
    IS_OWNER=$(cast call "$SAFE_ADDRESS" "isOwner(address) returns (bool)" "$OWNER_TO_BE_REMOVED" --rpc-url "$RPC_URL" 2>/dev/null)
    if [[ $? -ne 0 || "$IS_OWNER" != "true" ]]; then
      error "[$NETWORK] Address $OWNER_TO_BE_REMOVED is not an owner of the Safe"
      return 1
    fi

    # Get owners list
    local OWNERS_JSON
    OWNERS_JSON=$(cast call "$SAFE_ADDRESS" "getOwners() returns (address[])" --rpc-url "$RPC_URL" 2>/dev/null)
    if [[ $? -ne 0 || -z "$OWNERS_JSON" ]]; then
      error "[$NETWORK] Failed to get owners list"
      return 1
    fi

    # Parse owners array (cast returns addresses without quotes, need to convert to valid JSON)
    # cast returns: [0xABC..., 0xDEF...] which is invalid JSON
    # Convert to valid JSON: ["0xABC...", "0xDEF..."]
    local OWNERS_ARRAY
    local VALID_JSON
    VALID_JSON=$(echo "$OWNERS_JSON" | sed 's/0x/"0x/g; s/, /", /g; s/\[/\["/g; s/\]/"\]/g' 2>/dev/null) || true
    OWNERS_ARRAY=$(echo "$VALID_JSON" | jq -r '.[]' 2>/dev/null) || true

    if [[ -z "$OWNERS_ARRAY" ]]; then
      # Fallback: parse manually using sed/grep
      OWNERS_ARRAY=$(echo "$OWNERS_JSON" | sed 's/\[//; s/\]//' | sed 's/,/\n/g' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -E '^0x[a-fA-F0-9]{40}$' || true)
      if [[ -z "$OWNERS_ARRAY" ]]; then
        error "[$NETWORK] Failed to parse owners list"
        return 1
      fi
    fi

    # Find the owner and track the previous owner (needed for Safe's linked list structure)
    local FOUND=false
    local PREV_OWNER_TEMP="0x0000000000000000000000000000000000000001"  # SENTINEL for first owner
    while IFS= read -r owner; do
      if [[ -n "$owner" ]]; then
        if [[ "$(echo "$owner" | tr '[:upper:]' '[:lower:]')" == "$(echo "$OWNER_TO_BE_REMOVED" | tr '[:upper:]' '[:lower:]')" ]]; then
          PREV_OWNER="$PREV_OWNER_TEMP"
          FOUND=true
          break
        fi
        PREV_OWNER_TEMP="$owner"
      fi
    done <<< "$OWNERS_ARRAY"

    if [[ "$FOUND" != "true" ]]; then
      error "[$NETWORK] Owner not found in owners list"
      return 1
    fi
  fi

  # Get current threshold
  local THRESHOLD
  THRESHOLD=$(cast call "$SAFE_ADDRESS" "getThreshold() returns (uint256)" --rpc-url "$RPC_URL" 2>/dev/null)
  if [[ $? -ne 0 || -z "$THRESHOLD" ]]; then
    error "[$NETWORK] Failed to get current threshold"
    return 1
  fi

  # For remove mode: validate threshold won't exceed remaining owners
  if [[ "$MODE" == "remove" ]]; then
    local CURRENT_OWNER_COUNT
    CURRENT_OWNER_COUNT=$(echo "$OWNERS_ARRAY" | grep -c '^0x' || echo "0")
    local REMAINING_OWNERS=$((CURRENT_OWNER_COUNT - 1))

    # Get threshold as decimal for comparison
    local THRESHOLD_DEC
    THRESHOLD_DEC=$(cast --to-dec "$THRESHOLD" 2>/dev/null || echo "$THRESHOLD")

    if [[ $THRESHOLD_DEC -gt $REMAINING_OWNERS ]]; then
      error "[$NETWORK] Cannot remove owner: threshold ($THRESHOLD_DEC) would exceed remaining owners ($REMAINING_OWNERS)"
      error "[$NETWORK] Please lower the threshold first or use a different removal strategy"
      return 1
    fi
  fi

  # Create calldata based on mode
  local CALLDATA=""
  case "$MODE" in
    "remove")
      CALLDATA=$(cast calldata "removeOwner(address,address,uint256)" "$PREV_OWNER" "$OWNER_TO_BE_REMOVED" "$THRESHOLD")
      ;;
    "replace")
      CALLDATA=$(cast calldata "swapOwner(address,address,address)" "$PREV_OWNER" "$OWNER_TO_BE_REMOVED" "$OWNER_TO_BE_ADDED")
      ;;
    "add")
      CALLDATA=$(cast calldata "addOwnerWithThreshold(address,uint256)" "$OWNER_TO_BE_ADDED" "$THRESHOLD")
      ;;
  esac

  if [[ -z "$CALLDATA" ]]; then
    error "[$NETWORK] Failed to create calldata"
    return 1
  fi

  # Create multisig proposal
  case "$MODE" in
    "remove")
      echo "[$NETWORK] Creating proposal to remove owner: $OWNER_TO_BE_REMOVED"
      ;;
    "replace")
      echo "[$NETWORK] Creating proposal to replace owner $OWNER_TO_BE_REMOVED with $OWNER_TO_BE_ADDED"
      ;;
    "add")
      echo "[$NETWORK] Creating proposal to add owner: $OWNER_TO_BE_ADDED"
      ;;
  esac

  local proposal_output
  local proposal_error

  # Get contracts directory and use absolute path for bunx
  local contracts_dir
  contracts_dir=$(getContractsDirectory)
  if [[ $? -ne 0 ]]; then
    error "[$NETWORK] Could not determine contracts directory"
    return 1
  fi

  # Use temp file to capture output and preserve exit code
  # Use bunx with explicit working directory via --cwd or absolute path
  local temp_output
  temp_output=$(mktemp)
  set +e  # Temporarily disable exit on error to capture exit code

  # Use absolute path to script and run from contracts directory
  (cd "$contracts_dir" && bunx tsx ./script/deploy/safe/propose-to-safe.ts \
    --to "$SAFE_ADDRESS" \
    --calldata "$CALLDATA" \
    --network "$NETWORK" \
    --rpcUrl "$RPC_URL" \
    --privateKey "$(getPrivateKey "$NETWORK" "production")" \
    >"$temp_output" 2>&1)
  local PROPOSAL_STATUS=$?
  set -e  # Re-enable exit on error

  # Read output from temp file
  proposal_output=$(cat "$temp_output" 2>/dev/null || echo "")
  rm -f "$temp_output" 2>/dev/null || true

  if [[ $PROPOSAL_STATUS -eq 0 ]]; then
    case "$MODE" in
      "remove")
        success "[$NETWORK] Successfully created proposal to remove owner: $OWNER_TO_BE_REMOVED"
        ;;
      "replace")
        success "[$NETWORK] Successfully created proposal to replace owner $OWNER_TO_BE_REMOVED with $OWNER_TO_BE_ADDED"
        ;;
      "add")
        success "[$NETWORK] Successfully created proposal to add owner: $OWNER_TO_BE_ADDED"
        ;;
    esac
    return 0
  else
    # Extract comprehensive error information from output
    # Look for specific error patterns from propose-to-safe.ts
    local signer_address
    local current_owners
    local error_summary

    # Check if it's the "not an owner" error
    if echo "$proposal_output" | grep -q "The current signer is not an owner"; then
      signer_address=$(echo "$proposal_output" | grep -A 1 "Signer address:" | tail -1 | sed 's/^[[:space:]]*//')
      current_owners=$(echo "$proposal_output" | grep -A 10 "Current owners:" | grep -E "^0x[a-fA-F0-9]{40}" | tr '\n' ' ' || echo "Unable to parse")
      error_summary="Signer ($signer_address) is not a Safe owner. Current owners: ${current_owners}"
    else
      # Try to extract other error messages
      error_summary=$(echo "$proposal_output" | grep -iE "(error|failed|revert|Cannot)" | head -3 | tr '\n' '; ' || echo "$proposal_output" | tail -3 | tr '\n' '; ')
    fi

    case "$MODE" in
      "remove")
        error "[$NETWORK] Failed to create proposal to remove owner: $OWNER_TO_BE_REMOVED"
        error "[$NETWORK] Error details: ${error_summary:-Exit code $PROPOSAL_STATUS}"
        ;;
      "replace")
        error "[$NETWORK] Failed to create proposal to replace owner $OWNER_TO_BE_REMOVED with $OWNER_TO_BE_ADDED"
        error "[$NETWORK] Error details: ${error_summary:-Exit code $PROPOSAL_STATUS}"
        ;;
      "add")
        error "[$NETWORK] Failed to create proposal to add owner: $OWNER_TO_BE_ADDED"
        error "[$NETWORK] Error details: ${error_summary:-Exit code $PROPOSAL_STATUS}"
        ;;
    esac
    return 1
  fi
}

# =============================================================================
# ACCESS MANAGER PERMISSION MANAGEMENT FUNCTIONS
# =============================================================================

function removeAccessManagerPermission() {
  # Function: removeAccessManagerPermission
  # Description: Creates a multisig proposal to remove permission for an address to call a specific function via AccessManagerFacet
  # Arguments:
  #   $1 - NETWORK: Network name
  #   $2 - FUNCTION_SELECTOR: Function selector (bytes4) to remove permission for (e.g., "0x1171c007")
  #   $3 - EXECUTOR_ADDRESS: Address to remove permission from
  #   $4 - ENVIRONMENT: Environment (default: "production")
  # Returns:
  #   0 on success, 1 on failure
  # Example:
  #   removeAccessManagerPermission "mainnet" "0x1171c007" "0x11F1022cA6AdEF6400e5677528a80d49a069C00c"
  #   removeAccessManagerPermission "mainnet" "0x1171c007" "0x11F1022cA6AdEF6400e5677528a80d49a069C00c" "production"

  local NETWORK="$1"
  local FUNCTION_SELECTOR="$2"
  local EXECUTOR_ADDRESS="$3"
  local ENVIRONMENT="${4:-production}"

  # Validate required parameters
  if [[ -z "$NETWORK" || -z "$FUNCTION_SELECTOR" || -z "$EXECUTOR_ADDRESS" ]]; then
    error "Usage: removeAccessManagerPermission NETWORK FUNCTION_SELECTOR EXECUTOR_ADDRESS [ENVIRONMENT]"
    error "Example: removeAccessManagerPermission mainnet 0x1171c007 0x11F1022cA6AdEF6400e5677528a80d49a069C00c"
    return 1
  fi

  if ! isValidSelector "$FUNCTION_SELECTOR"; then
    error "[$NETWORK] Invalid function selector format: $FUNCTION_SELECTOR"
    error "[$NETWORK] Function selector must be 0x followed by 8 hex characters (e.g., 0x1171c007)"
    return 1
  fi

  if ! isValidEvmAddress "$EXECUTOR_ADDRESS"; then
    error "[$NETWORK] Invalid executor address format: $EXECUTOR_ADDRESS"
    return 1
  fi

  # Get network configuration
  local RPC_URL
  RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT") || {
    error "[$NETWORK] Failed to get RPC URL"
    return 1
  }

  # Get Diamond address
  local DIAMOND_ADDRESS
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond") || {
    error "[$NETWORK] Failed to get LiFiDiamond address"
    return 1
  }

  if [[ -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" ]]; then
    error "[$NETWORK] LiFiDiamond not found in deployment logs"
    return 1
  fi

  # Check if the deployer wallet already has permission removed (can't execute)
  # If permission is already removed, skip proposal creation and mark as success
  local CAN_EXECUTE
  CAN_EXECUTE=$(cast call "$DIAMOND_ADDRESS" "addressCanExecuteMethod(bytes4,address) returns (bool)" "$FUNCTION_SELECTOR" "$EXECUTOR_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null || echo "false")

  if [[ "$CAN_EXECUTE" == "false" ]]; then
    success "[$NETWORK] ✅ Permission already removed - deployer wallet ($EXECUTOR_ADDRESS) cannot execute function selector $FUNCTION_SELECTOR. Skipping proposal creation."
    return 0
  fi

  # Get Safe address from networks.json (not deployment logs)
  # Required for propose-to-safe.ts to initialize Safe client
  # Even with --timelock, we need Safe address to create and sign the transaction
  local SAFE_ADDRESS
  SAFE_ADDRESS=$(getValueFromJSONFile "./config/networks.json" "$NETWORK.safeAddress")
  if [[ $? -ne 0 || -z "$SAFE_ADDRESS" || "$SAFE_ADDRESS" == "null" ]]; then
    error "[$NETWORK] Safe address not found in networks.json"
    return 1
  fi

  # Create calldata for AccessManagerFacet.setCanExecute(bytes4,address,bool)
  # setCanExecute(bytes4 _selector, address _executor, bool _canExecute)
  # We're setting _canExecute to false to remove the permission
  local CALLDATA
  CALLDATA=$(cast calldata "setCanExecute(bytes4,address,bool)" "$FUNCTION_SELECTOR" "$EXECUTOR_ADDRESS" false 2>&1)
  local CALLDATA_EXIT_CODE=$?

  if [[ $CALLDATA_EXIT_CODE -ne 0 || -z "$CALLDATA" || "$CALLDATA" =~ ^Error ]]; then
    error "[$NETWORK] Failed to create calldata for setCanExecute"
    error "[$NETWORK] Function selector: $FUNCTION_SELECTOR"
    error "[$NETWORK] Executor address: $EXECUTOR_ADDRESS"
    error "[$NETWORK] Cast error: $CALLDATA"
    return 1
  fi

  # Verify calldata looks valid (should start with 0x and be a reasonable length)
  if [[ ! "$CALLDATA" =~ ^0x[0-9a-fA-F]+$ ]] || [[ ${#CALLDATA} -lt 10 ]]; then
    error "[$NETWORK] Invalid calldata generated: $CALLDATA"
    return 1
  fi

  echo "[$NETWORK] Creating proposal to remove permission for $EXECUTOR_ADDRESS to call function selector $FUNCTION_SELECTOR"

  local proposal_output
  local proposal_error

  # Get contracts directory and use absolute path for bunx
  local contracts_dir
  contracts_dir=$(getContractsDirectory)
  if [[ $? -ne 0 ]]; then
    error "[$NETWORK] Could not determine contracts directory"
    return 1
  fi

  # Use temp file to capture output and preserve exit code
  local temp_output
  temp_output=$(mktemp)
  set +e  # Temporarily disable exit on error to capture exit code

  # Use absolute path to script and run from contracts directory
  # Note: AccessManagerFacet.setCanExecute requires owner, so we wrap in timelock
  (cd "$contracts_dir" && bunx tsx ./script/deploy/safe/propose-to-safe.ts \
    --to "$DIAMOND_ADDRESS" \
    --calldata "$CALLDATA" \
    --network "$NETWORK" \
    --rpcUrl "$RPC_URL" \
    --timelock \
    --privateKey "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" \
    >"$temp_output" 2>&1)
  local PROPOSAL_STATUS=$?
  set -e  # Re-enable exit on error

  # Read output from temp file
  proposal_output=$(cat "$temp_output" 2>/dev/null || echo "")
  rm -f "$temp_output" 2>/dev/null || true

  if [[ $PROPOSAL_STATUS -eq 0 ]]; then
    success "[$NETWORK] Successfully created proposal to remove permission for $EXECUTOR_ADDRESS to call function selector $FUNCTION_SELECTOR @LiFiDiamond: $DIAMOND_ADDRESS"
    return 0
  else
    # Extract comprehensive error information from output
    local signer_address
    local current_owners
    local error_summary

    # Check if it's the "not an owner" error
    if echo "$proposal_output" | grep -q "The current signer is not an owner"; then
      signer_address=$(echo "$proposal_output" | grep -A 1 "Signer address:" | tail -1 | sed 's/^[[:space:]]*//')
      current_owners=$(echo "$proposal_output" | grep -A 10 "Current owners:" | grep -E "^0x[a-fA-F0-9]{40}" | tr '\n' ' ' || echo "Unable to parse")
      error_summary="Signer ($signer_address) is not a Safe owner. Current owners: ${current_owners}"
    else
      # Try to extract other error messages
      error_summary=$(echo "$proposal_output" | grep -iE "(error|failed|revert|Cannot)" | head -3 | tr '\n' '; ' || echo "$proposal_output" | tail -3 | tr '\n' '; ')
    fi

    error "[$NETWORK] Failed to create proposal to remove permission for $EXECUTOR_ADDRESS to call function selector $FUNCTION_SELECTOR"
    error "[$NETWORK] Error details: ${error_summary:-Exit code $PROPOSAL_STATUS}"
    return 1
  fi
}

function removeDeployerWhitelistPermission() {
  # Function: removeDeployerWhitelistPermission
  # Description: Convenience wrapper to remove the old deployer wallet's permission to call batchSetContractSelectorWhitelist
  #              This is a specific use case for offboarding the old deployer wallet.
  #              Uses hardcoded values: function selector 0x1171c007 and old deployer address 0x11F1022cA6AdEF6400e5677528a80d49a069C00c
  # Arguments:
  #   $1 - NETWORK: Network name
  #   $2 - ENVIRONMENT: Environment (default: "production")
  # Returns:
  #   0 on success, 1 on failure
  # Example:
  #   removeDeployerWhitelistPermission "mainnet"
  #   removeDeployerWhitelistPermission "mainnet" "production"

  local NETWORK="$1"
  local ENVIRONMENT="${2:-production}"

  # Validate required parameters
  if [[ -z "$NETWORK" ]]; then
    error "Usage: removeDeployerWhitelistPermission NETWORK [ENVIRONMENT]"
    error "Example: removeDeployerWhitelistPermission mainnet"
    return 1
  fi

  # Hardcoded values for this specific use case
  local FUNCTION_SELECTOR="0x1171c007"  # batchSetContractSelectorWhitelist
  local OLD_DEPLOYER_ADDRESS="0x11F1022cA6AdEF6400e5677528a80d49a069C00c"

  echo "[$NETWORK] Removing whitelist permission from old deployer wallet ($OLD_DEPLOYER_ADDRESS)"
  echo "[$NETWORK] Function selector: $FUNCTION_SELECTOR (batchSetContractSelectorWhitelist)"

  # Call the generic function with hardcoded values
  removeAccessManagerPermission "$NETWORK" "$FUNCTION_SELECTOR" "$OLD_DEPLOYER_ADDRESS" "$ENVIRONMENT"
}

# =============================================================================
# STAGING DIAMOND OWNERSHIP TRANSFER
# =============================================================================

# Transfer ownership of staging diamond to new dev wallet
# This function performs the complete ownership transfer flow:
# 1. Identifies if there is a staging diamond for the network
# 2. Initiates ownership transfer from old dev wallet (using PRIVATE_KEY_OLD from .env)
# 3. Accepts ownership transfer from new dev wallet (using PRIVATE_KEY from .env)
# 4. Verifies that owner of staging diamond is new dev wallet (from config/global.json)
# Returns 0 on success, 1 on error (for retry logic)
# Usage: transferStagingDiamondOwnership <network>
function transferStagingDiamondOwnership() {
  local NETWORK="${1:-}"

  if [[ -z "$NETWORK" ]]; then
    error "transferStagingDiamondOwnership: Network is required"
    return 1
  fi

  # Step 1: Identify if there is a staging diamond
  local STAGING_DIAMOND_FILE="./deployments/${NETWORK}.diamond.staging.json"

  if [[ ! -f "$STAGING_DIAMOND_FILE" ]]; then
    logWithTimestamp "[$NETWORK] No staging diamond found - marking as success"
    return 0
  fi

  logWithTimestamp "[$NETWORK] Staging diamond found, starting ownership transfer..."

  # Get diamond address from staging deployment log using existing helper
  local DIAMOND_ADDRESS
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "staging" "LiFiDiamond")

  if [[ $? -ne 0 || -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" || "$DIAMOND_ADDRESS" == "0x" ]]; then
    error "[$NETWORK] Failed to get LiFiDiamond address from staging deployment log"
    return 1
  fi

  # Get new dev wallet address from global.json
  local NEW_DEV_WALLET
  NEW_DEV_WALLET=$(jq -r '.devWallet // empty' "./config/global.json" 2>/dev/null)

  if [[ -z "$NEW_DEV_WALLET" || "$NEW_DEV_WALLET" == "null" || "$NEW_DEV_WALLET" == "0x" ]]; then
    error "[$NETWORK] Failed to get devWallet from config/global.json"
    return 1
  fi

  # Get RPC URL for the network
  local RPC_URL
  RPC_URL=$(getRPCUrl "$NETWORK") || {
    error "[$NETWORK] Failed to get RPC URL"
    return 1
  }

  # Get current owner from the diamond
  local CURRENT_OWNER
  CURRENT_OWNER=$(cast call "$DIAMOND_ADDRESS" "owner() returns (address)" --rpc-url "$RPC_URL" 2>/dev/null)

  if [[ -z "$CURRENT_OWNER" || "$CURRENT_OWNER" == "0x" ]]; then
    error "[$NETWORK] Failed to get current owner from diamond at $DIAMOND_ADDRESS"
    return 1
  fi

  # Normalize addresses for comparison (lowercase)
  local CURRENT_OWNER_LOWER
  CURRENT_OWNER_LOWER=$(echo "$CURRENT_OWNER" | tr '[:upper:]' '[:lower:]')
  local NEW_DEV_WALLET_LOWER
  NEW_DEV_WALLET_LOWER=$(echo "$NEW_DEV_WALLET" | tr '[:upper:]' '[:lower:]')

  # Check if ownership transfer is already complete
  if [[ "$CURRENT_OWNER_LOWER" == "$NEW_DEV_WALLET_LOWER" ]]; then
    logWithTimestamp "[$NETWORK] Ownership already transferred to new dev wallet ($NEW_DEV_WALLET)"
    return 0
  fi

  logWithTimestamp "[$NETWORK] Current owner: $CURRENT_OWNER, New dev wallet: $NEW_DEV_WALLET"

  # Step 2: Get private key for old dev wallet (using PRIVATE_KEY_OLD from .env)
  local OLD_OWNER_PRIVATE_KEY="${PRIVATE_KEY_OLD:-}"

  if [[ -z "$OLD_OWNER_PRIVATE_KEY" ]]; then
    error "[$NETWORK] PRIVATE_KEY_OLD environment variable is not set"
    error "[$NETWORK] Please set PRIVATE_KEY_OLD in your .env file with the private key for the old dev wallet"
    return 1
  fi

  # Verify old owner private key matches current owner
  local OLD_OWNER_ADDRESS
  OLD_OWNER_ADDRESS=$(cast wallet address --private-key "$OLD_OWNER_PRIVATE_KEY" 2>/dev/null)

  if [[ -z "$OLD_OWNER_ADDRESS" ]]; then
    error "[$NETWORK] Failed to get address from PRIVATE_KEY_OLD"
    return 1
  fi

  local OLD_OWNER_ADDRESS_LOWER
  OLD_OWNER_ADDRESS_LOWER=$(echo "$OLD_OWNER_ADDRESS" | tr '[:upper:]' '[:lower:]')

  if [[ "$OLD_OWNER_ADDRESS_LOWER" != "$CURRENT_OWNER_LOWER" ]]; then
    error "[$NETWORK] PRIVATE_KEY_OLD address ($OLD_OWNER_ADDRESS) does not match current owner ($CURRENT_OWNER)"
    error "[$NETWORK] Cannot transfer ownership - current owner must match PRIVATE_KEY_OLD"
    return 1
  fi

  # Step 2a: Initiate ownership transfer from old owner
  logWithTimestamp "[$NETWORK] Step 1: Initiating ownership transfer from old dev wallet..."
  local TRANSFER_OUTPUT
  TRANSFER_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "transferOwnership(address)" "$NEW_DEV_WALLET" \
    --private-key "$OLD_OWNER_PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --legacy \
    2>&1)
  local TRANSFER_EXIT_CODE=$?

  if [[ $TRANSFER_EXIT_CODE -ne 0 ]]; then
    error "[$NETWORK] Failed to call transferOwnership: $TRANSFER_OUTPUT"
    return 1
  fi

  # Check if transfer was successful (look for transaction hash in output)
  if [[ "$TRANSFER_OUTPUT" != *"transactionHash"* && "$TRANSFER_OUTPUT" != *"blockHash"* ]]; then
    error "[$NETWORK] transferOwnership transaction may have failed. Output: $TRANSFER_OUTPUT"
    return 1
  fi

  logWithTimestamp "[$NETWORK] Step 1 completed successfully - ownership transfer initiated"
  logWithTimestamp "[$NETWORK] ⚠️  Next steps: Move funds to new dev wallet ($NEW_DEV_WALLET), then uncomment Step 2 and Step 3 below to accept and verify"

  # Step 3: Accept ownership transfer from new dev wallet
  logWithTimestamp "[$NETWORK] Step 2: Accepting ownership transfer from new dev wallet..."

  # Get private key for new dev wallet (using PRIVATE_KEY from .env)
  local NEW_DEV_WALLET_PRIVATE_KEY="${PRIVATE_KEY:-}"

  if [[ -z "$NEW_DEV_WALLET_PRIVATE_KEY" ]]; then
    error "[$NETWORK] PRIVATE_KEY environment variable is not set"
    error "[$NETWORK] Please set PRIVATE_KEY in your .env file with the private key for $NEW_DEV_WALLET"
    return 1
  fi

  # Verify new dev wallet private key matches the expected address
  local VERIFIED_NEW_OWNER_ADDRESS
  VERIFIED_NEW_OWNER_ADDRESS=$(cast wallet address --private-key "$NEW_DEV_WALLET_PRIVATE_KEY" 2>/dev/null)

  if [[ -z "$VERIFIED_NEW_OWNER_ADDRESS" ]]; then
    error "[$NETWORK] Failed to get address from PRIVATE_KEY"
    return 1
  fi

  local VERIFIED_NEW_OWNER_ADDRESS_LOWER
  VERIFIED_NEW_OWNER_ADDRESS_LOWER=$(echo "$VERIFIED_NEW_OWNER_ADDRESS" | tr '[:upper:]' '[:lower:]')

  if [[ "$VERIFIED_NEW_OWNER_ADDRESS_LOWER" != "$NEW_DEV_WALLET_LOWER" ]]; then
    error "[$NETWORK] PRIVATE_KEY does not match new dev wallet address"
    error "[$NETWORK] Expected: $NEW_DEV_WALLET, Got: $VERIFIED_NEW_OWNER_ADDRESS"
    return 1
  fi

  local CONFIRM_OUTPUT
  CONFIRM_OUTPUT=$(cast send "$DIAMOND_ADDRESS" "confirmOwnershipTransfer()" \
    --private-key "$NEW_DEV_WALLET_PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --legacy \
    2>&1)
  local CONFIRM_EXIT_CODE=$?

  if [[ $CONFIRM_EXIT_CODE -ne 0 ]]; then
    # Check if the error is because there's no pending transfer
    if [[ "$CONFIRM_OUTPUT" == *"NotPendingOwner"* ]] || [[ "$CONFIRM_OUTPUT" == *"NoPendingOwnershipTransfer"* ]]; then
      error "[$NETWORK] No pending ownership transfer found. This may indicate the transfer was cancelled or already completed"
      return 1
    else
      error "[$NETWORK] Failed to call confirmOwnershipTransfer: $CONFIRM_OUTPUT"
      return 1
    fi
  fi

  # Check if confirmation was successful
  if [[ "$CONFIRM_OUTPUT" != *"transactionHash"* && "$CONFIRM_OUTPUT" != *"blockHash"* ]]; then
    error "[$NETWORK] confirmOwnershipTransfer transaction may have failed. Output: $CONFIRM_OUTPUT"
    return 1
  fi

  logWithTimestamp "[$NETWORK] Step 2 completed successfully - ownership transfer accepted"

  # Step 4: Verify that owner of staging diamond is new dev wallet
  logWithTimestamp "[$NETWORK] Step 3: Verifying ownership transfer..."
  local VERIFIED_OWNER
  VERIFIED_OWNER=$(cast call "$DIAMOND_ADDRESS" "owner() returns (address)" --rpc-url "$RPC_URL" 2>/dev/null)

  if [[ -z "$VERIFIED_OWNER" || "$VERIFIED_OWNER" == "0x" ]]; then
    error "[$NETWORK] Failed to verify new owner"
    return 1
  fi

  local VERIFIED_OWNER_LOWER
  VERIFIED_OWNER_LOWER=$(echo "$VERIFIED_OWNER" | tr '[:upper:]' '[:lower:]')

  if [[ "$VERIFIED_OWNER_LOWER" == "$NEW_DEV_WALLET_LOWER" ]]; then
    logWithTimestamp "[$NETWORK] ✅ Ownership successfully transferred to new dev wallet ($NEW_DEV_WALLET)"
    return 0
  else
    error "[$NETWORK] Ownership verification failed. Current owner: $VERIFIED_OWNER, Expected: $NEW_DEV_WALLET"
    return 1
  fi
}

# =============================================================================
# EXPORT FUNCTIONS FOR USE IN OTHER SCRIPTS
# =============================================================================

# Contract verification and deployment
export -f getContractVerified
export -f deployContract
export -f getContractDeploymentStatusSummary
export -f compareContractBytecode
export -f isContractAlreadyDeployed
export -f isContractAlreadyVerified

# Network utilities
export -f getNetworksByEvmVersionAndContractDeployment
export -f getNetworkEvmVersion
export -f getNetworkSolcVersion
export -f isZkEvmNetwork
export -f getNetworkGroup

# Multisig proposal functions
export -f createMultisigProposalForContract
export -f proposeDiamondCutForContract
export -f proposePeripheryContractRegistration

# Access management
export -f removeAccessManagerPermission
export -f removeDeployerWhitelistPermission
export -f manageTimelockCanceller
export -f manageSafeOwner

# Utility functions
export -f validateDependencies
export -f logWithTimestamp
export -f logNetworkResult
export -f analyzeFailingTx
export -f transferStagingDiamondOwnership
export -f manageTimelockCanceller
export -f manageSafeOwner
