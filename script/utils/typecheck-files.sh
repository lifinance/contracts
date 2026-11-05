#!/bin/bash
# typecheck-files: Type-checks each given file against the runtime it runs on.
# `*.test.ts` runs under `bun test` and is checked against tsconfig.json (Bun
# types); every other module runs on Node via `bunx tsx` and is checked against
# tsconfig.node.json (Node types only), so a Bun-only API in it fails here
# instead of at runtime. The two sets need separate tsc-files calls because
# ambient types apply to a whole program, not to a file.
#
# This check runs at commit time and must not build contracts. While a
# gitignored build output (typechain/, diamond.json, out/) is absent, a file
# that cannot find it is not judged: its errors (the missing module and what
# follows from it) are ignored with a notice, and errors in every other file
# still fail. Going by tsc's errors rather than a file's own imports also covers
# files that reach an output through another module (e.g. demoScriptHelpers.ts).
# Under CI (CI set), which generates the outputs first, nothing is ignored.
#
# Usage: typecheck-files.sh FILE...
#   FILE - Path relative to the repo root; non-TS files are ignored
#
# Returns: 0 if every file that can be judged type-checks, 1 otherwise
# Example: bash script/utils/typecheck-files.sh script/utils/utils.ts

set -euo pipefail

ABSENT_OUTPUTS=()
if [[ -z "${CI:-}" ]]; then
  # index.ts, not the directory: a failed `bun typechain` leaves typechain/ empty
  if [[ ! -f typechain/index.ts ]]; then
    ABSENT_OUTPUTS+=("typechain")
  fi
  if [[ ! -f diamond.json ]]; then
    ABSENT_OUTPUTS+=("diamond\.json")
  fi
  if [[ ! -d out ]]; then
    ABSENT_OUTPUTS+=("out")
  fi
fi
BUILD_HINT="run 'bun build:typechain-and-abi' to generate the build outputs"

# unjudgedFiles: Prints, one per line, the files in tsc OUTPUT that cannot find
# an absent build output.
#
# Usage: unjudgedFiles OUTPUT
function unjudgedFiles() {
  local ABSENT
  ABSENT=$(
    IFS='|'
    echo "${ABSENT_OUTPUTS[*]}"
  )
  grep -E "^[^(]+\([0-9]+,[0-9]+\): error TS2307: Cannot find module '(\.\./)*($ABSENT)['/]" \
    <<< "$1" | cut -d'(' -f1 | sort -u || true
}

# judgedErrors: Prints the error lines of tsc OUTPUT in files not listed in
# UNJUDGED, any error line tsc printed without a file, and any other line that
# is not an indented continuation (a crash or tool message is never ignored).
#
# Usage: judgedErrors OUTPUT UNJUDGED
#   OUTPUT   - tsc-files output
#   UNJUDGED - Newline-separated files whose errors are ignored
function judgedErrors() {
  # Through the environment: BSD awk refuses a newline in a -v value
  UNJUDGED="$2" awk '
    BEGIN {
      N = split(ENVIRON["UNJUDGED"], LIST, "\n")
      for (I = 1; I <= N; I++) SKIP[LIST[I]] = 1
    }
    / error TS[0-9]+:/ {
      FILE = $0
      if (FILE ~ /^[^(]+\([0-9]+,[0-9]+\): /) { sub(/\(.*/, "", FILE) } else { FILE = "" }
      if (!(FILE in SKIP)) print
      next
    }
    NF && !/^[[:space:]]/ { print }
  ' <<< "$1"
}

# checkFiles: Runs tsc-files with ARGS and prints its output. While a build
# output is absent, the errors of files that cannot find it are ignored.
#
# Usage: checkFiles ARGS...
#   ARGS - Arguments after `tsc-files --noEmit` (tsconfig flag and files)
#
# Returns: 0 if tsc-files passed or every error is in an unjudged file, 1 otherwise
function checkFiles() {
  local OUTPUT
  local TSC_STATUS=0
  OUTPUT=$(bunx tsc-files --noEmit "$@" 2>&1) || TSC_STATUS=$?
  if [[ $TSC_STATUS -eq 0 ]]; then
    if [[ -n "$OUTPUT" ]]; then printf '%s\n' "$OUTPUT"; fi
    return 0
  fi

  local UNJUDGED=""
  if [[ ${#ABSENT_OUTPUTS[@]} -gt 0 ]]; then
    UNJUDGED=$(unjudgedFiles "$OUTPUT")
  fi
  if [[ -n "$UNJUDGED" ]]; then
    local JUDGED
    if ! JUDGED=$(judgedErrors "$OUTPUT" "$UNJUDGED"); then
      printf '%s\n' "$OUTPUT"
      echo "typecheck-files: could not filter the tsc output" >&2
      return 1
    fi
    if [[ -z "$JUDGED" ]]; then
      echo "Ignored the type errors in these files: they import a build output not generated" \
        "in this checkout ($BUILD_HINT and check them locally; CI checks them):" >&2
      local UNJUDGED_FILE
      while IFS= read -r UNJUDGED_FILE; do
        echo "  $UNJUDGED_FILE" >&2
      done <<< "$UNJUDGED"
      return 0
    fi
  fi

  printf '%s\n' "$OUTPUT"
  if grep -qE "(typechain|diamond\.json|/out/)" <<< "$OUTPUT"; then
    echo "If these errors come from outdated build outputs, $BUILD_HINT." >&2
  fi
  return 1
}

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
  checkFiles -p tsconfig.node.json "${NODE_FILES[@]}" || STATUS=1
fi
if [[ ${#TEST_FILES[@]} -gt 0 ]]; then
  checkFiles "${TEST_FILES[@]}" || STATUS=1
fi
exit "$STATUS"
