#!/bin/bash
# typecheck-files: Type-checks each given file against the runtime it runs on.
# `*.test.ts` runs under `bun test` and is checked against tsconfig.json (Bun
# types); every other module runs on Node via `bunx tsx` and is checked against
# tsconfig.node.json (Node types only), so a Bun-only API in it fails here
# instead of at runtime. The two sets need separate tsc-files calls because
# ambient types apply to a whole program, not to a file.
#
# When a given file imports typechain/ and it is missing or older than a contract
# under src/, it is generated first (`bun typechain:incremental`, which builds src/).
#
# Usage: typecheck-files.sh FILE...
#   FILE - Path relative to the repo root; non-TS files are ignored
#
# Returns: 0 if every file type-checks, 1 otherwise
# Example: bash script/utils/typecheck-files.sh script/utils/utils.ts

set -euo pipefail

NODE_FILES=()
TEST_FILES=()
for FILE in "$@"; do
  case "$FILE" in
    *.test.ts) TEST_FILES+=("$FILE") ;;
    *.ts | *.tsx) NODE_FILES+=("$FILE") ;;
  esac
done

# ensureTypechain: Generates typechain/ when one of the given files imports it and it is missing
# or older than a contract under src/, so a fresh worktree or a just-edited contract type-checks
# against current bindings instead of failing with "Cannot find module".
#
# Usage: ensureTypechain FILE...
#
# Returns: 0, or exits 1 when generation fails
function ensureTypechain() {
  if ! grep -qE "['\"](\.\./)+typechain['\"/]" -- "$@"; then
    return 0
  fi
  local NEWER_CONTRACT=""
  if [[ -f typechain/index.ts ]]; then
    NEWER_CONTRACT=$(find src -name '*.sol' -newer typechain/index.ts -print -quit)
    if [[ -z "$NEWER_CONTRACT" ]]; then
      return 0
    fi
  fi

  echo "typechain/ is missing or older than src/; generating it (bun typechain:incremental)" >&2
  if ! bun typechain:incremental >&2; then
    echo "TypeChain generation failed; fix the build above or run 'bun typechain' manually" >&2
    exit 1
  fi
}

if [[ $((${#NODE_FILES[@]} + ${#TEST_FILES[@]})) -gt 0 ]]; then
  ensureTypechain ${NODE_FILES[@]+"${NODE_FILES[@]}"} ${TEST_FILES[@]+"${TEST_FILES[@]}"}
fi

STATUS=0
if [[ ${#NODE_FILES[@]} -gt 0 ]]; then
  bunx tsc-files --noEmit -p tsconfig.node.json "${NODE_FILES[@]}" || STATUS=1
fi
if [[ ${#TEST_FILES[@]} -gt 0 ]]; then
  bunx tsc-files --noEmit "${TEST_FILES[@]}" || STATUS=1
fi
exit "$STATUS"
