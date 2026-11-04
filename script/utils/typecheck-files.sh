#!/bin/bash
# typecheck-files: Type-checks each given file against the runtime it runs on.
# `*.test.ts` runs under `bun test` and is checked against tsconfig.json (Bun
# types); every other module runs on Node via `bunx tsx` and is checked against
# tsconfig.node.json (Node types only), so a Bun-only API in it fails here
# instead of at runtime. The two sets need separate tsc-files calls because
# ambient types apply to a whole program, not to a file.
#
# A file that imports a gitignored build output (typechain/, diamond.json) is
# skipped with a notice while that output is absent: this check runs at commit
# time and must not build contracts. CI generates both and checks those files.
#
# Usage: typecheck-files.sh FILE...
#   FILE - Path relative to the repo root; non-TS files are ignored
#
# Returns: 0 if every checked file type-checks, 1 otherwise
# Example: bash script/utils/typecheck-files.sh script/utils/utils.ts

set -euo pipefail

# missingBuildOutput: Prints the build output FILE imports that is absent from
# this checkout, or nothing.
#
# Usage: missingBuildOutput FILE
function missingBuildOutput() {
  local FROM="^[^'\"]*from[[:space:]]+['\"](\.\./)+"
  if [[ ! -d typechain ]] && grep -qE "${FROM}typechain['\"/]" -- "$1"; then
    echo "typechain/"
  elif [[ ! -f diamond.json ]] && grep -qE "${FROM}diamond\.json['\"]" -- "$1"; then
    echo "diamond.json"
  fi
}

NODE_FILES=()
TEST_FILES=()
for FILE in "$@"; do
  case "$FILE" in
    *.ts | *.tsx) ;;
    *) continue ;;
  esac
  MISSING=$(missingBuildOutput "$FILE")
  if [[ -n "$MISSING" ]]; then
    echo "Not type-checked: $FILE imports $MISSING, which is not generated in this" \
      "checkout (run 'bun build:typechain-and-abi' to check it locally; CI checks it)" >&2
    continue
  fi
  case "$FILE" in
    *.test.ts) TEST_FILES+=("$FILE") ;;
    *) NODE_FILES+=("$FILE") ;;
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
