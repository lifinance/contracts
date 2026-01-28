#!/bin/bash

# verify-proposal-exists.sh
# Verifies that a Safe multisig proposal exists in MongoDB with pending status
# This script is called after proposal creation to ensure the proposal was successfully stored

set -euo pipefail

# Source helper functions if available
if [[ -f "script/helperFunctions.sh" ]]; then
  source script/helperFunctions.sh
fi

# Function to print error messages
error() {
  echo "[error] $*" >&2
}

# Function to print success messages
success() {
  echo "[success] $*"
}

# Function to print info messages
info() {
  echo "[info] $*"
}

# Read function arguments
NETWORK="${1:-}"
ENVIRONMENT="${2:-}"
CONTRACT="${3:-}"

# Validate arguments
if [[ -z "$NETWORK" ]]; then
  error "Network parameter is required"
  exit 1
fi

if [[ -z "$ENVIRONMENT" ]]; then
  error "Environment parameter is required"
  exit 1
fi

if [[ -z "$CONTRACT" ]]; then
  error "Contract parameter is required"
  exit 1
fi

# Validate environment value
if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  error "Environment must be either 'staging' or 'production'"
  exit 1
fi

info "[$NETWORK] Verifying proposal exists in MongoDB for $CONTRACT..."

# Call TypeScript utility to check for proposal
set +e  # Temporarily disable exit on error to capture exit code
MONGO_RESULT=$(bun script/deploy/safe/query-safe-proposals.ts check \
  --network "$NETWORK" \
  --environment "$ENVIRONMENT" \
  --contract "$CONTRACT" 2>&1)
MONGO_EXIT=$?
set -e  # Re-enable exit on error

# Check if command executed successfully
if [[ $MONGO_EXIT -ne 0 ]]; then
  # Try to parse error from JSON output
  if echo "$MONGO_RESULT" | jq -e . >/dev/null 2>&1; then
    local ERROR_MSG=$(echo "$MONGO_RESULT" | jq -r '.error // "Unknown error"')
    error "[$NETWORK] Failed to verify proposal: $ERROR_MSG"
  else
    error "[$NETWORK] Failed to verify proposal. Script output: $MONGO_RESULT"
  fi
  exit 1
fi

# Validate that MONGO_RESULT is valid JSON
if ! echo "$MONGO_RESULT" | jq -e . >/dev/null 2>&1; then
  error "[$NETWORK] Invalid JSON response from query script: $MONGO_RESULT"
  exit 1
fi

# Parse JSON response
FOUND=$(echo "$MONGO_RESULT" | jq -r '.found // false')

if [[ "$FOUND" == "true" ]]; then
  local SAFE_TX_HASH=$(echo "$MONGO_RESULT" | jq -r '.safeTxHash // "unknown"')
  local TIMESTAMP=$(echo "$MONGO_RESULT" | jq -r '.timestamp // "unknown"')
  success "[$NETWORK] Proposal verified in MongoDB for $CONTRACT"
  info "[$NETWORK] Safe Tx Hash: $SAFE_TX_HASH"
  info "[$NETWORK] Timestamp: $TIMESTAMP"
  exit 0
else
  error "[$NETWORK] Proposal for $CONTRACT was not found in MongoDB with pending status"
  error "[$NETWORK] The proposal may not have been created successfully"
  exit 1
fi
