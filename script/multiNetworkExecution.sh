#!/bin/bash

# =============================================================================
# Bash mode configuration
# =============================================================================
# Using set -o pipefail to catch pipeline errors, but NOT set -e
# We want individual network failures to not stop the entire script
# Individual functions handle their own errors explicitly
set -o pipefail
IFS=$'\n\t'

# =============================================================================
# Network Grouping and Execution Management
# =============================================================================
# This file contains helper functions for managing network deployments
# across different EVM versions and zkEVM networks with proper grouping
# and progress tracking.
# =============================================================================

# Load required dependencies
source script/helperFunctions.sh
source script/playgroundHelpers.sh

# =============================================================================
# MANUAL CONFIGURATION SECTIONS
# =============================================================================
# These sections are where you manually configure what to execute
# All configuration should be done here - helper functions are below

# =============================================================================
# EXECUTION CONFIGURATION
# =============================================================================
# Environment to use (e.g., "production", "staging")
# ENVIRONMENT="staging"
ENVIRONMENT="production"

# =============================================================================
# NETWORK SELECTION CONFIGURATION
# =============================================================================
# Configure which networks to execute by modifying the NETWORKS array below
# This is the main place to adjust your network list for multi-execution

# Option 1: Use all included networks (default)
# NETWORKS=($(getIncludedNetworksArray))

# Option 2: Use specific networks (uncomment and modify as needed)
# NETWORKS=("mainnet" "arbitrum" "base" "blast" "zksync" "hyperevm")
  # NETWORKS=("arbitrum" "optimism" "base" "bsc" "linea" "scroll" "polygon" "blast" "mainnet" "worldchain")

# Option 3: Use networks by EVM version (uncomment as needed)
# NETWORKS=($(getIncludedNetworksByEvmVersionArray "london"))
NETWORKS=($(getIncludedNetworksByEvmVersionArray "cancun"))

# Option 4: Use networks where contract is deployed (uncomment as needed)
# NETWORKS=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT"))

# Option 5: Use whitelist filtering (uncomment and modify as needed)
# NETWORKS_WHITELIST=("mainnet" "arbitrum" "base" "zksync")
# NETWORKS_WHITELIST=("mainnet" "arbitrum" "base" "bsc" "blast" "ink" "linea" "lisk" "mode" "optimism" "polygon" "scroll" "soneium" "unichain" "worldchain" "zksync")

# Option 6: Use blacklist filtering (applied after network selection)
# Networks in the blacklist will be excluded from the final network list
# This is useful for excluding networks that need to be skipped (e.g. already done manually)
NETWORKS_BLACKLIST=("aurora" "moonriver" "xlayer")

# Foundry.toml backup file
FOUNDRY_TOML_BACKUP="foundry.toml.backup"

# =============================================================================
# NETWORK ACTION EXECUTION
# =============================================================================

function executeNetworkActions() {
    # This function executes the actions configured below
    # To modify actions, edit the code in this function
    # ENVIRONMENT is read from the global configuration variable
    # CONTRACT is determined here based on the actions being performed

    local NETWORK="$1"
    local LOG_DIR="$2"
    local RETURN_CODE=0

    # Determine the contract based on the actions being performed
    # This should be set based on what contract you're working with
    CONTRACT="WhitelistManagerFacet"
    # Export CONTRACT so it can be used by other functions
    export CONTRACT

    # Also write CONTRACT to a temp file if CONTRACT_FILE is set (for parent shell access)
    if [[ -n "${CONTRACT_FILE:-}" ]]; then
        echo "$CONTRACT" > "$CONTRACT_FILE"
    fi

    # Get RPC URL for the network
    # RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")

    # Execute configured actions (uncomment the ones you want)
    # All commands will be executed, and the last command's exit code will be returned

    # DEPLOY & VERIFY CONTRACT
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")
    echo "[$NETWORK] CURRENT_VERSION of contract $CONTRACT: $CURRENT_VERSION"
    deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$CURRENT_VERSION" false
    RETURN_CODE=$?
    echo "[$NETWORK] deploySingleContract completed with exit code: $RETURN_CODE"

    # VERIFY - Verify the contract on the network
    # getContractVerified "$NETWORK" "$ENVIRONMENT" "$CONTRACT"

    # PROPOSE - Create multisig proposal for the contract
    # createMultisigProposalForContract "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$LOG_DIR"

    # UPDATE DIAMOND - Update diamond log for the network
    # updateDiamondLogForNetwork "$NETWORK" "$ENVIRONMENT"

    # CUSTOM ACTIONS - Add your custom actions here
    # CALLDATA=$(cast calldata "batchSetFunctionApprovalBySignature(bytes4[],bool)" [0x23b872dd] false)
    # cast send "$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")" "$CALLDATA" --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY_PRODUCTION"

    # bunx tsx ./script/deploy/safe/propose-to-safe.ts --to "$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl "$RPC_URL" --timelock --ledger

    # RESPONSE=$(cast call "$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")" "isFunctionApproved(bytes4) returns (bool)" 0x23b872dd --rpc-url "$RPC_URL")
    # echo "[$NETWORK] function 0x23b872dd is approved: $RESPONSE"

    # Return the exit code of the last executed command (defaults to 0 if no commands executed)
    # If you need more sophisticated error handling, you can add it here
    if [ $? -ne 0 ]; then
        RETURN_CODE=1
    fi
    return "${RETURN_CODE}"
}

# =============================================================================
# HELPER FUNCTIONS AND EXECUTION LOGIC
# =============================================================================
# All helper functions and execution logic are below
# Do not modify these unless you know what you're doing

# =============================================================================
# Environment and Dependency Validation
# =============================================================================

# Helper function to check for required tools
requireTools() {
  local MISSING_TOOLS=()

  # Check for required tools
  command -v jq >/dev/null 2>&1 || MISSING_TOOLS+=("jq")
  command -v sed >/dev/null 2>&1 || MISSING_TOOLS+=("sed")
  command -v mktemp >/dev/null 2>&1 || MISSING_TOOLS+=("mktemp")
  command -v forge >/dev/null 2>&1 || MISSING_TOOLS+=("forge")

  if [[ ${#MISSING_TOOLS[@]} -gt 0 ]]; then
    error "Missing required tools: ${MISSING_TOOLS[*]}"
    error "Please install the missing tools and try again"
    return 1
  fi
}

# Helper function to validate environment
validateEnv() {
  # Check if NETWORKS_JSON_FILE_PATH is readable using existing helper
  checkNetworksJsonFilePath || {
    error "Environment validation failed"
    return 1
  }
}

# Validate dependencies and environment immediately
# Note: Errors are handled gracefully to avoid exiting before NETWORKS is set
requireTools || true
validateEnv || true

# =============================================================================
# CONFIGURATION AND CONSTANTS
# =============================================================================

# Progress tracking file - will be set based on action type
PROGRESS_TRACKING_FILE=""

# Group definitions
GROUP_LONDON="london"
GROUP_ZKEVM="zkevm"
GROUP_CANCUN="cancun"

# Solidity version constants
SOLC_LONDON="0.8.17"
SOLC_CANCUN="0.8.29"

# EVM version constants
EVM_LONDON="london"
EVM_CANCUN="cancun"

# =============================================================================
# EXECUTION CONFIGURATION
# =============================================================================
# Configure execution behavior

# PARALLEL EXECUTION SETTINGS
# Set to true to run networks in parallel within each group, false for sequential execution
RUN_PARALLEL=true

# zkEVM networks always run sequentially (regardless of RUN_PARALLEL setting)
# This is because zkEVM networks require special handling in deploy scripts
ZKEVM_ALWAYS_SEQUENTIAL=true

# =============================================================================
# NETWORK SELECTION HELPER
# =============================================================================

function getConfiguredNetworks() {
    # This function returns the networks configured in the NETWORK SELECTION CONFIGURATION section above
    # It reads from the NETWORKS array and applies whitelist/blacklist filters if configured
    # All network selection logic should be done in the configuration section at the top of the file
    # CONTRACT and ENVIRONMENT are read from the global configuration variables

    local SELECTED_NETWORKS=()

    # Read from NETWORKS array - it should be defined in the configuration section above
    # Check if NETWORKS is defined and not empty
    if [[ -z "${NETWORKS+x}" ]] || [[ ${#NETWORKS[@]} -eq 0 ]]; then
        error "NETWORKS array is not defined or empty. Please configure NETWORKS in the NETWORK SELECTION CONFIGURATION section." >&2
        return 1
    fi

    # Copy the NETWORKS array to SELECTED_NETWORKS
    SELECTED_NETWORKS=("${NETWORKS[@]}")

    # Apply whitelist filtering if NETWORKS_WHITELIST is defined and not empty
    if [[ ${NETWORKS_WHITELIST+x} && ${#NETWORKS_WHITELIST[@]} -gt 0 ]]; then
        local FILTERED_NETWORKS=()
        for NETWORK in "${SELECTED_NETWORKS[@]}"; do
            for WHITELISTED_NETWORK in "${NETWORKS_WHITELIST[@]}"; do
                if [[ "$NETWORK" == "$WHITELISTED_NETWORK" ]]; then
                    FILTERED_NETWORKS+=("$NETWORK")
                    break
                fi
            done
        done
        SELECTED_NETWORKS=("${FILTERED_NETWORKS[@]}")
    fi

    # Apply blacklist filtering if NETWORKS_BLACKLIST is defined and not empty
    # This removes networks from the selected list that are in the blacklist
    if [[ ${NETWORKS_BLACKLIST+x} && ${#NETWORKS_BLACKLIST[@]} -gt 0 ]]; then
        local FILTERED_NETWORKS=()
        for NETWORK in "${SELECTED_NETWORKS[@]}"; do
            local IS_BLACKLISTED=false
            for BLACKLISTED_NETWORK in "${NETWORKS_BLACKLIST[@]}"; do
                if [[ "$NETWORK" == "$BLACKLISTED_NETWORK" ]]; then
                    IS_BLACKLISTED=true
                    break
                fi
            done
            if [[ "$IS_BLACKLISTED" == "false" ]]; then
                FILTERED_NETWORKS+=("$NETWORK")
            fi
        done
        SELECTED_NETWORKS=("${FILTERED_NETWORKS[@]}")
    fi

    # Return the final network list (one network per line)
    printf '%s\n' "${SELECTED_NETWORKS[@]}"
}

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

function logGroupInfo() {
    local group="$1"
    shift 1  # Remove first argument
    local -a networks=("$@")  # Remaining arguments are networks

    # Build network list string for display
    local network_list=""
    for network in "${networks[@]}"; do
        if [[ -z "$network_list" ]]; then
            network_list="$network"
        else
            network_list="$network_list $network"
        fi
    done

    logWithTimestamp "Group: $group (${#networks[@]} networks): $network_list"
}

# =============================================================================
# NETWORK GROUPING FUNCTIONS
# =============================================================================





function groupNetworksByExecutionGroup() {
    local NETWORKS=("$@")

    if [[ ${#NETWORKS[@]} -eq 0 ]]; then
        error "No networks provided for grouping"
        return 1
    fi

    # Initialize group arrays
    local LONDON_NETWORKS=()
    local ZKEVM_NETWORKS=()
    local CANCUN_NETWORKS=()
    local INVALID_NETWORKS=()

    # Group networks
    for NETWORK in "${NETWORKS[@]}"; do
        local GROUP=$(getNetworkGroup "$NETWORK")
        local GROUP_RESULT=$?

        if [[ $GROUP_RESULT -eq 0 ]]; then
            case "$GROUP" in
                "london")
                    LONDON_NETWORKS+=("$NETWORK")
                    ;;
                "zkevm")
                    ZKEVM_NETWORKS+=("$NETWORK")
                    ;;
                "cancun")
                    CANCUN_NETWORKS+=("$NETWORK")
                    ;;
            esac
        else
            INVALID_NETWORKS+=("$NETWORK")
        fi
    done

    # Output results as JSON
    jq -n \
        --argjson london "$(if [[ ${#LONDON_NETWORKS[@]} -gt 0 ]]; then printf '%s\n' "${LONDON_NETWORKS[@]}" | jq -R . | jq -s .; else echo "[]"; fi)" \
        --argjson zkevm "$(if [[ ${#ZKEVM_NETWORKS[@]} -gt 0 ]]; then printf '%s\n' "${ZKEVM_NETWORKS[@]}" | jq -R . | jq -s .; else echo "[]"; fi)" \
        --argjson cancun "$(if [[ ${#CANCUN_NETWORKS[@]} -gt 0 ]]; then printf '%s\n' "${CANCUN_NETWORKS[@]}" | jq -R . | jq -s .; else echo "[]"; fi)" \
        --argjson invalid "$(if [[ ${#INVALID_NETWORKS[@]} -gt 0 ]]; then printf '%s\n' "${INVALID_NETWORKS[@]}" | jq -R . | jq -s .; else echo "[]"; fi)" \
        '{london: $london, zkevm: $zkevm, cancun: $cancun, invalid: $invalid}'
}

# =============================================================================
# FOUNDRY.TOML MANAGEMENT
# =============================================================================

function backupFoundryToml() {
    if [[ -f "foundry.toml" ]]; then
        cp "foundry.toml" "$FOUNDRY_TOML_BACKUP" 2>/dev/null || true
    else
        error "foundry.toml not found"
        return 1
    fi
}

function restoreFoundryToml() {
    if [[ -f "$FOUNDRY_TOML_BACKUP" ]]; then
        cp "$FOUNDRY_TOML_BACKUP" "foundry.toml" 2>/dev/null || true
        rm -f "$FOUNDRY_TOML_BACKUP" 2>/dev/null || true
    fi
}

function updateFoundryTomlForGroup() {
    local group="$1"

    if [[ -z "$group" ]]; then
        error "Group is required"
        return 1
    fi

    case "$group" in
        "$GROUP_LONDON")
            # Update solc version and EVM version in profile.default section only
            sed -i.bak "1,/^\[/ s/solc_version = .*/solc_version = '$SOLC_LONDON'/" foundry.toml 2>/dev/null || true
            sed -i.bak "1,/^\[/ s/evm_version = .*/evm_version = '$EVM_LONDON'/" foundry.toml 2>/dev/null || true
            rm -f foundry.toml.bak 2>/dev/null || true
            # Build with new solc version (Foundry will detect if recompilation is needed)
            forge build 2>&1 || true
            ;;
        "$GROUP_ZKEVM")
            # zkEVM networks don't need foundry.toml updates or special compilation
            # Deploy scripts handle zkEVM networks correctly
            # No action needed here
            ;;
        "$GROUP_CANCUN")
            # Update solc version and EVM version in profile.default section only
            sed -i.bak "1,/^\[/ s/solc_version = .*/solc_version = '$SOLC_CANCUN'/" foundry.toml 2>/dev/null || true
            sed -i.bak "1,/^\[/ s/evm_version = .*/evm_version = '$EVM_CANCUN'/" foundry.toml 2>/dev/null || true
            rm -f foundry.toml.bak 2>/dev/null || true
            # Build with new solc version (Foundry will detect if recompilation is needed)
            forge build 2>&1 || true
            ;;
        *)
            error "Unknown group: $group"
            return 1
            ;;
    esac
}

function recompileForGroup() {
    local group="$1"

    if [[ -z "$group" ]]; then
        error "Group is required"
        return 1
    fi

    case "$group" in
        "$GROUP_ZKEVM")
            # zkEVM networks don't need special compilation
            # Deploy scripts handle compilation correctly for zkEVM networks
            # No action needed here
            return 0
            ;;
        *)
            # All other groups use standard solc compilation
            forge build 2>&1 || true
            ;;
    esac
}

# =============================================================================
# ACTION DETECTION AND TRACKING
# =============================================================================

function detectActionType() {
    # Detect what type of action is being performed by analyzing executeNetworkActions
    # This function looks at the executeNetworkActions function to determine the action type

    # Check if the function contains verification calls
    if grep -q "getContractVerified" <<< "$(declare -f executeNetworkActions)"; then
        echo "verification"
        return 0
    fi

    # Check if the function contains deployment calls
    if grep -q "deployContract\|deploySingleContract" <<< "$(declare -f executeNetworkActions)"; then
        echo "deployment"
        return 0
    fi

    # Check if the function contains proposal calls
    if grep -q "createMultisigProposalForContract" <<< "$(declare -f executeNetworkActions)"; then
        echo "proposal"
        return 0
    fi

    # Check if the function contains diamond update calls
    if grep -q "updateDiamondLogForNetwork" <<< "$(declare -f executeNetworkActions)"; then
        echo "diamond_update"
        return 0
    fi

    # Default to generic action
    echo "generic"
    return 0
}

function setProgressTrackingFile() {
    local ACTION_TYPE="$1"
    local CONTRACT="$2"
    local ENVIRONMENT="$3"

    case "$ACTION_TYPE" in
        "verification")
            PROGRESS_TRACKING_FILE=".network_verification_progress.json"
            ;;
        "deployment")
            PROGRESS_TRACKING_FILE=".network_deployment_progress.json"
            ;;
        "proposal")
            PROGRESS_TRACKING_FILE=".network_proposal_progress.json"
            ;;
        "diamond_update")
            PROGRESS_TRACKING_FILE=".network_diamond_update_progress.json"
            ;;
        *)
            PROGRESS_TRACKING_FILE=".network_${ACTION_TYPE}_progress.json"
            ;;
    esac

    # Progress tracking file is set silently
}

function isActionAlreadyCompleted() {
    # Generic function to check if an action is already completed for a network
    local ACTION_TYPE="$1"
    local CONTRACT="$2"
    local NETWORK="$3"
    local ENVIRONMENT="$4"

    case "$ACTION_TYPE" in
        "verification")
            isContractAlreadyVerified "$CONTRACT" "$NETWORK" "$ENVIRONMENT"
            ;;
        "deployment")
            isContractAlreadyDeployed "$CONTRACT" "$NETWORK" "$ENVIRONMENT"
            ;;
        "proposal")
            # For proposals, we might want to check if a proposal was already created
            # This would need to be implemented based on your proposal tracking system
            return 1  # Always run proposals for now
            ;;
        "diamond_update")
            # For diamond updates, we might want to check if the diamond was already updated
            # This would need to be implemented based on your diamond update tracking system
            return 1  # Always run diamond updates for now
            ;;
        *)
            # For generic actions, always run them
            return 1
            ;;
    esac
}

# =============================================================================
# PROGRESS TRACKING
# =============================================================================

function initializeProgressTracking() {
    # CONTRACT is determined in executeNetworkActions and exported
    # ENVIRONMENT is read from the global configuration variable
    local contract="$1"
    shift 1  # Remove first argument
    local -a networks=("$@")  # Remaining arguments are networks

    if [[ -z "$contract" || -z "$ENVIRONMENT" || ${#networks[@]} -eq 0 ]]; then
        error "Contract, ENVIRONMENT, and networks are required. Contract should be determined in executeNetworkActions."
        return 1
    fi

    # Filter out any invalid network names (containing spaces) before processing
    # This prevents issues if somehow invalid networks were passed
    local valid_networks=()
    for network in "${networks[@]}"; do
        if [[ "$network" =~ [[:space:]] ]]; then
            error "Skipping invalid network name (contains spaces): '$network'"
            continue
        fi
        valid_networks+=("$network")
    done

    # Use only valid networks
    networks=("${valid_networks[@]}")

    if [[ ${#networks[@]} -eq 0 ]]; then
        error "No valid networks to track after filtering"
        return 1
    fi

    # Detect action type and set appropriate tracking file
    local action_type=$(detectActionType)
    setProgressTrackingFile "$action_type" "$contract" "$ENVIRONMENT"

    # Check if progress file already exists
    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        # Load existing progress and merge with new networks
        local existing_data=$(cat "$PROGRESS_TRACKING_FILE")
        local existing_contract=$(echo "$existing_data" | jq -r '.contract')
        local existing_environment=$(echo "$existing_data" | jq -r '.environment')
        local existing_action=$(echo "$existing_data" | jq -r '.actionType // "unknown"')

        # Only merge if it's the same contract, environment, and action type
        if [[ "$existing_contract" == "$contract" && "$existing_environment" == "$ENVIRONMENT" && "$existing_action" == "$action_type" ]]; then
            # Resuming existing progress tracking silently

            # Clean up any invalid network entries (those containing spaces or blacklisted networks)
            local cleaned_data="$existing_data"
            local networks_to_remove=()

            # Find invalid entries (containing spaces)
            local invalid_networks=$(echo "$existing_data" | jq -r '.networks | to_entries[] | select(.key | contains(" ")) | .key' 2>/dev/null || echo "")
            if [[ -n "$invalid_networks" ]]; then
                while IFS= read -r invalid_network; do
                    if [[ -n "$invalid_network" ]]; then
                        networks_to_remove+=("$invalid_network")
                    fi
                done <<< "$invalid_networks"
            fi

            # Find blacklisted networks that should be removed
            if [[ ${NETWORKS_BLACKLIST+x} && ${#NETWORKS_BLACKLIST[@]} -gt 0 ]]; then
                local existing_network_keys=$(echo "$existing_data" | jq -r '.networks | keys[]' 2>/dev/null || echo "")
                while IFS= read -r existing_network; do
                    if [[ -n "$existing_network" ]]; then
                        for BLACKLISTED_NETWORK in "${NETWORKS_BLACKLIST[@]}"; do
                            if [[ "$existing_network" == "$BLACKLISTED_NETWORK" ]]; then
                                networks_to_remove+=("$existing_network")
                                break
                            fi
                        done
                    fi
                done <<< "$existing_network_keys"
            fi

            # Remove all networks that should be cleaned up
            if [[ ${#networks_to_remove[@]} -gt 0 ]]; then
                logWithTimestamp "Cleaning up invalid/blacklisted network entries: ${networks_to_remove[*]}"
                for network_to_remove in "${networks_to_remove[@]}"; do
                    logWithTimestamp "Removing network entry: '$network_to_remove'"
                    cleaned_data=$(echo "$cleaned_data" | jq --arg network "$network_to_remove" 'del(.networks[$network])' 2>/dev/null || echo "$cleaned_data")
                done
                # Update existing_data with cleaned data and save it immediately
                existing_data="$cleaned_data"
                if ! echo "$existing_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
                    error "Failed to write cleaned progress tracking data"
                    return 1
                fi
                if [[ -f "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
                    mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE" 2>/dev/null || true
                fi
            fi

            # Add any new networks that aren't already tracked
            local updated_data="$existing_data"
            for network in "${networks[@]}"; do
                # Validate network name (should not contain spaces - indicates array was passed incorrectly)
                if [[ "$network" =~ [[:space:]] ]]; then
                    error "Invalid network name detected (contains spaces): '$network'"
                    error "This usually indicates networks array was passed incorrectly. Skipping."
                    continue
                fi
                local network_exists=$(echo "$existing_data" | jq -r --arg network "$network" '.networks[$network] // empty' 2>/dev/null || echo "")
                if [[ -z "$network_exists" || "$network_exists" == "null" ]]; then
                    # Add new network silently
                    updated_data=$(echo "$updated_data" | jq --arg network "$network" --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.networks[$network] = {status: "pending", attempts: 0, lastAttempt: $timestamp, error: null} | .lastUpdate = $timestamp' 2>/dev/null || echo "$existing_data")
                fi
            done

            if ! echo "$updated_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
                error "Failed to write progress tracking data"
                return 1
            fi
            if [[ -f "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
                mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE" 2>/dev/null || true
            fi
            return 0
        else
            logWithTimestamp "Different contract/environment/action detected. Creating new progress tracking."
        fi
    fi

    # Create initial progress structure, checking for existing completion status
    local networks_json="{}"
    for network in "${networks[@]}"; do
        # Validate network name (should not contain spaces - indicates array was passed incorrectly)
        if [[ "$network" =~ [[:space:]] ]]; then
            error "Invalid network name detected (contains spaces): '$network'"
            error "This usually indicates networks array was passed incorrectly. Skipping."
            continue
        fi
        local network_status="pending"
        local attempts=0
        local lastAttempt=null
        local error=null

        # Check if action is already completed for this network
        if isActionAlreadyCompleted "$action_type" "$contract" "$network" "$ENVIRONMENT" 2>/dev/null; then
            network_status="success"
            attempts=1
            lastAttempt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        fi

        # Use --argjson for null values to ensure proper JSON null handling
        if [[ "$lastAttempt" == "null" ]]; then
            networks_json=$(echo "$networks_json" | jq --arg network "$network" --arg status "$network_status" --argjson attempts "$attempts" --argjson lastAttempt null --argjson error null '. + {($network): {status: $status, attempts: $attempts, lastAttempt: $lastAttempt, error: $error}}')
        else
            networks_json=$(echo "$networks_json" | jq --arg network "$network" --arg status "$network_status" --argjson attempts "$attempts" --arg lastAttempt "$lastAttempt" --argjson error null '. + {($network): {status: $status, attempts: $attempts, lastAttempt: $lastAttempt, error: $error}}')
        fi
    done

    local progress_data=$(jq -n \
        --arg contract "$contract" \
        --arg environment "$ENVIRONMENT" \
        --arg actionType "$action_type" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson networks "$networks_json" \
        '{
            contract: $contract,
            environment: $environment,
            actionType: $actionType,
            startTime: $timestamp,
            lastUpdate: $timestamp,
            networks: $networks
        }')

    if ! echo "$progress_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
        error "Failed to write initial progress tracking data"
        return 1
    fi
    if [[ -f "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
        mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE" 2>/dev/null || true
    fi
    # Progress tracking initialized silently
}

function updateNetworkProgress() {
    local network="$1"
    local status="$2"
    local error_message="${3:-}"  # Default to empty string if not provided

    if [[ -z "$network" || -z "$status" ]]; then
        error "Network and status are required"
        return 1
    fi

    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        error "Progress tracking file not found"
        return 1
    fi

    # Create lock file path
    local LOCK_FILE="${PROGRESS_TRACKING_FILE}.lock"
    local LOCK_TIMEOUT=30 # 30 seconds timeout
    local LOCK_ATTEMPTS=0
    local MAX_LOCK_ATTEMPTS=60 # 60 attempts = 30 seconds total

    # Wait for lock to be available
    while [[ -f "$LOCK_FILE" && $LOCK_ATTEMPTS -lt $MAX_LOCK_ATTEMPTS ]]; do
        sleep 0.5
        LOCK_ATTEMPTS=$((LOCK_ATTEMPTS + 1))
    done

    # If we couldn't get the lock, fail
    if [[ -f "$LOCK_FILE" ]]; then
        error "Could not acquire lock for $PROGRESS_TRACKING_FILE after $LOCK_TIMEOUT seconds. Another process may be stuck."
        return 1
    fi

    # Create lock file
    echo "$$" >"$LOCK_FILE"

    # Verify file still exists after acquiring lock
    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        rm -f "$LOCK_FILE"
        error "Progress tracking file not found"
        return 1
    fi

    # Re-read the file RIGHT BEFORE updating to ensure we have the latest data
    # This prevents overwriting updates made by other processes
    local current_data=$(cat "$PROGRESS_TRACKING_FILE" 2>/dev/null)
    if [[ -z "$current_data" ]]; then
        rm -f "$LOCK_FILE"
        error "Failed to read progress tracking file"
        return 1
    fi

    # Use a unique temp file name for this process to avoid conflicts
    local TEMP_FILE="${PROGRESS_TRACKING_FILE}.tmp.$$"

    # Update progress - use --arg for error to handle quotes/backslashes safely
    # Use the freshly read data instead of reading from file again
    local updated_data=$(echo "$current_data" | jq \
        --arg network "$network" \
        --arg status "$status" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg error "$(if [[ -n "${error_message:-}" ]]; then echo "$error_message"; else echo "null"; fi)" \
        '.networks[$network].status = $status |
         .networks[$network].lastAttempt = $timestamp |
         .networks[$network].attempts += 1 |
         .networks[$network].error = ($error | if . == "null" then null else . end) |
         .lastUpdate = $timestamp')

    if ! echo "$updated_data" > "$TEMP_FILE"; then
        rm -f "$LOCK_FILE" "$TEMP_FILE" 2>/dev/null
        error "Failed to write progress update for $network"
        return 1
    fi

    # Verify temp file was written correctly
    if [[ ! -f "$TEMP_FILE" ]] || [[ ! -s "$TEMP_FILE" ]]; then
        rm -f "$LOCK_FILE" "$TEMP_FILE" 2>/dev/null
        error "Temp file was not created or is empty for $network"
        return 1
    fi

    # Verify temp file is valid JSON
    if ! jq empty "$TEMP_FILE" 2>/dev/null; then
        rm -f "$LOCK_FILE" "$TEMP_FILE" 2>/dev/null
        error "Temp file contains invalid JSON for $network"
        return 1
    fi

    # Atomic move - ensure file is written to disk before moving
    sync 2>/dev/null || true

    # Perform the move and verify it succeeded
    if ! mv "$TEMP_FILE" "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
        # If move failed, another process may have updated the file
        # Re-read the current file and merge our update with it
        local current_file_data=$(cat "$PROGRESS_TRACKING_FILE" 2>/dev/null)
        if [[ -z "$current_file_data" ]]; then
            # File doesn't exist or is empty, try move again
            sleep 0.1
            if ! mv "$TEMP_FILE" "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
                rm -f "$LOCK_FILE" "$TEMP_FILE" 2>/dev/null
                error "Failed to move temp file to progress file for $network"
                return 1
            fi
        else
            # Move failed - file was updated by another process
            # Re-read the file while still holding the lock and merge our update
            local latest_data=$(cat "$PROGRESS_TRACKING_FILE" 2>/dev/null)
            if [[ -z "$latest_data" ]]; then
                rm -f "$LOCK_FILE" "$TEMP_FILE" 2>/dev/null
                error "Failed to re-read progress tracking file for $network"
                return 1
            fi

            # Merge our update with the latest file data
            # Use max() to ensure we don't decrease attempt count
            local current_attempts=$(echo "$latest_data" | jq -r --arg network "$network" '.networks[$network].attempts // 0' 2>/dev/null || echo "0")
            local new_attempts=$((current_attempts + 1))

            local merged_data=$(echo "$latest_data" | jq \
                --arg network "$network" \
                --arg status "$status" \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                --argjson attempts "$new_attempts" \
                --arg error "$(if [[ -n "${error_message:-}" ]]; then echo "$error_message"; else echo "null"; fi)" \
                '.networks[$network].status = $status |
                 .networks[$network].lastAttempt = $timestamp |
                 .networks[$network].attempts = $attempts |
                 .networks[$network].error = ($error | if . == "null" then null else . end) |
                 .lastUpdate = $timestamp')

            # Write merged data to temp file
            if ! echo "$merged_data" > "$TEMP_FILE"; then
                rm -f "$LOCK_FILE" "$TEMP_FILE" 2>/dev/null
                error "Failed to write merged progress update for $network"
                return 1
            fi

            # Verify merged file is valid JSON
            if ! jq empty "$TEMP_FILE" 2>/dev/null; then
                rm -f "$LOCK_FILE" "$TEMP_FILE" 2>/dev/null
                error "Merged temp file contains invalid JSON for $network"
                return 1
            fi

            # Try move again with merged data
            sync 2>/dev/null || true
            if ! mv "$TEMP_FILE" "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
                rm -f "$LOCK_FILE" "$TEMP_FILE" 2>/dev/null
                error "Failed to move merged temp file to progress file for $network after merge"
                return 1
            fi
        fi
    fi

    # Ensure the move is complete before releasing lock
    sync 2>/dev/null || true

    # Verify the final file exists and is valid JSON
    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]] || ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
        rm -f "$LOCK_FILE"
        error "Progress file is invalid after update for $network"
        return 1
    fi

    # Remove lock file only after file operations are complete and verified
    rm -f "$LOCK_FILE"

    # Log the update
    case "$status" in
        "success")
            logNetworkResult "$network" "✅ SUCCESS" "Operation completed successfully"
            ;;
        "failed")
            logNetworkResult "$network" "❌ FAILED" "${error_message:-Unknown error}"
            ;;
        "in_progress")
            logNetworkResult "$network" "🔄 IN PROGRESS" "Operation started"
            ;;
    esac
}

function getPendingNetworks() {
    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        error "Progress tracking file not found"
        return 1
    fi

    # Check if file is valid JSON
    if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
        error "Progress tracking file contains invalid JSON"
        return 1
    fi

    jq -r '.networks | to_entries[] | select(.value.status == "pending") | .key' "$PROGRESS_TRACKING_FILE" 2>/dev/null || true
}

function getFailedNetworks() {
    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        error "Progress tracking file not found"
        return 1
    fi

    # Check if file is valid JSON
    if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
        error "Progress tracking file contains invalid JSON"
        return 1
    fi

    jq -r '.networks | to_entries[] | select(.value.status == "failed") | .key' "$PROGRESS_TRACKING_FILE" 2>/dev/null || true
}

function getProgressSummary() {
    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        # File doesn't exist - silently return (might have been cleaned up already)
        return 0
    fi

    # Check if file is empty or invalid JSON
    if [[ ! -s "$PROGRESS_TRACKING_FILE" ]] || ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
        logWithTimestamp "Progress tracking file is empty or contains invalid JSON (no progress to summarize)"
        return 0
    fi

    local total=$(jq '.networks | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
    local pending=$(jq '[.networks[] | select(.status == "pending")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
    local success=$(jq '[.networks[] | select(.status == "success")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
    local failed=$(jq '[.networks[] | select(.status == "failed")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
    local in_progress=$(jq '[.networks[] | select(.status == "in_progress")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")

    echo ""
    echo "=========================================="
    echo "  EXECUTION PROGRESS SUMMARY"
    echo "=========================================="
    echo "Total networks: $total"
    echo "✅ Successful: $success"
    echo "❌ Failed: $failed"
    echo "🔄 In Progress: $in_progress"
    echo "⏳ Pending: $pending"
    echo ""

    if [[ $failed -gt 0 ]]; then
        echo "❌ FAILED NETWORKS:"
        getFailedNetworks | while read -r network; do
            local error=$(jq -r --arg network "$network" '.networks[$network].error // "Unknown error"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "Unknown error")
            echo "  - $network: $error"
        done
        echo ""
    fi

      if [[ $pending -gt 0 ]]; then
    echo "⏳ PENDING NETWORKS:"
    getPendingNetworks | while read -r network; do
      echo "  - $network"
    done
    echo ""
  fi

  # Show retry instructions if there are failed or pending networks
  local remaining_networks=($(getFailedNetworks) $(getPendingNetworks))
  if [[ ${#remaining_networks[@]} -gt 0 ]]; then
    echo "🔄 TO RETRY FAILED/PENDING NETWORKS:"
    echo "  Simply run the same command again!"
    echo "  The system will automatically skip successful networks and retry only the failed/pending ones."
    echo ""
  fi

  echo "=========================================="
}

function cleanupProgressTracking() {
    # Only clean up if all networks are successful
    if [[ -n "$PROGRESS_TRACKING_FILE" && -f "$PROGRESS_TRACKING_FILE" ]]; then
        # Check if file is valid JSON
        if jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
            local total=$(jq '.networks | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
            local success=$(jq '[.networks[] | select(.status == "success")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")

            if [[ "$total" -gt 0 && "$success" -eq "$total" ]]; then
                rm "$PROGRESS_TRACKING_FILE"
                logWithTimestamp "All networks completed successfully - cleaned up progress tracking file: $PROGRESS_TRACKING_FILE"
            else
                logWithTimestamp "Progress tracking file preserved for resumable execution (success: $success/$total): $PROGRESS_TRACKING_FILE"
            fi
        else
            logWithTimestamp "Progress tracking file contains invalid JSON, removing it: $PROGRESS_TRACKING_FILE"
            rm "$PROGRESS_TRACKING_FILE"
        fi
    else
        # File doesn't exist - silently return (might have been cleaned up already)
        return 0
    fi
}

function forceCleanupProgressTracking() {
    # Force cleanup of progress tracking file (use with caution)
    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        rm "$PROGRESS_TRACKING_FILE"
        logWithTimestamp "Force cleaned up progress tracking file"
    else
        logWithTimestamp "Progress tracking file not found"
    fi
}




function isGroupComplete() {
    # Check if all networks in a group are already successful
    local NETWORKS=("$@")

    if [[ ${#NETWORKS[@]} -eq 0 ]]; then
        return 0  # Empty group is considered complete
    fi

    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        return 1  # No progress file means not complete
    fi

    local PENDING_COUNT=0
    for NETWORK in "${NETWORKS[@]}"; do
        local STATUS=$(jq -r --arg network "$NETWORK" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
        if [[ "$STATUS" != "success" ]]; then
            PENDING_COUNT=$((PENDING_COUNT + 1))
        fi
    done

    # Group is complete if no networks are pending
    return $PENDING_COUNT
}

# =============================================================================
# NETWORK EXECUTION FUNCTIONS
# =============================================================================

function executeNetworkInGroup() {
    # ENVIRONMENT is read from the global configuration variable
    # CONTRACT is determined in executeNetworkActions and exported
    local network="$1"
    local log_dir="$2"

    if [[ -z "$network" || -z "$log_dir" || -z "$ENVIRONMENT" ]]; then
        error "Network and log_dir are required, and ENVIRONMENT must be configured in the EXECUTION CONFIGURATION section"
        return 1
    fi

    # Update progress to in_progress
    updateNetworkProgress "$network" "in_progress"

    # Get RPC URL
    local rpc_url=$(getRPCUrl "$network" "$ENVIRONMENT")
    if [[ $? -ne 0 ]]; then
        updateNetworkProgress "$network" "failed" "Failed to get RPC URL"
        return 1
    fi

    # Check if RPC URL is empty (additional safety check)
    if [[ -z "$rpc_url" ]]; then
        updateNetworkProgress "$network" "failed" "Empty RPC URL"
        return 1
    fi

    # Export RPC_URL for downstream commands
    export RPC_URL="$rpc_url"

    # Retry logic setup
    local retry_count=0
    local command_status=1
    local max_attempts=3

    # Attempt operations with retries
    while [[ $command_status -ne 0 && $retry_count -lt $max_attempts ]]; do
        logWithTimestamp "[$network] Attempt $((retry_count + 1))/$max_attempts: Executing operations..."

        # Check if we should exit (in case of interrupt)
        if [[ -n "$EXIT_REQUESTED" ]]; then
            logWithTimestamp "[$network] Exit requested, stopping operations"
            updateNetworkProgress "$network" "failed" "Execution interrupted"
            return 1
        fi

        # Execute the actual network operations
        # This calls the executeNetworkActions function which contains the configured actions
        # CONTRACT is determined and exported in executeNetworkActions
        executeNetworkActions "$network" "$log_dir"
        command_status=$?

        # Get CONTRACT from executeNetworkActions (it's exported)
        local contract="${CONTRACT:-}"
        if [[ -z "$contract" ]]; then
            error "[$network] CONTRACT was not determined in executeNetworkActions"
            updateNetworkProgress "$network" "failed" "CONTRACT not determined"
            return 1
        fi

        # Increase retry counter
        retry_count=$((retry_count + 1))

        # Sleep for 2 seconds before trying again if failed
        if [[ $command_status -ne 0 ]]; then
            sleep 2
        fi
    done

    # Check final status and update progress
    if [[ $command_status -eq 0 ]]; then
        updateNetworkProgress "$network" "success"
        return 0
    else
        updateNetworkProgress "$network" "failed" "Failed after $max_attempts attempts"
        return 1
    fi
}

function executeGroupSequentially() {
    # ENVIRONMENT is read from the global configuration variable
    # CONTRACT is determined in executeNetworkActions
    local group="$1"
    shift 1  # Remove first argument
    local -a networks=("$@")  # Remaining arguments are networks

    if [[ -z "$group" || ${#networks[@]} -eq 0 || -z "$ENVIRONMENT" ]]; then
        error "Group and networks are required, and ENVIRONMENT must be configured in the EXECUTION CONFIGURATION section"
        return 1
    fi

    logGroupInfo "$group" "${networks[@]}"

    # Update foundry.toml for this group
    if ! updateFoundryTomlForGroup "$group"; then
        error "Failed to update foundry.toml for group $group"
        return 1
    fi

    # Recompile for this group
    if ! recompileForGroup "$group"; then
        error "Failed to recompile for group $group"
        return 1
    fi

    # Create log directory for this group
    local log_dir=$(mktemp -d)

    # Set up signal handler to kill background jobs on interrupt
    trap 'echo ""; logWithTimestamp "Interrupt received. Stopping all background jobs..."; jobs -p | xargs -r kill; rm -rf "$log_dir"; exit 1' INT TERM

    # Determine execution mode for this group
    local should_run_parallel="$RUN_PARALLEL"
    if [[ "$group" == "$GROUP_ZKEVM" && "$ZKEVM_ALWAYS_SEQUENTIAL" == "true" ]]; then
        should_run_parallel=false
        logWithTimestamp "zkEVM group: forcing sequential execution"
    fi

    if [[ "$should_run_parallel" == "true" ]]; then
        # Execute networks in parallel within the group
        logWithTimestamp "Executing networks in parallel"

        local -a pids=()
        for network in "${networks[@]}"; do
            # Check if this network is still pending
            if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
                local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
                if [[ "$status" == "success" || "$status" == "failed" ]]; then
                    logWithTimestamp "[$network] Skipping (status: $status)"
                    continue
                fi
            fi


            # Start network execution in background
            # Each process runs independently and updates progress file atomically
            executeNetworkInGroup "$network" "$log_dir" &
            pids+=($!)

        done
    else
        # Execute networks sequentially within the group
        logWithTimestamp "Executing networks sequentially"
        for network in "${networks[@]}"; do
            # Check if this network is still pending
            if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
                local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
                if [[ "$status" == "success" || "$status" == "failed" ]]; then
                    logWithTimestamp "[$network] Skipping (status: $status)"
                    continue
                fi
            fi


            # Execute network in foreground
            executeNetworkInGroup "$network" "$log_dir"
        done
    fi

    # Wait for all background jobs to complete (only for parallel execution)
    local current_execution_failures=0
    if [[ "$should_run_parallel" == "true" ]]; then
        for pid in "${pids[@]}"; do
            if ! wait "$pid"; then
                current_execution_failures=$((current_execution_failures + 1))
            fi
        done
    fi

    # Count total failed networks (including those from previous runs)
    local total_failed_count=0
    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        for network in "${networks[@]}"; do
            local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
            if [[ "$status" == "failed" ]]; then
                total_failed_count=$((total_failed_count + 1))
            fi
        done
    fi

    # Clean up log directory
    rm -rf "$log_dir"

    logWithTimestamp "Group $group execution completed. Failed networks: $total_failed_count (current execution: $current_execution_failures)"

    if [[ $total_failed_count -gt 0 ]]; then
        return 1
    fi

    return 0
}

# =============================================================================
# MAIN EXECUTION FUNCTION
# =============================================================================

function executeNetworksByGroup() {
    # ENVIRONMENT is read from the global configuration variable
    # CONTRACT is determined in executeNetworkActions
    local -a networks=("$@")  # All arguments are networks

    if [[ -z "$ENVIRONMENT" || ${#networks[@]} -eq 0 ]]; then
        error "ENVIRONMENT must be configured in the EXECUTION CONFIGURATION section, and at least one network is required"
        error "Example: Configure ENVIRONMENT at the top of multiNetworkExecution.sh, then call executeNetworksByGroup mainnet arbitrum base"
        return 1
    fi

    # We need to determine CONTRACT before initializing progress tracking
    # Call executeNetworkActions on the first network to determine CONTRACT
    # Use a temporary log dir and temp file for this
    local temp_log_dir=$(mktemp -d)
    local temp_contract_file=$(mktemp)
    local first_network="${networks[0]}"

    # Call executeNetworkActions with CONTRACT_FILE set so it writes CONTRACT to file
    CONTRACT_FILE="$temp_contract_file" executeNetworkActions "$first_network" "$temp_log_dir" > /dev/null 2>&1
    local contract=$(cat "$temp_contract_file" 2>/dev/null || echo "")
    rm -rf "$temp_log_dir" "$temp_contract_file"

    if [[ -z "$contract" ]]; then
        error "CONTRACT could not be determined. Please ensure executeNetworkActions sets CONTRACT."
        return 1
    fi

    # Initialize progress tracking silently
    initializeProgressTracking "$contract" "${networks[@]}" > /dev/null 2>&1

    # Group networks by execution requirements
    local groups_data=$(groupNetworksByExecutionGroup "${networks[@]}")
    if [[ $? -ne 0 ]]; then
        error "Failed to group networks"
        return 1
    fi

    # Extract group arrays - read line by line to ensure proper array population
    local -a london_networks=()
    local -a zkevm_networks=()
    local -a cancun_networks=()
    local -a invalid_networks=()

    while IFS= read -r network || [[ -n "$network" ]]; do
        if [[ -n "$network" ]]; then
            london_networks+=("$network")
        fi
    done < <(echo "$groups_data" | jq -r '.london[] // empty')

    while IFS= read -r network || [[ -n "$network" ]]; do
        if [[ -n "$network" ]]; then
            zkevm_networks+=("$network")
        fi
    done < <(echo "$groups_data" | jq -r '.zkevm[] // empty')

    while IFS= read -r network || [[ -n "$network" ]]; do
        if [[ -n "$network" ]]; then
            cancun_networks+=("$network")
        fi
    done < <(echo "$groups_data" | jq -r '.cancun[] // empty')

    while IFS= read -r network || [[ -n "$network" ]]; do
        if [[ -n "$network" ]]; then
            invalid_networks+=("$network")
        fi
    done < <(echo "$groups_data" | jq -r '.invalid[] // empty')

    # Report invalid networks
    if [[ ${#invalid_networks[@]} -gt 0 ]]; then
        error "Invalid networks found: ${invalid_networks[*]}"
        return 1
    fi

    # Backup foundry.toml silently
    backupFoundryToml > /dev/null 2>&1

    # Set up cleanup on exit
    trap 'restoreFoundryToml; getProgressSummary; cleanupProgressTracking' EXIT

    # Show group execution plan
    echo ""
    echo "=================================================================================="
    logWithTimestamp "📋 GROUP EXECUTION PLAN"
    echo "=================================================================================="

    # Build comma-separated network lists for each group
    if [[ ${#cancun_networks[@]} -gt 0 ]]; then
        local cancun_list=$(IFS=','; echo "${cancun_networks[*]}")
        if isGroupComplete "${cancun_networks[@]}"; then
            logWithTimestamp "✅ Cancun EVM Group (${#cancun_networks[@]} networks): ${cancun_list} - SKIP"
        else
            logWithTimestamp "🚀 Cancun EVM Group (${#cancun_networks[@]} networks): ${cancun_list} - EXECUTE"
        fi
    fi

    if [[ ${#zkevm_networks[@]} -gt 0 ]]; then
        local zkevm_list=$(IFS=','; echo "${zkevm_networks[*]}")
        if isGroupComplete "${zkevm_networks[@]}"; then
            logWithTimestamp "✅ zkEVM Group (${#zkevm_networks[@]} networks): ${zkevm_list} - SKIP"
        else
            logWithTimestamp "🚀 zkEVM Group (${#zkevm_networks[@]} networks): ${zkevm_list} - EXECUTE"
        fi
    fi

    if [[ ${#london_networks[@]} -gt 0 ]]; then
        local london_list=$(IFS=','; echo "${london_networks[*]}")
        if isGroupComplete "${london_networks[@]}"; then
            logWithTimestamp "✅ London EVM Group (${#london_networks[@]} networks): ${london_list} - SKIP"
        else
            logWithTimestamp "🚀 London EVM Group (${#london_networks[@]} networks): ${london_list} - EXECUTE"
        fi
    fi

    echo "=================================================================================="
    echo ""

    local overall_success=true

    # Execute groups sequentially: Cancun → zkEVM (same config) → London (needs recompilation)
    if [[ ${#cancun_networks[@]} -gt 0 ]]; then
        if isGroupComplete "${cancun_networks[@]}"; then
            echo ""
            echo "=================================================================================="
            logWithTimestamp "✅ SKIPPING CANCUN EVM GROUP (${#cancun_networks[@]} networks) - All networks already completed"
            echo "=================================================================================="
            echo ""
        else
            echo ""
            echo "=================================================================================="
            logWithTimestamp "🚀 EXECUTING CANCUN EVM GROUP (${#cancun_networks[@]} networks)"
            echo "=================================================================================="

            if ! executeGroupSequentially "$GROUP_CANCUN" "${cancun_networks[@]}"; then
                overall_success=false
            fi
            echo ""
            logWithTimestamp "✅ Cancun EVM group completed"
            echo "=================================================================================="
            echo ""
        fi
    fi

    if [[ ${#zkevm_networks[@]} -gt 0 ]]; then
        if isGroupComplete "${zkevm_networks[@]}"; then
            echo ""
            echo "=================================================================================="
            logWithTimestamp "✅ SKIPPING ZKEVM GROUP (${#zkevm_networks[@]} networks) - All networks already completed"
            echo "=================================================================================="
            echo ""
        else
            echo ""
            echo "=================================================================================="
            logWithTimestamp "🚀 EXECUTING ZKEVM GROUP (${#zkevm_networks[@]} networks)"
            echo "=================================================================================="
            if ! executeGroupSequentially "$GROUP_ZKEVM" "${zkevm_networks[@]}"; then
                overall_success=false
            fi
            echo ""
            logWithTimestamp "✅ zkEVM group completed"
            echo "=================================================================================="
            echo ""
        fi
    fi

    if [[ ${#london_networks[@]} -gt 0 ]]; then
        if isGroupComplete "${london_networks[@]}"; then
            echo ""
            echo "=================================================================================="
            logWithTimestamp "✅ SKIPPING LONDON EVM GROUP (${#london_networks[@]} networks) - All networks already completed"
            echo "=================================================================================="
            echo ""
        else
            echo ""
            echo "=================================================================================="
            logWithTimestamp "🚀 EXECUTING LONDON EVM GROUP (${#london_networks[@]} networks)"
            echo "=================================================================================="
            if ! executeGroupSequentially "$GROUP_LONDON" "${london_networks[@]}"; then
                overall_success=false
            fi
            echo ""
            logWithTimestamp "✅ London EVM group completed"
            echo "=================================================================================="
            echo ""
        fi
    fi

    # Restore foundry.toml
    restoreFoundryToml

    # Summary and cleanup are handled by EXIT trap
    if [[ "$overall_success" == "true" ]]; then
        return 0
    else
        return 1
    fi
}

# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

function executeAllNetworksForContract() {
    local contract="$1"
    local environment="$2"

    if [[ -z "$contract" || -z "$environment" ]]; then
        error "Usage: executeAllNetworksForContract CONTRACT ENVIRONMENT"
        return 1
    fi

    # Get all included networks
    local -a all_networks=($(getIncludedNetworksArray))

    executeNetworksByGroup "$contract" "$environment" "${all_networks[@]}"
}

function executeNetworksByEvmVersion() {
    local contract="$1"
    local environment="$2"
    local evm_version="$3"

    if [[ -z "$contract" || -z "$environment" || -z "$evm_version" ]]; then
        error "Usage: executeNetworksByEvmVersion CONTRACT ENVIRONMENT EVM_VERSION"
        error "Example: executeNetworksByEvmVersion GlacisFacet production london"
        return 1
    fi

    # Get networks with specific EVM version
    local -a networks=($(getIncludedNetworksByEvmVersionArray "$evm_version"))

    if [[ ${#networks[@]} -eq 0 ]]; then
        error "No networks found with EVM version: $evm_version"
        return 1
    fi

    executeNetworksByGroup "$contract" "$environment" "${networks[@]}"
}

# Note: retryFailedNetworks function removed - just run the same command again!
# The system now automatically handles retries by resuming from existing progress

# =============================================================================
# COMPLETE NETWORK ITERATION SYSTEM
# =============================================================================

function iterateAllNetworksOriginal() {
    # Original function from playground.sh - now with grouping support
    local CONTRACT="$1"
    local ENVIRONMENT="$2"

    local RUN_PARALLEL=true  # <<<<<<<<---------------------- ADJUST FOR PARALLEL vs. SEQUENTIAL EXECUTION

    # Clean up any stale lock files before starting
    cleanupStaleLocksOriginal

    # get array with all network names
    ##### GET ONLY THOSE NETWORKS WHERE THE GIVEN CONTRACT IS DEPLOYED #####
    # local NETWORKS=($(getNetworksByEvmVersionAndContractDeployment "" "$CONTRACT" "$ENVIRONMENT")) # if no evm version is provided, it will return all networks where the contract is deployed
    # local NETWORKS=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT"))   # to get networks with same evm version AND contract deployed
    # local NETWORKS=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT" "london"))   # to get networks with same evm version AND contract deployed
    # local NETWORKS=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT"))   # to get networks with same evm version AND contract deployed

    #####  GET ALL NETWORKS WITH A GIVEN EVM VERSION #####
    # local NETWORKS=($(getIncludedNetworksByEvmVersionArray "london"))   # to get networks with same evm version
    #####  GET ALL NETWORKS #####

    local NETWORKS=($(getIncludedNetworksArray)) # to get all included networks
    # local NETWORKS=("arbitrum" "aurora" "base" "blast" "bob" "bsc" "cronos" "gravity" "linea" "mainnet" "mantle" "mode" "polygon" "scroll" "taiko")
    # local NETWORKS=("arbitrum" "avalanche" "base" "bsc" "celo" "mainnet" "optimism" "polygon") # <<<<< AllBridgeFacet
    # local NETWORKS=("abstract" "fraxtal" "lens" "lisk" "sei" "sophon" "swellchain" "unichain")
    # local NETWORKS=("base" "arbitrum" "bsc" "corn" "katana" "bob" "etherlink" "plume" "gravity" "superposition" "cronos" "scroll" "blast" "apechain" "opbnb" "fantom" "lens" "abstract" "avalanche" "sei" "sophon" "zksync" "celo" "unichain" "lisk" "fraxtal" "boba" "swellchain")
    # local NETWORKS=("plume" "taiko" "xlayer" "zksync")
    # local NETWORKS=("vana" "fraxtal" "bob" "sophon")

    # local NETWORKS=("avalanche" "linea" "")

    # local NETWORKS=("arbitrum" "avalanche" "base" "blast" "bsc" "celo" "etherlink" "flare" "gnosis" "linea" "lisk" "mainnet" "mantle" "mode" "optimism" "polygon" "polygonzkevm" "rootstock" "scroll" "sei" "sonic" "viction")
    # local NETWORKS=("zksync")

    ##### USE THIS WHITELIST TO FILTER NETWORKS RETURNED BY THE FUNCTIONS ABOVE #####
    # local NETWORKS_WHITELIST=("mainnet" "arbitrum" "avalanche" "base" "bsc" "celo" "optimism" "polygon")
    # local NETWORKS_WHITELIST=("abstract" "lens" "sophon" "zksync") # zkEVM networks
    # local NETWORKS_WHITELIST=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT"))

    # Filter NETWORKS to only include networks that are also in the whitelist
    if [[ ${NETWORKS_WHITELIST+x} && ${#NETWORKS_WHITELIST[@]} -gt 0 ]]; then
        local FILTERED_NETWORKS=()
        for network in "${NETWORKS[@]}"; do
            for whitelisted_network in "${NETWORKS_WHITELIST[@]}"; do
                if [[ "$network" == "$whitelisted_network" ]]; then
                    FILTERED_NETWORKS+=("$network")
                    break
                fi
            done
        done
        NETWORKS=("${FILTERED_NETWORKS[@]}")
    fi

    echo ""
    echo "[info] Environment: $ENVIRONMENT"
    echo "[info] iterating over all ${#NETWORKS[@]} networks: ${NETWORKS[*]}"
    echo ""

    # Initialize arrays to track results
    local SUCCESSFUL_NETWORKS=()
    local FAILED_NETWORKS=()
    LOG_DIR=$(mktemp -d)

    # Save LOG_DIR and network list to files so cleanup function can access them
    echo "$LOG_DIR" > "/tmp/network_processing_log_dir"
    printf '%s\n' "${NETWORKS[@]}" > "/tmp/network_processing_networks"

    if [[ "$RUN_PARALLEL" == "true" ]]; then
        echo "[info] Running in parallel mode"

        # Set up signal handler to kill background jobs on interrupt
        trap 'echo ""; echo "[info] Interrupt received. Stopping all background jobs..."; jobs -p | xargs -r kill; rm -rf "$LOG_DIR"; exit 1' INT TERM

        # Run all networks in parallel
        for NETWORK in "${NETWORKS[@]}"; do
            handleNetworkOriginal "$NETWORK" "$ENVIRONMENT" "$LOG_DIR" "$CONTRACT" &
        done

        # Wait for all background jobs to complete
        wait
        echo "[info] All parallel jobs completed"
    else
        echo "[info] Running in sequential mode"
        # loop through all networks sequentially
        for NETWORK in "${NETWORKS[@]}"; do
            handleNetworkOriginal "$NETWORK" "$ENVIRONMENT" "$LOG_DIR" "$CONTRACT"
        done
    fi

    # Generate final summary
    generateSummaryOriginal "$LOG_DIR"

    # Clean up log directory and tracking files
    rm -rf "$LOG_DIR"
    rm -f "/tmp/network_processing_log_dir"
    rm -f "/tmp/network_processing_networks"
}

function iterateAllNetworksGrouped() {
    # This function replaces iterateAllNetworks but with automatic grouping
    # ENVIRONMENT is read from the global configuration variable
    # CONTRACT is determined in executeNetworkActions

    if [[ -z "$ENVIRONMENT" ]]; then
        error "ENVIRONMENT must be configured in the EXECUTION CONFIGURATION section at the top of multiNetworkExecution.sh"
        return 1
    fi

    # Get the networks configured in the NETWORK SELECTION CONFIGURATION section above
    # Use a different variable name to avoid shadowing the global NETWORKS array
    local SELECTED_NETWORKS_ARRAY=()

    # Capture networks from stdout only (stderr goes to actual stderr)
    # This ensures we only capture network names, not error messages
    local temp_output=$(mktemp)
    local temp_stderr=$(mktemp)
    if ! getConfiguredNetworks > "$temp_output" 2> "$temp_stderr"; then
        # Function failed - show error and cleanup
        cat "$temp_stderr" >&2
        rm -f "$temp_output" "$temp_stderr"
        return 1
    fi
    # Check if there were any errors (but function succeeded)
    if [[ -s "$temp_stderr" ]]; then
        cat "$temp_stderr" >&2
    fi
    rm -f "$temp_stderr"

    # Function succeeded - read networks from output
    # Read networks line by line, ensuring each is added as a separate array element
    # Use process substitution to avoid subshell issues
    while IFS= read -r network || [[ -n "$network" ]]; do
        # Skip empty lines and lines that look like error messages
        if [[ -n "$network" ]]; then
            # Trim whitespace
            network=$(printf '%s' "$network" | xargs)
            # Skip if empty after trimming or if it looks like an error message
            if [[ -n "$network" ]] && [[ ! "$network" =~ ^\[error\] ]] && [[ ! "$network" =~ NETWORKS.*not.*defined ]]; then
                SELECTED_NETWORKS_ARRAY+=("$network")
            fi
        fi
    done < "$temp_output"
    rm -f "$temp_output"

    # Check if we got any networks
    if [[ ${#SELECTED_NETWORKS_ARRAY[@]} -eq 0 ]]; then
        error "No networks found for environment '$ENVIRONMENT'"
        error "Please check that NETWORKS array is configured in the NETWORK SELECTION CONFIGURATION section of multiNetworkExecution.sh"
        return 1
    fi

    # Use the new execution logic with group skipping
    # Ensure proper array expansion by using explicit array syntax
    # Pass networks as separate arguments by expanding the array
    executeNetworksByGroup "${SELECTED_NETWORKS_ARRAY[@]}"
}

function handleNetworkOriginal() {
    local NETWORK="$1"
    local ENVIRONMENT="$2"
    local LOG_DIR="$3"
    local CONTRACT="$4"

    RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")
    if [[ $? -ne 0 ]]; then
        echo "[$NETWORK] Failed to get RPC URL"
        return 1
    fi

    # Check if RPC URL is empty (additional safety check)
    if [[ -z "$RPC_URL" ]]; then
        echo "[$NETWORK] Empty RPC URL"
        return 1
    fi

    # Export RPC_URL for downstream commands
    export RPC_URL

    # Retry logic setup
    RETRY_COUNT=0
    COMMAND_STATUS=1
    MAX_ATTEMPTS_PER_SCRIPT_EXECUTION=1

    if [[ -z "$CONTRACT" ]]; then
        echo "[$NETWORK] No contract provided, cannot proceed"
        return 1
    fi

    # Attempt all operations with retries
    while [ $COMMAND_STATUS -ne 0 -a $RETRY_COUNT -lt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
        echo "[$NETWORK] Attempt $((RETRY_COUNT + 1))/$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION: Executing operations..."

        # Check if we should exit (in case of interrupt)
        if [[ -n "$EXIT_REQUESTED" ]]; then
            echo "[$NETWORK] Exit requested, stopping operations"
            echo "FAILED" > "$LOG_DIR/${NETWORK}.log"
            return 1
        fi

        # Execute the configured network actions
        # To modify actions, edit the NETWORK ACTION CONFIGURATION section at the top of this file
        executeNetworkActions "$NETWORK" "$ENVIRONMENT" "$LOG_DIR" "$CONTRACT"
        COMMAND_STATUS=$?

        # increase retry counter
        RETRY_COUNT=$((RETRY_COUNT + 1))

        # sleep for 2 seconds before trying again if failed
        [ $COMMAND_STATUS -ne 0 ] && sleep 2
    done

    # Check final status and log result
    if [ $COMMAND_STATUS -eq 0 ]; then
        success "[$NETWORK] All operations completed successfully"
        echo "SUCCESS" > "$LOG_DIR/${NETWORK}.log"
        return 0
    else
        error "[$NETWORK] Failed to complete operations after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts"
        echo "FAILED" > "$LOG_DIR/${NETWORK}.log"
        return 1
    fi
}

function generateSummaryOriginal() {
    local LOG_DIR="$1"

    # Get the actual networks that were processed by reading the log files
    local NETWORKS=()
    if [[ -d "$LOG_DIR" ]]; then
        # Read all .log files in the directory to get the actual networks that were processed
        for log_file in "$LOG_DIR"/*.log; do
            if [[ -f "$log_file" ]]; then
                local network_name=$(basename "$log_file" .log)
                NETWORKS+=("$network_name")
            fi
        done
    fi

    # If no log files found, fall back to the current network selection
    if [[ ${#NETWORKS[@]} -eq 0 ]]; then
        # Try to read the network list from the temporary file that was saved
        local network_file="/tmp/network_processing_networks"
        if [[ -f "$network_file" ]]; then
            NETWORKS=($(cat "$network_file"))
        else
            # Fallback to the original function if no saved network list
            NETWORKS=($(getIncludedNetworksByEvmVersionArray "cancun"))
        fi
    fi

    # Initialize arrays to track results
    local SUCCESSFUL_NETWORKS=()
    local FAILED_NETWORKS=()
    local IN_PROGRESS_NETWORKS=()

    # Read results from individual log files
    for NETWORK in "${NETWORKS[@]}"; do
        local NETWORK_LOG_FILE="$LOG_DIR/${NETWORK}.log"
        if [[ -f "$NETWORK_LOG_FILE" ]]; then
            local STATUS=$(cat "$NETWORK_LOG_FILE")
            if [[ "$STATUS" == "SUCCESS" ]]; then
                SUCCESSFUL_NETWORKS+=("$NETWORK")
            elif [[ "$STATUS" == "FAILED" ]]; then
                FAILED_NETWORKS+=("$NETWORK")
            fi
        else
            # If no log file exists, it was still in progress
            IN_PROGRESS_NETWORKS+=("$NETWORK")
        fi
    done

    # Print summary
    echo ""
    echo "=========================================="
    echo "           INTERRUPTED EXECUTION SUMMARY"
    echo "=========================================="
    echo "Total networks: ${#NETWORKS[@]}"
    echo "✅ Successful: ${#SUCCESSFUL_NETWORKS[@]}"
    echo "❌ Failed: ${#FAILED_NETWORKS[@]}"
    echo "⏳ In Progress: ${#IN_PROGRESS_NETWORKS[@]}"
    echo ""

    if [[ ${#SUCCESSFUL_NETWORKS[@]} -gt 0 ]]; then
        echo "✅ SUCCESSFUL NETWORKS (${#SUCCESSFUL_NETWORKS[@]}):"
        printf "  %s\n" "${SUCCESSFUL_NETWORKS[@]}"
        echo ""
    fi

    if [[ ${#FAILED_NETWORKS[@]} -gt 0 ]]; then
        echo "❌ FAILED NETWORKS (${#FAILED_NETWORKS[@]}):"
        printf "  %s\n" "${FAILED_NETWORKS[@]}"
        echo ""
    fi

    if [[ ${#IN_PROGRESS_NETWORKS[@]} -gt 0 ]]; then
        echo "⏳ NETWORKS STILL IN PROGRESS (${#IN_PROGRESS_NETWORKS[@]}):"
        printf "  %s\n" "${IN_PROGRESS_NETWORKS[@]}"
        echo ""
    fi

    # Show retry commands
    local REMAINING_NETWORKS=("${FAILED_NETWORKS[@]}" "${IN_PROGRESS_NETWORKS[@]}")
    if [[ ${#REMAINING_NETWORKS[@]} -gt 0 ]]; then
        echo "🔄 REMAINING NETWORKS TO PROCESS:"
        echo "  # local NETWORKS=($(printf '"%s" ' "${REMAINING_NETWORKS[@]}" | sed 's/ $//'))"
        echo ""
        echo "💡 To retry only the remaining networks, copy the line above and replace the NETWORKS array in your script."
    else
        echo "✅ ALL NETWORKS COMPLETED SUCCESSFULLY!"
    fi

    echo "=========================================="
}

function cleanupStaleLocksOriginal() {
    # Clean up any stale lock files that might prevent execution
    find /tmp -name "*.lock" -mtime +1 -delete 2>/dev/null || true
}

function executeGroupWithHandleNetwork() {
    # This function executes a group of networks using your existing handleNetwork function
    local group="$1"
    local environment="$2"
    local contract="$3"
    local -a networks=("${@:4}")

    if [[ -z "$group" || ${#networks[@]} -eq 0 || -z "$environment" || -z "$contract" ]]; then
        error "Group, networks, environment, and contract are required"
        return 1
    fi

    logGroupInfo "$group" "${networks[@]}"

    # Update foundry.toml for this group
    if ! updateFoundryTomlForGroup "$group"; then
        error "Failed to update foundry.toml for group $group"
        return 1
    fi

    # Recompile for this group
    if ! recompileForGroup "$group"; then
        error "Failed to recompile for group $group"
        return 1
    fi

    # Create log directory for this group
    local log_dir=$(mktemp -d)

    # Set up signal handler to kill background jobs on interrupt
    trap 'echo ""; logWithTimestamp "Interrupt received. Stopping all background jobs..."; jobs -p | xargs -r kill; rm -rf "$log_dir"; exit 1' INT TERM

    # Determine execution mode for this group
    local should_run_parallel="$RUN_PARALLEL"
    if [[ "$group" == "$GROUP_ZKEVM" && "$ZKEVM_ALWAYS_SEQUENTIAL" == "true" ]]; then
        should_run_parallel=false
        logWithTimestamp "zkEVM group: forcing sequential execution"
    fi

    if [[ "$should_run_parallel" == "true" ]]; then
        # Execute networks in parallel within the group using your existing handleNetwork function
        logWithTimestamp "Executing networks in parallel"
        local -a pids=()
        for network in "${networks[@]}"; do
            # Check if this network is still pending
            if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
                local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
                if [[ "$status" == "success" || "$status" == "failed" ]]; then
                    logWithTimestamp "[$network] Skipping (status: $status)"
                    continue
                fi
            fi

            # Start network execution in background using your existing handleNetwork function
            executeNetworkWithHandleNetwork "$network" "$environment" "$log_dir" "$contract" "$group" &
            pids+=($!)
        done

        # Wait for all background jobs to complete
        local current_execution_failures=0
        for pid in "${pids[@]}"; do
            if ! wait "$pid"; then
                current_execution_failures=$((current_execution_failures + 1))
            fi
        done
    else
        # Execute networks sequentially within the group using your existing handleNetwork function
        logWithTimestamp "Executing networks sequentially"
        local current_execution_failures=0
        for network in "${networks[@]}"; do
            # Check if this network is still pending
            if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
                local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
                if [[ "$status" == "success" || "$status" == "failed" ]]; then
                    logWithTimestamp "[$network] Skipping (status: $status)"
                    continue
                fi
            fi

            # Execute network in foreground using your existing handleNetwork function
            if ! executeNetworkWithHandleNetwork "$network" "$environment" "$log_dir" "$contract" "$group"; then
                current_execution_failures=$((current_execution_failures + 1))
            fi
        done
    fi

    # Count total failed networks (including those from previous runs)
    local total_failed_count=0
    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        for network in "${networks[@]}"; do
            local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
            if [[ "$status" == "failed" ]]; then
                total_failed_count=$((total_failed_count + 1))
            fi
        done
    fi

    # Clean up log directory
    rm -rf "$log_dir"

    logWithTimestamp "Group $group execution completed. Failed networks: $total_failed_count (current execution: $current_execution_failures)"

    if [[ $total_failed_count -gt 0 ]]; then
        return 1
    fi

    return 0
}

function executeNetworkWithHandleNetwork() {
    # This function wraps your existing handleNetwork function with progress tracking
    local network="$1"
    local environment="$2"
    local log_dir="$3"
    local contract="$4"
    local group="$5"

    if [[ -z "$network" || -z "$environment" || -z "$log_dir" || -z "$contract" || -z "$group" ]]; then
        error "All parameters are required for executeNetworkWithHandleNetwork"
        return 1
    fi

    # Update progress to in_progress
    updateNetworkProgress "$network" "in_progress"

    # Retry logic setup
    local retry_count=0
    local command_status=1
    local max_attempts=3

    # Attempt operations with retries
    while [[ $command_status -ne 0 && $retry_count -lt $max_attempts ]]; do
        logWithTimestamp "[$network] Attempt $((retry_count + 1))/$max_attempts: Executing operations..."

        # Check if we should exit (in case of interrupt)
        if [[ -n "$EXIT_REQUESTED" ]]; then
            logWithTimestamp "[$network] Exit requested, stopping operations"
            updateNetworkProgress "$network" "failed" "Execution interrupted"
            return 1
        fi

        # Call your existing handleNetwork function
        handleNetworkOriginal "$network" "$environment" "$log_dir" "$contract"
        command_status=$?

        # Increase retry counter
        retry_count=$((retry_count + 1))

        # Sleep for 2 seconds before trying again if failed
        if [[ $command_status -ne 0 ]]; then
            sleep 2
        fi
    done

    # Check final status and update progress
    if [[ $command_status -eq 0 ]]; then
        updateNetworkProgress "$network" "success"
        return 0
    else
        updateNetworkProgress "$network" "failed" "Failed after $max_attempts attempts"
        return 1
    fi
}

# =============================================================================
# EXPORT FUNCTIONS FOR USE IN OTHER SCRIPTS
# =============================================================================

# Make functions available to other scripts
export -f executeNetworksByGroup
export -f executeAllNetworksForContract
export -f executeNetworksByEvmVersion
export -f groupNetworksByExecutionGroup
export -f getProgressSummary
export -f iterateAllNetworksOriginal
export -f iterateAllNetworksGrouped
export -f handleNetworkOriginal
export -f generateSummaryOriginal
export -f cleanupStaleLocksOriginal
export -f executeGroupWithHandleNetwork
export -f executeNetworkWithHandleNetwork
export -f executeNetworkActions
export -f forceCleanupProgressTracking
export -f isGroupComplete
export -f detectActionType
export -f setProgressTrackingFile
export -f isActionAlreadyCompleted

# Helper function to reset progress tracking (for testing)
function resetProgressTracking() {
    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        rm "$PROGRESS_TRACKING_FILE"
        logWithTimestamp "Reset progress tracking file - will reinitialize with existing deployment detection"
    else
        logWithTimestamp "Progress tracking file not found - nothing to reset"
    fi
}

export -f resetProgressTracking
