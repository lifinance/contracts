#!/bin/bash

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
# CONFIGURATION AND CONSTANTS
# =============================================================================

# Progress tracking file - will be set based on action type
PROGRESS_TRACKING_FILE=""

# Group definitions
GROUP_LONDON="london"
GROUP_ZKEVM="zkevm"
GROUP_CANCUN="cancun"

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
# NETWORK SELECTION CONFIGURATION
# =============================================================================
# Configure which networks to execute by modifying the NETWORKS array below
# This is the main place to adjust your network list for multi-execution

# Option 1: Use all included networks (default)
# NETWORKS=($(getIncludedNetworksArray))

# Option 2: Use specific networks (uncomment and modify as needed)
# NETWORKS=("mainnet" "arbitrum" "base" "zksync" "blast" "hyperevm")
  NETWORKS=("arbitrum" "optimism" "base" "bsc" "linea" "scroll" "polygon" "blast" "mainnet" "worldchain")

# Option 3: Use networks by EVM version (uncomment as needed)
# NETWORKS=($(getIncludedNetworksByEvmVersionArray "london"))
# NETWORKS=($(getIncludedNetworksByEvmVersionArray "cancun"))

# Option 4: Use networks where contract is deployed (uncomment as needed)
# NETWORKS=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT"))

# Option 4b: Use networks from relay.json (hardcoded list for RelayDepositoryFacet deployment)
# NETWORKS=("abstract" "apechain" "arbitrum" "avalanche" "base" "berachain" "blast" "bob" "boba" "bsc" "celo" "corn" "cronos" "gnosis" "gravity" "hyperevm" "ink" "katana" "linea" "lisk" "mainnet" "mantle" "metis" "mode" "optimism" "plume" "polygon" "polygonzkevm" "ronin" "scroll" "sei" "soneium" "sonic" "superposition" "swellchain" "taiko" "unichain" "worldchain" "zksync")

# Option 5: Use whitelist filtering (uncomment and modify as needed)
# NETWORKS_WHITELIST=("mainnet" "arbitrum" "base" "zksync")
# NETWORKS_WHITELIST=("mainnet" "arbitrum" "base" "bsc" "blast" "ink" "linea" "lisk" "mode" "optimism" "polygon" "scroll" "soneium" "unichain" "worldchain" "zksync")

# NETWORKS=($(getIncludedNetworksArray))
# # Filter logic would go here

# =============================================================================
# NETWORK ACTION CONFIGURATION
# =============================================================================
# Configure what action to execute for each network by uncommenting the desired option(s)
# Multiple actions can be enabled simultaneously

# DEPLOY - Deploy the contract to the network
# deployContract "$NETWORK" "$ENVIRONMENT" "$CONTRACT"

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

# Foundry.toml backup file
FOUNDRY_TOML_BACKUP="foundry.toml.backup"

# =============================================================================
# NETWORK ACTION EXECUTION
# =============================================================================

function executeNetworkActions() {
    # This function executes the actions configured in the NETWORK ACTION CONFIGURATION section above
    # To modify actions, edit the configuration section at the top of this file

    local NETWORK="$1"
    local ENVIRONMENT="$2"
    local LOG_DIR="$3"
    local CONTRACT="$4"

    # Get RPC URL for the network
    # RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")

    # Execute configured actions (uncomment the ones you want in the configuration section above)
    # All commands will be executed, and the last command's exit code will be returned

    # DEPLOY - Deploy the contract to the network
    # deployContract "$NETWORK" "$ENVIRONMENT" "$CONTRACT"

    # DEPLOY & VERIFY CONTRACT
    # CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")
    # echo "[$NETWORK] CURRENT_VERSION of contract $CONTRACT: $CURRENT_VERSION"
    # deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$CURRENT_VERSION" false
    # RETURN_CODE=$?
    # echo "[$NETWORK] deploySingleContract completed with exit code: $RETURN_CODE"

    getContractVerified "$NETWORK" "$ENVIRONMENT" "AcrossFacetV4"
    if [ $? -ne 0 ]; then
        RETURN_CODE=1
    fi
    getContractVerified "$NETWORK" "$ENVIRONMENT" "AcrossFacetPackedV4"
    if [ $? -ne 0 ]; then
        RETURN_CODE=1
    fi
    getContractVerified "$NETWORK" "$ENVIRONMENT" "ReceiverAcrossV4"
    if [ $? -ne 0 ]; then
        RETURN_CODE=1
    fi

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
    return "${RETURN_CODE:-0}"
}

 # =============================================================================
# NETWORK SELECTION HELPER
# =============================================================================

function getConfiguredNetworks() {
    # This function returns the networks configured in the NETWORK SELECTION CONFIGURATION section above
    # It handles the case where variables like $CONTRACT and $ENVIRONMENT might not be available yet

    local CONTRACT="$1"
    local ENVIRONMENT="$2"
    local selected_networks=()

    # Check if NETWORKS array is empty or contains function calls that need variables
    if [[ ${#NETWORKS[@]} -eq 0 ]]; then
        # No networks configured, fallback to all networks
        selected_networks=($(getIncludedNetworksArray))
    else
        # Check if the current NETWORKS array contains function calls that need variables
        local needs_variables=false
        for network in "${NETWORKS[@]}"; do
            if [[ "$network" == *"\$CONTRACT"* ]] || [[ "$network" == *"\$ENVIRONMENT"* ]]; then
                needs_variables=true
                break
            fi
        done

        if [[ "$needs_variables" == "true" ]]; then
            # Re-evaluate the network selection with available variables
            if [[ -n "$CONTRACT" && -n "$ENVIRONMENT" ]]; then
                # Re-evaluate the configuration with variables available
                # This is a simplified approach - you can uncomment the specific option you want
                selected_networks=($(getNetworksByEvmVersionAndContractDeployment "$CONTRACT" "$ENVIRONMENT"))
            else
                # Fallback to all networks if variables not available
                selected_networks=($(getIncludedNetworksArray))
            fi
        else
            # Return the pre-configured networks
            if [[ ${#NETWORKS[@]} -gt 0 ]]; then
                selected_networks=("${NETWORKS[@]}")
            else
                # If NETWORKS is empty, fallback to all networks
                selected_networks=($(getIncludedNetworksArray))
            fi
        fi
    fi

    # Apply whitelist filtering if NETWORKS_WHITELIST is defined and not empty
    if [[ -n "${NETWORKS_WHITELIST[*]}" ]]; then
        local filtered_networks=()
        for network in "${selected_networks[@]}"; do
            for whitelisted_network in "${NETWORKS_WHITELIST[@]}"; do
                if [[ "$network" == "$whitelisted_network" ]]; then
                    filtered_networks+=("$network")
                    break
                fi
            done
        done
        selected_networks=("${filtered_networks[@]}")
    fi

    # Return the final network list
    printf '%s\n' "${selected_networks[@]}"
}

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

function logWithTimestamp() {
    local message="$1"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] $message"
}

function logGroupInfo() {
    local group="$1"
    local networks=("${@:2}")
    logWithTimestamp "Group: $group (${#networks[@]} networks): ${networks[*]}"
}

function logNetworkResult() {
    local network="$1"
    local status="$2"
    local message="$3"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$network] $status: $message"
}

# =============================================================================
# NETWORK GROUPING FUNCTIONS
# =============================================================================

function getNetworkEvmVersion() {
    local network="$1"

    if [[ -z "$network" ]]; then
        error "Network name is required"
        return 1
    fi

    # Check if network exists in networks.json
    if ! jq -e --arg network "$network" '.[$network] != null' "$NETWORKS_JSON_FILE_PATH" > /dev/null; then
        error "Network '$network' not found in networks.json"
        return 1
    fi

    # Get EVM version
    local evm_version=$(jq -r --arg network "$network" '.[$network].deployedWithEvmVersion // empty' "$NETWORKS_JSON_FILE_PATH")

    if [[ -z "$evm_version" || "$evm_version" == "null" ]]; then
        error "EVM version not defined for network '$network' in networks.json"
        return 1
    fi

    echo "$evm_version"
}

function getNetworkSolcVersion() {
    local network="$1"

    if [[ -z "$network" ]]; then
        error "Network name is required"
        return 1
    fi

    # Check if network exists in networks.json
    if ! jq -e --arg network "$network" '.[$network] != null' "$NETWORKS_JSON_FILE_PATH" > /dev/null; then
        error "Network '$network' not found in networks.json"
        return 1
    fi

    # Get Solidity version
    local solc_version=$(jq -r --arg network "$network" '.[$network].deployedWithSolcVersion // empty' "$NETWORKS_JSON_FILE_PATH")

    if [[ -z "$solc_version" || "$solc_version" == "null" ]]; then
        error "Solc version not defined for network '$network' in networks.json"
        return 1
    fi

    echo "$solc_version"
}

function isZkEvmNetwork() {
    local network="$1"

    if [[ -z "$network" ]]; then
        error "Network name is required"
        return 1
    fi

    # Check if network exists in networks.json
    if ! jq -e --arg network "$network" '.[$network] != null' "$NETWORKS_JSON_FILE_PATH" > /dev/null; then
        error "Network '$network' not found in networks.json"
        return 1
    fi

    # Get isZkEVM value
    local is_zkevm=$(jq -r --arg network "$network" '.[$network].isZkEVM // false' "$NETWORKS_JSON_FILE_PATH")

    if [[ "$is_zkevm" == "true" ]]; then
        return 0  # Success (true)
    else
        return 1  # Failure (false)
    fi
}

function getNetworkGroup() {
    local network="$1"

    if [[ -z "$network" ]]; then
        error "Network name is required"
        return 1
    fi

    # Check if it's a zkEVM network first
    if isZkEvmNetwork "$network"; then
        echo "$GROUP_ZKEVM"
        return 0
    fi

    # Get EVM version
    local evm_version=$(getNetworkEvmVersion "$network")
    if [[ $? -ne 0 ]]; then
        return 1
    fi

    case "$evm_version" in
        "london")
            echo "$GROUP_LONDON"
            ;;
        "cancun")
            echo "$GROUP_CANCUN"
            ;;
        *)
            error "Unsupported EVM version '$evm_version' for network '$network'"
            return 1
            ;;
    esac
}

function groupNetworksByExecutionGroup() {
    local networks=("$@")

    if [[ ${#networks[@]} -eq 0 ]]; then
        error "No networks provided for grouping"
        return 1
    fi

    # Initialize group arrays
    local london_networks=()
    local zkevm_networks=()
    local cancun_networks=()
    local invalid_networks=()

    # Group networks
    for network in "${networks[@]}"; do
        local group=$(getNetworkGroup "$network")
        local group_result=$?

        if [[ $group_result -eq 0 ]]; then
            case "$group" in
                "$GROUP_LONDON")
                    london_networks+=("$network")
                    ;;
                "$GROUP_ZKEVM")
                    zkevm_networks+=("$network")
                    ;;
                "$GROUP_CANCUN")
                    cancun_networks+=("$network")
                    ;;
            esac
        else
            invalid_networks+=("$network")
        fi
    done

    # Output results as JSON
    jq -n \
        --argjson london "$(printf '%s\n' "${london_networks[@]}" | jq -R . | jq -s .)" \
        --argjson zkevm "$(printf '%s\n' "${zkevm_networks[@]}" | jq -R . | jq -s .)" \
        --argjson cancun "$(printf '%s\n' "${cancun_networks[@]}" | jq -R . | jq -s .)" \
        --argjson invalid "$(printf '%s\n' "${invalid_networks[@]}" | jq -R . | jq -s .)" \
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
        # Don't show error if backup doesn't exist (might have been cleaned up already)
        logWithTimestamp "Foundry.toml backup not found (already restored or never created)"
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
            logWithTimestamp "Updating foundry.toml for London EVM (solc 0.8.17)"
            # Update solc version to 0.8.17 and EVM version to london in profile.default section only
            logWithTimestamp "Running sed commands..."
            # Use simpler sed pattern - just replace the first occurrence of each setting
            sed -i.bak '1,/^\[/ s/solc_version = .*/solc_version = '\''0.8.17'\''/' foundry.toml
            logWithTimestamp "Updated solc_version"
            sed -i.bak '1,/^\[/ s/evm_version = .*/evm_version = '\''london'\''/' foundry.toml
            logWithTimestamp "Updated evm_version"
            rm -f foundry.toml.bak
            logWithTimestamp "Updated foundry.toml successfully"
            # Build with new solc version (Foundry will detect if recompilation is needed)
            logWithTimestamp "Running forge build..."
            timeout 300 forge build --silent 2>/dev/null || {
                logWithTimestamp "Forge build timed out or failed, continuing..."
            }
            logWithTimestamp "Forge build completed"
            ;;
        "$GROUP_ZKEVM")
            logWithTimestamp "zkEVM networks use profile.zksync - no foundry.toml updates needed"
            # zkEVM networks use the [profile.zksync] section with zksolc
            # No need to update the main solc_version or evm_version settings
            ;;
        "$GROUP_CANCUN")
            logWithTimestamp "Updating foundry.toml for Cancun EVM (solc 0.8.29)"
            # Update solc version to 0.8.29 and EVM version to cancun in profile.default section only
            logWithTimestamp "Running sed commands..."
            # Use simpler sed pattern - just replace the first occurrence of each setting
            sed -i.bak '1,/^\[/ s/solc_version = .*/solc_version = '\''0.8.29'\''/' foundry.toml
            logWithTimestamp "Updated solc_version"
            sed -i.bak '1,/^\[/ s/evm_version = .*/evm_version = '\''cancun'\''/' foundry.toml
            logWithTimestamp "Updated evm_version"
            rm -f foundry.toml.bak
            logWithTimestamp "Updated foundry.toml successfully"
            # Build with new solc version (Foundry will detect if recompilation is needed)
            logWithTimestamp "Running forge build..."
            timeout 300 forge build --silent 2>/dev/null || {
                logWithTimestamp "Forge build timed out or failed, continuing..."
            }
            logWithTimestamp "Forge build completed"
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

    logWithTimestamp "Recompiling contracts for group: $group"

    # All groups use standard compilation - zkEVM compilation is handled by deploy scripts
    logWithTimestamp "Compiling with standard solc"
    if ! forge build; then
        error "Failed to compile contracts"
        return 1
    fi

    logWithTimestamp "Compilation completed successfully for group: $group"
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
    local action_type="$1"
    local contract="$2"
    local environment="$3"

    case "$action_type" in
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
            PROGRESS_TRACKING_FILE=".network_${action_type}_progress.json"
            ;;
    esac

    echo "Using progress tracking file: $PROGRESS_TRACKING_FILE"
}

function isActionAlreadyCompleted() {
    # Generic function to check if an action is already completed for a network
    local action_type="$1"
    local contract="$2"
    local network="$3"
    local environment="$4"

    case "$action_type" in
        "verification")
            isContractAlreadyVerified "$contract" "$network" "$environment"
            ;;
        "deployment")
            isContractAlreadyDeployed "$contract" "$network" "$environment"
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
    local contract="$1"
    local environment="$2"
    local networks=("${@:3}")

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
                local network_exists=$(echo "$existing_data" | jq -r --arg network "$network" '.networks[$network] // empty' 2>/dev/null || echo "")
                if [[ -z "$network_exists" || "$network_exists" == "null" ]]; then
                    logWithTimestamp "Adding new network to tracking: $network"
                    updated_data=$(echo "$updated_data" | jq --arg network "$network" --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.networks[$network] = {status: "pending", attempts: 0, lastAttempt: $timestamp, error: null} | .lastUpdate = $timestamp' 2>/dev/null || echo "$existing_data")
                fi
            done

            if ! echo "$updated_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
                error "Failed to write progress tracking data"
                return 1
            fi
            mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE"
            return 0
        else
            logWithTimestamp "Different contract/environment/action detected. Creating new progress tracking."
        fi
    fi

    # Create initial progress structure, checking for existing completion status
    local networks_json="{}"
    for network in "${networks[@]}"; do
        local network_status="pending"
        local attempts=0
        local lastAttempt=null
        local error=null

        # Check if action is already completed for this network
        if isActionAlreadyCompleted "$action_type" "$contract" "$network" "$environment"; then
            network_status="success"
            attempts=1
            lastAttempt="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
            logWithTimestamp "Network $network already has $action_type completed for $contract - marking as success"
        else
            logWithTimestamp "Network $network needs $action_type for $contract - marking as pending"
        fi

        networks_json=$(echo "$networks_json" | jq --arg network "$network" --arg status "$network_status" --argjson attempts "$attempts" --arg lastAttempt "$lastAttempt" --arg error "$error" '. + {($network): {status: $status, attempts: $attempts, lastAttempt: $lastAttempt, error: $error}}')
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

    if ! echo "$progress_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
        error "Failed to write initial progress tracking data"
        return 1
    fi
    mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE"
    logWithTimestamp "Initialized progress tracking for $action_type action on $contract in $environment"
}

function updateNetworkProgress() {
    local network="$1"
    local status="$2"
    local error_message="$3"

    if [[ -z "$network" || -z "$status" ]]; then
        error "Network and status are required"
        return 1
    fi

    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        error "Progress tracking file not found"
        return 1
    fi

    # Update progress
    local updated_data=$(jq \
        --arg network "$network" \
        --arg status "$status" \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg error "$error_message" \
        '.networks[$network].status = $status |
         .networks[$network].lastAttempt = $timestamp |
         .networks[$network].attempts += 1 |
         .networks[$network].error = $error |
         .lastUpdate = $timestamp' \
        "$PROGRESS_TRACKING_FILE")

    if ! echo "$updated_data" > "${PROGRESS_TRACKING_FILE}.tmp"; then
        error "Failed to write progress update for $network"
        return 1
    fi
    mv "${PROGRESS_TRACKING_FILE}.tmp" "$PROGRESS_TRACKING_FILE"

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
        logWithTimestamp "Progress tracking file not found (no progress to summarize)"
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
        # Don't show error if file doesn't exist (might have been cleaned up already)
        logWithTimestamp "Progress tracking file not found (already cleaned up or never created): ${PROGRESS_TRACKING_FILE:-'not set'}"
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

function isContractAlreadyDeployed() {
    # Check if a contract is already deployed to a network
    local contract="$1"
    local network="$2"
    local environment="$3"

    # Check if contract address exists in deployments file
    local deployment_file="./deployments/${network}.json"
    if [[ -f "$deployment_file" ]]; then
        local contract_address=$(jq -r --arg contract "$contract" '.[$contract] // empty' "$deployment_file")
        if [[ -n "$contract_address" && "$contract_address" != "null" && "$contract_address" != "" ]]; then
            return 0  # Contract is deployed
        fi
    fi

    return 1  # Contract is not deployed
}

function isContractAlreadyVerified() {
    # Check if a contract is already verified on a network
    local contract="$1"
    local network="$2"
    local environment="$3"

    # Get the highest deployed version for this contract
    local version=$(getHighestDeployedContractVersionFromMasterLog "$network" "$environment" "$contract")
    if [[ -z "$version" || "$version" == "null" ]]; then
        return 1  # No deployed version found
    fi

    # Check if contract is verified in master log
    local log_entry=$(findContractInMasterLog "$contract" "$network" "$environment" "$version")
    if [[ $? -ne 0 || -z "$log_entry" || "$log_entry" == "null" ]]; then
        return 1  # No log entry found
    fi

    # Extract verification status
    local verified=$(echo "$log_entry" | jq -r ".VERIFIED" 2>/dev/null)
    if [[ "$verified" == "true" ]]; then
        return 0  # Contract is verified
    fi

    return 1  # Contract is not verified
}


function isGroupComplete() {
    # Check if all networks in a group are already successful
    local networks=("$@")

    if [[ ${#networks[@]} -eq 0 ]]; then
        return 0  # Empty group is considered complete
    fi

    if [[ ! -f "$PROGRESS_TRACKING_FILE" ]]; then
        return 1  # No progress file means not complete
    fi

    local pending_count=0
    for network in "${networks[@]}"; do
        local status=$(jq -r --arg network "$network" '.networks[$network].status // "pending"' "$PROGRESS_TRACKING_FILE" 2>/dev/null || echo "pending")
        if [[ "$status" != "success" ]]; then
            pending_count=$((pending_count + 1))
        fi
    done

    # Group is complete if no networks are pending
    return $pending_count
}

# =============================================================================
# NETWORK EXECUTION FUNCTIONS
# =============================================================================

function executeNetworkInGroup() {
    local network="$1"
    local environment="$2"
    local contract="$3"
    local group="$4"
    local log_dir="$5"

    if [[ -z "$network" || -z "$environment" || -z "$contract" || -z "$group" || -z "$log_dir" ]]; then
        error "All parameters are required for executeNetworkInGroup"
        return 1
    fi

    # Update progress to in_progress
    updateNetworkProgress "$network" "in_progress"

    # Get RPC URL
    local rpc_url=$(getRPCUrl "$network" "$environment")
    if [[ $? -ne 0 ]]; then
        updateNetworkProgress "$network" "failed" "Failed to get RPC URL"
        return 1
    fi

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
        executeNetworkActions "$network" "$environment" "$log_dir" "$contract"
        command_status=$?
        echo "[$network] executeNetworkActions returned with status: $command_status"

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
    local group="$1"
    local environment="$2"
    local contract="$3"
    local networks=("${@:4}")

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
        # Execute networks in parallel within the group
        logWithTimestamp "Executing networks in parallel"

        local pids=()
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
            executeNetworkInGroup "$network" "$environment" "$contract" "$group" "$log_dir" &
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
            executeNetworkInGroup "$network" "$environment" "$contract" "$group" "$log_dir"
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
    local contract="$1"
    local environment="$2"
    local networks=("${@:3}")

    if [[ -z "$contract" || -z "$environment" || ${#networks[@]} -eq 0 ]]; then
        error "Usage: executeNetworksByGroup CONTRACT ENVIRONMENT NETWORK1 NETWORK2 ..."
        error "Example: executeNetworksByGroup GlacisFacet production mainnet arbitrum base"
        return 1
    fi

    logWithTimestamp "Starting network execution for $contract in $environment"
    logWithTimestamp "Networks to process: ${networks[*]}"

    # Initialize progress tracking
    initializeProgressTracking "$contract" "$environment" "${networks[@]}"

    # Group networks by execution requirements
    local groups_data=$(groupNetworksByExecutionGroup "${networks[@]}")
    if [[ $? -ne 0 ]]; then
        error "Failed to group networks"
        return 1
    fi

    # Extract group arrays
    local london_networks=($(echo "$groups_data" | jq -r '.london[]'))
    local zkevm_networks=($(echo "$groups_data" | jq -r '.zkevm[]'))
    local cancun_networks=($(echo "$groups_data" | jq -r '.cancun[]'))
    local invalid_networks=($(echo "$groups_data" | jq -r '.invalid[]'))

    # Report invalid networks
    if [[ ${#invalid_networks[@]} -gt 0 ]]; then
        error "Invalid networks found: ${invalid_networks[*]}"
        return 1
    fi

    # Backup foundry.toml
    backupFoundryToml

    # Set up cleanup on exit
    trap 'restoreFoundryToml; getProgressSummary; cleanupProgressTracking' EXIT

    # Show group execution plan
    echo ""
    echo "=================================================================================="
    logWithTimestamp "📋 GROUP EXECUTION PLAN"
    echo "=================================================================================="

    if [[ ${#cancun_networks[@]} -gt 0 ]]; then
        if isGroupComplete "${cancun_networks[@]}"; then
            logWithTimestamp "✅ Cancun EVM Group (${#cancun_networks[@]} networks): SKIP - All completed"
        else
            logWithTimestamp "🚀 Cancun EVM Group (${#cancun_networks[@]} networks): EXECUTE - Has pending networks"
        fi
    fi

    if [[ ${#zkevm_networks[@]} -gt 0 ]]; then
        if isGroupComplete "${zkevm_networks[@]}"; then
            logWithTimestamp "✅ zkEVM Group (${#zkevm_networks[@]} networks): SKIP - All completed"
        else
            logWithTimestamp "🚀 zkEVM Group (${#zkevm_networks[@]} networks): EXECUTE - Has pending networks"
        fi
    fi

    if [[ ${#london_networks[@]} -gt 0 ]]; then
        if isGroupComplete "${london_networks[@]}"; then
            logWithTimestamp "✅ London EVM Group (${#london_networks[@]} networks): SKIP - All completed"
        else
            logWithTimestamp "🚀 London EVM Group (${#london_networks[@]} networks): EXECUTE - Has pending networks"
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

            if ! executeGroupSequentially "$GROUP_CANCUN" "$environment" "$contract" "${cancun_networks[@]}"; then
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
            if ! executeGroupSequentially "$GROUP_ZKEVM" "$environment" "$contract" "${zkevm_networks[@]}"; then
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
            if ! executeGroupSequentially "$GROUP_LONDON" "$environment" "$contract" "${london_networks[@]}"; then
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

    # Show final summary
    getProgressSummary

    if [[ "$overall_success" == "true" ]]; then
        logWithTimestamp "All network executions completed successfully!"
        cleanupProgressTracking
        return 0
    else
        logWithTimestamp "Some network executions failed. Check the summary above."
        logWithTimestamp "You can rerun the same command to retry failed networks."
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
    local all_networks=($(getIncludedNetworksArray))

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
    local networks=($(getIncludedNetworksByEvmVersionArray "$evm_version"))

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
    if [[ -n "$NETWORKS_WHITELIST" ]]; then
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
    # It maintains the same interface but adds grouping functionality

    local CONTRACT="$1"
    local ENVIRONMENT="$2"

    if [[ -z "$CONTRACT" || -z "$ENVIRONMENT" ]]; then
        error "Usage: iterateAllNetworksGrouped CONTRACT ENVIRONMENT"
        return 1
    fi

    # Get the networks configured in the NETWORK SELECTION CONFIGURATION section above
    local NETWORKS=($(getConfiguredNetworks "$CONTRACT" "$ENVIRONMENT"))

    # Debug: Show what networks were selected
    if [[ ${#NETWORKS[@]} -eq 0 ]]; then
        error "No networks found for contract '$CONTRACT' in environment '$ENVIRONMENT'"
        return 1
    fi

    # Use the new execution logic with group skipping
    executeNetworksByGroup "$CONTRACT" "$ENVIRONMENT" "${NETWORKS[@]}"
}

function handleNetworkOriginal() {
    local NETWORK="$1"
    local ENVIRONMENT="$2"
    local LOG_DIR="$3"
    local CONTRACT="$4"

    RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")

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
    local networks=("${@:4}")

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
        local pids=()
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
export -f getNetworkGroup
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
export -f isContractAlreadyDeployed
export -f isContractAlreadyVerified
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
