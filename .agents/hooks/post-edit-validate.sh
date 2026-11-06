#!/usr/bin/env bash
# PostToolUse hook: format the edited file, then run linter/type-checker/syntax-check on it
# Triggered on: Write, Edit
# Reads tool JSON from stdin. Exits 0 when clean; on findings prints them to stderr and
# exits 2, the only PostToolUse channel Claude Code feeds back to the model (stdout on
# exit 0 goes to the debug log). Formatting runs here rather than as a sibling hook because
# matching hooks run in parallel, and the formatter rewriting the file mid-check races the linters.

HOOK_DIR=$(cd "$(dirname "$0")" && pwd)
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[[ -z "$FILE" || ! -f "$FILE" ]] && exit 0

# Scratch files outside a checkout have no repo tooling or tsconfig to check against.
ROOT=$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null) || exit 0
# A file inside a lib/ submodule resolves to the submodule's own root, where REL would read as
# src/... and the repo's checks (and its check-spdx-headers.sh) do not exist.
[[ -n "$(git -C "$ROOT" rev-parse --show-superproject-working-tree 2>/dev/null)" ]] && exit 0
cd "$ROOT" || exit 0

echo "$INPUT" | bash "$HOOK_DIR/post-edit-format.sh"

# Resolve path relative to repo root (macOS-compatible)
REL="${FILE#"$ROOT"/}"

FINDINGS=""
case "$FILE" in
  *.sol)
    # Only lint Solidity in src/ or script/ — skip lib/, test artifacts, generated files
    if [[ "$REL" == src/* || "$REL" == script/* ]]; then
      FINDINGS+="$(bunx solhint --disc --noPoster -f unix "$FILE" 2>&1)"$'\n'
    fi
    # [CONV:LICENSE] SPDX header + pragma check (src/, script/, test/; external copies allowlisted in the script)
    if [[ "$REL" == src/* || "$REL" == script/* || "$REL" == test/* ]]; then
      FINDINGS+="$(bash script/utils/check-spdx-headers.sh "$REL" 2>&1 || true)"
    fi
    ;;
  *.ts)
    # A checkout from before the wrapper existed (another repo, an older worktree)
    # gets the plain check rather than a "No such file" on every edit.
    if [[ -f script/utils/typecheck-files.sh ]]; then
      FINDINGS=$(bash script/utils/typecheck-files.sh "$REL" 2>&1)
    else
      FINDINGS=$(bunx tsc-files --noEmit "$REL" 2>&1)
    fi
    ;;
  *.sh)
    FINDINGS=$(bash -n "$FILE" 2>&1)
    [[ -n "$FINDINGS" ]] && FINDINGS="bash -n: $FINDINGS"
    ;;
esac

if [[ -n "${FINDINGS//[[:space:]]/}" ]]; then
  echo "$FINDINGS" >&2
  exit 2
fi
exit 0
