#!/bin/bash

# getZkToolchainPin: Reads a version pin from the [external.zksync] section of foundry.toml.
# Vanilla forge ignores [external.*] sections without warning, so the pins can live in
# foundry.toml even though only our scripts consume them.
#
# Usage: getZkToolchainPin KEY
#   KEY - Pin name, e.g. "zksolc" or "foundry_zksync"
#
# Returns: The pinned version string (empty if not found)
# Example: getZkToolchainPin "zksolc"
function getZkToolchainPin() {
  local KEY="$1"
  # default covers .env files that don't define FOUNDRY_TOML_FILE_PATH
  local FOUNDRY_TOML="${FOUNDRY_TOML_FILE_PATH:-foundry.toml}"

  if [[ ! -f "$FOUNDRY_TOML" ]]; then
    return 1
  fi

  awk -v key="$KEY" '
    /^\[external\.zksync\]/ { IN_SECTION = 1; next }
    /^\[/ { IN_SECTION = 0 }
    IN_SECTION && $1 == key && $2 == "=" { gsub(/["'\'']/, "", $3); print $3; exit }
  ' "$FOUNDRY_TOML"
}
