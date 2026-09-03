#!/bin/bash

# assertTreeRecordableOrFail: Refuses a production deploy whose record could not be
# verified later. The decision lives in assert-tree-recordable.ts, which prints its
# own reasons; this turns them into a verdict so both deploy entry points agree.
#
# Usage: assertTreeRecordableOrFail ENVIRONMENT
#   ENVIRONMENT - Deployment environment, e.g. "production" or "staging"
#
# Routing/Behavior:
#   - Tree is recordable: silent, returns 0
#   - Not recordable, ENVIRONMENT is exactly "staging": warns, returns 0
#   - Not recordable, anything else: prints an error, returns 1
#
# Returns: 0 to continue the deploy, 1 to refuse it. Never exits.
# Example: assertTreeRecordableOrFail "$ENVIRONMENT" || return 1
function assertTreeRecordableOrFail() {
  local ENVIRONMENT="$1"

  if bunx tsx script/deploy/shared/assert-tree-recordable.ts; then
    return 0
  fi

  # getPrivateKey hands out the production signing key for every ENVIRONMENT that
  # does not contain "staging", so matching on the exact string keeps the gate at
  # least as broad as the key it protects.
  if [[ "$ENVIRONMENT" != "staging" ]]; then
    error "Refusing to deploy. Nothing has been broadcast."
    return 1
  fi

  warning "Continuing anyway - a staging record makes no verifiable claim."
  return 0
}
