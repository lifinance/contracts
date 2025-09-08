#!/bin/bash

# =============================================================================
# LibAsset v2.0.0 Upgrade Wrapper Script
# =============================================================================
# This script provides the simplified interface requested:
# playground.sh <chainName> [--dry-run]
# =============================================================================

# Load required dependencies
source script/helperFunctions.sh
source script/tasks/libAssetUpgrade.sh

function main() {
    local CHAIN_NAME="$1"
    local DRY_RUN_FLAG="$2"

    if [[ -z "$CHAIN_NAME" ]]; then
        echo "Usage: $0 <chainName> [--dry-run]"
        echo "Example: $0 mainnet --dry-run"
        echo "Example: $0 mainnet"
        exit 1
    fi

    # Set dry run mode based on flag
    if [[ "$DRY_RUN_FLAG" == "--dry-run" ]]; then
        DRY_RUN_MODE=true
    else
        DRY_RUN_MODE=false
    fi

    echo ""
    echo "=========================================="
    echo "  LibAsset v2.0.0 Upgrade"
    echo "=========================================="
    echo "Chain: $CHAIN_NAME"
    echo "Dry Run: $DRY_RUN_MODE"
    echo ""

    # Call the main upgrade function
    libAssetUpgrade "$CHAIN_NAME" "$DRY_RUN_FLAG"
}

# Run main function with all arguments
main "$@"

