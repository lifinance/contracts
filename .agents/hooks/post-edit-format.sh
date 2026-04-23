#!/usr/bin/env bash
# PostToolUse hook: auto-format edited file with prettier (silent)
# Triggered on: Write, Edit, MultiEdit
# Reads tool JSON from stdin; exits 0 always (never blocks Claude)

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[[ -z "$FILE" || ! -f "$FILE" ]] && exit 0

ROOT=$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null || pwd)

case "$FILE" in
  *.sol|*.ts|*.js)
    cd "$ROOT" && bunx prettier --write "$FILE" 2>/dev/null
    ;;
esac

exit 0
