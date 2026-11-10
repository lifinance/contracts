#!/bin/bash
# Formats the given Solidity files: Prettier for src/, forge fmt for everything else.
# src/ holds audited contracts. forge fmt would change their layout and so their audit
# source hashes; prettier-plugin-solidity 1.4.3 reproduces their current layout exactly.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
PRETTIER_FILES=()
FORGE_FILES=()

for FILE in "$@"; do
  case "${FILE#"$ROOT"/}" in
    src/*) PRETTIER_FILES+=("$FILE") ;;
    *) FORGE_FILES+=("$FILE") ;;
  esac
done

if [[ ${#PRETTIER_FILES[@]} -gt 0 ]]; then
  bunx prettier --write --log-level warn "${PRETTIER_FILES[@]}"
fi

if [[ ${#FORGE_FILES[@]} -gt 0 ]]; then
  forge fmt "${FORGE_FILES[@]}"
fi
