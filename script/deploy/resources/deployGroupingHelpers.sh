#!/bin/bash

# =============================================================================
# EVM-version deployment grouping helpers
# =============================================================================
# Single source of truth for splitting a set of networks by the toolchain they
# must be built with, and for pointing foundry.toml at the matching profile
# before a build.
#
# Why this exists: contracts compiled for `cancun` embed opcodes (PUSH0, MCOPY,
# TLOAD/TSTORE) that a `london` chain's VM rejects, and the two solc pins differ
# too. A multi-network deploy therefore has to build once per EVM-version group
# and ship each group its own artifact - it cannot flatten every chain into one
# build. zkEVM networks need a different compiler entirely and are always run
# on their own.
#
# Sourced by:
#   - script/multiNetworkExecution.sh   (grouped playground runner)
#   - script/playgroundHelpers.sh       (re-exports getNetworkGroup/...EvmVersion)
#   - script/deploy/deployContractToNetworks.sh (parallel non-interactive deploy)
#
# Requires helperFunctions.sh to be sourced first (error, logWithTimestamp,
# isZkEvmNetwork, NETWORKS_JSON_FILE_PATH).
# =============================================================================

# Group identifiers
GROUP_LONDON="london"
GROUP_ZKEVM="zkevm"
GROUP_CANCUN="cancun"

# solc pins per group (must match foundry.toml profiles)
SOLC_LONDON="0.8.17"
SOLC_CANCUN="0.8.29"

# evm_version per group
EVM_LONDON="london"
EVM_CANCUN="cancun"

# foundry.toml backup file used while a group build temporarily rewrites it
FOUNDRY_TOML_BACKUP="foundry.toml.backup"

# getNetworkEvmVersion NETWORK -> echoes the network's targetEvmVersion.
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
    local EVM_VERSION
    EVM_VERSION=$(jq -r --arg network "$NETWORK" '.[$network].targetEvmVersion // empty' "$NETWORKS_JSON_FILE_PATH")

    if [[ -z "$EVM_VERSION" || "$EVM_VERSION" == "null" ]]; then
        error "EVM version not defined for network '$NETWORK' in networks.json"
        return 1
    fi

    echo "$EVM_VERSION"
}

# getNetworkGroup NETWORK -> echoes london | cancun | zkevm.
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

    # Get EVM version (assign separately so the return code is not masked by `local`)
    local EVM_VERSION
    EVM_VERSION=$(getNetworkEvmVersion "$NETWORK") || return 1

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

# groupNetworksByExecutionGroup NETWORK... -> JSON {london,zkevm,cancun,invalid}.
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

    # Group networks. NETWORK is local so grouping never clobbers a caller's
    # NETWORK in this sourced script. Branch on getNetworkGroup's real exit status
    # (not a captured value): error() prints to stdout, so on failure the substitution
    # holds diagnostic text, not a group - the `*)` arm plus the failure branch both
    # route such networks to INVALID_NETWORKS instead of silently dropping them.
    local NETWORK
    local GROUP
    for NETWORK in "${NETWORKS[@]}"; do
        if GROUP=$(getNetworkGroup "$NETWORK" 2>/dev/null); then
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
                *)
                    INVALID_NETWORKS+=("$NETWORK")
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
        # Check the copy: without strict mode a failed cp would otherwise report
        # success, then a group build mutates foundry.toml with no backup to restore.
        if ! cp "foundry.toml" "$FOUNDRY_TOML_BACKUP"; then
            error "Failed to back up foundry.toml to $FOUNDRY_TOML_BACKUP"
            return 1
        fi
        logWithTimestamp "Backed up foundry.toml to $FOUNDRY_TOML_BACKUP"
    else
        error "foundry.toml not found"
        return 1
    fi
}

function restoreFoundryToml() {
    if [[ -f "$FOUNDRY_TOML_BACKUP" ]]; then
        # Only remove the backup once the restore copy has actually succeeded;
        # deleting it after a failed cp would lose the sole copy of the original.
        if ! cp "$FOUNDRY_TOML_BACKUP" "foundry.toml"; then
            error "Failed to restore foundry.toml from $FOUNDRY_TOML_BACKUP - backup kept"
            return 1
        fi
        logWithTimestamp "Restored foundry.toml from $FOUNDRY_TOML_BACKUP"
        rm "$FOUNDRY_TOML_BACKUP"
    else
        # Silently return if backup doesn't exist (expected after restore)
        return 0
    fi
}

# updateFoundryTomlForGroup GROUP [STRICT]
#   Points [profile.default] at GROUP's solc + evm_version and builds.
#   STRICT="true" makes a failed `forge build` return non-zero (callers that
#   must not deploy against a stale artifact set it); the default keeps the
#   original tolerant behavior for the playground runner.
function updateFoundryTomlForGroup() {
    local group="${1:-}"
    local STRICT="${2:-false}"

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
            if [[ "$STRICT" == "true" ]]; then
                forge build || { error "forge build failed for $group group"; return 1; }
            else
                forge build || true
            fi
            ;;
        "$GROUP_ZKEVM")
            # zkEVM networks use the [profile.zksync] section; zksolc is pinned in foundry.toml [external.zksync] and exported via FOUNDRY_ZKSYNC (see helperFunctions.sh)
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
            if [[ "$STRICT" == "true" ]]; then
                forge build || { error "forge build failed for $group group"; return 1; }
            else
                forge build || true
            fi
            ;;
        *)
            error "Unknown group: $group"
            return 1
            ;;
    esac
}
