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
# TARGET STATE MANAGEMENT FUNCTIONS
# =============================================================================

function addContractVersionToTargetState() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  CONTRACT_NAME=$3
  DIAMOND_NAME=$4
  VERSION=$5
  UPDATE_EXISTING=$6

  # check if entry already exists
  ENTRY_EXISTS=$(jq ".\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" // empty" "$TARGET_STATE_PATH")

  # check if entry should be updated and log warning if debug flag is set
  if [[ -n "$ENTRY_EXISTS" ]]; then
    if [[ "$UPDATE_EXISTING" == *"false"* ]]; then
      warning "target state file already contains an entry for NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, and CONTRACT_NAME:$CONTRACT_NAME."
      # exit script
      return 1
    else
      echoDebug "target state file already contains an entry for NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, and CONTRACT_NAME:$CONTRACT_NAME. Updating version."
    fi
  fi

  # add or update target state file
  jq ".\"${NETWORK}\" = (.\"${NETWORK}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" = \"${VERSION}\"" "$TARGET_STATE_PATH" >temp.json && mv temp.json "$TARGET_STATE_PATH"
}

function updateExistingContractVersionInTargetState() {
  # this function will update only existing entries, not add new ones

  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  CONTRACT_NAME=$3
  DIAMOND_NAME=$4
  VERSION=$5

  # check if entry already exists
  ENTRY_EXISTS=$(jq ".\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" // empty" "$TARGET_STATE_PATH")

  # check if entry should be updated and log warning if debug flag is set
  if [[ -n "$ENTRY_EXISTS" ]]; then
    echo "[info]: updating version in target state file: NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, CONTRACT_NAME:$CONTRACT_NAME, new VERSION: $VERSION."
    # add or update target state file
    jq ".\"${NETWORK}\" = (.\"${NETWORK}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" = \"${VERSION}\"" "$TARGET_STATE_PATH" >temp.json && mv temp.json "$TARGET_STATE_PATH"
  else
    echo "[info]: target state file does not contain an entry for NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, and CONTRACT_NAME:$CONTRACT_NAME that could be updated."
    # exit script
    return 1
  fi
}

function updateContractVersionInAllIncludedNetworks() {
  # read function arguments into variables
  local ENVIRONMENT=$1
  local CONTRACT_NAME=$2
  local DIAMOND_NAME=$3
  local VERSION=$4

  # get an array with all networks
  local NETWORKS=$(getIncludedNetworksArray)

  # go through all networks
  for NETWORK in $NETWORKS; do
    # update existing entries
    updateExistingContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT_NAME" "$DIAMOND_NAME" "$VERSION"
  done
}

function addNewContractVersionToAllIncludedNetworks() {
  # read function arguments into variables
  local ENVIRONMENT=$1
  local CONTRACT_NAME=$2
  local DIAMOND_NAME=$3
  local VERSION=$4
  local UPDATE_EXISTING=$5

  # get an array with all networks
  local NETWORKS=$(getIncludedNetworksArray)

  # go through all networks
  for NETWORK in $NETWORKS; do
    # update existing entries
    addContractVersionToTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT_NAME" "$DIAMOND_NAME" "$VERSION" "$UPDATE_EXISTING"
  done
}

function addNewNetworkWithAllIncludedContractsInLatestVersions() {
  # read function arguments into variables
  local NETWORK=$1
  local ENVIRONMENT=$2
  local DIAMOND_NAME=$3

  if [[ -z "$NETWORK" || -z "$ENVIRONMENT" || -z "$DIAMOND_NAME" ]]; then
    error "function addNewNetworkWithAllIncludedContractsInLatestVersions called with invalid parameters: NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, DIAMOND_NAME=$DIAMOND_NAME"
    return 1
  fi

  # get all facet contracts
  local FACET_CONTRACTS=$(getIncludedAndSortedFacetContractsArray)

  # get all periphery contracts
  local PERIPHERY_CONTRACTS=$(getIncludedPeripheryContractsArray)

  # merge all contracts into one array
  local ALL_CONTRACTS=("$DIAMOND_NAME" "${FACET_CONTRACTS[@]}" "${PERIPHERY_CONTRACTS[@]}")

  # go through all contracts
  for CONTRACT in ${ALL_CONTRACTS[*]}; do
    # get current contract version
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")

    # add to target state json
    addContractVersionToTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_NAME" "$CURRENT_VERSION" true
    if [ $? -ne 0 ]; then
      error "could not add contract version to target state for NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, CONTRACT=$CONTRACT, DIAMOND_NAME=$DIAMOND_NAME, VERSION=$CURRENT_VERSION"
    fi
  done
}

function findContractVersionInTargetState() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  CONTRACT="$3"
  DIAMOND_NAME=$4

  # Check if target state FILE exists
  if [ ! -f "$TARGET_STATE_PATH" ]; then
    error "target state FILE does not exist in path $TARGET_STATE_PATH"
    exit 1
  fi

  # find matching entry
  local TARGET_STATE_FILE=$(cat "$TARGET_STATE_PATH")
  local RESULT=$(echo "$TARGET_STATE_FILE" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg DIAMOND_NAME "$DIAMOND_NAME" '.[$NETWORK][$ENVIRONMENT][$DIAMOND_NAME][$CONTRACT]')

  if [[ "$RESULT" != "null" ]]; then
    # entry found
    # remove leading and trailing "
    RESULT_ADJUSTED=$(echo "$RESULT" | sed 's/"//g')

    # return TARGET_STATE_FILE and success error code
    echo "${RESULT_ADJUSTED}"
    return 0
  else
    # entry not found - issue error message and return error code
    echo "[info] No matching entry found in target state file for NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, CONTRACT=$CONTRACT"
    return 1
  fi
}

# =============================================================================
# BLOCKCHAIN READ FUNCTIONS
# =============================================================================

function getContractAddressFromSalt() {
  # read function arguments into variables
  local SALT=$1
  local NETWORK=$2
  local CONTRACT_NAME=$3
  local ENVIRONMENT=$4

  # get RPC URL
  local RPC_URL="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

  # get deployer address
  local DEPLOYER_ADDRESS=$(getDeployerAddress "$NETWORK" "$ENVIRONMENT")

  # get actual deploy salt (as we do in DeployScriptBase:  keccak256(abi.encodePacked(saltPrefix, contractName));)
  ACTUAL_SALT=$(cast keccak "0x$(echo -n "$SALT$CONTRACT_NAME" | xxd -p -c 256)")

  # call create3 factory to obtain contract address
  RESULT=$(cast call "$CREATE3_FACTORY_ADDRESS" "getDeployed(address,bytes32) returns (address)" "$DEPLOYER_ADDRESS" "$ACTUAL_SALT" --rpc-url "${!RPC_URL}")

  # return address
  echo "$RESULT"
}

function getDeployerAddress() {
  # read function arguments into variables
  local NETWORK=$1
  local ENVIRONMENT=$2

  PRIV_KEY="$(getPrivateKey "$NETWORK" "$ENVIRONMENT")"

  # get deployer address from private key
  DEPLOYER_ADDRESS=$(cast wallet address "$PRIV_KEY")

  # return deployer address
  echo "$DEPLOYER_ADDRESS"
}

function getDeployerBalance() {
  # read function arguments into variables
  local NETWORK=$1
  local ENVIRONMENT=$2

  # get RPC URL
  RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  # get deployer address
  ADDRESS=$(getDeployerAddress "$NETWORK" "$ENVIRONMENT")

  # get balance in given network
  BALANCE=$(cast balance "$ADDRESS" --rpc-url "$RPC_URL")

  # return formatted balance
  echo "$(echo "scale=10;$BALANCE / 1000000000000000000" | bc)"
}

function doesDiamondHaveCoreFacetsRegistered() {
  # read function arguments into variables
  local DIAMOND_ADDRESS="$1"
  local NETWORK="$2"
  local FILE_SUFFIX="$3"

  # get file with deployment addresses
  DEPLOYMENTS_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  # get list of all core facet contracts from global.json
  FACETS_NAMES=($(getCoreFacetsArray))
  checkFailure $? "retrieve core facets array from global.json"


  # get a list of all facets that the diamond knows
  KNOWN_FACET_ADDRESSES=$(cast call "$DIAMOND_ADDRESS" "facets() returns ((address,bytes4[])[])" --rpc-url "$RPC_URL") 2>/dev/null
  local CAST_EXIT_CODE=$?
  if [ $CAST_EXIT_CODE -ne 0 ]; then
    echoDebug "not all core facets are registered in the diamond"
    return 1
  fi

  # extract the IDiamondLoupe.Facet tuples
  tuples=($(echo "${KNOWN_FACET_ADDRESSES:1:${#KNOWN_FACET_ADDRESSES}-2}" | sed 's/),(/) /g' | sed 's/[()]//g'))

  # extract the addresses from the tuples into an array
  ADDRESSES=()
  for tpl in "${tuples[@]}"; do
    tpl="${tpl// /}"  # remove spaces
    tpl="${tpl//\'/}" # remove single quotes
    addr="${tpl%%,*}" # extract address from tuple
    ADDRESSES+=("$addr")
  done

  # loop through all contracts
  for FACET_NAME in "${FACETS_NAMES[@]}"; do
    # get facet address from deployments file
    local FACET_ADDRESS=$(jq -r ".$FACET_NAME" "$DEPLOYMENTS_FILE")
    # check if the address is not included in the diamond
    local FOUND=false
    for addr in "${ADDRESSES[@]}"; do
      if [[ "$addr" == "$FACET_ADDRESS" ]]; then
        FOUND=true
        break
      fi
    done

    if [[ "$FOUND" == "false" ]]; then
      echoDebug "not all core facets are registered in the diamond"

      # not included, return error code
      return 1
    fi
  done
  return 0
}

function getPeripheryAddressFromDiamond() {
  # read function arguments into variables
  local NETWORK="$1"
  local DIAMOND_ADDRESS="$2"
  local PERIPHERY_CONTRACT_NAME="$3"

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  # call diamond to check for periphery address
  PERIPHERY_CONTRACT_ADDRESS=$(cast call "$DIAMOND_ADDRESS" "getPeripheryContract(string) returns (address)" "$PERIPHERY_CONTRACT_NAME" --rpc-url "${RPC_URL}")

  if [[ "$PERIPHERY_CONTRACT_ADDRESS" == "$ZERO_ADDRESS" ]]; then
    return 1
  else
    echo "$PERIPHERY_CONTRACT_ADDRESS"
    return 0
  fi
}

function getFacetFunctionSelectorsFromDiamond() {
  # THIS FUNCTION NEEDS TO BE UPDATED/FIXED BEFORE BEING USED AGAIN

  # read function arguments into variables
  local DIAMOND_ADDRESS="$1"
  local FACET_NAME="$2"
  local NETWORK="$3"
  local ENVIRONMENT="$4"
  local EXIT_ON_ERROR="$5"

  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # get facet address from deployments JSON
  local FILE_PATH="deployments/$NETWORK.${FILE_SUFFIX}json"
  local FACET_ADDRESS=$(jq -r ".$FACET_NAME" "$FILE_PATH")

  # check if facet address was found
  if [[ -z "$FACET_ADDRESS" ]]; then
    error "no address found for $FACET_NAME in $FILE_PATH"
    return 1
  fi

  # get RPC URL
  local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

  # get path of diamond log file
  local DIAMOND_FILE_PATH="deployments/$NETWORK.diamond.${FILE_SUFFIX}json"

  # search in DIAMOND_FILE_PATH for the given address
  if jq -e ".facets | index(\"$FACET_ADDRESS\")" "$DIAMOND_FILE_PATH" >/dev/null; then # << this does not yet reflect the new file structure !!!!!!
    # get function selectors from diamond (function facetFunctionSelectors)
    local ATTEMPTS=1
    while [[ -z "$FUNCTION_SELECTORS" && $ATTEMPTS -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]]; do
      # get address of facet in diamond
      local FUNCTION_SELECTORS=$(cast call "$DIAMOND_ADDRESS" "facetFunctionSelectors(address) returns (bytes4[])" "$FACET_ADDRESS" --rpc-url "${!RPC}")
      ((ATTEMPTS++))
      sleep 1
    done

    if [[ "$ATTEMPTS" -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]]; then
      error "could not get facet address after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts, exiting."
      return 1
    fi
  else
    error "$FACET_NAME with address $FACET_ADDRESS is not known by diamond $DIAMOND_ADDRESS on network $NETWORK in $ENVIRONMENT environment. Please check why you tried to remove this facet from the diamond."
    return 1
  fi

  # return the selectors array
  echo "${FUNCTION_SELECTORS[@]}"
}

function getFacetAddressFromSelector() {
  # read function arguments into variables
  local DIAMOND_ADDRESS="$1"
  local FACET_NAME="$2"
  local NETWORK="$3"
  local FUNCTION_SELECTOR="$4"

  #echo "FUNCTION_SELECTOR in Func: $FUNCTION_SELECTOR"

  # get RPC URL
  local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

  # loop until FACET_ADDRESS has a value or maximum attempts are reached
  local FACET_ADDRESS
  local ATTEMPTS=1
  while [[ -z "$FACET_ADDRESS" && $ATTEMPTS -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]]; do
    # get address of facet in diamond
    FACET_ADDRESS=$(cast call "$DIAMOND_ADDRESS" "facetAddress(bytes4) returns (address)" "$FUNCTION_SELECTOR" --rpc-url "${!RPC}")
    ((ATTEMPTS++))
    sleep 1
  done

  if [[ "$ATTEMPTS" -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]]; then
    error "could not get facet address after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts, exiting."
    return 1
  fi

  echo "$FACET_ADDRESS"
  return 0
}

function doesFacetExistInDiamond() {
  # read function arguments into variables
  local DIAMOND_ADDRESS=$1
  local FACET_NAME=$2
  local NETWORK=$3

  # get all facet selectors of the facet to be checked
  local SELECTORS=$(getFunctionSelectorsFromContractABI "$FACET_NAME")

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  # loop through facet selectors and see if this selector is known by the diamond
  for SELECTOR in $SELECTORS; do
    # call diamond to get address of facet for given selector
    local RESULT=$(cast call "$DIAMOND_ADDRESS" "facetAddress(bytes4) returns (address)" "$SELECTOR" --rpc-url "$RPC_URL")

    # if result != address(0) >> facet selector is known
    if [[ "$RESULT" != "0x0000000000000000000000000000000000000000" ]]; then
      echo "true"
      return 0
    fi
  done

  echo "false"
  return 0
}

function doesAddressContainBytecode() {
  # read function arguments into variables
  NETWORK="$1"
  ADDRESS="$2"

  # check address value
  if [[ "$ADDRESS" == "null" || "$ADDRESS" == "" ]]; then
    echo "[warning]: trying to verify deployment at invalid address: ($ADDRESS)"
    return 1
  fi

  # get correct node URL for given NETWORK
  RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  # check if NODE_URL is available
  if [ -z "$RPC_URL" ]; then
    error ": no node url found for NETWORK $NETWORK. Please update your .env FILE and make sure it has a value for the following key: $NODE_URL_KEY"
    return 1
  fi

  # make sure address is in correct checksum format
  CHECKSUM_ADDRESS=$(cast to-check-sum-address "$ADDRESS")

  # get CONTRACT code from ADDRESS using
  contract_code=$(cast code "$ADDRESS" --rpc-url "$RPC_URL")

  # return ƒalse if ADDRESS does not contain CONTRACT code, otherwise true
  if [[ "$contract_code" == "0x" || "$contract_code" == "" ]]; then
    echo "false"
  else
    echo "true"
  fi
}

function getFacetAddressFromDiamond() {
  # read function arguments into variables
  local NETWORK="$1"
  local DIAMOND_ADDRESS="$2"
  local SELECTOR="$3"

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  local RESULT=$(cast call "$DIAMOND_ADDRESS" "facetAddress(bytes4) returns (address)" "$SELECTOR" --rpc-url "$RPC_URL")

  echo "$RESULT"
}

function getCurrentGasPrice() {
  # read function arguments into variables
  local NETWORK=$1

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")

  echo "$GAS_PRICE"
}

function getContractOwner() {
  # read function arguments into variables
  local Unetwork=$1
  local Uenvironment=$2
  local Ucontract=$3

  # get RPC URL
  rpc_url=$(getRPCUrl "$network") || checkFailure $? "get rpc url"

  # get contract address
  address=$(getContractAddressFromDeploymentLogs "$network" "$environment" "$contract")
  local ADDRESS_EXIT_CODE=$?

  # check if address was found
  if [[ $ADDRESS_EXIT_CODE -ne 0 || -z $address ]]; then
    echoDebug "could not find address of '$contract' in network-specific deploy log"
    return 1
  fi

  # get owner
  owner=$(cast call "$address" "owner()" --rpc-url "$rpc_url")

  if [[ $? -ne 0 || -z $owner ]]; then
    echoDebug "unable to retrieve owner of $contract with address $address on network $network ($environment)"
    return 1
  fi

  echo "$owner"
  return 0
}

function getPendingContractOwner() {
  # read function arguments into variables
  local Unetwork=$1
  local Uenvironment=$2
  local Ucontract=$3

  # get RPC URL
  rpc_url=$(getRPCUrl "$network") || checkFailure $? "get rpc url"

  # get contract address
  address=$(getContractAddressFromDeploymentLogs "$network" "$environment" "$contract")
  local ADDRESS_EXIT_CODE=$?

  # check if address was found
  if [[ $ADDRESS_EXIT_CODE -ne 0 || -z $address ]]; then
    echoDebug "could not find address of '$contract' in network-specific deploy log"
    return 1
  fi

  # get owner
  owner=$(cast call "$address" "pendingOwner()" --rpc-url "$rpc_url")

  if [[ $? -ne 0 || -z $owner ]]; then
    echoDebug "unable to retrieve pending owner of $contract with address $address on network $network ($environment)"
    return 1
  fi

  echo "$owner"
  return 0
}

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

function doNotContinueUnlessGasIsBelowThreshold() {
  # read function arguments into variables
  local NETWORK=$1

  if [ "$NETWORK" != "mainnet" ]; then
    return 0
  fi

  echo "ensuring gas price is below maximum threshold as defined in config (for mainnet only)"

  # Start the do-while loop
  while true; do
    # Get the current gas price
    CURRENT_GAS_PRICE=$(getCurrentGasPrice "mainnet")

    # Check if the counter variable has reached 10
    if [ "$MAINNET_MAXIMUM_GAS_PRICE" -gt "$CURRENT_GAS_PRICE" ]; then
      # If the counter variable has reached 10, exit the loop
      echo "gas price ($CURRENT_GAS_PRICE) is below maximum threshold ($MAINNET_MAXIMUM_GAS_PRICE) - continuing with script execution"
      return 0
    else
      echo "gas price ($CURRENT_GAS_PRICE) is above maximum ($MAINNET_MAXIMUM_GAS_PRICE) - waiting..."
      echo ""
    fi

    # wait 5 seconds before checking gas price again
    sleep 5
  done
}

function getRPCUrl() {
  # read function arguments into variables
  local NETWORK=$1

  # get RPC KEY
  RPC_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

  # return RPC URL
  echo "${!RPC_KEY}"
}

function getRpcUrlFromNetworksJson() {
  local NETWORK="$1"

  # make sure networks.json exists
  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"

  # extract RPC URL from networks.json for given network
  local RPC_URL=$(jq -r --arg network "$NETWORK" '.[$network].rpcUrl // empty' "$NETWORKS_JSON_FILE_PATH")

  # make sure a value was found
  if [[ -z "$RPC_URL" ]]; then
    echo "Error: Network '$NETWORK' not found in '$NETWORKS_JSON_FILE_PATH'." >&2
    return 1
  fi

  echo "$RPC_URL"
}

function playNotificationSound() {
  if [[ "$NOTIFICATION_SOUNDS" == *"true"* ]]; then
    afplay ./script/deploy/resources/notification.mp3
  fi
}

function deployAndAddContractToDiamond() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  CONTRACT="$3"
  DIAMOND_CONTRACT_NAME="$4"
  VERSION="$5"

  # logging for debug purposes
  echo ""
  echoDebug "in function deployAndAddContractToDiamond"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "CONTRACT=$CONTRACT"
  echoDebug "DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
  echoDebug "VERSION=$VERSION"
  echo ""

  # check which type of contract we are deploying
  if [[ "$CONTRACT" == *"Facet"* ]]; then
    # deploying a facet
    deployFacetAndAddToDiamond "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_CONTRACT_NAME" "$VERSION"
    return 0
  elif [[ "$CONTRACT" == *"LiFiDiamond"* ]]; then
    # deploying a diamond
    deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" false
    return 0
  else
    # deploy periphery contract
    deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" false "$DIAMOND_CONTRACT_NAME"

    # save return code
    RETURN_CODE1=$?

    # update periphery registry in diamond
    diamondUpdatePeriphery "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" false false "$CONTRACT"
    RETURN_CODE2=$?

    if [[ "$RETURN_CODE1" -eq 0 || "$RETURN_CODE2" -eq 0 ]]; then
      return 0
    else
      return 1
    fi
  fi

  # there was an error if we reach this code
  return 1
}

function getPrivateKey() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"

  # skip for local network
  if [[ "$NETWORK" == "localanvil" || "$NETWORK" == "LOCALANVIL" ]]; then
    echo "$PRIVATE_KEY_ANVIL"
    return 0
  fi

  # check environment value
  if [[ "$ENVIRONMENT" == *"staging"* ]]; then
    # check if env variable is set/available
    if [[ -z "$PRIVATE_KEY" ]]; then
      error "could not find PRIVATE_KEY value in your .env file"
      return 1
    else
      echo "$PRIVATE_KEY"
      return 0
    fi
  else
    # check if env variable is set/available
    if [[ -z "$PRIVATE_KEY_PRODUCTION" ]]; then
      error "could not find PRIVATE_KEY_PRODUCTION value in your .env file"
      return 1
    else
      echo "$PRIVATE_KEY_PRODUCTION"
      return 0
    fi
  fi
}

function isActiveMainnet() {
  # read function arguments into variables
  local NETWORK="$1"

  # Check if the network exists in the JSON
  if ! jq -e --arg network "$NETWORK" '.[$network] != null' "$NETWORKS_JSON_FILE_PATH" > /dev/null; then
    error "Network '$NETWORK' not found in networks.json"
    return 1  # false
  fi

  local TYPE=$(jq -r --arg network "$NETWORK" '.[$network].type // empty' "$NETWORKS_JSON_FILE_PATH")
  local STATUS=$(jq -r --arg network "$NETWORK" '.[$network].status // empty' "$NETWORKS_JSON_FILE_PATH")

  # Check if both values are present and match required conditions
  if [[ "$TYPE" == "mainnet" && "$STATUS" == "active" ]]; then
    return 0  # true
  else
    return 1  # false
  fi
}

function getChainId() {
  local NETWORK="$1"

  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
  if [[ ! -f "$NETWORKS_JSON_FILE_PATH" ]]; then
    echo "Error: JSON file '$NETWORKS_JSON_FILE_PATH' not found." >&2
    return 1
  fi

  local CHAIN_ID=$(jq -r --arg network "$NETWORK" '.[$network].chainId // empty' "$NETWORKS_JSON_FILE_PATH")

  if [[ -z "$CHAIN_ID" ]]; then
    echo "Error: Network '$NETWORK' not found in '$NETWORKS_JSON_FILE_PATH'." >&2
    return 1
  fi

  echo "$CHAIN_ID"
}

function getCreate3FactoryAddress() {
  NETWORK="$1"
  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
  CREATE3_FACTORY=$(jq --arg NETWORK "$NETWORK" -r '.[$NETWORK].create3Factory // empty' "$NETWORKS_JSON_FILE_PATH")

  if [ -z "$CREATE3_FACTORY" ]; then
    echo "Error: create3Factory address not found for network '$NETWORK'"
    return 1
  fi

  echo "$CREATE3_FACTORY"
}

function convertToBcInt() {
  echo "$1" | tr -d '\n' | bc
}

function extractDeployedAddressFromRawReturnData() {
  local RAW_DATA="$1"
  local NETWORK="$2"
  local ADDRESS=""
  local CLEAN_DATA=""

  # Attempt to isolate the JSON blob that starts with {"logs":
  CLEAN_DATA=$(echo "$RAW_DATA" | grep -o '{\"logs\":.*')

  # Try extracting from `.returns.deployed.value`
  ADDRESS=$(echo "$CLEAN_DATA" | jq -r '.returns.deployed.value // empty' 2>/dev/null)

  # Fallback: try to extract from Etherscan "contract_address"
  if [[ -z "$ADDRESS" ]]; then
    ADDRESS=$(echo "$RAW_DATA" | grep -oE '"contract_address"\s*:\s*"0x[a-fA-F0-9]{40}"' | head -n1 | grep -oE '0x[a-fA-F0-9]{40}')
  fi

  # Last resort: use first 0x-prefixed address in blob
  if [[ -z "$ADDRESS" ]]; then
    ADDRESS=$(echo "$RAW_DATA" | grep -oE '0x[a-fA-F0-9]{40}' | head -n1)
  fi

  # Validate the format of the extracted address
  if [[ "$ADDRESS" =~ ^0x[a-fA-F0-9]{40}$ ]]; then
    # check every 10 seconds up until MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC
    local COUNT=0
    while [ $COUNT -lt "$MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC" ]; do
      # check if address contains and bytecode and leave the loop if bytecode is found
      if [[ "$(doesAddressContainBytecode "$NETWORK" "$ADDRESS")" == "true" ]]; then
        break
      fi
      echoDebug "waiting 10 seconds for blockchain to sync bytecode (max wait time: $MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC seconds)"
      sleep 10
      COUNT=$((COUNT + 10))
    done

    if [ $COUNT -ge "$MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC" ]; then
      echo "❌ Extracted address does not contain bytecode" >&2
      return 1
    fi

    echo "$ADDRESS"
    return 0
  else
    echo "❌ Failed to find any deployed-to address in raw return data" >&2
    return 1
  fi
}

function transferContractOwnership() {
    # transfers ownership of the given contract from old wallet to new wallet (e.g. new tester wallet)
    # will fail if old wallet is not owner
    # will transfer native funds from new owner to old owner, if old wallet has insufficient funds
    # will send all remaining native funds from old owner to new owner after ownership transfer
    local PRIV_KEY_OLD_OWNER="$1"
    local PRIV_KEY_NEW_OWNER="$2"
    local CONTRACT_ADDRESS="$3"
    local NETWORK="$4"

    # Define minimum native balance
    local MIN_NATIVE_BALANCE=$(convertToBcInt "100000000000000") # 100,000 Gwei
    local NATIVE_TRANSFER_GAS_STIPEND=$(convertToBcInt "21000000000000") # 21,000 Gwei
    local MIN_NATIVE_BALANCE_DOUBLE=$(convertToBcInt "$MIN_NATIVE_BALANCE * 2")

    local RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

    # Get address of old and new owner
    local ADDRESS_OLD_OWNER=$(cast wallet address --private-key "$PRIV_KEY_OLD_OWNER")
    local ADDRESS_NEW_OWNER=$(cast wallet address --private-key "$PRIV_KEY_NEW_OWNER")
    echo "Transferring ownership of contract $CONTRACT_ADDRESS on $NETWORK from $ADDRESS_OLD_OWNER to $ADDRESS_NEW_OWNER now"

    # make sure OLD_OWNER is actually contract owner
    local CURRENT_OWNER=$(cast call "$CONTRACT_ADDRESS" "owner() returns (address)" --rpc-url "$RPC_URL")
    if [[ "$CURRENT_OWNER" -ne "$ADDRESS_OLD_OWNER" ]]; then
      error "Current contract owner ($CURRENT_OWNER) does not match with private key of old owner provided ($ADDRESS_OLD_OWNER)"
      return 1
    fi

    # Check native funds of old owner wallet
    local NATIVE_BALANCE_OLD=$(convertToBcInt "$(cast balance "$ADDRESS_OLD_OWNER" --rpc-url "$RPC_URL")")
    local NATIVE_BALANCE_NEW=$(convertToBcInt "$(cast balance "$ADDRESS_NEW_OWNER" --rpc-url "$RPC_URL")")

    echo "native balance old owner: $NATIVE_BALANCE_OLD"
    echo "native balance new owner: $NATIVE_BALANCE_NEW"

    # make sure that sufficient native balances are available on both wallets
    if (( $(echo "$NATIVE_BALANCE_OLD < $MIN_NATIVE_BALANCE" | bc -l) )); then
        echo "old balance is low"
        if (( $(echo "$NATIVE_BALANCE_NEW < $MIN_NATIVE_BALANCE_DOUBLE" | bc -l) )); then
            echo "balance of new owner wallet is too low. Cannot continue"
            return 1
        else
            echo "sending ""$MIN_NATIVE_BALANCE"" native tokens from new (""$ADDRESS_NEW_OWNER"") to old wallet (""$ADDRESS_OLD_OWNER"") now"
            # Send some funds from new to old wallet
            cast send "$ADDRESS_OLD_OWNER" --value "$MIN_NATIVE_BALANCE" --private-key "$PRIV_KEY_NEW_OWNER" --rpc-url "$RPC_URL"

            NATIVE_BALANCE_OLD=$(convertToBcInt "$(cast balance "$ADDRESS_OLD_OWNER" --rpc-url "$RPC_URL")")
            NATIVE_BALANCE_NEW=$(convertToBcInt "$(cast balance "$ADDRESS_NEW_OWNER" --rpc-url "$RPC_URL")")
            echo ""
            echo "native balance old owner: $NATIVE_BALANCE_OLD"
            echo "native balance new owner: $NATIVE_BALANCE_NEW"
        fi
    fi

    # # transfer ownership to new owner
    echo ""
    echo "[info] calling transferOwnership() function from old owner wallet now"
    cast send "$CONTRACT_ADDRESS" "transferOwnership(address)" "$ADDRESS_NEW_OWNER" --private-key "$PRIV_KEY_OLD_OWNER" --rpc-url "$RPC_URL"
    echo ""

    # # accept ownership transfer
    echo ""
    echo "[info] calling confirmOwnershipTransfer() function from new owner wallet now"
    cast send "$CONTRACT_ADDRESS" "confirmOwnershipTransfer()" --private-key "$PRIV_KEY_NEW_OWNER" --rpc-url "$RPC_URL"
    echo ""
    echo ""

    # send remaining native tokens from old owner wallet to new owner wallet
    NATIVE_BALANCE_OLD=$(convertToBcInt "$(cast balance "$ADDRESS_OLD_OWNER" --rpc-url "$RPC_URL")")
    SENDABLE_BALANCE=$(convertToBcInt "$NATIVE_BALANCE_OLD - $NATIVE_TRANSFER_GAS_STIPEND")
    if [[ $SENDABLE_BALANCE -gt 0 ]]; then
      echo ""
      echo "sending ""$SENDABLE_BALANCE"" native tokens from old (""$ADDRESS_OLD_OWNER"") to new wallet (""$ADDRESS_NEW_OWNER"") now"
      cast send "$ADDRESS_NEW_OWNER" --value "$SENDABLE_BALANCE" --private-key "$PRIV_KEY_OLD_OWNER" --rpc-url "$RPC_URL"
    else
      echo "remaining native balance in old wallet is too low to send back to new wallet"
    fi

    # check balances
    NATIVE_BALANCE_OLD=$(convertToBcInt "$(cast balance "$ADDRESS_OLD_OWNER" --rpc-url "$RPC_URL")")
    NATIVE_BALANCE_NEW=$(convertToBcInt "$(cast balance "$ADDRESS_NEW_OWNER" --rpc-url "$RPC_URL")")
    echo ""
    echo "native balance old owner: $NATIVE_BALANCE_OLD"
    echo "native balance new owner: $NATIVE_BALANCE_NEW"

    # make sure NEW OWNER is actually contract owner
    CURRENT_OWNER=$(cast call "$CONTRACT_ADDRESS" "owner() returns (address)" --rpc-url "$RPC_URL")
    echo ""
    if [[ "$CURRENT_OWNER" -ne "$ADDRESS_NEW_OWNER" ]]; then
      error "Current contract owner ($CURRENT_OWNER) does not match with new owner address ($ADDRESS_NEW_OWNER). Ownership transfer failed"
      return 1
    else
      echo "Ownership transfer executed successfully"
      return 0
    fi
}

function printDeploymentsStatus() {
  # read function arguments into variables
  ENVIRONMENT="$1"
  echo ""
  echo "+--------------------------------------+------------+------------+-----------+"
  printf "+------------------------- ENVIRONMENT: %-10s --------------------------+\n" "$ENVIRONMENT"
  echo "+--------------------------------------+-----------+-------------+-----------+"
  echo "|                                      |  target   |   target    |           |"
  echo "|       Facet (latest version)         | (mutable) | (immutable) |  current  |"
  echo "+--------------------------------------+-----------+-------------+-----------+"

  # Check if target state FILE exists
  if [ ! -f "$TARGET_STATE_PATH" ]; then
    error "target state FILE does not exist in path $TARGET_STATE_PATH"
    exit 1
  fi

  # get an arrqay with all contracts (sorted: diamonds, coreFacets, nonCoreFacets, periphery)
  local ALL_CONTRACTS=$(getAllContractNames "false")

  # get a list of all networks
  local NETWORKS=$(getAllNetworksArray)

  # define column width for table
  FACET_COLUMN_WIDTH=38
  TARGET_COLUMN_WIDTH=11
  CURRENT_COLUMN_WIDTH=10

  # go through all contracts
  for CONTRACT in ${ALL_CONTRACTS[*]}; do
    # get current contract version
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${CURRENT_COLUMN_WIDTH}s|\n" " $CONTRACT ($CURRENT_VERSION)" "" "" ""

    for NETWORK in ${NETWORKS[*]}; do
      PRINTED=false
      #echo "  NETWORK: $NETWORK"

      # get highest deployed version from master log
      HIGHEST_VERSION_DEPLOYED=$(getHighestDeployedContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$CONTRACT")
      RETURN_CODE3=$?

      # check if contract has entry in target state
      TARGET_VERSION_DIAMOND=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamond")
      RETURN_CODE1=$?
      TARGET_VERSION_DIAMOND_IMMUTABLE=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamondImmutable")
      RETURN_CODE2=$?

      if [ "$RETURN_CODE1" -eq 0 ]; then
        TARGET_ENTRY_1=$TARGET_VERSION_DIAMOND
      else
        TARGET_ENTRY_1=""
      fi

      if [ "$RETURN_CODE2" -eq 0 ]; then
        TARGET_ENTRY_2=$TARGET_VERSION_DIAMOND_IMMUTABLE
      else
        TARGET_ENTRY_2=""
      fi

      if [[ "$RETURN_CODE1" -eq 0 || "$RETURN_CODE2" -eq 0 ]]; then
        #echo "TARGET_VERSION_DIAMOND: $TARGET_VERSION_DIAMOND"
        printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${CURRENT_COLUMN_WIDTH}s|\n" "  -$NETWORK" "  $TARGET_ENTRY_1" "  $TARGET_ENTRY_2" "  $HIGHEST_VERSION_DEPLOYED"
      fi

    done

    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${CURRENT_COLUMN_WIDTH}s|\n" "" "" "" ""

  done
  echo "+--------------------------------------+------------+------------+-----------+"
  return 0
}

function printDeploymentsStatusV2() {
  # read function arguments into variables
  ENVIRONMENT="$1"

  OUTPUT_FILE_PATH="target_vs_deployed_""$ENVIRONMENT"".txt"

  echo ""
  echo "+------------------------------------------------------------------------------+"
  echo "+------------------------- TARGET STATE vs. ACTUAL STATE ----------------------+"
  echo "+                                                                              +"
  echo "+ (will only list networks for which an entry exists in target or deploy log)  +"
  echo "+------------------------------------------------------------------------------+"
  printf "+-------------------------- ENVIRONMENT: %-10s ---------------------------+\n" "$ENVIRONMENT"
  echo "+--------------------------------------+-------------------+-------------------+"
  echo "|                                      |      mutable      |     immutable     |"
  echo "|      Contract (latest version)       | target : deployed | target : deployed |"
  echo "+--------------------------------------+-------------------+-------------------+"

  echo "" >"$OUTPUT_FILE_PATH"
  echo "+------------------------------------------------------------------------------+" >>"$OUTPUT_FILE_PATH"
  echo "+------------------------- TARGET STATE vs. ACTUAL STATE ----------------------+" >>"$OUTPUT_FILE_PATH"
  echo "+                                                                              +" >>"$OUTPUT_FILE_PATH"
  echo "+ (will only list networks for which an entry exists in target or deploy log)  +" >>"$OUTPUT_FILE_PATH"
  echo "+------------------------------------------------------------------------------+" >>"$OUTPUT_FILE_PATH"
  printf "+-------------------------- ENVIRONMENT: %-10s ---------------------------+\n" "$ENVIRONMENT" >>"$OUTPUT_FILE_PATH"
  echo "+--------------------------------------+-------------------+-------------------+" >>"$OUTPUT_FILE_PATH"
  echo "|                                      |      mutable      |     immutable     |" >>"$OUTPUT_FILE_PATH"
  echo "|      Contract (latest version)       | target : deployed | target : deployed |" >>"$OUTPUT_FILE_PATH"
  echo "+--------------------------------------+-------------------+-------------------+" >>"$OUTPUT_FILE_PATH"

  # Check if target state FILE exists
  if [ ! -f "$TARGET_STATE_PATH" ]; then
    error "target state FILE does not exist in path $TARGET_STATE_PATH"
    exit 1
  fi

  # get an arrqay with all contracts (sorted: diamonds, coreFacets, nonCoreFacets, periphery)
  local ALL_CONTRACTS=$(getAllContractNames "false")

  # get a list of all networks
  local NETWORKS=$(getIncludedNetworksArray)

  # define column width for table
  FACET_COLUMN_WIDTH=38
  TARGET_COLUMN_WIDTH=18

  # go through all contracts
  for CONTRACT in ${ALL_CONTRACTS[*]}; do
    #      if [ "$CONTRACT" != "LiFiDiamondImmutable" ] ; then
    #        continue
    #      fi

    # get current contract version
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s|\n" " $CONTRACT ($CURRENT_VERSION)" "" "" ""
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s|\n" " $CONTRACT ($CURRENT_VERSION)" "" "" "" >>"$OUTPUT_FILE_PATH"

    # go through all networks
    for NETWORK in ${NETWORKS[*]}; do
      # skip any network that is a testnet
      if [[ "$TEST_NETWORKS" == *"$NETWORK"* ]]; then
        continue
      fi

      # (re-)set entry values
      TARGET_ENTRY_1="  -  "
      TARGET_ENTRY_2="  -  "
      DEPLOYED_ENTRY_1="  -  "
      DEPLOYED_ENTRY_2="  -  "
      KNOWN_VERSION=""
      MUTABLE_ENTRY_COMBINED=""
      IMMUTABLE_ENTRY_COMBINED=""

      # check if contract has entry in target state
      TARGET_VERSION_DIAMOND=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamond")
      RETURN_CODE1=$?
      TARGET_VERSION_DIAMOND_IMMUTABLE=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamondImmutable")
      RETURN_CODE2=$?

      # if entry was found in target state, prepare data for entry in table (if not default value will be used to preserve formatting)
      if [ "$RETURN_CODE1" -eq 0 ]; then
        TARGET_ENTRY_1=$TARGET_VERSION_DIAMOND
      fi
      if [ "$RETURN_CODE2" -eq 0 ]; then
        TARGET_ENTRY_2=$TARGET_VERSION_DIAMOND_IMMUTABLE
      fi

      # check if contract has entry in diamond deployment log
      LOG_INFO_DIAMOND=$(getContractInfoFromDiamondDeploymentLogByName "$NETWORK" "$ENVIRONMENT" "LiFiDiamond" "$CONTRACT")
      RETURN_CODE3=$?
      LOG_INFO_DIAMOND_IMMUTABLE=$(getContractInfoFromDiamondDeploymentLogByName "$NETWORK" "$ENVIRONMENT" "LiFiDiamondImmutable" "$CONTRACT")
      RETURN_CODE4=$?

      # check if entry was found in diamond deployment log (if version == null, replace with "unknown")
      if [ "$RETURN_CODE3" -eq 0 ]; then
        KNOWN_VERSION=$(echo "$LOG_INFO_DIAMOND" | jq -r '.[].Version')
        if [[ "$KNOWN_VERSION" == "null" || "$KNOWN_VERSION" == "" ]]; then
          DEPLOYED_ENTRY_1=" n/a"
        else
          DEPLOYED_ENTRY_1=$KNOWN_VERSION
        fi
      fi
      if [ "$RETURN_CODE4" -eq 0 ]; then
        KNOWN_VERSION=$(echo "$LOG_INFO_DIAMOND_IMMUTABLE" | jq -r '.[].Version')

        if [[ "$KNOWN_VERSION" == "null" || "$KNOWN_VERSION" == "" ]]; then
          DEPLOYED_ENTRY_2=" n/a"
        else
          DEPLOYED_ENTRY_2=$KNOWN_VERSION
        fi
      fi

      # print new line if any entry was found in either target state or diamond deploy log
      if [[ "$RETURN_CODE1" -eq 0 || "$RETURN_CODE2" -eq 0 || "$RETURN_CODE3" -eq 0 || "$RETURN_CODE4" -eq 0 ]]; then
        # prepare entries (to preserve formatting)
        MUTABLE_ENTRY_COMBINED="$TARGET_ENTRY_1"" : ""$DEPLOYED_ENTRY_1"
        IMMUTABLE_ENTRY_COMBINED="$TARGET_ENTRY_2"" : ""$DEPLOYED_ENTRY_2"

        if [ "$CONTRACT" == "LiFiDiamond" ]; then
          IMMUTABLE_ENTRY_COMBINED=""
        elif [ "$CONTRACT" == "LiFiDiamondImmutable" ]; then
          MUTABLE_ENTRY_COMBINED=""
        fi

        # determine color codes
        COLOR_CODE_1=$NC
        COLOR_CODE_2=$NC
        if [[ "$TARGET_ENTRY_1" != *"-"* && "$DEPLOYED_ENTRY_1" != *"-"* ]]; then
          if [[ "$TARGET_ENTRY_1" == "$DEPLOYED_ENTRY_1" ]]; then
            COLOR_CODE_1=$GREEN
          else
            COLOR_CODE_1=$RED
          fi
        fi
        if [[ "$TARGET_ENTRY_2" != *"-"* && "$DEPLOYED_ENTRY_2" != *"-"* ]]; then
          if [[ "$TARGET_ENTRY_2" == "$DEPLOYED_ENTRY_2" ]]; then
            COLOR_CODE_2=$GREEN
          else
            COLOR_CODE_2=$RED
          fi
        fi

        # print new line in table view
        printf "|%-${FACET_COLUMN_WIDTH}s| $COLOR_CODE_1 %-15s $NC | $COLOR_CODE_2 %-15s $NC |\n" "  -$NETWORK" " $MUTABLE_ENTRY_COMBINED" " $IMMUTABLE_ENTRY_COMBINED"
        printf "|%-${FACET_COLUMN_WIDTH}s| %-17s | %-17s |\n" "  -$NETWORK" " $MUTABLE_ENTRY_COMBINED" " $IMMUTABLE_ENTRY_COMBINED" >>"$OUTPUT_FILE_PATH"
      fi
    done

    # print empty line
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s|\n" "" "" "" ""
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s|\n" "" "" "" "" >>"$OUTPUT_FILE_PATH"
  done

  # print closing line
  echo "+--------------------------------------+-------------------+-------------------+"
  echo "+--------------------------------------+-------------------+-------------------+" >>"$OUTPUT_FILE_PATH"
  return 0

  playNotificationSound
}

function checkDeployRequirements() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  CONTRACT="$3"

  echo ""
  echoDebug "checking if all information required for deployment is available for $CONTRACT on $NETWORK in $ENVIRONMENT environment"

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # part 1: check configData requirements
  CONFIG_REQUIREMENTS=($(jq -r --arg CONTRACT "$CONTRACT" '.[$CONTRACT].configData | select(type == "object") | keys[]' "$DEPLOY_REQUIREMENTS_PATH"))

  # check if configData requirements were found
  if [ ${#CONFIG_REQUIREMENTS[@]} -gt 0 ]; then
    # go through array with requirements
    for REQUIREMENT in "${CONFIG_REQUIREMENTS[@]}"; do
      # get configFileName
      CONFIG_FILE=$(jq -r --arg CONTRACT "$CONTRACT" --arg REQUIREMENT "$REQUIREMENT" '.[$CONTRACT].configData[$REQUIREMENT].configFileName' "$DEPLOY_REQUIREMENTS_PATH")

      # get keyInConfigFile
      KEY_IN_FILE=$(jq -r --arg CONTRACT "$CONTRACT" --arg REQUIREMENT "$REQUIREMENT" '.[$CONTRACT].configData[$REQUIREMENT].keyInConfigFile' "$DEPLOY_REQUIREMENTS_PATH")
      # replace '<NETWORK>' with actual network, if needed
      KEY_IN_FILE=${KEY_IN_FILE//<NETWORK>/$NETWORK}

      # get full config file path
      CONFIG_FILE_PATH="$DEPLOY_CONFIG_FILE_PATH""$CONFIG_FILE"

      # check if file exists
      if ! checkIfFileExists "$CONFIG_FILE_PATH" >/dev/null; then
        error "file does not exist: $CONFIG_FILE_PATH (access attempted by function 'checkDeployRequirements')"
        return 1
      fi

      # try to read value from config file
      VALUE=$(jq -r "$KEY_IN_FILE" "$CONFIG_FILE_PATH")

      # check if data is available in config file
      if [[ "$VALUE" != "null" && "$VALUE" != "" ]]; then
        echoDebug "address information for parameter $REQUIREMENT found in $CONFIG_FILE_PATH"
      else
        echoDebug "address information for parameter $REQUIREMENT not found in $CONFIG_FILE_PATH"

        # check if it's allowed to deploy with zero address
        DEPLOY_FLAG=$(jq -r --arg CONTRACT "$CONTRACT" --arg REQUIREMENT "$REQUIREMENT" '.[$CONTRACT].configData[$REQUIREMENT].allowToDeployWithZeroAddress' "$DEPLOY_REQUIREMENTS_PATH")

        # continue with script depending on DEPLOY_FLAG
        if [[ "$DEPLOY_FLAG" == "true" ]]; then
          # if yes, deployment is OK
          warning "contract $CONTRACT will be deployed with zero address as argument for parameter $REQUIREMENT since this information was missing in $CONFIG_FILE_PATH for network $NETWORK"
        else
          # if no, return "do not deploy"
          error "contract $CONTRACT cannot be deployed with zero address as argument for parameter $REQUIREMENT and this information is missing in $CONFIG_FILE_PATH for network $NETWORK"
          return 1
        fi
      fi
    done
  fi

  # part 2: check required contractAddresses
  # read names of required contract addresses into array
  DEPENDENCIES=($(jq -r --arg CONTRACT "$CONTRACT" '.[$CONTRACT].contractAddresses | select(type == "object") | keys[]' "$DEPLOY_REQUIREMENTS_PATH"))

  # check if dependencies were found
  if [ ${#DEPENDENCIES[@]} -gt 0 ]; then
    # get file name for network deploy log
    ADDRESSES_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

    # check if file exists
    if ! checkIfFileExists "$ADDRESSES_FILE" >/dev/null; then
      error "file does not exist: $ADDRESSES_FILE (access attempted by function 'checkDeployRequirements')"
      return 1
    fi
    # go through array
    for DEPENDENCY in "${DEPENDENCIES[@]}"; do
      # get contract address from deploy file
      echoDebug "now looking for address of contract $DEPENDENCY in file $ADDRESSES_FILE"
      ADDRESS=$(jq -r --arg DEPENDENCY "$DEPENDENCY" '.[$DEPENDENCY]' "$ADDRESSES_FILE")

      # check if contract address is available in log file
      if [[ "$ADDRESS" != "null" && "$ADDRESS" == *"0x"* ]]; then
        echoDebug "address information for contract $DEPENDENCY found"
      else
        echoDebug "address information for contract $DEPENDENCY not found"

        # check if it's allowed to deploy with zero address
        DEPLOY_FLAG=$(jq -r --arg CONTRACT "$CONTRACT" --arg DEPENDENCY "$DEPENDENCY" '.[$CONTRACT].contractAddresses[$DEPENDENCY].allowToDeployWithZeroAddress' "$DEPLOY_REQUIREMENTS_PATH")

        # continue with script depending on DEPLOY_FLAG
        if [[ "$DEPLOY_FLAG" == "true" ]]; then
          # if yes, deployment is OK
          warning "contract $CONTRACT will be deployed with zero address as argument for parameter $DEPENDENCY since this information was missing in $ADDRESSES_FILE for network $NETWORK"
        else
          # if no, return "do not deploy"
          error "contract $CONTRACT cannot be deployed with zero address as argument for parameter $DEPENDENCY and this information is missing in $ADDRESSES_FILE for network $NETWORK"
          return 1
        fi
      fi
    done
  fi
  return 0
}

function isVersionTag() {
  # read function arguments into variable
  local STRING=$1

  # define version tag pattern
  local PATTERN="^[0-9]+\.[0-9]+\.[0-9]+$"

  if [[ $STRING =~ $PATTERN ]]; then
    return 0
  else
    return 1
  fi
}

function deployCreate3FactoryToAnvil() {
  # deploy create3Factory
  RAW_RETURN_DATA=$(PRIVATE_KEY=$PRIVATE_KEY_ANVIL forge script lib/create3-factory/script/Deploy.s.sol --fork-url "$ETH_NODE_URI_LOCALANVIL" --broadcast --silent)

  # extract address of deployed factory contract
  ADDRESS=$(echo "$RAW_RETURN_DATA" | grep -o -E 'Contract Address: 0x[a-fA-F0-9]{40}' | grep -o -E '0x[a-fA-F0-9]{40}')

  # update value of CREATE3_FACTORY_ADDRESS .env variable
  export CREATE3_FACTORY_ADDRESS=$ADDRESS
  echo "$ADDRESS"
}

function getValueFromJSONFile() {
  # read function arguments into variable
  local FILE_PATH=$1
  local KEY=$2

  # check if file exists
  if ! checkIfFileExists "$FILE_PATH" >/dev/null; then
    error "file does not exist: $FILE_PATH (access attempted by function 'getValueFromJSONFile')"
    return 1
  fi

  # extract and return value from file
  VALUE=$(cat "$FILE_PATH" | jq -r ".$KEY")
  echo "$VALUE"
}

function compareAddresses() {
  # read function arguments into variable
  local Uaddress_1=$1
  local Uaddress_2=$2

  # count characters / analyze format
  local Uaddress_1_chars=${#address_1}
  local Uaddress_2_chars=${#address_2}

  # shorten address1
  if [[ $address_1_chars -gt 42 ]]; then
    address_1_short="0x"${address_1: -40}
  else
    address_1_short=$address_1
  fi

  # shorten address2
  if [[ "$address_2_chars" -gt 64 ]]; then
    address_2_short="0x"${address_2: -40}
  else
    address_2_short=$address_2
  fi

  # convert both addresses to lowercase
  address_1_short_upper=$(echo "$address_1_short" | tr '[:upper:]' '[:lower:]')
  address_2_short_upper=$(echo "$address_2_short" | tr '[:upper:]' '[:lower:]')

  # compare
  if [[ $address_1_short_upper == $address_2_short_upper ]]; then
    echo true
    return 0
  else
    echo false
    return 1
  fi
}

function sendMessageToSlackSmartContractsChannel() {
  # read function arguments into variable
  local MESSAGE=$1

  if [ -z "$SLACK_WEBHOOK_SC_GENERAL" ]; then
    echo ""
    warning "Slack webhook URL for dev-sc-general is missing. Cannot send log message."
    echo ""
    return 1
  fi

  echo ""
  echoDebug "sending the following message to Slack webhook ('dev-sc-general' channel):"
  echoDebug "$MESSAGE"
  echo ""

  # Send the message
  curl -H "Content-Type: application/json" \
     -X POST \
     -d "{\"text\": \"$MESSAGE\"}" \
     "$SLACK_WEBHOOK_SC_GENERAL"

  echoDebug "Log message sent to Slack"

  return 0
}

function getUserInfo() {
  # log local username
  local USERNAME=$(whoami)

  # log Github email address
  EMAIL=$(git config --global user.email)
  if [ -z "$EMAIL" ]; then
      EMAIL=$(git config --local user.email)
  fi

  # return collected info
  echo "Username: $USERNAME, Github email: $EMAIL"
}

function cleanupBackgroundJobs() {
  echo "Cleaning up..."
  # Kill all background jobs
  pkill -P $$
  echo "All background jobs killed. Script execution aborted."
  exit 1
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
