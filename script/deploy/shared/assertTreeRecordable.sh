#!/bin/bash

# Refuses a deploy whose record could not be verified later.
#
# Source this and call `assertTreeRecordableOrFail "$ENVIRONMENT"` before the
# first broadcast. The decision lives in assert-tree-recordable.ts, which prints
# its own reasons; this seam only turns them into a verdict, so both deploy
# entry points refuse identically.
assertTreeRecordableOrFail() {
  local ENVIRONMENT="$1"

  if bunx tsx script/deploy/shared/assert-tree-recordable.ts; then
    return 0
  fi

  # Mirrors getPrivateKey (helperFunctions.sh): every ENVIRONMENT that does not
  # contain "staging" signs with PRIVATE_KEY_PRODUCTION, a typo included. Using
  # the same classifier means the gate refuses exactly when the production key
  # would have been used.
  if [[ "$ENVIRONMENT" == *"staging"* ]]; then
    warning "Continuing anyway - a staging record makes no verifiable claim."
    return 0
  fi

  error "Refusing to deploy. Nothing has been broadcast."
  return 1
}
