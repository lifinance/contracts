#!/usr/bin/env bash
# Auto-format the edited file with oxfmt (.ts/.js) or prettier (.sol), silently. Called by post-edit-validate.sh before
# it lints, so formatting never races the linters.
# Reads tool JSON from stdin; exits 0 always (never blocks Claude)

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[[ -z "$FILE" || ! -f "$FILE" ]] && exit 0

ROOT=$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null || pwd)

case "$FILE" in
  *.ts|*.js)
    cd "$ROOT" && bunx oxfmt "$FILE" >/dev/null 2>&1
    ;;
  *.sol)
    cd "$ROOT" && bunx prettier --write "$FILE" >/dev/null 2>&1
    ;;
esac

exit 0
