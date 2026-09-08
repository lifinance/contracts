#!/bin/bash

# assertZkToolchainOrFail: Refuses a zkEVM build whose toolchain does not match the pins in
# foundry.toml [external.zksync]. The comparison is delegated to
# script/utils/verify-zk-toolchain.sh so every caller reaches one verdict.
#
# Usage: assertZkToolchainOrFail [INSTALL_DIR]
#   INSTALL_DIR - foundry-zksync install directory (default: ./foundry-zksync)
#
# Routing/Behavior:
#   - Checker exits 0: returns 0, prints nothing
#   - Pin missing, zksolc unpinned, or binary version mismatch: the checker prints why, returns 1
#   - Checker missing or unrunnable: returns 1
#
# Returns: 0 to continue, 1 to refuse. Never exits.
# Example: assertZkToolchainOrFail || return 1
function assertZkToolchainOrFail() {
  local INSTALL_DIR="${1:-./foundry-zksync}"
  local GIT_ROOT
  GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  local CHECKER="$GIT_ROOT/script/utils/verify-zk-toolchain.sh"

  if [[ ! -f "$CHECKER" ]]; then
    error "zk toolchain checker not found at $CHECKER. Refusing to build for zkEVM. Nothing has been broadcast."
    return 1
  fi

  # Only an explicit success permits the build, so an unrunnable checker refuses too.
  if bash "$CHECKER" --quiet --dir "$INSTALL_DIR"; then
    return 0
  fi

  error "Cannot confirm the zkEVM toolchain matches the pins in $GIT_ROOT/foundry.toml [external.zksync], so a rebuild would not reproduce this deployment. Refusing to build for zkEVM. Nothing has been broadcast."
  return 1
}
