#!/bin/bash

# assertFoundryVersionOrFail: Refuses a deploy whose local forge does not match
# .foundry-version. The comparison is delegated to
# script/utils/verify-foundry-version.sh — the checker the CI setup-foundry action and
# the pre-commit hook also run — so all three reach one verdict.
#
# Usage: assertFoundryVersionOrFail
#
# Routing/Behavior:
#   - Checker exits 0: returns 0, prints nothing
#   - Version mismatch, or forge not on PATH: the checker prints why, returns 1
#   - Checker missing or unrunnable: returns 1
#
# Returns: 0 to continue the deploy, 1 to refuse it. Never exits.
# Example: assertFoundryVersionOrFail || return 1
function assertFoundryVersionOrFail() {
  local GIT_ROOT
  GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  local CHECKER="$GIT_ROOT/script/utils/verify-foundry-version.sh"

  if [[ ! -f "$CHECKER" ]]; then
    error "foundry version checker not found at $CHECKER. Refusing to deploy. Nothing has been broadcast."
    return 1
  fi

  # Only an explicit success permits the deploy, so an unrunnable checker refuses too.
  if bash "$CHECKER" --quiet; then
    return 0
  fi

  error "Cannot confirm the local foundry matches $GIT_ROOT/.foundry-version, so a rebuild would not reproduce this deployment. Refusing to deploy. Nothing has been broadcast."
  return 1
}
