#!/bin/bash
# Prints a stable SHA-256 of all pinned fork block numbers in test files.
# Used as a GitHub Actions cache key segment for ~/.foundry/cache/rpc.
#
# Captures every fork-pin style so bumping any pin always changes the key:
#   customBlockNumberForForking = N      (TestBase-derived tests)
#   blockNumber = N                      (local var + vm.createSelectFork)
#   vm.createSelectFork(rpc, N)          (inline numeric literal)
# The fallback default — used by every test that sets no custom pin — is read
# from TestBase.DEFAULT_BLOCK_NUMBER_MAINNET so the literal is single-sourced.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

TESTBASE="test/solidity/utils/TestBase.sol"
DEFAULT_BLOCK="$(grep -oE 'DEFAULT_BLOCK_NUMBER_MAINNET = [0-9]+' "$TESTBASE" 2>/dev/null | grep -oE '[0-9]+$' || true)"
if [[ -z "$DEFAULT_BLOCK" ]]; then
  echo "::error::could not read DEFAULT_BLOCK_NUMBER_MAINNET from $TESTBASE" >&2
  exit 1
fi

{
  echo "$DEFAULT_BLOCK"
  grep -rhoE '(customBlockNumberForForking|blockNumber)[[:space:]]*=[[:space:]]*[0-9]+' test/solidity 2>/dev/null \
    | grep -oE '[0-9]+' || true
  grep -rhoE 'create(Select)?Fork\(.*,[[:space:]]*[0-9]+\)' test/solidity 2>/dev/null \
    | sed -E 's/.*,[[:space:]]*([0-9]+)\)/\1/' || true
} | sort -n | uniq | shasum -a 256 | awk '{print $1}'
