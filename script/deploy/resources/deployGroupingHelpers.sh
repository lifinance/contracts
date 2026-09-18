#!/bin/bash

# =============================================================================
# EVM-version deployment grouping helpers
# =============================================================================
# Single source of truth for splitting a set of networks by the toolchain they
# must be built with, and for selecting the foundry profile a group builds and
# deploys under.
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
#   - script/tasks/proposeContractToNetworks.sh (parallel Safe proposals)
#
# Requires helperFunctions.sh to be sourced first (error, logWithTimestamp,
# isZkEvmNetwork, NETWORKS_JSON_FILE_PATH).
# =============================================================================

# Group identifiers
GROUP_LONDON="london"
GROUP_ZKEVM="zkevm"
GROUP_CANCUN="cancun"

# foundry.toml profile the london group builds under; cancun is the default profile
PROFILE_LONDON="london"

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
# GROUP BUILD SELECTION
# =============================================================================

# prepareGroupBuild GROUP [STRICT]
#   Exports the foundry profile GROUP builds and deploys under, then builds.
#   Selecting the profile through the environment keeps foundry.toml identical
#   to the commit, which the tree-reproducibility guard requires of a production
#   deploy. The export outlives this call on purpose: the deploy workers a caller
#   launches next inherit it. STRICT="true" makes a failed `forge build` return
#   non-zero (callers that must not deploy against a stale artifact set it); the
#   default keeps the original tolerant behavior for the playground runner.
function prepareGroupBuild() {
    local GROUP="${1:-}"
    local STRICT="${2:-false}"

    if [[ -z "$GROUP" ]]; then
        error "Group is required"
        return 1
    fi

    # Only under STRICT: the tolerant mode swallows build failures for the playground
    # runner and its two callers in multiNetworkExecution.sh rely on that, so refusing
    # there would abort a whole multi-network group on a mismatch the per-network gate
    # in deploySingleContract already refuses.
    if [[ "$STRICT" == "true" ]] && ! assertFoundryVersionOrFail; then
        return 1
    fi

    case "$GROUP" in
        "$GROUP_LONDON")
            export FOUNDRY_PROFILE="$PROFILE_LONDON"
            logWithTimestamp "Running forge build for London EVM group (FOUNDRY_PROFILE=$FOUNDRY_PROFILE)..."
            ;;
        "$GROUP_CANCUN")
            # A profile exported by a previous group or by the operator's shell must not
            # reach this build.
            unset FOUNDRY_PROFILE
            logWithTimestamp "Running forge build for Cancun EVM group..."
            ;;
        "$GROUP_ZKEVM")
            # zkEVM networks use the [profile.zksync] section; zksolc is pinned in foundry.toml [external.zksync] and exported via FOUNDRY_ZKSYNC (see helperFunctions.sh)
            # No standard forge build needed for zkEVM - compilation handled by deploy scripts.
            # out/ is nonetheless required to derive the CREATE2 deploy salt; deploySingleContract's
            # zk path ensures it per contract (ensureStandardArtifactForSalt).
            return 0
            ;;
        *)
            error "Unknown group: $GROUP"
            return 1
            ;;
    esac

    if [[ "$STRICT" == "true" ]]; then
        forge build || { error "forge build failed for $GROUP group"; return 1; }
    else
        forge build || true
    fi
}
