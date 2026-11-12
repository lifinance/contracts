#!/usr/bin/env bash
# Auto-format the edited file (silent): oxfmt for .ts/.js, Prettier for src/ and archive/ Solidity,
# forge fmt for test/ and script/ Solidity. Called by post-edit-validate.sh before it lints, so
# formatting never races the linters.
# Reads tool JSON from stdin; exits 0 always (never blocks Claude)

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[[ -z "$FILE" || ! -f "$FILE" ]] && exit 0

# Resolved paths, so ./src/X.sol, symlinks and /tmp vs /private/tmp all land in the src/ branch:
# forge fmt on an explicit path ignores [fmt] ignore and would rewrite an audited contract.
FILE=$(realpath "$FILE")
ROOT=$(realpath "$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null || pwd)")

case "${FILE#"$ROOT"/}" in
  *.ts|*.js)
    cd "$ROOT" && bunx oxfmt "$FILE" >/dev/null 2>&1
    ;;
  src/*.sol|archive/*.sol)
    cd "$ROOT" && bunx prettier --write "$FILE" >/dev/null 2>&1
    ;;
  test/*.sol|script/*.sol)
    cd "$ROOT" && forge fmt "$FILE" >/dev/null 2>&1
    ;;
esac

exit 0
