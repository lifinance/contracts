#!/bin/bash

# =============================================================================
# Strict bash mode for safety and reliability
# =============================================================================
set -euo pipefail
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

# Contract to execute actions for (e.g., "WhitelistManagerFacet", "GlacisFacet")
CONTRACT="AllBridgeFacet"
export CONTRACT
export ENVIRONMENT

# =============================================================================
# NETWORK SELECTION CONFIGURATION
# =============================================================================
# Configure which networks to execute by modifying the NETWORKS array below
# This is the main place to adjust your network list for multi-execution

# Option 1: Use all included networks (default)
NETWORKS=($(getIncludedNetworksArray))

# Option 2: Use specific networks (uncomment and modify as needed)
# NETWORKS=("arbitrum" "avalanche" "base" "bsc" "celo" "gnosis" "lisk" "mainnet" "mantle" "optimism" "polygon" "scroll" "sonic" "worldchain" "berachain" "hyperevm" "ink" "soneium" "unichain" "katana" "plume")

  # NETWORKS=("arbitrum" "optimism" "base" "bsc" "linea" "scroll" "polygon" "blast" "mainnet" "worldchain")

# Option 3: Use networks by EVM version (uncomment as needed)
# NETWORKS=($(getIncludedNetworksByEvmVersionArray "london"))
# NETWORKS=($(getIncludedNetworksByEvmVersionArray "london"))

# Option 4: Use networks where contract is deployed (uncomment as needed)
# NETWORKS=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT"))
# NETWORKS=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT" "cancun"))

# Option 5: Use whitelist filtering (uncomment and modify as needed)
# NETWORKS_WHITELIST=("mainnet" "arbitrum" "base" "zksync")
# NETWORKS_WHITELIST=("mainnet" "arbitrum" "base" "bsc" "blast" "ink" "linea" "lisk" "mode" "optimism" "polygon" "scroll" "soneium" "unichain" "worldchain" "zksync")

# Option 6: Use blacklist filtering (applied after network selection)
# Networks in the blacklist will be excluded from the final network list
# This is useful for excluding networks that need to be skipped (e.g. already done manually)
# NETWORKS_BLACKLIST=("xlayer" "corn" "superposition" "tron" "tronshasta")
NETWORKS_BLACKLIST=("tron" "tronshasta")

# Foundry.toml backup file
FOUNDRY_TOML_BACKUP="foundry.toml.backup"

# =============================================================================
# NETWORK ACTION EXECUTION
# =============================================================================

function executeNetworkActions() {
    # This function executes the actions configured below
    # To modify actions, edit the code in this function
    # ENVIRONMENT and CONTRACT are read from the global configuration variables

    local NETWORK="${1:-}"
    local LOG_DIR="${2:-}"
    local RETURN_CODE=0

    # CONTRACT is set in the EXECUTION CONFIGURATION section above
    # Export CONTRACT so it can be used by other functions
    export CONTRACT

    # Also write CONTRACT to a temp file if CONTRACT_FILE is set (for parent shell access)
    if [[ -n "${CONTRACT_FILE:-}" ]]; then
        echo "$CONTRACT" > "$CONTRACT_FILE"
        # If CONTRACT_FILE is set, we're just determining CONTRACT, so skip actual execution
        return 0
    fi

    # Get RPC URL for the network
    # RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")

    # Execute configured actions (uncomment the ones you want)
    # All commands will be executed, and the last command's exit code will be returned

    # DEPLOY & VERIFY CONTRACT
    # CURRENT_VERSION=$(getCurrentContractVersion "${CONTRACT:-}")
    # # # echo "[$NETWORK] CURRENT_VERSION of contract $CONTRACT: $CURRENT_VERSION"
    # deploySingleContract "${CONTRACT:-}" "$NETWORK" "${ENVIRONMENT:-}" "${CURRENT_VERSION:-}" false
    # RETURN_CODE=$?
    # echo "[$NETWORK] deploySingleContract completed with exit code: $RETURN_CODE"




    # VERIFY - Verify the contract on the network
    # getContractVerified "$NETWORK" "$ENVIRONMENT" "$CONTRACT"
    # RETURN_CODE=$?
    # if [[ $RETURN_CODE -ne 0 ]]; then
    #     return $RETURN_CODE
    # fi

    # SYNC WHITEL IST - Sync whitelist from whitelist.json to diamo

    # PROPOSE - Create multisig proposal for the contract
    # createMultisigProposalForContract "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$LOG_DIR"
    #     RETURN_CODE=$?
    # if [[ $RETURN_CODE -ne 0 ]]; then
    #     return $RETURN_CODE
    # fi

    # UPDATE DIAMOND - Update diamond log for the network
    # updateDiamondLogForNetwork "$NETWORK" "$ENVIRONMENT"

    # CUSTOM ACTIONS - Add your custom actions here
    # CALLDATA=$(cast calldata "batchSetFunctionApprovalBySignature(bytes4[],bool)" [0x23b872dd] false)
    # cast send "$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")" "$CALLDATA" --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY_PRODUCTION"

    #### MANAGE SAFE OWNERS #############
    # Remove an owner from Safe
    # manageSafeOwner "remove" "$NETWORK" "0x1cEC0F949D04b809ab26c1001C9aEf75b1a28eeb"
    # manageSafeOwner "replace" "$NETWORK" "0x11F1022cA6AdEF6400e5677528a80d49a069C00c" "0xb137683965ADC470f140df1a1D05B0D25C14E269"
    # manageTimelockCanceller "replace" "$NETWORK" "0x11F1022cA6AdEF6400e5677528a80d49a069C00c" "0xb137683965ADC470f140df1a1D05B0D25C14E269"

    # removeAccessManagerPermission "$NETWORK" "0x1171c007" "0x11F1022cA6AdEF6400e5677528a80d49a069C00c"
    RETURN_CODE=$?


    # # Replace an owner in Safe (remove old, add new)
    # manageSafeOwner "replace" "$NETWORK" "0x1cEC0F949D04b809ab26c1001C9aEf75b1a28eeb" "0xb137683965ADC470f140df1a1D05B0D25C14E269"
    # if [[ $RETURN_CODE -ne 0 ]]; then
    #   RETURN_CODE=$?
    # fi
    # Add a new owner to Safe
    # manageSafeOwner "add" "$NETWORK" "" "0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62"


    # bunx tsx ./script/deploy/safe/propose-to-safe.ts --to "$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl "$RPC_URL" --timelock --ledger

    # RESPONSE=$(cast call "$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")" "isFunctionApproved(bytes4) returns (bool)" 0x23b872dd --rpc-url "$RPC_URL")
    # echo "[$NETWORK] function 0x23b872dd is approved: $RESPONSE"

    # Return the exit code of the last executed command (defaults to 0 if no commands executed)
    # If you need more sophisticated error handling, you can add it here
    # Note: If no commands are executed, RETURN_CODE defaults to 0, so we always return success
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
requireTools
validateEnv

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

function getConfiguredNetworksWithoutBlacklist() {
    # This function returns the networks configured in the NETWORK SELECTION CONFIGURATION section above
    # WITHOUT applying blacklist filtering (used for display purposes)
    # It handles the case where variables like $CONTRACT and $ENVIRONMENT might not be available yet

    local CONTRACT="${1:-}"
    local ENVIRONMENT="${2:-}"
    local SELECTED_NETWORKS=()

    # Check if NETWORKS array is empty or contains function calls that need variables
    if [[ ${#NETWORKS[@]} -eq 0 ]]; then
        # No networks configured, fallback to all networks
        SELECTED_NETWORKS=($(getIncludedNetworksArray))
    else
        # Check if the current NETWORKS array contains function calls that need variables
        local NEEDS_VARIABLES=false
        for NETWORK in "${NETWORKS[@]}"; do
            if [[ "$NETWORK" == *"\$CONTRACT"* ]] || [[ "$NETWORK" == *"\$ENVIRONMENT"* ]]; then
                NEEDS_VARIABLES=true
                break
            fi
        done

        if [[ "$NEEDS_VARIABLES" == "true" ]]; then
            # Re-evaluate the network selection with available variables
            if [[ -n "$CONTRACT" && -n "$ENVIRONMENT" ]]; then
                # Re-evaluate the configuration with variables available
                # This is a simplified approach - you can uncomment the specific option you want
                SELECTED_NETWORKS=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT"))
            else
                # Fallback to all networks if variables not available
                SELECTED_NETWORKS=($(getIncludedNetworksArray))
            fi
        else
            # Return the pre-configured networks
            if [[ ${#NETWORKS[@]} -gt 0 ]]; then
                SELECTED_NETWORKS=("${NETWORKS[@]}")
            else
                # If NETWORKS is empty, fallback to all networks
                SELECTED_NETWORKS=($(getIncludedNetworksArray))
            fi
        fi
    fi

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

    # Return the network list WITHOUT blacklist filtering
    printf '%s\n' "${SELECTED_NETWORKS[@]}"
}

function getConfiguredNetworks() {
    # This function returns the networks configured in the NETWORK SELECTION CONFIGURATION section above
    # WITH blacklist filtering applied (used for actual execution)
    # It handles the case where variables like $CONTRACT and $ENVIRONMENT might not be available yet

    local CONTRACT="${1:-}"
    local ENVIRONMENT="${2:-}"

    # Get networks without blacklist filtering first
    local SELECTED_NETWORKS=($(getConfiguredNetworksWithoutBlacklist "$CONTRACT" "$ENVIRONMENT"))

    # Apply blacklist filtering if NETWORKS_BLACKLIST is defined and not empty
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

    # Return the final network list (with blacklist filtering applied)
    printf '%s\n' "${SELECTED_NETWORKS[@]}"
}

function isNetworkBlacklisted() {
    # Check if a network is in the blacklist
    local NETWORK="${1:-}"

    if [[ -z "$NETWORK" ]]; then
        return 1
    fi

    if [[ ${NETWORKS_BLACKLIST+x} && ${#NETWORKS_BLACKLIST[@]} -gt 0 ]]; then
        for BLACKLISTED_NETWORK in "${NETWORKS_BLACKLIST[@]}"; do
            if [[ "$NETWORK" == "$BLACKLISTED_NETWORK" ]]; then
                return 0  # Network is blacklisted
            fi
        done
    fi

    return 1  # Network is not blacklisted
}

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

function logGroupInfo() {
    # This function is kept for potential future use but currently not called
    # to avoid duplicate output (group info is already shown in execution plan)
    local group="${1:-}"
    local -a networks=("${@:2}")
    logWithTimestamp "Group: $group (${#networks[@]} networks): ${networks[*]}"
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
        local GROUP=$(getNetworkGroup "$NETWORK" 2>/dev/null || echo "")
        local GROUP_RESULT=$?

        if [[ $GROUP_RESULT -eq 0 && -n "${GROUP:-}" ]]; then
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
    # Handle empty arrays safely by using conditional expansion
    local london_json="[]"
    local zkevm_json="[]"
    local cancun_json="[]"
    local invalid_json="[]"

    if [[ ${#LONDON_NETWORKS[@]} -gt 0 ]]; then
        london_json=$(printf '%s\n' "${LONDON_NETWORKS[@]}" | jq -R . | jq -s .)
    fi

    if [[ ${#ZKEVM_NETWORKS[@]} -gt 0 ]]; then
        zkevm_json=$(printf '%s\n' "${ZKEVM_NETWORKS[@]}" | jq -R . | jq -s .)
    fi

    if [[ ${#CANCUN_NETWORKS[@]} -gt 0 ]]; then
        cancun_json=$(printf '%s\n' "${CANCUN_NETWORKS[@]}" | jq -R . | jq -s .)
    fi

    if [[ ${#INVALID_NETWORKS[@]} -gt 0 ]]; then
        invalid_json=$(printf '%s\n' "${INVALID_NETWORKS[@]}" | jq -R . | jq -s .)
    fi

    jq -n \
        --argjson london "$london_json" \
        --argjson zkevm "$zkevm_json" \
        --argjson cancun "$cancun_json" \
        --argjson invalid "$invalid_json" \
        '{london: $london, zkevm: $zkevm, cancun: $cancun, invalid: $invalid}'
}

# =============================================================================
# FOUNDRY.TOML MANAGEMENT
# =============================================================================

function backupFoundryToml() {
    if [[ -f "foundry.toml" ]]; then
        cp "foundry.toml" "$FOUNDRY_TOML_BACKUP"
        logWithTimestamp "Backed up foundry.toml to $FOUNDRY_TOML_BACKUP"
    else
        error "foundry.toml not found"
        return 1
    fi
}

function restoreFoundryToml() {
    if [[ -f "$FOUNDRY_TOML_BACKUP" ]]; then
        cp "$FOUNDRY_TOML_BACKUP" "foundry.toml"
        logWithTimestamp "Restored foundry.toml from $FOUNDRY_TOML_BACKUP"
        rm "$FOUNDRY_TOML_BACKUP"
    else
        # Silently return if backup doesn't exist (expected after restore)
        return 0
    fi
}

function updateFoundryTomlForGroup() {
    local group="${1:-}"

    if [[ -z "$group" ]]; then
        error "Group is required"
        return 1
    fi

    case "$group" in
        "$GROUP_LONDON")
            # Update solc version and EVM version in profile.default section only
            sed -i.bak "1,/^\[/ s/solc_version = .*/solc_version = '$SOLC_LONDON'/" foundry.toml 2>/dev/null || true
            sed -i.bak "1,/^\[/ s/evm_version = .*/evm_version = '$EVM_LONDON'/" foundry.toml 2>/dev/null || true
            rm -f foundry.toml.bak
            # Build with new solc version (Foundry will detect if recompilation is needed)
            logWithTimestamp "Running forge build for London EVM group..."
            forge build || true
            ;;
        "$GROUP_ZKEVM")
            # zkEVM networks use the [profile.zksync] section with zksolc
            # No need to update the main solc_version or evm_version settings
            # No standard forge build needed for zkEVM - compilation handled by deploy scripts
            ;;
        "$GROUP_CANCUN")
            # Update solc version and EVM version in profile.default section only
            sed -i.bak "1,/^\[/ s/solc_version = .*/solc_version = '$SOLC_CANCUN'/" foundry.toml 2>/dev/null || true
            sed -i.bak "1,/^\[/ s/evm_version = .*/evm_version = '$EVM_CANCUN'/" foundry.toml 2>/dev/null || true
            rm -f foundry.toml.bak
            # Build with new solc version (Foundry will detect if recompilation is needed)
            logWithTimestamp "Running forge build for Cancun EVM group..."
            forge build || true
            ;;
        *)
            error "Unknown group: $group"
            return 1
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
    local ACTION_TYPE="${1:-}"
    local CONTRACT="${2:-}"
    local ENVIRONMENT="${3:-}"

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

    echo "Using progress tracking file: $PROGRESS_TRACKING_FILE"
}

function isActionAlreadyCompleted() {
    # Generic function to check if an action is already completed for a network
    # NOTE: For "deployment" actions, this function is NOT called during initialization.
    # Deployment completion is determined solely by the progress tracking file to allow
    # redeploying new versions of contracts even if an older version exists.
    local ACTION_TYPE="${1:-}"
    local CONTRACT="${2:-}"
    local NETWORK="${3:-}"
    local ENVIRONMENT="${4:-}"

    case "$ACTION_TYPE" in
        "verification")
            isContractAlreadyVerified "$CONTRACT" "$NETWORK" "$ENVIRONMENT"
            ;;
        "deployment")
            # For deployments, we don't check deployment files - only progress file matters
            # This allows redeploying new versions even if an old version exists
            return 1  # Always treat as not completed - progress file is the source of truth
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
    local contract="${1:-}"
    local environment="${2:-}"
    # Properly capture remaining arguments as an array
    shift 2
    local -a networks=("$@")

    if [[ -z "$contract" || -z "$environment" || ${#networks[@]} -eq 0 ]]; then
        error "Contract, environment, and networks are required"
        return 1
    fi

    # Detect action type and set appropriate tracking file
    local action_type=$(detectActionType)
    setProgressTrackingFile "$action_type" "$contract" "$environment"

    logWithTimestamp "Detected action type: $action_type"

    # Check if progress file already exists
    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        # Load existing progress and merge with new networks
        local existing_data=$(cat "$PROGRESS_TRACKING_FILE")
        local existing_contract=$(echo "$existing_data" | jq -r '.contract')
        local existing_environment=$(echo "$existing_data" | jq -r '.environment')
        local existing_action=$(echo "$existing_data" | jq -r '.actionType // "unknown"')

        # Only merge if it's the same contract, environment, and action type
        if [[ "$existing_contract" == "$contract" && "$existing_environment" == "$environment" && "$existing_action" == "$action_type" ]]; then
            logWithTimestamp "Resuming existing progress tracking for $action_type action on $contract in $environment"

            # Add any new networks that aren't already tracked
            local updated_data="$existing_data"
            for network in "${networks[@]}"; do
                # Skip invalid network names (contain spaces or empty)
                if [[ -z "$network" || "$network" == *" "* ]]; then
                    continue
                fi

                local network_exists=$(echo "$existing_data" | jq -r --arg network "$network" '.networks[$network] // empty' 2>/dev/null || echo "")
                if [[ -z "$network_exists" || "$network_exists" == "null" ]]; then
                    logWithTimestamp "Adding new network to tracking: $network"
                    updated_data=$(echo "$updated_data" | jq --arg network "$network" --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.networks[$network] = {status: "pending", attempts: 0, lastAttempt: $timestamp, error: null} | .lastUpdate = $timestamp' 2>/dev/null || echo "$existing_data")
                fi
            done

            # Clean up any invalid network entries (those with spaces in the name)
            updated_data=$(echo "$updated_data" | jq 'del(.networks | to_entries[] | select(.key | contains(" ")) | .key)' 2>/dev/null || echo "$updated_data")

            # Count how many invalid entries were removed
            local invalid_count=$(echo "$existing_data" | jq '[.networks | to_entries[] | select(.key | contains(" "))] | length' 2>/dev/null || echo "0")
            if [[ "$invalid_count" -gt 0 ]]; then
                logWithTimestamp "Cleaned up $invalid_count invalid network entry/entries from progress tracking file"
            fi

            # Validate JSON before writing
            if ! echo "$updated_data" | jq empty 2>/dev/null; then
                error "Generated invalid JSON for progress tracking merge"
                return 1
            fi

            if ! echo "$updated_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
                error "Failed to write progress tracking data"
                return 1
            fi

            # Validate temp file JSON before moving - ensure file exists first
            if [[ ! -f "${PROGRESS_TRACKING_FILE}.tmp" ]] || [[ ! -s "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
                error "Temp file was not created or is empty"
                rm -f "${PROGRESS_TRACKING_FILE}.tmp"
                return 1
            fi

            # Re-check file existence right before validation to handle race conditions
            if [[ ! -f "${PROGRESS_TRACKING_FILE}.tmp" ]] || [[ ! -r "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
                error "Temp file was removed before validation (race condition)"
                rm -f "${PROGRESS_TRACKING_FILE}.tmp"
                return 1
            fi

            local jq_error_output
            jq_error_output=$(jq empty "${PROGRESS_TRACKING_FILE}.tmp" 2>&1)
            local jq_exit_code=$?
            if [[ $jq_exit_code -ne 0 ]]; then
                # Check if the error is due to file not existing (race condition)
                if [[ "$jq_error_output" == *"No such file or directory"* ]] || [[ "$jq_error_output" == *"Could not open file"* ]]; then
                    error "Temp file was removed before validation (race condition)"
                    rm -f "${PROGRESS_TRACKING_FILE}.tmp"
                    return 1
                fi
                error "Temp file contains invalid JSON"
                error "JSON validation error: ${jq_error_output:-Unknown error}"
                rm -f "${PROGRESS_TRACKING_FILE}.tmp"
                return 1
            fi

            # Only move if temp file exists and is valid
            if [[ -f "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
                mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE" 2>/dev/null || {
                    error "Failed to move progress tracking temp file"
                    rm -f "${PROGRESS_TRACKING_FILE}.tmp"
                    return 1
                }

                # Final validation after move
                if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
                    error "Final file contains invalid JSON after move"
                    return 1
                fi
            fi
            return 0
        else
            logWithTimestamp "Different contract/environment/action detected. Creating new progress tracking."
        fi
    fi

    # Create initial progress structure, checking for existing completion status
    local networks_json="{}"
    local total_networks=${#networks[@]}
    local checked_count=0

    for network in "${networks[@]}"; do
        # Skip if network name contains spaces (likely a concatenated string)
        if [[ "$network" == *" "* ]]; then
            error "Skipping invalid network name (contains spaces): '$network'"
            continue
        fi

        # Skip empty network names
        if [[ -z "$network" ]]; then
            continue
        fi

        local network_status="pending"
        local attempts=0
        local lastAttempt=null
        local error=null

        # For deployment actions, we only rely on the progress file to determine completion
        # This allows redeploying new versions of contracts even if an older version exists
        # For other action types (like verification), we can still check if already completed
        if [[ "$action_type" != "deployment" ]]; then
            checked_count=$((checked_count + 1))
            if [[ $total_networks -gt 10 ]] && [[ $((checked_count % 10)) -eq 0 ]]; then
                logWithTimestamp "Checking completion status: $checked_count/$total_networks networks..."
            fi

            # Only check if already completed for non-deployment actions
            if isActionAlreadyCompleted "$action_type" "$contract" "$network" "$environment" 2>/dev/null; then
                network_status="success"
                attempts=1
                lastAttempt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
                # Don't log every network individually during initialization to reduce noise
            fi
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
        --arg environment "$environment" \
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

    # Validate JSON before writing
    if ! echo "$progress_data" | jq empty 2>/dev/null; then
        error "Generated invalid JSON for progress tracking"
        return 1
    fi

    if ! echo "$progress_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
        error "Failed to write initial progress tracking data"
        return 1
    fi

    # Validate temp file JSON before moving
    if ! jq empty "${PROGRESS_TRACKING_FILE}.tmp" 2>/dev/null; then
        error "Temp file contains invalid JSON"
        rm -f "${PROGRESS_TRACKING_FILE}.tmp"
        return 1
    fi

    # Only move if temp file exists and is valid
    if [[ -f "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
        mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE" 2>/dev/null || {
            error "Failed to move progress tracking temp file"
            rm -f "${PROGRESS_TRACKING_FILE}.tmp"
            return 1
        }

        # Final validation after move
        if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
            error "Final file contains invalid JSON after move"
            return 1
        fi
    fi

    logWithTimestamp "Initialized progress tracking for $action_type action on $contract in $environment"
}

function updateNetworkProgress() {
    local network="${1:-}"
    local status="${2:-}"
    local error_message="${3:-}"

    if [[ -z "$network" || -z "$status" ]]; then
        error "Network and status are required"
        return 1
    fi

    # Skip invalid network names (contain spaces)
    if [[ "$network" == *" "* ]]; then
        return 0
    fi

    # Create progress file if it doesn't exist
    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        # Try to initialize it - if we can't determine contract/environment, create minimal structure
        local contract="${CONTRACT:-unknown}"
        local environment="${ENVIRONMENT:-unknown}"
        local action_type=$(detectActionType 2>/dev/null || echo "generic")

        local initial_data=$(jq -n \
            --arg contract "$contract" \
            --arg environment "$environment" \
            --arg actionType "$action_type" \
            --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{
                contract: $contract,
                environment: $environment,
                actionType: $actionType,
                startTime: $timestamp,
                lastUpdate: $timestamp,
                networks: {}
            }')

        # Validate JSON before writing
        if ! echo "$initial_data" | jq empty 2>/dev/null; then
            error "Generated invalid JSON for initial progress tracking"
            return 1
        fi

        if ! echo "$initial_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
            error "Failed to create progress tracking file"
            return 1
        fi

        # Validate temp file JSON before moving - ensure file exists first
        if [[ ! -f "${PROGRESS_TRACKING_FILE}.tmp" ]] || [[ ! -s "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
            error "Temp file was not created or is empty"
            rm -f "${PROGRESS_TRACKING_FILE}.tmp"
            return 1
        fi

        # Re-check file existence right before validation to handle race conditions
        if [[ ! -f "${PROGRESS_TRACKING_FILE}.tmp" ]] || [[ ! -r "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
            error "Temp file was removed before validation (race condition)"
            rm -f "${PROGRESS_TRACKING_FILE}.tmp"
            return 1
        fi

        local jq_error_output
        jq_error_output=$(jq empty "${PROGRESS_TRACKING_FILE}.tmp" 2>&1)
        local jq_exit_code=$?
        if [[ $jq_exit_code -ne 0 ]]; then
            # Check if the error is due to file not existing (race condition)
            if [[ "$jq_error_output" == *"No such file or directory"* ]] || [[ "$jq_error_output" == *"Could not open file"* ]]; then
                error "Temp file was removed before validation (race condition)"
                rm -f "${PROGRESS_TRACKING_FILE}.tmp"
                return 1
            fi
            error "Temp file contains invalid JSON"
            error "JSON validation error: ${jq_error_output:-Unknown error}"
            rm -f "${PROGRESS_TRACKING_FILE}.tmp"
            return 1
        fi

        mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE" 2>/dev/null || true

        # Final validation after move
        if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
            if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
                error "Final file contains invalid JSON after move"
                return 1
            fi
        fi
    fi

    # Use file-based locking with flock if available, otherwise use directory-based locking
    # flock is the most reliable method for file locking on Unix systems
    local lock_file="${PROGRESS_TRACKING_FILE}.lock"
    local lock_timeout=120  # 2 minutes for parallel execution
    local lock_attempts=0
    local max_lock_attempts=240  # 240 attempts * 0.5s = 120 seconds
    local lock_fd=200  # File descriptor for flock
    local lock_acquired=false

    # Try to use flock if available (most reliable)
    if command -v flock >/dev/null 2>&1; then
        # Wait for lock to be available using flock
        while [[ $lock_attempts -lt $max_lock_attempts ]]; do
            # Try to acquire lock with flock (non-blocking)
            if (eval "exec $lock_fd>$lock_file" && flock -n $lock_fd 2>/dev/null); then
                lock_acquired=true
                break
            fi
            # Check if lock file is stale (older than 5 minutes)
            if [[ -f "$lock_file" ]]; then
                local lock_age=$(($(date +%s) - $(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null || echo 0)))
                if [[ $lock_age -gt 300 ]]; then
                    # Lock is stale, remove it
                    rm -f "$lock_file" 2>/dev/null || true
                fi
            fi
            sleep 0.5
            lock_attempts=$((lock_attempts + 1))
        done

        if [[ "$lock_acquired" == "true" ]]; then
            # Store lock info for cleanup
            local lock_type="flock"
        fi
    else
        # Fallback to directory-based locking if flock not available
        local lock_dir="${lock_file}.dir"
        while [[ -d "$lock_dir" && $lock_attempts -lt $max_lock_attempts ]]; do
            # Check if lock directory is stale
            if [[ -d "$lock_dir" ]]; then
                local lock_age=$(($(date +%s) - $(stat -f %m "$lock_dir" 2>/dev/null || stat -c %Y "$lock_dir" 2>/dev/null || echo 0)))
                if [[ $lock_age -gt 300 ]]; then
                    rm -rf "$lock_dir" 2>/dev/null || true
                    sleep 0.1
                    continue
                fi
            fi
            sleep 0.5
            lock_attempts=$((lock_attempts + 1))
        done

        # Try to create lock directory
        for i in {1..10}; do
            if mkdir "$lock_dir" 2>/dev/null; then
                if [[ -d "$lock_dir" ]]; then
                    echo "$$" > "${lock_dir}/pid" 2>/dev/null
                    if [[ -f "${lock_dir}/pid" ]]; then
                        lock_acquired=true
                        break
                    else
                        rm -rf "$lock_dir" 2>/dev/null || true
                    fi
                fi
            fi
            sleep 0.1
        done

        if [[ "$lock_acquired" == "true" ]]; then
            local lock_type="directory"
        fi
    fi

    # Helper function to release lock
    # Use default values to handle unbound variables with set -u
    releaseLock() {
        local acquired="${lock_acquired:-false}"
        local ltype="${lock_type:-}"
        local lfd="${lock_fd:-}"
        local ldir="${lock_dir:-}"
        local lfile="${lock_file:-}"

        if [[ "$acquired" == "true" ]]; then
            if [[ "$ltype" == "flock" ]] && command -v flock >/dev/null 2>&1 && [[ -n "$lfd" ]]; then
                flock -u $lfd 2>/dev/null || true
                eval "exec $lfd>&-" 2>/dev/null || true
            elif [[ "$ltype" == "directory" ]] && [[ -n "$ldir" ]]; then
                rm -rf "$ldir" 2>/dev/null || true
            fi
            rm -f "$lfile" 2>/dev/null || true
        fi
    }

    # Set up trap to release lock on exit
    # Capture lock state in trap command to avoid unbound variable errors
    local trap_lock_acquired="${lock_acquired:-false}"
    local trap_lock_type="${lock_type:-}"
    local trap_lock_fd="${lock_fd:-}"
    local trap_lock_dir="${lock_dir:-}"
    local trap_lock_file="${lock_file:-}"

    if [[ "$trap_lock_acquired" == "true" ]]; then
        # Create a trap that uses captured variables
        if [[ "$trap_lock_type" == "flock" ]] && command -v flock >/dev/null 2>&1 && [[ -n "$trap_lock_fd" ]]; then
            trap "flock -u $trap_lock_fd 2>/dev/null || true; eval 'exec $trap_lock_fd>&-' 2>/dev/null || true; rm -f '$trap_lock_file' 2>/dev/null || true" RETURN
        elif [[ "$trap_lock_type" == "directory" ]] && [[ -n "$trap_lock_dir" ]]; then
            trap "rm -rf '$trap_lock_dir' 2>/dev/null || true; rm -f '$trap_lock_file' 2>/dev/null || true" RETURN
        else
            trap "rm -f '$trap_lock_file' 2>/dev/null || true" RETURN
        fi
    fi

    # If we couldn't acquire lock, continue anyway (better than hanging)
    # The update will still work, just with potential race conditions

    # Re-read file in case it was updated by another process
    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        releaseLock
        return 1
    fi

    # Validate input JSON file is valid before processing
    if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
        # File is corrupted - try to repair or recreate
        releaseLock
        error "[$network] Progress tracking file contains invalid JSON, attempting to repair..."

        # Try to extract valid parts and recreate file
        local contract=$(jq -r '.contract // "unknown"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "unknown")
        local environment=$(jq -r '.environment // "unknown"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "unknown")
        local action_type=$(jq -r '.actionType // "generic"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "generic")

        # Create fresh file with just this network
        local repaired_data=$(jq -n \
            --arg contract "$contract" \
            --arg environment "$environment" \
            --arg actionType "$action_type" \
            --arg network "$network" \
            --arg status "$status" \
            --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --arg error "$(if [[ -n "$error_message" ]]; then echo "$error_message"; else echo ""; fi)" \
            '{
                contract: $contract,
                environment: $environment,
                actionType: $actionType,
                startTime: $timestamp,
                lastUpdate: $timestamp,
                networks: {
                    ($network): {
                        status: $status,
                        attempts: 1,
                        lastAttempt: $timestamp,
                        error: (if $error == "" then null else $error end)
                    }
                }
            }')

        if ! echo "$repaired_data" > "${PROGRESS_TRACKING_FILE}.tmp" 2>/dev/null; then
            return 1
        fi

        # Validate repaired JSON before moving
        if ! jq empty "${PROGRESS_TRACKING_FILE}.tmp" 2>/dev/null; then
            rm -f "${PROGRESS_TRACKING_FILE}.tmp"
            return 1
        fi

        mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE" 2>/dev/null || return 1
        releaseLock
        return 0
    fi

    # Update progress - use --arg for error to handle quotes/backslashes safely
    # First, ensure the file is valid JSON before reading
    if ! jq empty "$PROGRESS_TRACKING_FILE" >/dev/null 2>&1; then
        releaseLock
        error "[$network] Progress tracking file is corrupted, cannot update"
        return 1
    fi

    # Capture both stdout and stderr from jq, and check exit code
    local updated_data
    local jq_stderr_file
    jq_stderr_file=$(mktemp)

    updated_data=$(jq \
        --arg network "$network" \
        --arg status "$status" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg error "$(if [[ -n "$error_message" ]]; then echo "$error_message"; else echo "null"; fi)" \
        '.networks[$network].status = $status |
         .networks[$network].lastAttempt = $timestamp |
         .networks[$network].attempts += 1 |
         .networks[$network].error = ($error | if . == "null" then null else . end) |
         .lastUpdate = $timestamp' \
        "$PROGRESS_TRACKING_FILE" 2>"$jq_stderr_file")

    local jq_exit_code=$?
    local jq_error_msg
    if [[ -f "$jq_stderr_file" ]]; then
        jq_error_msg=$(cat "$jq_stderr_file" 2>/dev/null || echo "")
        rm -f "$jq_stderr_file"
    fi

    if [[ $jq_exit_code -ne 0 ]]; then
        releaseLock
        error "[$network] Failed to generate updated JSON data (jq exit code: $jq_exit_code)"
        if [[ -n "$jq_error_msg" ]]; then
            error "[$network] jq error: $jq_error_msg"
        fi
        return 1
    fi

    if [[ -z "$updated_data" ]]; then
        releaseLock
        error "[$network] Failed to generate updated JSON data (empty output from jq)"
        if [[ -n "$jq_error_msg" ]]; then
            error "[$network] jq stderr: $jq_error_msg"
        fi
        return 1
    fi

    # Validate the updated JSON is valid before writing
    if ! echo "$updated_data" | jq empty >/dev/null 2>&1; then
        releaseLock
        error "[$network] Generated invalid JSON, skipping update"
        return 1
    fi

    # Write to temp file - don't suppress errors so we can see if write fails
    if ! echo "$updated_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
        releaseLock
        error "[$network] Failed to write temp file"
        return 1
    fi

    # Validate temp file exists and has content - check immediately after write
    if [[ ! -f "${PROGRESS_TRACKING_FILE}.tmp" ]] || [[ ! -s "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
        rm -f "${PROGRESS_TRACKING_FILE}.tmp"
        releaseLock
        error "[$network] Temp file was not created or is empty"
        return 1
    fi

    # Validate JSON - file exists at this point (checked above)
    # Re-check file existence right before validation to handle race conditions in parallel execution
    if [[ -f "${PROGRESS_TRACKING_FILE}.tmp" ]] && [[ -r "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
        local jq_error_output
        jq_error_output=$(jq empty "${PROGRESS_TRACKING_FILE}.tmp" 2>&1)
        local jq_exit_code=$?
        if [[ $jq_exit_code -ne 0 ]]; then
            # Check if the error is due to file not existing (race condition)
            if [[ "$jq_error_output" == *"No such file or directory"* ]] || [[ "$jq_error_output" == *"Could not open file"* ]]; then
                rm -f "${PROGRESS_TRACKING_FILE}.tmp"
                releaseLock
                error "[$network] Temp file was removed before validation (race condition), skipping update"
                return 1
            fi
            rm -f "${PROGRESS_TRACKING_FILE}.tmp"
            releaseLock
            error "[$network] Temp file contains invalid JSON, skipping update"
            error "[$network] JSON validation error: ${jq_error_output:-Unknown error}"
            return 1
        fi
    else
        rm -f "${PROGRESS_TRACKING_FILE}.tmp"
        releaseLock
        error "[$network] Temp file does not exist or is not readable for validation"
        return 1
    fi

    # Move temp file to final location - file exists and is valid at this point
    # Retry move operation in case of race conditions
    local move_success=false
    for move_retry in {1..10}; do
        if mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
            move_success=true
            break
        fi
        # Another process might be moving the file - wait and retry
        sleep 0.1
    done

    if [[ "$move_success" == "true" ]]; then
        # Validate the final file is valid JSON after move
        local final_jq_error
        final_jq_error=$(jq empty "$PROGRESS_TRACKING_FILE" 2>&1)
        local final_jq_exit_code=$?
        if [[ $final_jq_exit_code -ne 0 ]]; then
            releaseLock
            error "[$network] Final file contains invalid JSON after move, update failed"
            error "[$network] JSON validation error: ${final_jq_error:-Unknown error}"
            return 1
        fi

        # Verify the update actually happened by reading back the status
        # Note: Under heavy parallel load, another process might have updated the status
        # between our write and verification, so we check if status matches OR if it's been
        # updated to a "later" state (pending -> in_progress -> success/failed)
        local verify_status=$(jq -r --arg network "$network" '.networks[$network].status // "unknown"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "unknown")
        if [[ "$verify_status" == "$status" ]]; then
            # Update succeeded - remove lock and return success
            releaseLock
            return 0
        else
            # Status doesn't match - could be due to race condition with parallel updates
            # Check if the current status is a "later" state (which is acceptable)
            # Order: pending < in_progress < success/failed
            local status_acceptable=false
            if [[ "$status" == "pending" && ("$verify_status" == "in_progress" || "$verify_status" == "success" || "$verify_status" == "failed") ]]; then
                status_acceptable=true  # Status progressed forward, that's fine
            elif [[ "$status" == "in_progress" && ("$verify_status" == "success" || "$verify_status" == "failed") ]]; then
                status_acceptable=true  # Status progressed forward, that's fine
            elif [[ "$status" == "success" && "$verify_status" == "success" ]]; then
                status_acceptable=true  # Already success, that's fine
            elif [[ "$status" == "failed" && "$verify_status" == "failed" ]]; then
                status_acceptable=true  # Already failed, that's fine
            fi

            if [[ "$status_acceptable" == "true" ]]; then
                # Status is acceptable (progressed forward or already correct)
                releaseLock
                return 0
            else
                # Status mismatch - silently return failure, caller will retry
                releaseLock
                return 1
            fi
        fi
    else
        # Move failed - try to recover by checking if file was moved by another process
        # This can happen in parallel execution when multiple processes try to update simultaneously
        if [[ -f "$PROGRESS_TRACKING_FILE" ]] && jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
            # File exists and is valid - another process might have updated it
            # Check if our update is already there or if we need to retry
            local current_status=$(jq -r --arg network "$network" '.networks[$network].status // "unknown"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "unknown")
            if [[ "$current_status" == "$status" ]]; then
                # Our update is already there - another process did it, that's fine
                rm -f "${PROGRESS_TRACKING_FILE}.tmp"
                releaseLock
                return 0
            fi
            # Status doesn't match - need to retry the update
            rm -f "${PROGRESS_TRACKING_FILE}.tmp"
            releaseLock
            # Retry once after a short delay
            sleep 0.5
            if updateNetworkProgress "$network" "$status" "$error_message"; then
                return 0
            fi
        fi
        # Move failed and file doesn't exist or is invalid - return failure, caller will retry
        rm -f "${PROGRESS_TRACKING_FILE}.tmp"
        releaseLock
        return 1
    fi

    # Remove lock (should already be removed above, but just in case)
    releaseLock

    # Don't log status updates here - they're logged by the caller
    # This function only updates the progress file
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

    # Filter out invalid network names (those containing spaces)
    jq -r '.networks | to_entries[] | select(.value.status == "pending") | select(.key | contains(" ") | not) | .key' "$PROGRESS_TRACKING_FILE" 2>/dev/null || true
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

    # Filter out invalid network names (those containing spaces)
    jq -r '.networks | to_entries[] | select(.value.status == "failed") | select(.key | contains(" ") | not) | .key' "$PROGRESS_TRACKING_FILE" 2>/dev/null || true
}

function getProgressSummary() {
    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        # Silently return if file doesn't exist (expected after cleanup)
        return 0
    fi

    # Check if file is empty or invalid JSON
    if [[ ! -s "$PROGRESS_TRACKING_FILE" ]] || ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
        # Silently return if file is invalid (expected after cleanup)
        return 0
    fi

    # Filter out invalid network names (those containing spaces) when counting
    local total=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not)] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
    local pending=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "pending")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
    local success=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "success")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
    local failed=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "failed")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
    local in_progress=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "in_progress")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")

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

    if [[ $success -gt 0 ]]; then
        echo "✅ SUCCESSFUL NETWORKS:"
        jq -r '.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "success") | .key' "$PROGRESS_TRACKING_FILE" 2>/dev/null | while read -r network; do
            echo "  - $network"
        done
        echo ""
    fi

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

    if [[ $in_progress -gt 0 ]]; then
        echo "🔄 IN PROGRESS NETWORKS:"
        jq -r '.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "in_progress") | .key' "$PROGRESS_TRACKING_FILE" 2>/dev/null | while read -r network; do
            echo "  - $network"
        done
        echo ""
    fi

  # Show retry instructions if there are failed, pending, or in_progress networks
  local remaining_networks=($(getFailedNetworks) $(getPendingNetworks))
  local in_progress_networks=$(jq -r '.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "in_progress") | .key' "$PROGRESS_TRACKING_FILE" 2>/dev/null || true)
  if [[ ${#remaining_networks[@]} -gt 0 || -n "$in_progress_networks" ]]; then
    echo "🔄 TO RETRY FAILED/PENDING/IN_PROGRESS NETWORKS:"
    echo "  Simply run the same command again!"
    echo "  The system will automatically skip successful networks and retry only the failed/pending/in_progress ones."
    echo ""
  fi

  echo "=========================================="
}

function cleanupProgressTracking() {
    # Only clean up if all networks are successful
    if [[ -n "$PROGRESS_TRACKING_FILE" && -f "$PROGRESS_TRACKING_FILE" ]]; then
        # Check if file is valid JSON
        if jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
            # Filter out invalid network names (those containing spaces) when counting
            local total=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not)] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
            local success=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "success")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")

            if [[ "$total" -gt 0 && "$success" -eq "$total" ]]; then
                rm "$PROGRESS_TRACKING_FILE"
                # Success message already logged by caller, silently clean up
            else
                logWithTimestamp "Progress tracking file preserved for resumable execution (success: $success/$total): $PROGRESS_TRACKING_FILE"
            fi
        else
            logWithTimestamp "Progress tracking file contains invalid JSON, removing it: $PROGRESS_TRACKING_FILE"
            rm "$PROGRESS_TRACKING_FILE"
        fi
    else
        # Silently return if file doesn't exist (expected after cleanup)
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
        # Skip invalid network names (contain spaces)
        if [[ "$NETWORK" == *" "* ]]; then
            continue
        fi

        local STATUS=$(jq -r --arg network "$NETWORK" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
        if [[ "$STATUS" != "success" ]]; then
            PENDING_COUNT=$((PENDING_COUNT + 1))
        fi
    done

    # Group is complete if no networks are pending
    return $PENDING_COUNT
}

# =============================================================================
# PROCESS MANAGEMENT AND SIGNAL HANDLING
# =============================================================================

# Global PID tracking for all background processes
declare -a GLOBAL_BACKGROUND_PIDS=()
GLOBAL_PID_TRACKING_FILE=$(mktemp -t "multinetwork_pids.XXXXXX" 2>/dev/null || echo "/tmp/multinetwork_pids.$$")

# Function to track a background PID
trackBackgroundPid() {
    local pid="${1:-}"
    if [[ -n "$pid" && "$pid" -gt 0 ]]; then
        GLOBAL_BACKGROUND_PIDS+=("$pid")
        # Also write to file for cross-shell access
        echo "$pid" >> "$GLOBAL_PID_TRACKING_FILE" 2>/dev/null || true
    fi
}

# Function to kill all tracked background processes and their children
killAllBackgroundProcesses() {
    local force="${1:-false}"
    local signal="${2:-TERM}"

    # Collect all PIDs from both array and file
    local -a all_pids=()

    # Add PIDs from global array (check if array is set to avoid unbound variable error)
    # Use parameter expansion to safely check if array exists and has elements
    if [[ -n "${GLOBAL_BACKGROUND_PIDS[*]:-}" ]] && [[ ${#GLOBAL_BACKGROUND_PIDS[@]} -gt 0 ]]; then
        all_pids+=("${GLOBAL_BACKGROUND_PIDS[@]}")
    fi

    # Add PIDs from tracking file
    if [[ -f "$GLOBAL_PID_TRACKING_FILE" ]]; then
        while IFS= read -r pid || [[ -n "$pid" ]]; do
            if [[ -n "$pid" && "$pid" -gt 0 ]]; then
                all_pids+=("$pid")
            fi
        done < "$GLOBAL_PID_TRACKING_FILE" 2>/dev/null || true
    fi

    # Also get all child processes of current shell
    local shell_pid=$$
    local -a child_pids=()
    if command -v pgrep >/dev/null 2>&1; then
        # Get all descendant processes
        while IFS= read -r pid; do
            if [[ -n "$pid" && "$pid" -gt 0 && "$pid" != "$shell_pid" ]]; then
                child_pids+=("$pid")
            fi
        done < <(pgrep -P "$shell_pid" 2>/dev/null || true)

        # Get processes in same process group
        local pgid=$(ps -o pgid= -p "$shell_pid" 2>/dev/null | tr -d ' ' || echo "")
        if [[ -n "$pgid" ]]; then
            while IFS= read -r pid; do
                if [[ -n "$pid" && "$pid" -gt 0 && "$pid" != "$shell_pid" ]]; then
                    child_pids+=("$pid")
                fi
            done < <(pgrep -g "$pgid" 2>/dev/null | grep -v "^$shell_pid$" || true)
        fi
    fi

    # Combine all PIDs (only if child_pids array has elements)
    if [[ ${#child_pids[@]} -gt 0 ]]; then
        all_pids+=("${child_pids[@]}")
    fi

    # Remove duplicates
    local -a unique_pids=()
    if [[ ${#all_pids[@]} -gt 0 ]]; then
        for pid in "${all_pids[@]}"; do
            local is_duplicate=false
            if [[ ${#unique_pids[@]} -gt 0 ]]; then
                for existing_pid in "${unique_pids[@]}"; do
                    if [[ "$pid" == "$existing_pid" ]]; then
                        is_duplicate=true
                        break
                    fi
                done
            fi
            if [[ "$is_duplicate" == "false" ]]; then
                unique_pids+=("$pid")
            fi
        done
    fi

    # Kill all processes
    local killed_count=0
    if [[ ${#unique_pids[@]} -gt 0 ]]; then
        for pid in "${unique_pids[@]}"; do
        # Check if process still exists
        if kill -0 "$pid" 2>/dev/null; then
            # Kill the process and its children
            if [[ "$force" == "true" ]]; then
                # Kill process group (more aggressive) - use negative PID for process group
                # First try to get the process group ID
                local pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || echo "")
                if [[ -n "$pgid" && "$pgid" -gt 0 ]]; then
                    # Kill entire process group
                    kill -"$signal" -"$pgid" 2>/dev/null || kill -"$signal" "$pid" 2>/dev/null || true
                else
                    # Fallback to killing just the process
                    kill -"$signal" "$pid" 2>/dev/null || true
                fi
            else
                # Kill just the process
                kill -"$signal" "$pid" 2>/dev/null || true
            fi
            killed_count=$((killed_count + 1))
        fi
        done
    fi

    # Also kill any remaining jobs in current shell
    if [[ "$force" == "true" ]]; then
        jobs -p 2>/dev/null | while read -r job_pid; do
            if [[ -n "$job_pid" ]]; then
                # Get process group and kill it
                local job_pgid=$(ps -o pgid= -p "$job_pid" 2>/dev/null | tr -d ' ' || echo "")
                if [[ -n "$job_pgid" && "$job_pgid" -gt 0 ]]; then
                    kill -TERM -"$job_pgid" 2>/dev/null || kill -TERM "$job_pid" 2>/dev/null || true
                else
                    kill -TERM "$job_pid" 2>/dev/null || kill -KILL "$job_pid" 2>/dev/null || true
                fi
            fi
        done
    fi

    # Wait a moment for processes to die
    sleep 0.5

    # Force kill any remaining processes
    if [[ "$force" == "true" ]]; then
        for pid in "${unique_pids[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                # Try to kill process group first
                local pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || echo "")
                if [[ -n "$pgid" && "$pgid" -gt 0 ]]; then
                    kill -KILL -"$pgid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
                else
                    kill -KILL "$pid" 2>/dev/null || true
                fi
            fi
        done
    fi

    # Clean up tracking file
    rm -f "$GLOBAL_PID_TRACKING_FILE" 2>/dev/null || true

    return 0
}

# Global interrupt handler
_global_interrupt_handler() {
    echo ""
    logWithTimestamp "⚠️  INTERRUPT RECEIVED - Stopping all processes..."

    # Set flag to stop execution
    export EXIT_REQUESTED=1

    # Kill all background processes forcefully
    killAllBackgroundProcesses true TERM

    # Wait a moment
    sleep 1

    # Force kill any remaining
    killAllBackgroundProcesses true KILL

    logWithTimestamp "✅ All processes terminated"

    # Restore foundry.toml if needed
    restoreFoundryToml 2>/dev/null || true

    # Clean up progress tracking
    cleanupProgressTracking 2>/dev/null || true

    exit 130  # Standard exit code for SIGINT
}

# =============================================================================
# NETWORK EXECUTION FUNCTIONS
# =============================================================================

# Helper function for cleanup trap - must be defined before executeNetworkInGroup
_cleanup_network_status() {
    local net="${1:-}"
    if [[ -z "$net" ]]; then
        return 0
    fi

    # Check current status before overwriting - don't overwrite success/failed with failed
    # This prevents cleanup traps from running after successful completion
    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        # Verify file is valid JSON before reading
        if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
            # File is invalid JSON, don't try to update
            return 0
        fi

        local current_status=$(jq -r --arg network "$net" '.networks[$network].status // "unknown"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "unknown")
        # Only update if status is not already success or failed (could be in_progress or pending)
        if [[ "$current_status" != "success" && "$current_status" != "failed" ]]; then
            # Update status synchronously (not in background) to prevent race conditions
            updateNetworkProgress "$net" "failed" "Unexpected exit or timeout" 2>/dev/null || true
        fi
    else
        # File doesn't exist - this could mean:
        # 1. It was cleaned up because all networks succeeded (don't create new file)
        # 2. It was never created (should create it)
        # To distinguish, check if we're in a context where the file should exist
        # If CONTRACT and ENVIRONMENT are set, we should create the file
        # Otherwise, assume it was cleaned up and don't create a new one
        if [[ -n "${CONTRACT:-}" && -n "${ENVIRONMENT:-}" ]]; then
            # File should exist but doesn't - create it with this network's failure
            updateNetworkProgress "$net" "failed" "Unexpected exit or timeout" 2>/dev/null || true
        fi
        # If CONTRACT/ENVIRONMENT not set, assume file was cleaned up (all succeeded) and don't recreate
    fi
}

function executeNetworkInGroup() {
    local network="${1:-}"
    local log_dir="${2:-}"

    if [[ -z "$network" || -z "$log_dir" ]]; then
        error "Network and log_dir are required for executeNetworkInGroup"
        return 1
    fi

    # Skip if network name contains spaces (invalid concatenated string)
    if [[ "$network" == *" "* ]]; then
        error "Skipping invalid network name (contains spaces): '$network'"
        return 1
    fi

    # Update progress to in_progress - try to set it, but don't abort if it fails
    # Under heavy parallel load, this might fail, but we should still proceed
    local in_progress_set=false
    for retry in {1..10}; do
        if updateNetworkProgress "$network" "in_progress"; then
            in_progress_set=true
            break
        fi
        sleep 0.3
    done
    # Don't abort if in_progress fails - status will be corrected later
    # The cleanup trap will ensure status is updated on exit

    # Set up trap to ensure status is always updated, even on unexpected exit
    # Note: INT/TERM are handled by global handler, but we still need EXIT for cleanup
    trap "_cleanup_network_status \"$network\"" EXIT

    # Note: Removed "no actions configured" check - this was too aggressive and incorrectly
    # identified cases with actions as "no action". Instead, we always execute and let the
    # action type detection fall back to "generic" if no specific action type is detected.

    # Get RPC URL (ENVIRONMENT is read from global variable)
    local rpc_url=$(getRPCUrl "$network" "$ENVIRONMENT")
    if [[ $? -ne 0 ]]; then
        trap - EXIT  # Remove EXIT trap before updating (INT/TERM handled by global handler)
        local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
        printf '\033[31m[%s] [%s] ❌ FAILED - Failed to get RPC URL\033[0m\n' "$TIMESTAMP" "$network"
        # Retry status update
        local update_success=false
        for retry in {1..3}; do
            if updateNetworkProgress "$network" "failed" "Failed to get RPC URL"; then
                update_success=true
                printf '\033[31m[%s] [%s] ❌ Status updated to FAILED in tracking file\033[0m\n' "$TIMESTAMP" "$network"
                # Output is flushed automatically by printf
                break
            fi
            sleep 0.2
        done
        if [[ "$update_success" == "false" ]]; then
            updateNetworkProgress "$network" "failed" "Failed to get RPC URL" || true
        fi
        return 1
    fi

    # Check if RPC URL is empty (additional safety check)
    if [[ -z "$rpc_url" ]]; then
        trap - EXIT  # Remove EXIT trap before updating (INT/TERM handled by global handler)
        local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
        printf '\033[31m[%s] [%s] ❌ FAILED - Empty RPC URL\033[0m\n' "$TIMESTAMP" "$network"
        # Retry status update
        local update_success=false
        for retry in {1..3}; do
            if updateNetworkProgress "$network" "failed" "Empty RPC URL"; then
                update_success=true
                printf '\033[31m[%s] [%s] ❌ Status updated to FAILED in tracking file\033[0m\n' "$TIMESTAMP" "$network"
                # Output is flushed automatically by printf
                break
            fi
            sleep 0.2
        done
        if [[ "$update_success" == "false" ]]; then
            updateNetworkProgress "$network" "failed" "Empty RPC URL" || true
        fi
        return 1
    fi

    # Export RPC_URL for downstream commands
    export RPC_URL="$rpc_url"

    # Retry logic setup
    local retry_count=0
    local command_status=1
    local max_attempts=3
    local last_error=""

        # Attempt operations with retries
        while [[ $command_status -ne 0 && $retry_count -lt $max_attempts ]]; do
        local attempt_num=$((retry_count + 1))
        printf '\033[36m[%s] [%s] ===== Attempt %d/%d: Starting execution =====\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$network" "$attempt_num" "$max_attempts"

        # Check if we should exit (in case of interrupt)
        if [[ -n "${EXIT_REQUESTED:-}" ]]; then
            local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
            printf '\033[33m[%s] [%s] Exit requested, stopping operations\033[0m\n' "$TIMESTAMP" "$network"
            trap - EXIT  # Remove EXIT trap before updating (INT/TERM handled by global handler)
            updateNetworkProgress "$network" "failed" "Execution interrupted" || true
            printf '\033[31m[%s] [%s] ❌ Status updated to FAILED in tracking file\033[0m\n' "$TIMESTAMP" "$network"
            return 1
        fi

        # Execute the actual network operations
        # This calls the executeNetworkActions function which contains the configured actions
        # CONTRACT is determined and exported in executeNetworkActions
        local start_time=$(date +%s)
        # Use tee to capture output to log file AND show it in real-time
        # Note: PIPESTATUS must be captured immediately after the pipe command
        # Remove /dev/null redirect so users can see progress in real-time
        executeNetworkActions "$network" "$log_dir" 2>&1 | tee "$log_dir/${network}_attempt_${attempt_num}.log"
        command_status=${PIPESTATUS[0]:-1}
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))

        # Check log file for success indicators (even if exit code is non-zero)
        local log_file="$log_dir/${network}_attempt_${attempt_num}.log"
        local is_success=false
        if [[ -f "$log_file" ]]; then
            # Check for success indicators: "already verified", "Successfully verified", "successfully verified"
            if grep -qiE "(already verified|Successfully verified|successfully verified)" "$log_file" 2>/dev/null; then
                # If we see success messages, treat as success even if exit code is non-zero
                # (exit code might be from log update failure, but verification succeeded)
                if ! grep -qiE "(unbound variable|error.*failed|Failed to)" "$log_file" 2>/dev/null; then
                    is_success=true
                    command_status=0
                fi
            fi
        fi

        if [[ $command_status -ne 0 ]]; then
            printf '\033[31m[%s] [%s] Attempt %d/%d: Failed with exit code %d (duration: %ds)\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$network" "$attempt_num" "$max_attempts" "$command_status" "$duration"

            # Show error output from log file
            if [[ -f "$log_file" ]]; then
                # Show last 10 lines of error output (filter out noise, show actual errors)
                local error_lines=$(tail -20 "$log_file" 2>/dev/null | grep -iE "(error|failed|revert|invalid|missing|timeout|exception|unbound variable)" | tail -10)
                if [[ -n "$error_lines" ]]; then
                    printf '[%s] [%s] Error details:\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$network"
                    echo "$error_lines" | while IFS= read -r line; do
                        printf '[%s] [%s]   %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$network" "$line"
                    done
                else
                    # If no error keywords found, show last 5 lines of output (without colors for info)
                    local last_lines=$(tail -5 "$log_file" 2>/dev/null)
                    if [[ -n "$last_lines" ]]; then
                        printf '[%s] [%s] Last output:\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$network"
                        echo "$last_lines" | while IFS= read -r line; do
                            printf '[%s] [%s]   %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$network" "$line"
                        done
                    fi
                fi
            fi
        elif [[ "$is_success" == "true" ]]; then
            # Log success even if original exit code was non-zero
            local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
            printf '\033[0;32m[%s] [%s] ✅ SUCCESS - Operation completed successfully\033[0m\n' "$TIMESTAMP" "$network"
        fi

        # Extract meaningful error message from log file if execution failed (and not a success case)
        if [[ $command_status -ne 0 && "$is_success" != "true" ]]; then
            # Priority order for error extraction (most specific first):
            # 1. Flattening errors
            # 2. API verification errors
            # 3. General verification errors
            # 4. Generic execution errors

            local log_file=""
            if [[ -f "$log_dir/${network}_attempt_${attempt_num}.log" ]]; then
                log_file="$log_dir/${network}_attempt_${attempt_num}.log"
            elif [[ -f "$log_dir/${network}.log" ]]; then
                log_file="$log_dir/${network}.log"
            fi

            if [[ -n "$log_file" && -f "$log_file" ]]; then
                # Try to extract the most specific error first
                # Look for flattening errors
                local flatten_error=$(grep -iE "\[$network\].*(flatten|pragma|solidity|compilation)" "$log_file" 2>/dev/null | grep -iE "(error|failed|invalid|malformed)" | tail -1 | sed 's/^[[:space:]]*//' | cut -c1-300)
                if [[ -n "$flatten_error" ]]; then
                    last_error="$flatten_error"
                fi

                # Look for API verification errors
                if [[ -z "$last_error" ]]; then
                    local api_error=$(grep -iE "\[$network\].*(etherscan.*api|verification.*failed|api.*error|NOTOK|timeout)" "$log_file" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//' | cut -c1-300)
                    if [[ -n "$api_error" ]]; then
                        last_error="$api_error"
                    fi
                fi

                # Look for general verification errors
                if [[ -z "$last_error" ]]; then
                    local verify_error=$(grep -iE "\[$network\].*(verify|verification)" "$log_file" 2>/dev/null | grep -iE "(error|failed)" | tail -1 | sed 's/^[[:space:]]*//' | cut -c1-300)
                    if [[ -n "$verify_error" ]]; then
                        last_error="$verify_error"
                    fi
                fi

                # Look for any error message with network prefix
                if [[ -z "$last_error" ]]; then
                    local any_error=$(grep -iE "\[$network\].*(error|failed)" "$log_file" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*//' | cut -c1-300)
                    if [[ -n "$any_error" ]]; then
                        last_error="$any_error"
                    fi
                fi

                # If still no error found, look for error messages without network prefix (from helper functions)
                if [[ -z "$last_error" ]]; then
                    local generic_error=$(grep -iE "(error|failed|revert|invalid|missing|timeout)" "$log_file" 2>/dev/null | grep -v "^\[" | tail -1 | sed 's/^[[:space:]]*//' | cut -c1-300)
                    if [[ -n "$generic_error" ]]; then
                        last_error="$generic_error"
                    fi
                fi
            fi

            # If no log error found, use generic message
            if [[ -z "$last_error" ]]; then
                last_error="Execution failed with exit code $command_status"
            fi

            # Display the extracted error message (without color for info messages)
            if [[ -n "$last_error" ]]; then
                printf '[%s] [%s] Error: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$network" "$last_error"
            fi
        fi

        # Increase retry counter (must happen regardless of success/failure to prevent infinite loop)
        retry_count=$((retry_count + 1))

        # If command succeeded, exit the loop immediately
        if [[ $command_status -eq 0 ]]; then
            break
        fi

        # Get CONTRACT from executeNetworkActions (it's exported) - only check if command failed
        # If command succeeded, CONTRACT check is not critical
        if [[ $command_status -ne 0 ]]; then
            local contract="${CONTRACT:-}"
            if [[ -z "$contract" ]]; then
                printf '\033[33m[%s] [%s] ⚠️  Warning: CONTRACT was not determined in executeNetworkActions\033[0m\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$network"
                # Don't fail here - just log a warning, the error handling below will handle it
            fi
        fi

        # If we've reached max attempts, exit the loop
        if [[ $retry_count -ge $max_attempts ]]; then
            break
        fi

        # Sleep for 2 seconds before trying again
        sleep 2
    done

    # Remove EXIT trap before final status update (to avoid double update)
    # INT/TERM are handled by global handler, so we only remove EXIT
    trap - EXIT

    # Check final status and update progress
    # CRITICAL: Ensure status update succeeds - retry if necessary
    if [[ $command_status -eq 0 ]]; then
        # Success message already logged above, now update progress
        # Retry updateNetworkProgress up to 5 times to ensure it succeeds
        local update_success=false
        for retry in {1..5}; do
            if updateNetworkProgress "$network" "success"; then
                update_success=true
                local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                printf '\033[0;32m[%s] [%s] ✅ Status updated to SUCCESS in tracking file\033[0m\n' "$TIMESTAMP" "$network"
                # Output is flushed automatically by printf
                break
            fi
            sleep 0.5
        done
        if [[ "$update_success" == "false" ]]; then
            # Try one more time - if it still fails, log warning
            if updateNetworkProgress "$network" "success"; then
                local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                printf '\033[0;32m[%s] [%s] ✅ Status updated to SUCCESS in tracking file\033[0m\n' "$TIMESTAMP" "$network"
            else
                local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                printf '\033[33m[%s] [%s] ⚠️  Warning: Failed to update status to success, but execution succeeded\033[0m\n' "$TIMESTAMP" "$network"
            fi
        fi
        return 0
    else
        # Use captured error message if available, otherwise generic message
        local final_error="Failed after $max_attempts attempts"
        if [[ -n "$last_error" ]]; then
            final_error="Failed after $max_attempts attempts: $last_error"
        fi
        local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
        printf '\033[31m[%s] [%s] ❌ FAILED - %s\033[0m\n' "$TIMESTAMP" "$network" "$final_error"
        # CRITICAL: Ensure status update succeeds - retry if necessary
        local update_success=false
        for retry in {1..5}; do
            if updateNetworkProgress "$network" "failed" "$final_error"; then
                update_success=true
                printf '\033[31m[%s] [%s] ❌ Status updated to FAILED in tracking file\033[0m\n' "$TIMESTAMP" "$network"
                # Output is flushed automatically by printf
                break
            fi
            sleep 0.5
        done
        if [[ "$update_success" == "false" ]]; then
            # Try one more time - if it still fails, log warning
            if updateNetworkProgress "$network" "failed" "$final_error"; then
                printf '\033[31m[%s] [%s] ❌ Status updated to FAILED in tracking file\033[0m\n' "$TIMESTAMP" "$network"
            else
                printf '\033[33m[%s] [%s] ⚠️  Warning: Failed to update status to failed in tracking file\033[0m\n' "$TIMESTAMP" "$network"
            fi
        fi
        return 1
    fi
}

function executeGroupSequentially() {
    local group="${1:-}"
    # Properly capture remaining arguments as an array
    shift
    local -a networks=("$@")

    if [[ -z "$group" || ${#networks[@]} -eq 0 ]]; then
        error "Group and networks are required"
        return 1
    fi

    # Group info is already shown in execution plan, skipping duplicate logGroupInfo call

    # Update foundry.toml for this group
    if ! updateFoundryTomlForGroup "$group"; then
        error "Failed to update foundry.toml for group $group"
        return 1
    fi

    # Note: Compilation is handled automatically by deploySingleContract when needed
    # No need to pre-compile here as forge will compile automatically

    # Create log directory for this group
    local log_dir=$(mktemp -d)

    # Set up signal handler to kill all background processes on interrupt
    # Use the global interrupt handler which properly kills all processes
    trap '_global_interrupt_handler; rm -rf "$log_dir"; exit 130' INT TERM

    # Determine execution mode for this group
    local should_run_parallel="$RUN_PARALLEL"
    if [[ "$group" == "$GROUP_ZKEVM" && "$ZKEVM_ALWAYS_SEQUENTIAL" == "true" ]]; then
        should_run_parallel=false
        logWithTimestamp "zkEVM group: forcing sequential execution"
    fi

    # Initialize pids array at function scope to avoid unbound variable errors
    local -a pids=()

    if [[ "$should_run_parallel" == "true" ]]; then
        # Execute networks in parallel within the group
        logWithTimestamp "Executing networks in parallel"
        local networks_to_execute=0
        for network in "${networks[@]}"; do
            # Skip invalid network names (contain spaces)
            if [[ "$network" == *" "* ]]; then
                continue
            fi

            # Check if this network is already successful
            if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
                local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
                if [[ "$status" == "success" ]]; then
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[0;32m[%s] [%s] ✅ Skipping - already successful\033[0m\n' "$TIMESTAMP" "$network"
                    continue
                elif [[ "$status" == "failed" ]]; then
                    # Reset failed networks to pending so they can retry
                    local error_msg=$(jq -r --arg network "$network" '.networks[$network].error // "Unknown error"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "Unknown error")
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[33m[%s] [%s] 🔄 Resetting failed status to pending for retry (previous error: %s)\033[0m\n' "$TIMESTAMP" "$network" "$error_msg"
                    # Retry status update to ensure it succeeds
                    for retry in {1..3}; do
                        updateNetworkProgress "$network" "pending" && break
                        sleep 0.2
                    done
                elif [[ "$status" == "pending" ]]; then
                    # Network is already pending - this is fine, proceed with execution
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[36m[%s] [%s] ℹ️  Network is pending, starting execution\033[0m\n' "$TIMESTAMP" "$network"
                fi
            fi

            # Start network execution in background
            # Each process runs independently and updates progress file atomically
            # Note: executeNetworkInGroup has its own timeout protection via EXIT trap
            # Use process groups for better signal handling
            # Start network execution in background
            # Each process runs independently and updates progress file atomically
            (set -m; executeNetworkInGroup "$network" "$log_dir") &
            local pid=$!
            # Track the PID globally for proper cleanup
            trackBackgroundPid "$pid"
            pids+=($pid)
            networks_to_execute=$((networks_to_execute + 1))

        done

        if [[ $networks_to_execute -gt 0 ]]; then
            logWithTimestamp "Started $networks_to_execute network(s) in parallel"
        fi
    else
        # Execute networks sequentially within the group
        logWithTimestamp "Executing networks sequentially"
        for network in "${networks[@]}"; do
            # Skip invalid network names (contain spaces)
            if [[ "$network" == *" "* ]]; then
                continue
            fi

            # Check if this network is already successful
            if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
                local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
                if [[ "$status" == "success" ]]; then
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[0;32m[%s] [%s] ✅ Skipping - already successful\033[0m\n' "$TIMESTAMP" "$network"
                    continue
                elif [[ "$status" == "failed" ]]; then
                    # Reset failed networks to pending so they can retry
                    local error_msg=$(jq -r --arg network "$network" '.networks[$network].error // "Unknown error"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "Unknown error")
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[33m[%s] [%s] 🔄 Resetting failed status to pending for retry (previous error: %s)\033[0m\n' "$TIMESTAMP" "$network" "$error_msg"
                    # Retry status update to ensure it succeeds
                    for retry in {1..3}; do
                        updateNetworkProgress "$network" "pending" && break
                        sleep 0.2
                    done
                elif [[ "$status" == "pending" ]]; then
                    # Network is already pending - this is fine, proceed with execution
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[36m[%s] [%s] ℹ️  Network is pending, starting execution\033[0m\n' "$TIMESTAMP" "$network"
                fi
            fi

            # Execute network in foreground
            executeNetworkInGroup "$network" "$log_dir"
        done
    fi

    # Wait for all background jobs to complete (only for parallel execution)
    local current_execution_failures=0
    if [[ "$should_run_parallel" == "true" ]]; then
        # Check for interrupt before waiting
        if [[ -n "${EXIT_REQUESTED:-}" ]]; then
            logWithTimestamp "Exit requested, skipping wait for background jobs"
        elif [[ ${#pids[@]} -gt 0 ]]; then
            for pid in "${pids[@]}"; do
                # Check if process still exists before waiting
                if kill -0 "$pid" 2>/dev/null; then
                    if ! wait "$pid" 2>/dev/null; then
                        current_execution_failures=$((current_execution_failures + 1))
                    fi
                fi
            done
        fi

        # Wait for file operations to complete (race condition fix)
        # Give file locks time to be released and writes to complete
        local lock_dir="${PROGRESS_TRACKING_FILE}.lock"
        local wait_attempts=0
        local max_wait_attempts=40  # 20 seconds max wait

        while [[ -d "$lock_dir" && $wait_attempts -lt $max_wait_attempts ]]; do
            sleep 0.5
            wait_attempts=$((wait_attempts + 1))
        done

        # Additional delay to ensure all file operations complete
        sleep 2

        # Wait for any networks still marked as "in_progress" to complete
        # This handles race conditions where processes finish but haven't updated status yet
        local in_progress_count=0
        local max_in_progress_wait=120  # Wait up to 60 seconds for in_progress networks
        local in_progress_wait_attempts=0
        local last_in_progress_count=999

        while [[ $in_progress_wait_attempts -lt $max_in_progress_wait ]]; do
            in_progress_count=0
            if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
                for network in "${networks[@]}"; do
                    # Skip invalid network names (contain spaces)
                    if [[ "$network" == *" "* ]]; then
                        continue
                    fi
                    local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
                    if [[ "$status" == "in_progress" ]]; then
                        in_progress_count=$((in_progress_count + 1))
                    fi
                done
            fi

            # If no networks are in_progress, we're done waiting
            if [[ $in_progress_count -eq 0 ]]; then
                break
            fi

            # Log progress every 5 seconds, or if count changes
            if [[ $in_progress_count -ne $last_in_progress_count ]] || [[ $((in_progress_wait_attempts % 10)) -eq 0 && $in_progress_wait_attempts -gt 0 ]]; then
                logWithTimestamp "Waiting for $in_progress_count network(s) still in progress..."
                last_in_progress_count=$in_progress_count
            fi

            sleep 0.5
            in_progress_wait_attempts=$((in_progress_wait_attempts + 1))
        done

        # Final wait to ensure all cleanup traps and background processes have finished
        # This prevents cleanup traps from overwriting status after we read it
        sleep 3

        # If we still have in_progress networks after waiting, log a warning
        if [[ $in_progress_count -gt 0 ]]; then
            logWithTimestamp "Warning: $in_progress_count network(s) still marked as in_progress after waiting. They may need manual retry."
        fi
    fi

    # Count total failed networks (including those from previous runs)
    local total_failed_count=0
    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        for network in "${networks[@]}"; do
            # Skip invalid network names (contain spaces)
            if [[ "$network" == *" "* ]]; then
                continue
            fi

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
    local contract="${1:-}"
    local environment="${2:-}"
    # Properly capture remaining arguments as an array
    shift 2
    local -a networks=("$@")

    if [[ -z "$contract" || -z "$environment" || ${#networks[@]} -eq 0 ]]; then
        error "Usage: executeNetworksByGroup CONTRACT ENVIRONMENT NETWORK1 NETWORK2 ..."
        error "Example: executeNetworksByGroup GlacisFacet production mainnet arbitrum base"
        return 1
    fi

    # Determine CONTRACT from executeNetworkActions (using first network)
    local first_network="${networks[0]}"
    local temp_contract_file=$(mktemp)
    local temp_log_dir=$(mktemp -d)

    # Call executeNetworkActions with CONTRACT_FILE set so it writes CONTRACT to file
    CONTRACT_FILE="$temp_contract_file" executeNetworkActions "$first_network" "$temp_log_dir" > /dev/null 2>&1
    local detected_contract=$(cat "$temp_contract_file" 2>/dev/null || echo "")
    rm -rf "$temp_log_dir" "$temp_contract_file"

    if [[ -z "$detected_contract" ]]; then
        error "CONTRACT could not be determined. Please ensure executeNetworkActions sets CONTRACT."
        return 1
    fi

    # Use detected contract if provided contract is empty, otherwise use provided
    if [[ -z "$contract" ]]; then
        contract="$detected_contract"
    fi

    # Get all networks (including blacklisted) for display purposes
    local -a all_networks=($(getConfiguredNetworksWithoutBlacklist "$contract" "$environment"))

    # Group all networks (including blacklisted) for display in execution plan
    local all_groups_data=$(groupNetworksByExecutionGroup "${all_networks[@]}")
    if [[ $? -ne 0 ]]; then
        error "Failed to group all networks for display"
        return 1
    fi

    # Initialize progress tracking with filtered networks (excluding blacklisted)
    initializeProgressTracking "$contract" "$environment" "${networks[@]}"

    # Group filtered networks by execution requirements (for actual execution)
    local groups_data=$(groupNetworksByExecutionGroup "${networks[@]}")
    if [[ $? -ne 0 ]]; then
        error "Failed to group networks"
        return 1
    fi

    # Extract group arrays - use mapfile to properly handle arrays
    local -a london_networks=()
    local -a zkevm_networks=()
    local -a cancun_networks=()
    local -a invalid_networks=()

    # Use readarray/mapfile to properly capture arrays from jq output
    while IFS= read -r line; do
        [[ -n "$line" ]] && london_networks+=("$line")
    done < <(echo "$groups_data" | jq -r '.london[]? // empty' 2>/dev/null | grep -v '^$')

    while IFS= read -r line; do
        [[ -n "$line" ]] && zkevm_networks+=("$line")
    done < <(echo "$groups_data" | jq -r '.zkevm[]? // empty' 2>/dev/null | grep -v '^$')

    while IFS= read -r line; do
        [[ -n "$line" ]] && cancun_networks+=("$line")
    done < <(echo "$groups_data" | jq -r '.cancun[]? // empty' 2>/dev/null | grep -v '^$')

    while IFS= read -r line; do
        [[ -n "$line" ]] && invalid_networks+=("$line")
    done < <(echo "$groups_data" | jq -r '.invalid[]? // empty' 2>/dev/null | grep -v '^$')

    # Report invalid networks
    if [[ ${#invalid_networks[@]} -gt 0 ]]; then
        error "Invalid networks found: ${invalid_networks[*]}"
        return 1
    fi

    # Backup foundry.toml
    backupFoundryToml

    # Set up global interrupt handler at the top level
    trap '_global_interrupt_handler' INT TERM

    # Set up cleanup on exit (only if script exits unexpectedly)
    # Normal completion will handle cleanup explicitly, so trap only handles errors/interrupts
    trap 'restoreFoundryToml 2>/dev/null; cleanupProgressTracking 2>/dev/null; rm -f "$GLOBAL_PID_TRACKING_FILE" 2>/dev/null' EXIT

    # Show group execution plan
    echo ""
    echo "=================================================================================="
    logWithTimestamp "📋 GROUP EXECUTION PLAN"
    echo "=================================================================================="

    if [[ ${#cancun_networks[@]} -gt 0 ]]; then
        local cancun_list=$(IFS=', '; echo "${cancun_networks[*]}")
        if isGroupComplete "${cancun_networks[@]}"; then
            logWithTimestamp "✅ Cancun EVM Group (${#cancun_networks[@]} networks): SKIP - All completed"
            logWithTimestamp "   Networks: $cancun_list"
        else
            logWithTimestamp "🚀 Cancun EVM Group (${#cancun_networks[@]} networks): EXECUTE - Has pending networks"
            logWithTimestamp "   Networks: $cancun_list"
        fi
    fi

    if [[ ${#zkevm_networks[@]} -gt 0 ]]; then
        local zkevm_list=$(IFS=', '; echo "${zkevm_networks[*]}")
        if isGroupComplete "${zkevm_networks[@]}"; then
            logWithTimestamp "✅ zkEVM Group (${#zkevm_networks[@]} networks): SKIP - All completed"
            logWithTimestamp "   Networks: $zkevm_list"
        else
            logWithTimestamp "🚀 zkEVM Group (${#zkevm_networks[@]} networks): EXECUTE - Has pending networks"
            logWithTimestamp "   Networks: $zkevm_list"
        fi
    fi

    if [[ ${#london_networks[@]} -gt 0 ]]; then
        local london_list=$(IFS=', '; echo "${london_networks[*]}")
        if isGroupComplete "${london_networks[@]}"; then
            logWithTimestamp "✅ London EVM Group (${#london_networks[@]} networks): SKIP - All completed"
            logWithTimestamp "   Networks: $london_list"
        else
            logWithTimestamp "🚀 London EVM Group (${#london_networks[@]} networks): EXECUTE - Has pending networks"
            logWithTimestamp "   Networks: $london_list"
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

    # Clean up PID tracking file
    rm -f "$GLOBAL_PID_TRACKING_FILE" 2>/dev/null || true

    # Wait for any remaining file operations to complete
    local lock_dir="${PROGRESS_TRACKING_FILE}.lock"
    local wait_attempts=0
    local max_wait_attempts=40  # 20 seconds max wait

    while [[ -d "$lock_dir" && $wait_attempts -lt $max_wait_attempts ]]; do
        sleep 0.5
        wait_attempts=$((wait_attempts + 1))
    done

    # Additional delay to ensure all file operations and cleanup traps complete
    # This prevents cleanup traps from overwriting status after we read it
    sleep 3

    # Show final summary (always show, even if file is invalid)
    # Try to show summary - if file is invalid, it will handle it gracefully
    echo ""
    logWithTimestamp "Generating final execution summary..."
    getProgressSummary || {
        logWithTimestamp "Warning: Could not generate summary. Progress file may be locked or invalid."
        # Try to show basic info even if summary fails
        if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
            echo ""
            echo "=========================================="
            echo "  EXECUTION PROGRESS SUMMARY (Basic)"
            echo "=========================================="
            echo "Progress file: $PROGRESS_TRACKING_FILE"
            echo "File exists: Yes"
            if jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
                echo "File is valid JSON: Yes"
            else
                echo "File is valid JSON: No"
            fi
            echo "=========================================="
            echo ""
        fi
    }

    # Check actual progress file state to determine success
    # Success means: no failed, no pending, and no in_progress networks
    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        # Validate JSON before using it
        if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
            # File is invalid JSON - log warning but don't remove yet (summary already shown)
            logWithTimestamp "Warning: Progress tracking file contains invalid JSON, will be cleaned up"
        fi
    fi

    if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
        # Validate JSON before using it
        if jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
            # File is valid JSON - check status
            local actual_failed=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "failed")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
            local actual_pending=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "pending")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")
            local actual_in_progress=$(jq '[.networks | to_entries[] | select(.key | contains(" ") | not) | select(.value.status == "in_progress")] | length' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "0")

            if [[ "$actual_failed" -eq 0 && "$actual_pending" -eq 0 && "$actual_in_progress" -eq 0 && "$overall_success" == "true" ]]; then
                logWithTimestamp "All network executions completed successfully!"
                cleanupProgressTracking
                return 0
            else
                if [[ "$actual_failed" -gt 0 ]]; then
                    logWithTimestamp "Some network executions failed. Check the summary above."
                elif [[ "$actual_pending" -gt 0 ]]; then
                    logWithTimestamp "Some networks are still pending. Check the summary above."
                elif [[ "$actual_in_progress" -gt 0 ]]; then
                    logWithTimestamp "Some networks are still in progress. Check the summary above."
                fi
                logWithTimestamp "You can rerun the same command to retry failed/pending/in_progress networks."
                return 1
            fi
        else
            # File is invalid JSON - clean it up
            logWithTimestamp "Progress tracking file contains invalid JSON, removing it"
            rm -f "$PROGRESS_TRACKING_FILE"
        fi
    fi

    # If we get here, either file doesn't exist or was invalid
    if [[ "$overall_success" == "true" ]]; then
        logWithTimestamp "All network executions completed successfully!"
        return 0
    else
        logWithTimestamp "Some network executions may have failed. Check the summary above."
        return 1
    fi
}

# =============================================================================
# CONVENIENCE FUNCTIONS
# =============================================================================

function executeAllNetworksForContract() {
    local contract="${1:-}"
    local environment="${2:-}"

    if [[ -z "$contract" || -z "$environment" ]]; then
        error "Usage: executeAllNetworksForContract CONTRACT ENVIRONMENT"
        return 1
    fi

    # Get all included networks
    local -a all_networks=($(getIncludedNetworksArray))

    executeNetworksByGroup "$contract" "$environment" "${all_networks[@]}"
}

function executeNetworksByEvmVersion() {
    local contract="${1:-}"
    local environment="${2:-}"
    local evm_version="${3:-}"

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
    local CONTRACT="${1:-}"
    local ENVIRONMENT="${2:-}"

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
    # local NETWORKS=("base" "arbitrum" "bsc" "corn" "katana" "bob" "etherlink" "plume" "gravity" "superposition" "cronos" "scroll" "blast" "apechain" "opbnb" "lens" "abstract" "avalanche" "sei" "sophon" "zksync" "celo" "unichain" "lisk" "fraxtal" "boba" "swellchain")
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

        # Set up signal handler to kill all background processes on interrupt
        # Use the global interrupt handler which properly kills all processes
        trap '_global_interrupt_handler; rm -rf "$LOG_DIR"; exit 130' INT TERM

        # Run all networks in parallel
        for NETWORK in "${NETWORKS[@]}"; do
            (set -m; handleNetworkOriginal "$NETWORK" "$ENVIRONMENT" "$LOG_DIR" "$CONTRACT") &
            local pid=$!
            trackBackgroundPid "$pid"
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
    # CONTRACT and ENVIRONMENT are read from the global configuration variables
    # Set them in the EXECUTION CONFIGURATION section above

    if [[ -z "${CONTRACT:-}" || -z "${ENVIRONMENT:-}" ]]; then
        error "CONTRACT and ENVIRONMENT must be set in the EXECUTION CONFIGURATION section of multiNetworkExecution.sh"
        error "Current CONTRACT: ${CONTRACT:-'not set'}"
        error "Current ENVIRONMENT: ${ENVIRONMENT:-'not set'}"
        return 1
    fi

    # Get the networks configured in the NETWORK SELECTION CONFIGURATION section above
    local NETWORKS=($(getConfiguredNetworks "$CONTRACT" "$ENVIRONMENT"))

    # Debug: Show what networks were selected
    if [[ ${#NETWORKS[@]} -eq 0 ]]; then
        error "No networks found for contract '$CONTRACT' in environment '$ENVIRONMENT'"
        return 1
    fi

    # Try to detect action type early (before CONTRACT is determined)
    local action_type=$(detectActionType)

    # Log execution summary before starting
    echo ""
    echo "=================================================================================="
    logWithTimestamp "📋 MULTI-NETWORK EXECUTION SUMMARY"
    echo "=================================================================================="
    logWithTimestamp "Contract: $CONTRACT"
    logWithTimestamp "Environment: $ENVIRONMENT"
    logWithTimestamp "Action Type: $action_type"
    logWithTimestamp "Total Networks: ${#NETWORKS[@]}"
    echo "=================================================================================="
    echo ""

    # Use the new execution logic with group skipping
    # Ensure NETWORKS is properly expanded as an array
    executeNetworksByGroup "$CONTRACT" "$ENVIRONMENT" "${NETWORKS[@]}"
}

function handleNetworkOriginal() {
    local NETWORK="${1:-}"
    local ENVIRONMENT="${2:-}"
    local LOG_DIR="${3:-}"
    local CONTRACT="${4:-}"

    RPC_URL=$(getRPCUrl "${NETWORK:-}" "${ENVIRONMENT:-}" 2>/dev/null || echo "")
    if [[ -z "${RPC_URL:-}" ]]; then
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

    if [[ -z "${CONTRACT:-}" ]]; then
        echo "[$NETWORK] No contract provided, cannot proceed"
        return 1
    fi

    # Attempt all operations with retries
    while [ $COMMAND_STATUS -ne 0 -a $RETRY_COUNT -lt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
        echo "[$NETWORK] Attempt $((RETRY_COUNT + 1))/$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION: Executing operations..."

        # Check if we should exit (in case of interrupt)
        if [[ -n "${EXIT_REQUESTED:-}" ]]; then
            echo "[$NETWORK] Exit requested, stopping operations"
            echo "FAILED" > "$LOG_DIR/${NETWORK}.log"
            return 1
        fi

        # Execute the configured network actions
        # To modify actions, edit the NETWORK ACTION CONFIGURATION section at the top of this file
        executeNetworkActions "${NETWORK:-}" "${ENVIRONMENT:-}" "${LOG_DIR:-}" "${CONTRACT:-}"
        COMMAND_STATUS=${?:-1}

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
    local LOG_DIR="${1:-}"

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
    local group="${1:-}"
    local environment="${2:-}"
    local contract="${3:-}"
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

    # Note: Compilation is handled automatically by deploySingleContract when needed
    # No need to pre-compile here as forge will compile automatically

    # Create log directory for this group
    local log_dir=$(mktemp -d)

    # Set up signal handler to kill all background processes on interrupt
    # Use the global interrupt handler which properly kills all processes
    trap '_global_interrupt_handler; rm -rf "$log_dir"; exit 130' INT TERM

    # Determine execution mode for this group
    local should_run_parallel="$RUN_PARALLEL"
    if [[ "$group" == "$GROUP_ZKEVM" && "$ZKEVM_ALWAYS_SEQUENTIAL" == "true" ]]; then
        should_run_parallel=false
        logWithTimestamp "zkEVM group: forcing sequential execution"
    fi

    # Initialize pids array at function scope to avoid unbound variable errors
    local -a pids=()

    if [[ "$should_run_parallel" == "true" ]]; then
        # Execute networks in parallel within the group using your existing handleNetwork function
        logWithTimestamp "Executing networks in parallel"
        for network in "${networks[@]}"; do
            # Check if this network is still pending
            if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
                local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
                if [[ "$status" == "success" ]]; then
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[0;32m[%s] [%s] Skipping (status: %s)\033[0m\n' "$TIMESTAMP" "$network" "$status"
                    continue
                elif [[ "$status" == "failed" ]]; then
                    local error_msg=$(jq -r --arg network "$network" '.networks[$network].error // "Unknown error"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "Unknown error")
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[31m[%s] [%s] Skipping (status: %s) - %s\033[0m\n' "$TIMESTAMP" "$network" "$status" "$error_msg"
                    continue
                fi
            fi

            # Start network execution in background using your existing handleNetwork function
            (set -m; executeNetworkWithHandleNetwork "$network" "$environment" "$log_dir" "$contract" "$group") &
            local pid=$!
            trackBackgroundPid "$pid"
            pids+=($pid)
        done

        # Wait for all background jobs to complete
        local current_execution_failures=0
        if [[ ${#pids[@]} -gt 0 ]]; then
            for pid in "${pids[@]}"; do
                if ! wait "$pid"; then
                    current_execution_failures=$((current_execution_failures + 1))
                fi
            done
        fi
    else
        # Execute networks sequentially within the group using your existing handleNetwork function
        logWithTimestamp "Executing networks sequentially"
        local current_execution_failures=0
        for network in "${networks[@]}"; do
            # Check if this network is still pending
            if [[ -f "$PROGRESS_TRACKING_FILE" ]]; then
                local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
                if [[ "$status" == "success" ]]; then
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[0;32m[%s] [%s] Skipping (status: %s)\033[0m\n' "$TIMESTAMP" "$network" "$status"
                    continue
                elif [[ "$status" == "failed" ]]; then
                    local error_msg=$(jq -r --arg network "$network" '.networks[$network].error // "Unknown error"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "Unknown error")
                    local TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    printf '\033[31m[%s] [%s] Skipping (status: %s) - %s\033[0m\n' "$TIMESTAMP" "$network" "$status" "$error_msg"
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
            # Skip invalid network names (contain spaces)
            if [[ "$network" == *" "* ]]; then
                continue
            fi

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
    local network="${1:-}"
    local environment="${2:-}"
    local log_dir="${3:-}"
    local contract="${4:-}"
    local group="${5:-}"

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
        if [[ -n "${EXIT_REQUESTED:-}" ]]; then
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

function resetNetworkStatuses() {
    # Reset specific network statuses to "pending" to force redeployment
    # Usage: resetNetworkStatuses "network1" "network2" ...
    local -a networks=("$@")

    if [[ ${#networks[@]} -eq 0 ]]; then
        error "No networks specified to reset"
        return 1
    fi

    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        logWithTimestamp "Progress tracking file not found - nothing to reset"
        return 0
    fi

    # Check if file is valid JSON
    if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
        error "Progress tracking file contains invalid JSON"
        return 1
    fi

    local updated_data=$(cat "$PROGRESS_TRACKING_FILE")
    local reset_count=0

    for network in "${networks[@]}"; do
        # Skip invalid network names
        if [[ -z "$network" || "$network" == *" "* ]]; then
            continue
        fi

        # Check if network exists in tracking file
        local network_exists=$(echo "$updated_data" | jq -r --arg network "$network" '.networks[$network] // empty' 2>/dev/null || echo "")
        if [[ -n "$network_exists" && "$network_exists" != "null" ]]; then
            # Reset network status to pending
            updated_data=$(echo "$updated_data" | jq \
                --arg network "$network" \
                --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
                '.networks[$network].status = "pending" | .networks[$network].attempts = 0 | .networks[$network].lastAttempt = $timestamp | .networks[$network].error = null | .lastUpdate = $timestamp' 2>/dev/null || echo "$updated_data")
            reset_count=$((reset_count + 1))
            logWithTimestamp "Reset network status to pending: $network"
        fi
    done

    if [[ $reset_count -eq 0 ]]; then
        logWithTimestamp "No matching networks found in progress tracking file to reset"
        return 0
    fi

    # Validate JSON before writing
    if ! echo "$updated_data" | jq empty 2>/dev/null; then
        error "Generated invalid JSON for progress tracking reset"
        return 1
    fi

    # Write updated data
    if ! echo "$updated_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
        error "Failed to write updated progress tracking data"
        return 1
    fi

    # Validate temp file JSON before moving - ensure file exists first
    if [[ ! -f "${PROGRESS_TRACKING_FILE}.tmp" ]] || [[ ! -s "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
        error "Temp file was not created or is empty"
        rm -f "${PROGRESS_TRACKING_FILE}.tmp"
        return 1
    fi

    # Re-check file existence right before validation to handle race conditions
    if [[ ! -f "${PROGRESS_TRACKING_FILE}.tmp" ]] || [[ ! -r "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
        error "Temp file was removed before validation (race condition)"
        rm -f "${PROGRESS_TRACKING_FILE}.tmp"
        return 1
    fi

    local jq_error_output
    jq_error_output=$(jq empty "${PROGRESS_TRACKING_FILE}.tmp" 2>&1)
    local jq_exit_code=$?
    if [[ $jq_exit_code -ne 0 ]]; then
        # Check if the error is due to file not existing (race condition)
        if [[ "$jq_error_output" == *"No such file or directory"* ]] || [[ "$jq_error_output" == *"Could not open file"* ]]; then
            error "Temp file was removed before validation (race condition)"
            rm -f "${PROGRESS_TRACKING_FILE}.tmp"
            return 1
        fi
        error "Temp file contains invalid JSON"
        error "JSON validation error: ${jq_error_output:-Unknown error}"
        rm -f "${PROGRESS_TRACKING_FILE}.tmp"
        return 1
    fi

    if [[ -f "${PROGRESS_TRACKING_FILE}.tmp" ]]; then
        mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE" 2>/dev/null || {
            error "Failed to move progress tracking temp file"
            rm -f "${PROGRESS_TRACKING_FILE}.tmp"
            return 1
        }

        # Final validation after move
        if ! jq empty "$PROGRESS_TRACKING_FILE" 2>/dev/null; then
            error "Final file contains invalid JSON after move"
            return 1
        fi
    fi

    logWithTimestamp "Reset $reset_count network(s) to pending status"
    return 0
}

export -f resetProgressTracking
export -f resetNetworkStatuses
