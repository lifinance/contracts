#!/bin/bash

# =============================================================================
# LibAsset v2.0.0 Upgrade Script
# =============================================================================
# This script handles the upgrade of contracts to use LibAsset v2.0.0
# It identifies contracts that need upgrading, redeploys them, and creates
# diamond cut proposals for the upgrade.
# =============================================================================

# Load required dependencies
source script/helperFunctions.sh
source script/multiNetworkExecution.sh
source script/deploy/deploySingleContract.sh
source script/tasks/diamondUpdateFacet.sh

# =============================================================================
# CONFIGURATION
# =============================================================================

# LibAsset v2.0.0 was introduced in commit b7d63f78d87603b97ab300dc2526f9a1dbee2917
# Date: May 6, 2025 (based on commit date from audit log)
LIBASSET_V2_COMMIT_DATE="2025-05-06"
LIBASSET_V2_COMMIT_HASH="b7d63f78d87603b97ab300dc2526f9a1dbee2917"

# Dry run mode - set to true for testing without making changes
DRY_RUN_MODE=true

# Filter mode for Step 2: which contracts require upgrade relative to commit date
# Options: "before" (default, include contracts deployed BEFORE the commit date), "after" (include contracts deployed AFTER)
: "${LIBASSET_FILTER_MODE:=before}"

# Contracts to always exclude from LibAsset upgrade flow (treated like diamonds)
EXCLUDED_FROM_UPGRADE=("OwnershipFacet")

# =============================================================================
# MAIN FUNCTIONS
# =============================================================================

function libAssetUpgrade() {
    local CHAIN_NAME="$1"
    local DRY_RUN="${2:-true}"

    if [[ -z "$CHAIN_NAME" ]]; then
        error "Usage: libAssetUpgrade CHAIN_NAME [--dry-run]"
        error "Example: libAssetUpgrade mainnet --dry-run"
        return 1
    fi

    # Set environment to production by default
    local ENVIRONMENT="production"

    # Convert dry run flag
    if [[ "$DRY_RUN" == "--dry-run" || "$DRY_RUN" == "true" ]]; then
        DRY_RUN_MODE=true
    else
        DRY_RUN_MODE=false
    fi

    echo ""
    echo "=========================================="
    echo "  LibAsset v2.0.0 Upgrade Process"
    echo "=========================================="
    echo "Chain: $CHAIN_NAME"
    echo "Environment: $ENVIRONMENT"
    echo "Dry Run Mode: $DRY_RUN_MODE"
    echo ""

    # Step 1: Get all contracts and classify them
    echo "Step 1: Classifying all contracts..."

    # Get all contract names from deployment file
    local DEPLOYMENT_FILE="./deployments/${CHAIN_NAME}.json"
    if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
        error "Deployment file not found: $DEPLOYMENT_FILE"
        return 1
    fi

    local ALL_CONTRACTS=($(jq -r 'keys[]' "$DEPLOYMENT_FILE"))
    echo "Found ${#ALL_CONTRACTS[@]} total contracts in deployment file"

    # Initialize classification arrays (not local to allow parseContractClassification to overwrite after review)
    LIBASSET_CONTRACTS=()
    NON_LIBASSET_CONTRACTS=()
    MISSING_CONTRACTS=()
    DIAMOND_CONTRACTS=()

    echo "Checking ${#ALL_CONTRACTS[@]} contracts for classification..."

    # Classify each contract
    for contract in "${ALL_CONTRACTS[@]}"; do
        if [[ "$contract" == "null" || -z "$contract" ]]; then
            continue
        fi

        echo "  Checking $contract..."

        # Skip actual diamond contracts (only LiFiDiamond and LiFiDiamondImmutable)
        if [[ "$contract" == "LiFiDiamond" || "$contract" == "LiFiDiamondImmutable" ]]; then
            DIAMOND_CONTRACTS+=("$contract")
            echo "    ⏭️  Added to diamond contracts"
            continue
        fi

        # Treat certain contracts as excluded (skip like diamonds)
        if echo " ${EXCLUDED_FROM_UPGRADE[*]} " | grep -q " $contract "; then
            DIAMOND_CONTRACTS+=("$contract")
            echo "    ⏭️  Excluded from upgrade flow"
            continue
        fi

        # Check if contract exists in archive (candidate for removal regardless of LibAsset usage)
        if contractExistsInArchive "$contract"; then
            MISSING_CONTRACTS+=("$contract")
            echo "    🗃️  Added to missing contracts (found in archive - candidate for removal)"
        # Check if contract uses LibAsset
        elif contractUsesLibAsset "$contract"; then
            LIBASSET_CONTRACTS+=("$contract")
            echo "    ✅ Added to LibAsset contracts"
        else
            # Check if contract exists in main codebase
            if contractExistsInCodebase "$contract"; then
                NON_LIBASSET_CONTRACTS+=("$contract")
                echo "    📝 Added to non-LibAsset contracts"
            else
                MISSING_CONTRACTS+=("$contract")
                echo "    ❌ Added to missing contracts (not found in codebase - candidate for removal)"
            fi
        fi
    done

    echo ""
    echo "Classification Results:"
    echo "Found ${#LIBASSET_CONTRACTS[@]} contracts using LibAsset:"
    printf "  %s\n" "${LIBASSET_CONTRACTS[@]}"
    echo ""

    # Save LibAsset contracts to a quick-reference file
    printf '%s\n' "${LIBASSET_CONTRACTS[@]}" > contractsUsingLibAsset.txt

    echo "Found ${#NON_LIBASSET_CONTRACTS[@]} contracts NOT using LibAsset:"
    printf "  %s\n" "${NON_LIBASSET_CONTRACTS[@]}"
    echo ""

    echo "Found ${#MISSING_CONTRACTS[@]} contracts MISSING from codebase (candidates for removal):"
    printf "  %s\n" "${MISSING_CONTRACTS[@]}"
    echo ""

    echo "Found ${#DIAMOND_CONTRACTS[@]} diamond contracts (will be skipped):"
    printf "  %s\n" "${DIAMOND_CONTRACTS[@]}"
    echo ""

    # Save all groups to a single file with 4 sections
    cat > "contractClassification.txt" << EOF
# Contract Classification for LibAsset v2.0.0 Upgrade
# Generated on: $(date)
# Chain: $CHAIN_NAME
#
# Instructions:
# 1. Review each section below
# 2. Move contracts between sections as needed
# 3. Add/remove contracts as necessary
# 4. Save this file when done
# 5. Press Enter to continue with Step 2
#
# =============================================================================
# SECTION 1: CONTRACTS USING LIBASSET (Need LibAsset v2.0.0 upgrade)
# =============================================================================
# These contracts import/use LibAsset and need to be upgraded
$(printf '%s\n' "${LIBASSET_CONTRACTS[@]}")

# =============================================================================
# SECTION 2: CONTRACTS NOT USING LIBASSET (No upgrade needed)
# =============================================================================
# These contracts exist in codebase but don't use LibAsset
$(printf '%s\n' "${NON_LIBASSET_CONTRACTS[@]}")

# =============================================================================
# SECTION 3: CONTRACTS MISSING FROM CODEBASE (Candidates for removal)
# =============================================================================
# These contracts are deployed but can't be found in current codebase
$(printf '%s\n' "${MISSING_CONTRACTS[@]}")

# =============================================================================
# SECTION 4: DIAMOND CONTRACTS (Will be skipped)
# =============================================================================
# These are diamond contracts that won't be processed
$(printf '%s\n' "${DIAMOND_CONTRACTS[@]}")
EOF

    echo "Saved contract classification to: contractClassification.txt"
    echo "  - ${#LIBASSET_CONTRACTS[@]} contracts using LibAsset"
    echo "  - ${#NON_LIBASSET_CONTRACTS[@]} contracts not using LibAsset"
    echo "  - ${#MISSING_CONTRACTS[@]} contracts missing from codebase"
    echo "  - ${#DIAMOND_CONTRACTS[@]} diamond contracts"
    echo ""

    # Interactive review step
    echo "📋 Step 1 Complete - Contract Classification"
    echo "File created: contractClassification.txt"
    echo ""
    echo "Please review the contractClassification.txt file and:"
    echo "  1. Move contracts between sections as needed"
    echo "  2. Add/remove contracts as necessary"
    echo "  3. Save the file when done"
    echo ""
    echo "Press Enter when ready to proceed to Step 2..."
    read -r

    # Parse the updated classification file
    echo "Parsing updated contractClassification.txt..."
    parseContractClassification

    # Step 2: Filter contracts deployed after LibAsset v2.0.0
    echo "Step 2: Filtering contracts deployed after LibAsset v2.0.0..."
    local UPGRADE_CANDIDATES=($(filterContractsForUpgrade "$CHAIN_NAME" "$ENVIRONMENT" "${LIBASSET_CONTRACTS[@]}"))

    if [[ ${#UPGRADE_CANDIDATES[@]} -eq 0 ]]; then
        echo "No contracts need upgrading on $CHAIN_NAME"
        return 0
    fi

    # Persist unique list then display from file to avoid dup/noise
    printf '%s\n' "${UPGRADE_CANDIDATES[@]}" | awk 'NF' | sort -u > "contractsToRedeploy.txt"
    local COUNT_SANITIZED=$(grep -cve '^\s*$' contractsToRedeploy.txt || true)
    echo "Found ${COUNT_SANITIZED} contracts that need upgrading:"
    sed 's/^/  /' contractsToRedeploy.txt
    echo ""

    echo "Saved contracts to redeploy to: contractsToRedeploy.txt"
    echo ""

    # Interactive review step
    echo "📋 Step 2 Complete - Contract Filtering by Deployment Date"
    echo "Files created:"
    echo "  - contractsToRedeploy.txt (${#UPGRADE_CANDIDATES[@]} contracts)"
    echo ""
    echo "These contracts were deployed after LibAsset v2.0.0 and need upgrading."
    echo "Please review the list and make any necessary adjustments."
    echo "Press Enter when ready to proceed to Step 3 (Redeployment)..."
    read -r

    # Reload the contract list after user review and sanitize (portable)
    UPGRADE_CANDIDATES=()
    if [[ -f "contractsToRedeploy.txt" ]]; then
        local DEPLOYMENT_FILE="./deployments/${CHAIN_NAME}.json"
        local TMP_VALID=$(mktemp)
        local HAS_VALID=0
        if [[ -f "$DEPLOYMENT_FILE" ]]; then
            jq -r 'keys[]' "$DEPLOYMENT_FILE" > "$TMP_VALID" 2>/dev/null || true
            if [[ -s "$TMP_VALID" ]]; then HAS_VALID=1; fi
        fi
        local TMP_SEEN=$(mktemp)
        : > "$TMP_SEEN"
        local TMP_OUT=$(mktemp)
        while IFS= read -r line; do
            # trim CRLF
            line="${line%%[$'\r\n']*}"
            # non-empty and simple name
            echo "$line" | grep -Eq '^[A-Za-z0-9_]+$' || continue
            # if we have a valid list, ensure it’s a deployed contract
            if [[ $HAS_VALID -eq 1 ]]; then
                if ! grep -Fxq -- "$line" "$TMP_VALID"; then
                    continue
                fi
            fi
            # dedupe preserve order
            if grep -Fxq -- "$line" "$TMP_SEEN"; then
                continue
            fi
            echo "$line" >> "$TMP_SEEN"
            echo "$line" >> "$TMP_OUT"
        done < "contractsToRedeploy.txt"
        # overwrite file with sanitized list
        if [[ -s "$TMP_OUT" ]]; then
            mv "$TMP_OUT" "contractsToRedeploy.txt"
        else
            : > "contractsToRedeploy.txt"
        fi
        # load into array
        while IFS= read -r c; do [[ -n "$c" ]] && UPGRADE_CANDIDATES+=("$c"); done < "contractsToRedeploy.txt"
        rm -f "$TMP_VALID" "$TMP_SEEN" 2>/dev/null || true
    fi
    echo "Loaded ${#UPGRADE_CANDIDATES[@]} contracts from contractsToRedeploy.txt after review"

    # Step 3: Redeploy contracts
    echo "Step 3: Redeploying contracts..."
    local REDEPLOYED_CONTRACTS=($(redeployContracts "$CHAIN_NAME" "$ENVIRONMENT" "${UPGRADE_CANDIDATES[@]}"))

    if [[ ${#REDEPLOYED_CONTRACTS[@]} -eq 0 ]]; then
        echo "No contracts were successfully redeployed"
        return 1
    fi

    echo "Successfully redeployed ${#REDEPLOYED_CONTRACTS[@]} contracts:"
    printf "  %s\n" "${REDEPLOYED_CONTRACTS[@]}"
    echo ""

    # Interactive review step
    echo "📋 Step 3 Complete - Contract Redeployment"
    echo "Successfully redeployed ${#REDEPLOYED_CONTRACTS[@]} contracts."
    echo "Check redeployLogs.json for detailed deployment information."
    echo ""
    echo "Press Enter when ready to proceed to Step 4 (Calldata Generation)..."
    read -r

    # Step 4: Generate diamond cut calldata
    echo "Step 4: Generating diamond cut calldata..."
    generateDiamondCutCalldata "$CHAIN_NAME" "$ENVIRONMENT" "${REDEPLOYED_CONTRACTS[@]}"

    # Step 5: Generate periphery registry update calldata
    echo "Step 5: Generating periphery registry update calldata..."
    generatePeripheryRegistryCalldata "$CHAIN_NAME" "$ENVIRONMENT" "${REDEPLOYED_CONTRACTS[@]}"

    # Step 6: Identify outdated facets for removal
    echo "Step 6: Identifying outdated facets for removal..."
    identifyOutdatedFacets "$CHAIN_NAME" "$ENVIRONMENT"

    # Interactive review step
    echo "📋 Steps 4-6 Complete - Calldata Generation"
    echo "Files created:"
    echo "  - diamondCutCalldata.tmp (diamond cut calldata)"
    echo "  - peripheryUpdateCalldata.tmp (periphery registry updates)"
    echo "  - outdatedFacets.txt (facets candidates for removal)"
    echo ""
    echo "Please review these files and make any necessary adjustments."
    echo "Press Enter when ready to proceed to Step 7 (Human Review)..."
    read -r

    # Step 7: Human review and confirmation
    echo "Step 7: Human review and confirmation..."
    reviewAndConfirm "$CHAIN_NAME" "$ENVIRONMENT"

    # Step 8: Create multisig proposals (if not in dry run mode and confirmed)
    if [[ "$DRY_RUN_MODE" == "false" && "$USER_CONFIRMED" == "true" ]]; then
        echo "Step 8: Creating multisig proposals..."
        createMultisigProposals "$CHAIN_NAME" "$ENVIRONMENT"
    fi

    echo ""
    echo "=========================================="
    echo "  LibAsset v2.0.0 Upgrade Complete"
    echo "=========================================="
    echo "Review the generated calldata files before creating proposals"
    echo "Output files:"
    echo "  - contractsUsingLibAsset.txt"
    echo "  - contractsToRedeploy.txt"
    echo "  - redeployLogs.json"
    echo "  - diamondCutCalldata.tmp"
    echo "  - peripheryUpdateCalldata.tmp"
    echo ""

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        echo "🔍 DRY RUN MODE: No actual changes were made"
        echo "To execute the upgrade, run without --dry-run flag"
    fi
    echo ""
}

function reviewAndConfirm() {
    local CHAIN_NAME="$1"
    local ENVIRONMENT="$2"

    echo ""
    echo "=========================================="
    echo "  HUMAN REVIEW REQUIRED"
    echo "=========================================="
    echo ""
    echo "Please review the following before proceeding:"
    echo ""
    echo "1. contractsUsingLibAsset.txt - Contracts that use LibAsset"
    echo "2. contractsToRedeploy.txt - Contracts that need upgrading"
    echo "3. redeployLogs.json - Addresses of redeployed contracts"
    echo "4. diamondCutCalldata.tmp - Diamond cut calldata"
    echo "5. peripheryUpdateCalldata.tmp - Periphery registry calldata"
    echo ""

    if [[ "$DRY_RUN_MODE" == "true" ]]; then
        echo "🔍 DRY RUN MODE: No actual changes will be made"
        echo "This is a preview of what would happen in live mode"
        echo ""
        USER_CONFIRMED="true"
        return 0
    fi

    echo "⚠️  LIVE MODE: This will make actual changes to the blockchain"
    echo ""
    echo "Do you want to proceed with creating multisig proposals? (yes/no)"
    read -r USER_INPUT

    if [[ "$USER_INPUT" == "yes" || "$USER_INPUT" == "y" ]]; then
        USER_CONFIRMED="true"
        echo "✅ User confirmed - proceeding with multisig proposals"
    else
        USER_CONFIRMED="false"
        echo "❌ User declined - skipping multisig proposals"
    fi
}

function identifyLibAssetContracts() {
    local NETWORK="$1"
    local ENVIRONMENT="$2"

    local CONTRACTS=()
    local DEPLOYMENT_FILE="./deployments/${NETWORK}.json"

    if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
        error "Deployment file not found: $DEPLOYMENT_FILE"
        return 1
    fi

    # Get all contract names from deployment file
    local ALL_CONTRACTS=($(jq -r 'keys[]' "$DEPLOYMENT_FILE"))

    echo "Checking ${#ALL_CONTRACTS[@]} contracts for LibAsset usage..." >&2

    # Check each contract for LibAsset usage
    for contract in "${ALL_CONTRACTS[@]}"; do
        if [[ "$contract" == "null" || -z "$contract" ]]; then
            continue
        fi

        # Skip diamond contracts
        if [[ "$contract" == *"Diamond"* ]]; then
            echo "  ⏭️  Skipping diamond contract: $contract" >&2
            continue
        fi

        echo "  Checking $contract..." >&2
        # Check if contract uses LibAsset by examining source code
        if contractUsesLibAsset "$contract"; then
            CONTRACTS+=("$contract")
            echo "    ✅ Added $contract to LibAsset contracts list" >&2
        else
            echo "    ❌ $contract does not use LibAsset - skipping" >&2
        fi
    done

    printf '%s\n' "${CONTRACTS[@]}"
}

function contractUsesLibAsset() {
    local CONTRACT="$1"

    # Search for source files in all possible locations
    local SOURCE_FILES=()

    # Check common source file locations
    for dir in "src/Facets" "src/Periphery" "src/Libraries" "src/Helpers" "src/Interfaces"; do
        if [[ -f "${dir}/${CONTRACT}.sol" ]]; then
            SOURCE_FILES+=("${dir}/${CONTRACT}.sol")
        fi
    done

    # If no source file found, try to find any .sol file with the contract name
    if [[ ${#SOURCE_FILES[@]} -eq 0 ]]; then
        local FOUND_FILES=($(find src -name "${CONTRACT}.sol" 2>/dev/null))
        if [[ ${#FOUND_FILES[@]} -gt 0 ]]; then
            SOURCE_FILES=("${FOUND_FILES[@]}")
        fi
    fi

    # If still no source file found, assume it doesn't use LibAsset
    if [[ ${#SOURCE_FILES[@]} -eq 0 ]]; then
        return 1
    fi

    # Check if any of the source files imports or uses LibAsset
    for source_file in "${SOURCE_FILES[@]}"; do
        if grep -q "LibAsset" "$source_file" 2>/dev/null; then
            return 0
        fi
    done

    return 1
}

function contractExistsInCodebase() {
    local CONTRACT="$1"

    # Search for source files in main codebase only (not archive)
    local SOURCE_FILES=()

    # Check main source directories only
    for dir in "src/Facets" "src/Periphery" "src/Libraries" "src/Helpers" "src/Interfaces"; do
        if [[ -f "${dir}/${CONTRACT}.sol" ]]; then
            SOURCE_FILES+=("${dir}/${CONTRACT}.sol")
        fi
    done

    # If no source file found, try to find any .sol file with the contract name in src only
    if [[ ${#SOURCE_FILES[@]} -eq 0 ]]; then
        local FOUND_FILES=($(find src -name "${CONTRACT}.sol" 2>/dev/null))
        if [[ ${#FOUND_FILES[@]} -gt 0 ]]; then
            SOURCE_FILES=("${FOUND_FILES[@]}")
        fi
    fi

    # Return true if any source file was found
    if [[ ${#SOURCE_FILES[@]} -gt 0 ]]; then
        return 0
    fi

    return 1
}

function contractExistsInArchive() {
    local CONTRACT="$1"
    local ARCHIVE_FILES=($(find archive -name "${CONTRACT}.sol" 2>/dev/null))

    if [[ ${#ARCHIVE_FILES[@]} -gt 0 ]]; then
        return 0
    fi

    return 1
}

function parseContractClassification() {
    local CLASSIFICATION_FILE="contractClassification.txt"

    if [[ ! -f "$CLASSIFICATION_FILE" ]]; then
        error "Classification file not found: $CLASSIFICATION_FILE"
        return 1
    fi

    # Clear arrays
    LIBASSET_CONTRACTS=()
    NON_LIBASSET_CONTRACTS=()
    MISSING_CONTRACTS=()
    DIAMOND_CONTRACTS=()

    local current_section=""

    while IFS= read -r line; do
        # Skip empty lines and comments
        if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
            # Check for section headers
            if [[ "$line" =~ "SECTION 1" ]]; then
                current_section="libasset"
            elif [[ "$line" =~ "SECTION 2" ]]; then
                current_section="non_libasset"
            elif [[ "$line" =~ "SECTION 3" ]]; then
                current_section="missing"
            elif [[ "$line" =~ "SECTION 4" ]]; then
                current_section="diamond"
            fi
            continue
        fi

        # Remove leading/trailing whitespace and comments
        local contract=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed 's/#.*$//')

        # Skip empty lines after processing
        if [[ -z "$contract" ]]; then
            continue
        fi

        # Add to appropriate array based on current section
        case "$current_section" in
            "libasset")
                LIBASSET_CONTRACTS+=("$contract")
                ;;
            "non_libasset")
                NON_LIBASSET_CONTRACTS+=("$contract")
                ;;
            "missing")
                MISSING_CONTRACTS+=("$contract")
                ;;
            "diamond")
                DIAMOND_CONTRACTS+=("$contract")
                ;;
        esac
    done < "$CLASSIFICATION_FILE"

    echo "Parsed contract classification:" >&2
    echo "  - ${#LIBASSET_CONTRACTS[@]} contracts using LibAsset" >&2
    echo "  - ${#NON_LIBASSET_CONTRACTS[@]} contracts not using LibAsset" >&2
    echo "  - ${#MISSING_CONTRACTS[@]} contracts missing from codebase" >&2
    echo "  - ${#DIAMOND_CONTRACTS[@]} diamond contracts" >&2
    echo "" >&2
}

function filterContractsForUpgrade() {
    local NETWORK="$1"
    local ENVIRONMENT="$2"
    shift 2
    local CONTRACTS=("$@")

    echo "Checking deployment dates for ${#CONTRACTS[@]} contracts..." >&2

    # concurrency settings (env FILTER_MAX_JOBS overrides, else use MAX_CONCURRENT_JOBS from config.sh, else 8)
    local MAX_JOBS=${FILTER_MAX_JOBS:-${MAX_CONCURRENT_JOBS:-8}}
    echo "Using up to $MAX_JOBS parallel jobs" >&2
    local TMPDIR
    TMPDIR=$(mktemp -d)
    : >"$TMPDIR/upgrade"
    : >"$TMPDIR/skip"

    # background worker function
    _filter_worker() {
        local contract="$1"
        local network="$2"
        local environment="$3"

        # Skip excluded contracts even if present due to manual edits
        if echo " ${EXCLUDED_FROM_UPGRADE[*]} " | grep -q " $contract "; then
            echo "  Skipping excluded contract: $contract" >&2
            return 0
        fi

        echo "  Checking $contract..." >&2
        local DEPLOYMENT_DATE
        DEPLOYMENT_DATE=$(getContractDeploymentDate "$contract" "$network" "$environment")

        if [[ "$DEPLOYMENT_DATE" == "unknown" ]]; then
            echo "    ⚠️  Unknown deployment date - including for upgrade (safer approach)" >&2
            printf '%s\n' "$contract" >>"$TMPDIR/upgrade"
        elif [[ "$LIBASSET_FILTER_MODE" == "after" && "$DEPLOYMENT_DATE" > "$LIBASSET_V2_COMMIT_DATE" ]]; then
            echo "    ✅ Deployed after LibAsset v2.0.0 ($DEPLOYMENT_DATE) - needs upgrade" >&2
            printf '%s\n' "$contract" >>"$TMPDIR/upgrade"
        elif [[ "$LIBASSET_FILTER_MODE" == "before" && "$DEPLOYMENT_DATE" < "$LIBASSET_V2_COMMIT_DATE" ]]; then
            echo "    ✅ Deployed before LibAsset v2.0.0 ($DEPLOYMENT_DATE) - needs upgrade" >&2
            printf '%s\n' "$contract" >>"$TMPDIR/upgrade"
        else
            echo "    ⏭️  Skipping $contract ($DEPLOYMENT_DATE)" >&2
            printf '%s\n' "$contract" >>"$TMPDIR/skip"
        fi
    }

    # spawn workers with throttling
    local PIDS=()
    for contract in "${CONTRACTS[@]}"; do
        (_filter_worker "$contract" "$NETWORK" "$ENVIRONMENT") &
        PIDS+=("$!")
        if ((${#PIDS[@]} >= MAX_JOBS)); then
            wait "${PIDS[0]}"
            PIDS=("${PIDS[@]:1}")
        fi
    done
    # wait remaining
    for pid in "${PIDS[@]}"; do
        wait "$pid"
    done

    # (No extra logic here — removal-only cuts handled in generateDiamondCutCalldata)

    # Read results (portable, no mapfile)
    local UPGRADE_CANDIDATES=()
    if [[ -s "$TMPDIR/upgrade" ]]; then
        while IFS= read -r _c; do [[ -n "$_c" ]] && UPGRADE_CANDIDATES+=("$_c"); done < "$TMPDIR/upgrade"
    fi
    local SKIPPED_CONTRACTS=()
    if [[ -s "$TMPDIR/skip" ]]; then
        while IFS= read -r _s; do [[ -n "$_s" ]] && SKIPPED_CONTRACTS+=("$_s"); done < "$TMPDIR/skip"
    fi

    echo "" >&2
    echo "Summary:" >&2
    echo "  Contracts needing upgrade: ${#UPGRADE_CANDIDATES[@]}" >&2
    echo "  Contracts skipped: ${#SKIPPED_CONTRACTS[@]}" >&2
    echo "" >&2

    # Output upgrade candidates one per line
    printf '%s\n' "${UPGRADE_CANDIDATES[@]}"

    # cleanup temp dir
    rm -rf "$TMPDIR" 2>/dev/null || true
}

function contractNeedsUpgrade() {
    local NETWORK="$1"
    local ENVIRONMENT="$2"
    local CONTRACT="$3"

    # Get deployment date from master log
    local DEPLOYMENT_DATE=$(getContractDeploymentDate "$CONTRACT" "$NETWORK" "$ENVIRONMENT")

    if [[ -z "$DEPLOYMENT_DATE" ]]; then
        echo "Warning: Could not determine deployment date for $CONTRACT on $NETWORK"
        return 1
    fi

    # Compare dates (assuming YYYY-MM-DD format)
    if [[ "$DEPLOYMENT_DATE" > "$LIBASSET_V2_COMMIT_DATE" ]]; then
        return 0  # Contract was deployed after LibAsset v2.0.0, needs upgrade
    else
        return 1  # Contract was deployed before LibAsset v2.0.0, no upgrade needed
    fi
}

function getContractDeploymentDate() {
    local CONTRACT="$1"
    local NETWORK="$2"
    local ENVIRONMENT="$3"

    # 1) Prefer MongoDB: get the latest deployment entry regardless of version
    if isMongoLoggingEnabled; then
        local MONGO_JSON=$(getLatestMongoDeployment "$CONTRACT" "$NETWORK" "$ENVIRONMENT" 2>/dev/null || true)
        if [[ -n "$MONGO_JSON" && "$MONGO_JSON" != "null" ]]; then
            # Accept either lowercase or uppercase keys
            local TS=$(echo "$MONGO_JSON" | jq -r '(.timestamp // .TIMESTAMP) // empty' 2>/dev/null)
            if [[ -n "$TS" ]]; then
                local DEPLOYMENT_DATE=""
                if echo "$TS" | grep -Eq '^[0-9]+$'; then
                    # numeric epoch (ms or s)
                    if [[ ${#TS} -ge 13 ]]; then
                        TS=$((TS/1000))
                    fi
                    DEPLOYMENT_DATE=$(date -r "$TS" "+%Y-%m-%d" 2>/dev/null || true)
                elif echo "$TS" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
                    # ISO date string, use the date part
                    DEPLOYMENT_DATE="${TS:0:10}"
                fi
                if [[ -n "$DEPLOYMENT_DATE" ]]; then
                    echo "$DEPLOYMENT_DATE"
                    return 0
                fi
            fi
        fi
    fi

    # 2) Fallback: try via versioned lookup (Mongo or JSON)
    local VERSION=$(getHighestDeployedContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$CONTRACT")
    if [[ -n "$VERSION" ]]; then
        local LOG_ENTRY=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" 2>/dev/null)
        if [[ -n "$LOG_ENTRY" && "$LOG_ENTRY" != "null" ]]; then
            local TIMESTAMP=$(echo "$LOG_ENTRY" | jq -r '(.timestamp // .TIMESTAMP) // empty' 2>/dev/null)
            if [[ -n "$TIMESTAMP" ]]; then
                local DEPLOYMENT_DATE=""
                if echo "$TIMESTAMP" | grep -Eq '^[0-9]+$'; then
                    if [[ ${#TIMESTAMP} -ge 13 ]]; then
                        TIMESTAMP=$((TIMESTAMP/1000))
                    fi
                    DEPLOYMENT_DATE=$(date -r "$TIMESTAMP" "+%Y-%m-%d" 2>/dev/null || true)
                elif echo "$TIMESTAMP" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
                    DEPLOYMENT_DATE="${TIMESTAMP:0:10}"
                fi
                if [[ -n "$DEPLOYMENT_DATE" ]]; then
                    echo "$DEPLOYMENT_DATE"
                    return 0
                fi
            fi
        fi
    fi

    # If we can't get the date, assume it needs upgrading (safer approach)
    echo "unknown"
    return 1
}

function redeployContracts() {
    local NETWORK="$1"
    local ENVIRONMENT="$2"
    shift 2
    local CONTRACTS=("$@")

    local REDEPLOYED=()
    local LOG_FILE="redeployLogs.json"
    local LOG_JSON="{}"
    if [[ -f "$LOG_FILE" ]]; then
        LOG_JSON=$(cat "$LOG_FILE")
    fi

    for contract in "${CONTRACTS[@]}"; do
        echo "Redeploying $contract on $NETWORK..." >&2
        local OLD_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$contract")

        if [[ "$DRY_RUN_MODE" == "true" ]]; then
            echo "  [DRY RUN] Would redeploy $contract" >&2
            # In dry-run, keep newAddress same as current to allow downstream analysis
            local NEW_ADDRESS="$OLD_ADDRESS"
            local TS=$(date +%s)
            LOG_JSON=$(echo "$LOG_JSON" | jq --arg c "$contract" --arg old "$OLD_ADDRESS" --arg new "$NEW_ADDRESS" --arg ts "$TS" '.[$c] = {oldAddress:$old, newAddress:$new, timestamp: ($ts|tonumber), dryRun:true}')
            REDEPLOYED+=("$contract")
        else
            # Get current version
            local VERSION=$(getCurrentContractVersion "$contract")
            if [[ -z "$VERSION" ]]; then
                echo "  Error: Could not determine version for $contract" >&2
                continue
            fi

            # Deploy contract
            if deploySingleContract "$contract" "$NETWORK" "$ENVIRONMENT" "$VERSION" false; then
                echo "  Successfully redeployed $contract" >&2
                REDEPLOYED+=("$contract")
                # Capture new address from deployments file
                local NEW_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$contract")
                local TS=$(date +%s)
                LOG_JSON=$(echo "$LOG_JSON" | jq --arg c "$contract" --arg old "$OLD_ADDRESS" --arg new "$NEW_ADDRESS" --arg ts "$TS" '.[$c] = {oldAddress:$old, newAddress:$new, timestamp: ($ts|tonumber), dryRun:false}')
            else
                echo "  Failed to redeploy $contract" >&2
            fi
        fi
    done

    # Persist redeploy log (also in dry-run for review)
    echo "$LOG_JSON" | jq . > "$LOG_FILE"

    printf '%s\n' "${REDEPLOYED[@]}"
}

function generateDiamondCutCalldata() {
    local CHAIN_NAME="$1"
    local ENVIRONMENT="$2"
    shift 2
    local CONTRACTS=("$@")

    local CALLDATA_FILE="diamondCutCalldata.tmp"
    local TMP_CALLDATA_FILE="/tmp/diamond_cut_calldata_${CHAIN_NAME}_${ENVIRONMENT}.txt"
    local DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$CHAIN_NAME" "$ENVIRONMENT" "LiFiDiamond")

    if [[ -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" ]]; then
        error "Could not find LiFiDiamond address on $CHAIN_NAME"
        return 1
    fi

    echo "Generating diamond cut calldata for $CHAIN_NAME..."
    echo "Diamond Address: $DIAMOND_ADDRESS"

    # RPC URL for on-chain reads
    local RPC_URL=$(getRPCUrl "$CHAIN_NAME" "$ENVIRONMENT")

    # Build cuts: separate arrays for add, replace, remove
    local CUTS_JSON_ARRAY="[]"
    local CHANGES_REPORT=()
    local REVIEW_REPORT=""

    # Load redeploy logs to map old/new addresses
    local REDEPLOY_LOG_FILE="redeployLogs.json"
    local REDEPLOY_JSON="{}"
    if [[ -f "$REDEPLOY_LOG_FILE" ]]; then
        REDEPLOY_JSON=$(cat "$REDEPLOY_LOG_FILE")
    fi

    for contract in "${CONTRACTS[@]}"; do
        if [[ "$contract" != *"Facet"* ]]; then
            continue
        fi

        # New facet address (post-deploy, or current if dry-run)
        local NEW_ADDR=$(getContractAddressFromDeploymentLogs "$CHAIN_NAME" "$ENVIRONMENT" "$contract")

        # Old facet address from redeploy logs if available; otherwise try to match by selectors mapping
        local OLD_ADDR=$(echo "$REDEPLOY_JSON" | jq -r --arg c "$contract" '.[$c].oldAddress // empty' 2>/dev/null)

        # Fallback: try to find current facet for this contract by name if old address not in log
        if [[ -z "$OLD_ADDR" ]]; then
            # Walk current facets and try to match by function selectors overlap if ABI available
            : # keep empty for now; selector matching without ABI can be flaky
        fi

        # Compute new selectors from ABI/source
        local NEW_SELECTORS=($(getFunctionSelectorsFromContractABI "$contract"))
        if [[ ${#NEW_SELECTORS[@]} -eq 0 ]]; then
            echo "  Warning: Could not determine function selectors for $contract"
            continue
        fi

        # Compute current selectors for OLD_ADDR from diamond
        local CUR_SELECTORS=()
        if [[ -n "$OLD_ADDR" ]]; then
            # Query selectors for old facet address via loupe
            local RAW_SEL=$(cast call "$DIAMOND_ADDRESS" "facetFunctionSelectors(address) returns (bytes4[])" "$OLD_ADDR" --rpc-url "$RPC_URL" 2>/dev/null)
            if [[ -n "$RAW_SEL" ]]; then
                # Normalize output like [0x..., 0x...] into array
                RAW_SEL=$(echo "$RAW_SEL" | tr -d '[]' | tr ',' ' ')
                # shellcheck disable=SC2206
                CUR_SELECTORS=($RAW_SEL)
            fi
        fi

        # Set operations using sort+comm (portable)
        local TMP_NEW=$(mktemp)
        local TMP_CUR=$(mktemp)
        printf '%s\n' "${NEW_SELECTORS[@]}" | awk 'NF' | sort -u > "$TMP_NEW"
        printf '%s\n' "${CUR_SELECTORS[@]}" | awk 'NF' | sort -u > "$TMP_CUR"

        # ADDED: new - cur
        local ADDED=($(comm -23 "$TMP_NEW" "$TMP_CUR" 2>/dev/null || true))
        # REPLACED: intersection
        local REPLACED=($(comm -12 "$TMP_NEW" "$TMP_CUR" 2>/dev/null || true))
        # REMOVED: cur - new
        local REMOVED=($(comm -13 "$TMP_CUR" "$TMP_NEW" 2>/dev/null || true))

        # Build cuts only when the new facet address differs from old (avoid no-op in dry-run)
        # macOS bash-compatible lowercase comparison
        local NEW_ADDR_LC=$(echo "$NEW_ADDR" | tr '[:upper:]' '[:lower:]')
        local OLD_ADDR_LC=$(echo "${OLD_ADDR:-}" | tr '[:upper:]' '[:lower:]')
        if [[ -n "$NEW_ADDR" && ( -z "$OLD_ADDR" || "$NEW_ADDR_LC" != "$OLD_ADDR_LC" ) ]]; then
            # Action: 0=Add, 1=Replace, 2=Remove
            if [[ ${#REPLACED[@]} -gt 0 ]]; then
                local REPLACED_JSON=$(printf '%s\n' "${REPLACED[@]}" | jq -R . | jq -s .)
                CUTS_JSON_ARRAY=$(echo "$CUTS_JSON_ARRAY" | jq --arg addr "$NEW_ADDR" --argjson sels "$REPLACED_JSON" '. + [[{"facet":$addr,"action":1,"selectors":$sels}]] | flatten')
            fi
            if [[ ${#ADDED[@]} -gt 0 ]]; then
                local ADDED_JSON=$(printf '%s\n' "${ADDED[@]}" | jq -R . | jq -s .)
                CUTS_JSON_ARRAY=$(echo "$CUTS_JSON_ARRAY" | jq --arg addr "$NEW_ADDR" --argjson sels "$ADDED_JSON" '. + [[{"facet":$addr,"action":0,"selectors":$sels}]] | flatten')
            fi
        fi
        if [[ ${#REMOVED[@]} -gt 0 ]]; then
            local REMOVED_JSON=$(printf '%s\n' "${REMOVED[@]}" | jq -R . | jq -s .)
            CUTS_JSON_ARRAY=$(echo "$CUTS_JSON_ARRAY" | jq --argjson sels "$REMOVED_JSON" '. + [[{"facet":"0x0000000000000000000000000000000000000000","action":2,"selectors":$sels}]] | flatten')
        fi

        # Change report line for summary
        CHANGES_REPORT+=("$contract | add:${#ADDED[@]} replace:${#REPLACED[@]} remove:${#REMOVED[@]} | old:${OLD_ADDR:-unknown} -> new:${NEW_ADDR}")

        # Detailed selectors review block
        {
            echo "## $contract"
            echo "old: ${OLD_ADDR:-unknown}"
            echo "new: ${NEW_ADDR:-unknown}"
            echo "new_selectors (${#NEW_SELECTORS[@]}):"
            for s in "${NEW_SELECTORS[@]}"; do echo "  - $s"; done
            if [[ ${#CUR_SELECTORS[@]} -gt 0 ]]; then
                echo "current_selectors (${#CUR_SELECTORS[@]}):"
                for s in "${CUR_SELECTORS[@]}"; do echo "  - $s"; done
            fi
            echo "added (${#ADDED[@]}):"
            for s in "${ADDED[@]}"; do echo "  - $s"; done
            echo "replaced (${#REPLACED[@]}):"
            for s in "${REPLACED[@]}"; do echo "  - $s"; done
            echo "removed (${#REMOVED[@]}):"
            for s in "${REMOVED[@]}"; do echo "  - $s"; done
            echo
        } >> "$CALLDATA_FILE.selectors.tmp"
    done

    # Attempt to build calldata via cast if possible
    local CALLDATA=""
    if command -v cast >/dev/null 2>&1; then
        # Convert CUTS_JSON_ARRAY to the tuple format expected by diamondCut: (address,uint8,bytes4[])[]
        # Build a string literal for cast with proper struct order
        local TUPLES=$(echo "$CUTS_JSON_ARRAY" | jq -c '[.[] | [ .facet, .action, .selectors ]]')
        # Use abi signature matching the DiamondCutFacet
        CALLDATA=$(cast calldata "diamondCut((address,uint8,bytes4[])[],address,bytes)" "$TUPLES" "0x0000000000000000000000000000000000000000" "0x" 2>/dev/null || echo "")
    fi

    # Write review file in repo and temp file for proposer
    {
        echo "# Diamond Cut Calldata for $CHAIN_NAME ($ENVIRONMENT)"
        echo "# Generated on: $(date)"
        echo "# Diamond Address: $DIAMOND_ADDRESS"
        echo ""
        if [[ -n "$CALLDATA" ]]; then
            echo "CALLDATA=$CALLDATA"
        else
            echo "# CALLDATA could not be generated locally. Use the JSON cuts below to build calldata."
        fi
        echo ""
        echo "# Cuts JSON (review):"
        echo "$CUTS_JSON_ARRAY" | jq .
        echo ""
        echo "# Summary:"
        printf "%s\n" "${CHANGES_REPORT[@]}"
        echo ""
        echo "# Selectors Review:"
        if [[ -f "$CALLDATA_FILE.selectors.tmp" ]]; then
            cat "$CALLDATA_FILE.selectors.tmp"
        else
            echo "No facet selectors to review."
        fi
    } > "$CALLDATA_FILE"

    # Also write proposer temp file if CALLDATA is available
    if [[ -n "$CALLDATA" ]]; then
        echo "CALLDATA=$CALLDATA" > "$TMP_CALLDATA_FILE"
    fi

    echo "Diamond cut output written to: $CALLDATA_FILE"
    [[ -n "$CALLDATA" ]] && echo "Proposer calldata saved: $TMP_CALLDATA_FILE"
    rm -f "$CALLDATA_FILE.selectors.tmp" 2>/dev/null || true
}

## Deprecated: replaced by generateDiamondCutCalldata’s inline logic
processFacetForDiamondCut() { :; }

function generatePeripheryRegistryCalldata() {
    local CHAIN_NAME="$1"
    local ENVIRONMENT="$2"
    shift 2
    local CONTRACTS=("$@")

    local CALLDATA_FILE="peripheryUpdateCalldata.tmp"
    local TMP_CALLDATA_FILE="/tmp/periphery_registry_calldata_${CHAIN_NAME}_${ENVIRONMENT}.txt"
    local DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$CHAIN_NAME" "$ENVIRONMENT" "LiFiDiamond")

    if [[ -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" ]]; then
        error "Could not find LiFiDiamond address on $CHAIN_NAME"
        return 1
    fi

    echo "Generating periphery registry calldata for $CHAIN_NAME..."

    local CALLDATA_ARRAY=()

    # Process each periphery contract
    for contract in "${CONTRACTS[@]}"; do
        if [[ "$contract" != *"Facet"* ]]; then
            local NEW_ADDRESS=$(getContractAddressFromDeploymentLogs "$CHAIN_NAME" "$ENVIRONMENT" "$contract")
            if [[ -n "$NEW_ADDRESS" && "$NEW_ADDRESS" != "null" ]]; then
                local CALLDATA=$(cast calldata "registerPeripheryContract(string,address)" "$contract" "$NEW_ADDRESS")
                CALLDATA_ARRAY+=("$CALLDATA")
                echo "  Added periphery update for $contract: $NEW_ADDRESS"
            fi
        fi
    done

    # Write to files
    {
        echo "# Periphery Registry Calldata for $CHAIN_NAME ($ENVIRONMENT)"
        echo "# Generated on: $(date)"
        echo "# Diamond Address: $DIAMOND_ADDRESS"
        echo ""
        echo "# Individual calldata for each contract:"
        printf '%s\n' "${CALLDATA_ARRAY[@]}" | nl -v0 | sed 's/^[[:space:]]*\([0-9]*\)[[:space:]]*/CALLDATA_\1=/' | sed 's/$/\\/'
    } > "$CALLDATA_FILE"

    # Also store in temp file for proposer if any
    if [[ ${#CALLDATA_ARRAY[@]} -gt 0 ]]; then
        : > "$TMP_CALLDATA_FILE"
        local idx=0
        for c in "${CALLDATA_ARRAY[@]}"; do
            echo "CALLDATA_${idx}=${c}" >> "$TMP_CALLDATA_FILE"
            idx=$((idx+1))
        done
    fi

    echo "Periphery registry calldata written to: $CALLDATA_FILE"
}

function identifyOutdatedFacets() {
    local NETWORK="$1"
    local ENVIRONMENT="$2"

    local OUTDATED_FILE="/tmp/outdated_facets_${NETWORK}_${ENVIRONMENT}.txt"
    local OUTDATED_LOCAL="outdatedFacets.txt"
    local TARGET_STATE_FILE="./target_vs_deployed_production.txt"

    echo "Identifying outdated facets for removal on $NETWORK..."

    # Get current facets from diamond
    local DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")
    if [[ -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" ]]; then
        error "Could not find LiFiDiamond address on $NETWORK"
        return 1
    fi

    local RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")
    local RAW_ADDRS=$(cast call "$DIAMOND_ADDRESS" "facetAddresses() returns (address[])" --rpc-url "$RPC_URL" 2>/dev/null)

    if [[ -z "$RAW_ADDRS" ]]; then
        echo "  Warning: Could not retrieve current facet addresses from diamond" >&2
        return 1
    fi

    # Extract addresses robustly and normalize
    local CURRENT_FACET_ADDRESSES=($(echo "$RAW_ADDRS" | grep -o '0x[0-9a-fA-F]\{40\}' | tr '[:upper:]' '[:lower:]'))

    # Get required facets from target state and normalize
    local REQUIRED_FACETS=($(getRequiredFacetsFromTargetState "$NETWORK" "$ENVIRONMENT"))
    local REQUIRED_FACETS_LC=()
    for a in "${REQUIRED_FACETS[@]}"; do REQUIRED_FACETS_LC+=("$(echo "$a" | tr '[:upper:]' '[:lower:]')"); done

    # Find outdated facets (present on diamond but not in target state)
    local OUTDATED_FACETS=()
    local CURRENT_SET_TMP=$(mktemp)
    : > "$CURRENT_SET_TMP"
    for a in "${CURRENT_FACET_ADDRESSES[@]}"; do echo "$a" >> "$CURRENT_SET_TMP"; done

    for facet_address in "${CURRENT_FACET_ADDRESSES[@]}"; do
        local is_required=0
        for required_facet in "${REQUIRED_FACETS_LC[@]}"; do
            if [[ "$facet_address" == "$required_facet" ]]; then is_required=1; break; fi
        done

        if [[ $is_required -eq 0 ]]; then
            # Resolve name from deployment logs (diamond files) or fallback to network deployments
            local contract_name=$(findContractNameByAddress "$facet_address" "$NETWORK" "$ENVIRONMENT")
            if [[ -z "$contract_name" ]]; then
                contract_name=$(getFacetNameFromDiamondByAddress "$NETWORK" "$ENVIRONMENT" "$facet_address")
            fi
            if [[ -z "$contract_name" ]]; then
                contract_name="Unknown"
            fi
            OUTDATED_FACETS+=("$contract_name:$facet_address")
        fi
    done

    # Include Section 3 (missing from codebase) facets if currently registered
    parseContractClassification
    if [[ ${#MISSING_CONTRACTS[@]} -gt 0 ]]; then
        for name in "${MISSING_CONTRACTS[@]}"; do
            # Only consider facet-like names
            if [[ "$name" != *"Facet"* ]]; then continue; fi
            local facet_addr=$(getFacetAddressFromDiamondByName "$NETWORK" "$ENVIRONMENT" "$name")
            if [[ -n "$facet_addr" ]]; then
                local addr_lc=$(echo "$facet_addr" | tr '[:upper:]' '[:lower:]')
                if grep -Fxq -- "$addr_lc" "$CURRENT_SET_TMP"; then
                    # append if not already included
                    local exists=0
                    for line in "${OUTDATED_FACETS[@]}"; do
                        if echo "$line" | grep -q "$addr_lc"; then exists=1; break; fi
                    done
                    if [[ $exists -eq 0 ]]; then
                        OUTDATED_FACETS+=("$name:$addr_lc")
                    fi
                fi
            fi
        done
    fi
    rm -f "$CURRENT_SET_TMP" 2>/dev/null || true

    # Write to file
    cat > "$OUTDATED_FILE" << EOF
# Outdated Facets for Removal on $NETWORK ($ENVIRONMENT)
# Generated on: $(date)
# Diamond Address: $DIAMOND_ADDRESS

# Facets that can be removed (not in target state):
$(printf '%s\n' "${OUTDATED_FACETS[@]}" | sed 's/^/# /')

# Review these carefully before removing!
# Each line shows: ContractName:Address
EOF

    echo "Outdated facets analysis written to: $OUTDATED_FILE"
    # Also provide a local copy for quick review
    cp "$OUTDATED_FILE" "$OUTDATED_LOCAL" 2>/dev/null || true

    if [[ ${#OUTDATED_FACETS[@]} -gt 0 ]]; then
        echo "Found ${#OUTDATED_FACETS[@]} potentially outdated facets:"
        printf "  %s\n" "${OUTDATED_FACETS[@]}"
    else
        echo "No outdated facets found"
    fi
}

# Helper: find facet Name by address from diamond deployment JSON
function getFacetNameFromDiamondByAddress() {
    local NETWORK="$1"; local ENVIRONMENT="$2"; local ADDRESS="$3"
    local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")
    local FILE_A="./deployments/${NETWORK}.diamond.${FILE_SUFFIX}json"
    local FILE_B="./deployments/${NETWORK}.diamond.immutable.${FILE_SUFFIX}json"
    local addr_lc=$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')
    for f in "$FILE_A" "$FILE_B"; do
        [[ -f "$f" ]] || continue
        local NAME=$(jq -r --arg addr "$addr_lc" '.LiFiDiamond.Facets | to_entries[] | select((.key|ascii_downcase)==$addr) | .value.Name' "$f" 2>/dev/null)
        if [[ -n "$NAME" && "$NAME" != "null" ]]; then echo "$NAME"; return 0; fi
    done
    return 1
}

# Helper: find facet address by Name from diamond deployment JSON
function getFacetAddressFromDiamondByName() {
    local NETWORK="$1"; local ENVIRONMENT="$2"; local NAME="$3"
    local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")
    local FILE_A="./deployments/${NETWORK}.diamond.${FILE_SUFFIX}json"
    local FILE_B="./deployments/${NETWORK}.diamond.immutable.${FILE_SUFFIX}json"
    for f in "$FILE_A" "$FILE_B"; do
        [[ -f "$f" ]] || continue
        local ADDR=$(jq -r --arg name "$NAME" '.LiFiDiamond.Facets | to_entries[] | select(.value.Name==$name) | .key' "$f" 2>/dev/null)
        if [[ -n "$ADDR" && "$ADDR" != "null" ]]; then echo "$ADDR"; return 0; fi
    done
    return 1
}

function getRequiredFacetsFromTargetState() {
    local NETWORK="$1"
    local ENVIRONMENT="$2"

    # This is a simplified version - you might need to parse the target state file more carefully
    local REQUIRED_FACETS=()

    # Get all facet contracts that should be deployed
    local ALL_FACETS=($(getIncludedAndSortedFacetContractsArray))

    for facet in "${ALL_FACETS[@]}"; do
        local address=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$facet")
        if [[ -n "$address" && "$address" != "null" ]]; then
            REQUIRED_FACETS+=("$address")
        fi
    done

    printf '%s\n' "${REQUIRED_FACETS[@]}"
}

function findContractNameByAddress() {
    local ADDRESS="$1"
    local NETWORK="$2"
    local ENVIRONMENT="$3"

    local DEPLOYMENT_FILE="./deployments/${NETWORK}.json"

    if [[ ! -f "$DEPLOYMENT_FILE" ]]; then
        return 1
    fi

    # Search for the address in the deployment file
    local CONTRACT_NAME=$(jq -r --arg addr "$ADDRESS" 'to_entries[] | select(.value == $addr) | .key' "$DEPLOYMENT_FILE")

    if [[ -n "$CONTRACT_NAME" && "$CONTRACT_NAME" != "null" ]]; then
        echo "$CONTRACT_NAME"
    else
        return 1
    fi
}

function createMultisigProposals() {
    local NETWORK="$1"
    local ENVIRONMENT="$2"

    local DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")
    local RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")

    if [[ -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" ]]; then
        error "Could not find LiFiDiamond address on $NETWORK"
        return 1
    fi

    echo "Creating multisig proposals for $NETWORK..."

    # Create diamond cut proposal
    local DIAMOND_CALLDATA_FILE="/tmp/diamond_cut_calldata_${NETWORK}_${ENVIRONMENT}.txt"
    if [[ -f "$DIAMOND_CALLDATA_FILE" ]]; then
        local CALLDATA=$(grep "^CALLDATA=" "$DIAMOND_CALLDATA_FILE" | cut -d'=' -f2-)
        if [[ -n "$CALLDATA" ]]; then
            echo "  Creating diamond cut proposal..."
            bunx tsx ./script/deploy/safe/propose-to-safe.ts \
                --to "$DIAMOND_ADDRESS" \
                --calldata "$CALLDATA" \
                --network "$NETWORK" \
                --rpcUrl "$RPC_URL" \
                --timelock \
                --privateKey "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")"
        fi
    fi

    # Create periphery registry proposal
    local PERIPHERY_CALLDATA_FILE="/tmp/periphery_registry_calldata_${NETWORK}_${ENVIRONMENT}.txt"
    if [[ -f "$PERIPHERY_CALLDATA_FILE" ]]; then
        echo "  Creating periphery registry proposal..."
        # Note: You might need to batch multiple periphery updates into a single proposal
        # For now, we'll create individual proposals for each contract
        local CALLDATA_ARRAY=($(grep "^CALLDATA_" "$PERIPHERY_CALLDATA_FILE" | cut -d'=' -f2- | sed 's/\\$//'))

        for calldata in "${CALLDATA_ARRAY[@]}"; do
            if [[ -n "$calldata" ]]; then
                bunx tsx ./script/deploy/safe/propose-to-safe.ts \
                    --to "$DIAMOND_ADDRESS" \
                    --calldata "$calldata" \
                    --network "$NETWORK" \
                    --rpcUrl "$RPC_URL" \
                    --timelock \
                    --privateKey "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")"
            fi
        done
    fi

    echo "Multisig proposals created successfully"
}

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

function getFunctionSelectorsFromContractABI() {
    local CONTRACT="$1"

    # Try to get function selectors from the contract's ABI
    local ABI_FILE=""

    # Look for ABI in foundry 'out' and fallback 'artifacts'
    if [[ -f "out/${CONTRACT}.sol/${CONTRACT}.json" ]]; then
        ABI_FILE="out/${CONTRACT}.sol/${CONTRACT}.json"
    elif [[ -f "artifacts/src/Facets/${CONTRACT}.sol/${CONTRACT}.json" ]]; then
        ABI_FILE="artifacts/src/Facets/${CONTRACT}.sol/${CONTRACT}.json"
    elif [[ -f "artifacts/src/Periphery/${CONTRACT}.sol/${CONTRACT}.json" ]]; then
        ABI_FILE="artifacts/src/Periphery/${CONTRACT}.sol/${CONTRACT}.json"
    elif [[ -f "artifacts/src/Libraries/${CONTRACT}.sol/${CONTRACT}.json" ]]; then
        ABI_FILE="artifacts/src/Libraries/${CONTRACT}.sol/${CONTRACT}.json"
    fi

    # If ABI not found, try to build once
    if [[ -z "$ABI_FILE" || ! -f "$ABI_FILE" ]]; then
        if command -v forge >/dev/null 2>&1 && [[ "${FORGE_BUILT:-false}" != "true" ]]; then
            echo "[info] Building artifacts to extract ABI..." >&2
            forge build >/dev/null 2>&1 || true
            FORGE_BUILT=true
        fi
        if [[ -f "out/${CONTRACT}.sol/${CONTRACT}.json" ]]; then
            ABI_FILE="out/${CONTRACT}.sol/${CONTRACT}.json"
        fi
    fi

    if [[ -n "$ABI_FILE" && -f "$ABI_FILE" ]]; then
        # Extract full function signatures from ABI and compute selectors
        jq -r '.abi[] | select(.type == "function") | .name + "(" + ((.inputs // []) | map(.type) | join(",")) + ")"' "$ABI_FILE" 2>/dev/null | while read -r sig; do
            if [[ -n "$sig" ]]; then
                local selector=$(cast sig "$sig" 2>/dev/null)
                if [[ -n "$selector" ]]; then
                    echo "$selector"
                fi
            fi
        done
    else
        # Fallback: try to get selectors from source code using cast
        if command -v cast &> /dev/null; then
            local SOURCE_FILE=""
            if [[ -f "src/Facets/${CONTRACT}.sol" ]]; then
                SOURCE_FILE="src/Facets/${CONTRACT}.sol"
            elif [[ -f "src/Periphery/${CONTRACT}.sol" ]]; then
                SOURCE_FILE="src/Periphery/${CONTRACT}.sol"
            elif [[ -f "src/Libraries/${CONTRACT}.sol" ]]; then
                SOURCE_FILE="src/Libraries/${CONTRACT}.sol"
            fi

            if [[ -n "$SOURCE_FILE" ]]; then
                # Best-effort: extract function signatures and calculate selectors
                # This is heuristic and may include internal/private; acceptable for review
                sed -n 's/^\s*function\s\+\([a-zA-Z0-9_]*\)\s*(\([^)]*\)).*$/\1(\2)/p' "$SOURCE_FILE" | while read -r sig; do
                    if [[ -n "$sig" ]]; then
                        local selector=$(cast sig "$sig" 2>/dev/null)
                        if [[ -n "$selector" ]]; then
                            echo "$selector"
                        fi
                    fi
                done
            fi
        fi
    fi
}

# =============================================================================
# MULTI-NETWORK EXECUTION
# =============================================================================

function libAssetUpgradeAllNetworks() {
    local ENVIRONMENT="$1"
    local NETWORKS=("${@:2}")

    if [[ -z "$ENVIRONMENT" || ${#NETWORKS[@]} -eq 0 ]]; then
        error "Usage: libAssetUpgradeAllNetworks ENVIRONMENT NETWORK1 NETWORK2 ..."
        error "Example: libAssetUpgradeAllNetworks production mainnet arbitrum base"
        return 1
    fi

    echo ""
    echo "=========================================="
    echo "  LibAsset v2.0.0 Multi-Network Upgrade"
    echo "=========================================="
    echo "Environment: $ENVIRONMENT"
    echo "Networks: ${NETWORKS[*]}"
    echo "Dry Run Mode: $DRY_RUN_MODE"
    echo ""

    local SUCCESSFUL_NETWORKS=()
    local FAILED_NETWORKS=()

    for network in "${NETWORKS[@]}"; do
        echo "Processing $network..."
        echo "----------------------------------------"

        if libAssetUpgrade "$network" "$ENVIRONMENT"; then
            SUCCESSFUL_NETWORKS+=("$network")
            echo "✅ $network completed successfully"
        else
            FAILED_NETWORKS+=("$network")
            echo "❌ $network failed"
        fi

        echo ""
    done

    # Summary
    echo "=========================================="
    echo "  Multi-Network Upgrade Summary"
    echo "=========================================="
    echo "Total networks: ${#NETWORKS[@]}"
    echo "✅ Successful: ${#SUCCESSFUL_NETWORKS[@]}"
    echo "❌ Failed: ${#FAILED_NETWORKS[@]}"
    echo ""

    if [[ ${#SUCCESSFUL_NETWORKS[@]} -gt 0 ]]; then
        echo "Successful networks:"
        printf "  %s\n" "${SUCCESSFUL_NETWORKS[@]}"
        echo ""
    fi

    if [[ ${#FAILED_NETWORKS[@]} -gt 0 ]]; then
        echo "Failed networks:"
        printf "  %s\n" "${FAILED_NETWORKS[@]}"
        echo ""
    fi

    if [[ ${#FAILED_NETWORKS[@]} -gt 0 ]]; then
        return 1
    fi

    return 0
}

# =============================================================================
# MAIN EXECUTION
# =============================================================================

# Check if script is being sourced or executed
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    # Script is being executed directly
    if [[ $# -lt 2 ]]; then
        echo "Usage: $0 NETWORK ENVIRONMENT [DRY_RUN]"
        echo "       $0 --all-networks ENVIRONMENT [DRY_RUN] [NETWORK1 NETWORK2 ...]"
        echo "Example: $0 mainnet production true"
        echo "Example: $0 --all-networks production true mainnet arbitrum base"
        exit 1
    fi

    if [[ "$1" == "--all-networks" ]]; then
        ENVIRONMENT="$2"
        DRY_RUN_MODE="${3:-true}"
        shift 3
        NETWORKS=("$@")

        if [[ ${#NETWORKS[@]} -eq 0 ]]; then
            # Use all included networks if none specified
            local NETWORKS=($(getIncludedNetworksArray))
        fi

        libAssetUpgradeAllNetworks "$ENVIRONMENT" "${NETWORKS[@]}"
    else
        NETWORK="$1"
        ENVIRONMENT="$2"
        DRY_RUN_MODE="${3:-true}"

        libAssetUpgrade "$NETWORK" "$ENVIRONMENT"
    fi
fi
