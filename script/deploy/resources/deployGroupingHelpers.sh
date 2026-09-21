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
PROFILE_LONDON="solc_floor"

# foundry.toml profile the zk toolchain builds under. Named, because its compiler pair is the
# default profile's and cannot tell the two apart.
PROFILE_ZKSYNC="zksync"

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

# assertLondonProfileDeclared: Refuses to export $PROFILE_LONDON when foundry.toml has no
# such section. forge falls back to [profile.default] with a warning and exit 0 when the
# named section is absent, so an unchecked export would ship a cancun build to a london
# chain on a green run.
#
# Usage: assertLondonProfileDeclared
#
# Returns: 0 when the section exists, 1 with an error otherwise
function assertLondonProfileDeclared() {
    if ! grep -q "^\[profile\.$PROFILE_LONDON\]" "${FOUNDRY_TOML_FILE_PATH:-foundry.toml}"; then
        error "foundry.toml has no [profile.$PROFILE_LONDON] section - refusing to build for a london network, because forge would silently fall back to [profile.default]"
        return 1
    fi
}

# selectFoundryProfileForNetwork: Makes FOUNDRY_PROFILE fit a single deploy to NETWORK.
# The direct entry points run no group build, so the profile forge compiles under is
# whatever the shell holds; a shell holding none would compile a london network's
# contract under [profile.default] and ship cancun opcodes to it.
#
# Usage: selectFoundryProfileForNetwork NETWORK
#   NETWORK - the network the next deploy targets
#
# Routing/Behavior:
#   - zkEVM network: nothing is selected and any inherited profile is cleared; the zk
#     build names its profile inline
#   - FOUNDRY_PROFILE unset, or exported by an earlier call of this function in the
#     same shell: exported as $PROFILE_LONDON for a london network, left unset for a
#     cancun one
#   - FOUNDRY_PROFILE exported by anything else (a group build, the operator's shell):
#     kept, and refused when its evm_version is not the network's targetEvmVersion
#
# Returns: 0 with FOUNDRY_PROFILE fitting NETWORK, 1 when the network's EVM version
#          cannot be read, the london section is missing, or the exported profile
#          builds for another EVM version
# Example: selectFoundryProfileForNetwork "fuse"
function selectFoundryProfileForNetwork() {
    local NETWORK="${1:-}"

    if [[ -z "$NETWORK" ]]; then
        error "Network name is required"
        return 1
    fi

    # Nothing is selected for zkEVM, but a profile the previous network in the loop
    # exported still has to go: deploySingleContract's zk path derives the CREATE2 salt
    # from the standard out/ (ensureStandardArtifactForSalt), and solc_floor writes
    # there too. Left set, it would decide that rebuild's bytecode and with it the
    # address. prepareGroupBuild clears it before the zkevm group for the same reason.
    if isZkEvmNetwork "$NETWORK"; then
        unset FOUNDRY_PROFILE
        unset FOUNDRY_PROFILE_SELECTED_FOR_NETWORK
        return 0
    fi

    if ! jq -e --arg network "$NETWORK" '.[$network] != null' "$NETWORKS_JSON_FILE_PATH" > /dev/null; then
        error "Network '$NETWORK' not found in networks.json - refusing to deploy"
        return 1
    fi

    # A row carrying targetEvmVersion as an empty string states nothing the active
    # profile can contradict; `localanvil`, which the deploy smoke test drives, is the
    # only one. A row missing the key altogether is a config error rather than a
    # statement, so it is refused instead of skipping the comparison below.
    if ! jq -e --arg network "$NETWORK" '.[$network] | has("targetEvmVersion")' "$NETWORKS_JSON_FILE_PATH" > /dev/null; then
        error "Network '$NETWORK' has no targetEvmVersion in networks.json - refusing to deploy"
        return 1
    fi

    # The evm_version comparison below cannot catch this one: [profile.zksync] declares
    # cancun and solc 0.8.29 like the default profile, so it reads as fitting every cancun
    # network - while its `script` and `out` keys would send the deploy to the zk script
    # directory and the zk artifact tree.
    if [[ "${FOUNDRY_PROFILE:-}" == "$PROFILE_ZKSYNC" ]]; then
        error "FOUNDRY_PROFILE=$PROFILE_ZKSYNC builds the zkEVM toolchain's script and artifact trees but $NETWORK is not a zkEVM network - refusing to deploy; unset FOUNDRY_PROFILE to let the network select its profile"
        return 1
    fi

    local TARGET_EVM_VERSION
    TARGET_EVM_VERSION=$(jq -r --arg network "$NETWORK" '.[$network].targetEvmVersion' "$NETWORKS_JSON_FILE_PATH")

    # Skipping the comparison is not the same as inheriting: in a scriptMaster-style loop a
    # profile an earlier network selected would otherwise decide this build, exactly as on
    # the zkEVM arm above.
    if [[ -z "$TARGET_EVM_VERSION" ]]; then
        if [[ -n "${FOUNDRY_PROFILE_SELECTED_FOR_NETWORK:-}" ]]; then
            unset FOUNDRY_PROFILE
            unset FOUNDRY_PROFILE_SELECTED_FOR_NETWORK
        fi
        return 0
    fi

    # scriptMaster deploys one contract to every network in a single loop, so a
    # profile this function exported for the previous network is re-selected rather
    # than read as the operator's choice.
    if [[ -n "${FOUNDRY_PROFILE_SELECTED_FOR_NETWORK:-}" ]]; then
        unset FOUNDRY_PROFILE
    fi

    if [[ -z "${FOUNDRY_PROFILE:-}" ]]; then
        if [[ "$TARGET_EVM_VERSION" == "$GROUP_LONDON" ]]; then
            assertLondonProfileDeclared || return 1
            export FOUNDRY_PROFILE="$PROFILE_LONDON"
        fi
        FOUNDRY_PROFILE_SELECTED_FOR_NETWORK="$NETWORK"
    fi

    local ACTIVE_EVM_VERSION
    ACTIVE_EVM_VERSION=$(getEvmVersion "$NETWORK") || return 1
    if [[ "$ACTIVE_EVM_VERSION" != "$TARGET_EVM_VERSION" ]]; then
        error "FOUNDRY_PROFILE=${FOUNDRY_PROFILE:-default} builds for evm $ACTIVE_EVM_VERSION but $NETWORK targets $TARGET_EVM_VERSION - refusing to deploy; unset FOUNDRY_PROFILE to let the network select its profile"
        return 1
    fi
}

# =============================================================================
# GROUP BUILD SELECTION
# =============================================================================

# prepareGroupBuild: Selects the foundry profile GROUP builds and deploys under, then builds.
# Selecting the profile through the environment keeps foundry.toml identical to the commit,
# which the tree-reproducibility guard requires of a production deploy. The exported profile
# outlives this call on purpose: the deploy workers a caller launches next inherit it. The
# zkevm group only clears the profile and returns without building; its compiler runs inside
# the deploy scripts.
#
# Usage: prepareGroupBuild GROUP [STRICT]
#   GROUP  - one of $GROUP_LONDON, $GROUP_CANCUN, $GROUP_ZKEVM
#   STRICT - "true" makes a failed `forge build` return non-zero; anything else keeps the
#            tolerant behavior the playground runner relies on (default: false)
#
# Returns: 0 on success (for $GROUP_ZKEVM: after clearing FOUNDRY_PROFILE, no build), 1 on
#          an unknown group, a missing group, a london group whose profile foundry.toml does
#          not declare, or (STRICT only) a failed foundry version check or build
# Example: prepareGroupBuild "$GROUP_LONDON" true
function prepareGroupBuild() {
    local GROUP="${1:-}"
    local STRICT="${2:-false}"

    if [[ -z "$GROUP" ]]; then
        error "Group is required"
        return 1
    fi

    # Only under STRICT: the tolerant mode swallows build failures for the playground
    # runner and its two callers in multiNetworkExecution.sh rely on that, so refusing
    # there would abort a whole multi-network group; deploySingleContract runs the same
    # check per network before it deploys.
    if [[ "$STRICT" == "true" ]] && ! assertFoundryVersionOrFail; then
        return 1
    fi

    case "$GROUP" in
        "$GROUP_LONDON")
            assertLondonProfileDeclared || return 1
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
            # zk path ensures it per contract (ensureStandardArtifactForSalt), which rebuilds when
            # the tree on disk was compiled under another profile. Clearing here keeps that rebuild
            # on the default profile rather than an earlier group's.
            unset FOUNDRY_PROFILE
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
