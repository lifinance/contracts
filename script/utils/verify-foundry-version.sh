#!/usr/bin/env bash
# Verify that the active foundry binary matches .foundry-version.
# Exits 0 on match, 1 on mismatch or missing forge.
# Used by CI (every workflow that installs foundry) and by the husky
# pre-commit hook so devs and CI runners are gated by the exact same check.
set -euo pipefail

GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
VERSION_FILE="$GIT_ROOT/.foundry-version"

if [ ! -f "$VERSION_FILE" ]; then
  printf '\033[31m✗ %s not found\033[0m\n' "$VERSION_FILE" >&2
  exit 1
fi

EXPECTED="$(tr -d '[:space:]' < "$VERSION_FILE")"

if [ -z "$EXPECTED" ]; then
  printf '\033[31m✗ .foundry-version is empty\033[0m\n' >&2
  exit 1
fi

if ! command -v forge >/dev/null 2>&1; then
  printf '\033[31m✗ forge not on PATH\033[0m\n' >&2
  printf '   install foundry %s: foundryup -v %s && foundryup -u %s\n' "$EXPECTED" "$EXPECTED" "$EXPECTED" >&2
  exit 1
fi

# `forge --version` output varies between releases:
#   older: "forge 1.7.0 (abc1234 2026-04-12T...)"
#   newer: "forge Version: 1.7.0\nCommit SHA: ...\nBuild Timestamp: ..."
# Extract the first semver-shaped token from anywhere in the output.
ACTUAL="$(forge --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?' | head -1)"

if [ -z "$ACTUAL" ]; then
  printf '\033[31m✗ could not parse foundry version from `forge --version`\033[0m\n' >&2
  forge --version >&2 || true
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  printf '\033[31m✗ foundry version mismatch\033[0m\n' >&2
  printf '   expected: %s\n' "$EXPECTED" >&2
  printf '   actual:   %s\n' "$ACTUAL" >&2
  printf '   fix:      foundryup -v %s && foundryup -u %s\n' "$EXPECTED" "$EXPECTED" >&2
  exit 1
fi

if [ "${1:-}" != "--quiet" ]; then
  printf '\033[32m✓ foundry %s\033[0m\n' "$ACTUAL"
fi
