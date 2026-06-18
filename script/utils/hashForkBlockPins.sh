#!/usr/bin/env bash
# Prints a stable SHA-256 of all pinned fork block numbers in test files.
# Used as a GitHub Actions cache key segment for ~/.foundry/cache/rpc.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

DEFAULT_BLOCK="15588208"

{
  echo "$DEFAULT_BLOCK"
  grep -rhoE 'customBlockNumberForForking = [0-9]+' test/solidity archive/test 2>/dev/null \
    | sed 's/customBlockNumberForForking = //' || true
} | sort -n | uniq | shasum -a 256 | awk '{print $1}'
