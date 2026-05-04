#!/usr/bin/env bash
# PostToolUse hook: run linter/type-checker/syntax-check and report errors to Claude
# Triggered on: Write, Edit
# Reads tool JSON from stdin; prints issues to stdout (Claude sees them); exits 0 always

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[[ -z "$FILE" || ! -f "$FILE" ]] && exit 0

ROOT=$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$ROOT" || exit 0

# Resolve path relative to repo root (macOS-compatible)
REL="${FILE#$ROOT/}"

case "$FILE" in
  *.sol)
    # Only lint Solidity in src/ or script/ — skip lib/, test artifacts, generated files
    if [[ "$REL" == src/* || "$REL" == script/* ]]; then
      OUTPUT=$(bunx solhint "$FILE" 2>&1)
      [[ -n "$OUTPUT" ]] && echo "$OUTPUT"
    fi
    ;;
  *.ts)
    OUTPUT=$(bunx tsc-files --noEmit "$FILE" 2>&1)
    [[ -n "$OUTPUT" ]] && echo "$OUTPUT"
    ;;
  *.sh)
    OUTPUT=$(bash -n "$FILE" 2>&1)
    [[ -n "$OUTPUT" ]] && echo "bash -n: $OUTPUT"
    ;;
esac

exit 0
