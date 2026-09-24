#!/bin/bash
# typecheck-files: Type-checks each given file against the runtime it runs on.
# `*.test.ts` runs under `bun test` and is checked against tsconfig.json (Bun
# types); every other module runs on Node via `bunx tsx` and is checked against
# tsconfig.node.json (Node types only), so a Bun-only API in it fails here
# instead of at runtime. The two sets need separate tsc-files calls because
# ambient types apply to a whole program, not to a file.
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

STATUS=0
if [[ ${#NODE_FILES[@]} -gt 0 ]]; then
  bunx tsc-files --noEmit -p tsconfig.node.json "${NODE_FILES[@]}" || STATUS=1
fi
if [[ ${#TEST_FILES[@]} -gt 0 ]]; then
  bunx tsc-files --noEmit "${TEST_FILES[@]}" || STATUS=1
fi
exit "$STATUS"
