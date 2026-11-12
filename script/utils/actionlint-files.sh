#!/bin/bash
# actionlint-files: Lints the given GitHub workflow files with actionlint, for
# lint-staged. A missing actionlint fails the commit instead of skipping the
# check, so a workflow that does not parse cannot be committed unlinted.
#
# Usage: actionlint-files.sh FILE...
#   FILE - Workflow file path; with no files the script does nothing
#
# Returns: actionlint's exit code, 1 if actionlint is not installed, 0 with no files
# Example: bash script/utils/actionlint-files.sh .github/workflows/markdownlint.yml

set -euo pipefail

if [[ $# -eq 0 ]]; then
  exit 0
fi

if ! command -v actionlint > /dev/null 2>&1; then
  echo -e "\033[31mactionlint is not installed, so the staged workflow files cannot be linted.\033[0m" >&2
  echo "Install it with: brew install actionlint" >&2
  exit 1
fi

exec actionlint "$@"
