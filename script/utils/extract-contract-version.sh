#!/bin/bash

# extract-contract-version.sh: Reads the `@custom:version` tag out of a Solidity
# source file and refuses anything that is not a well-formed version.
#
# The bash half of the version grammar. The TypeScript half lives in
# script/deploy/shared/contract-version.ts, and
# script/deploy/shared/contract-version.test.ts drives both from one table of
# cases so they cannot drift apart: CI looks up audit coverage by version while
# the audit gate compares content at that same version, so two grammars would
# check one version's audits against another version's source.
#
# Usage: bash script/utils/extract-contract-version.sh <path-to-.sol>
#
# Exit codes:
#   0 - prints the version to stdout
#   1 - the file could not be read
#   2 - the file carries no version tag (prints nothing)
#   3 - the tag's value is not a version; prints the offending value to stdout
#       and an explanation to stderr

set -euo pipefail

# MAJOR.MINOR.PATCH with an optional lowercase suffix whose segments are separated
# by '.' or '-': a fork overlay is 2.1.3-tron, and its redeploys 2.1.3-tron-r2 etc.
VERSION_GRAMMAR='^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9]+([.-][a-z0-9]+)*)?$'

FILE_PATH="${1:-}"

if [[ -z "$FILE_PATH" ]]; then
  echo "Usage: $0 <path-to-.sol>" >&2
  exit 1
fi

if [[ ! -f "$FILE_PATH" ]]; then
  echo "Could not read $FILE_PATH" >&2
  exit 1
fi

# A tag with no value does not match, so it reads as absent rather than empty.
TAG_LINE=$(grep -E '^///[[:space:]]+@custom:version[[:space:]]+' "$FILE_PATH" | head -1 || true)

if [[ -z "$TAG_LINE" ]]; then
  exit 2
fi

RAW=$(echo "$TAG_LINE" |
  sed -E 's|^///[[:space:]]+@custom:version[[:space:]]+||' |
  tr -d '\r' |
  sed -E 's/[[:space:]]+$//')

# A tag whose value is only whitespace carries no version to judge, so it reads as
# absent rather than as a malformed one — the same verdict the TypeScript reaches.
if [[ -z "$RAW" ]]; then
  exit 2
fi

if [[ ! "$RAW" =~ $VERSION_GRAMMAR ]]; then
  echo "$RAW"
  echo "Not a version: '$RAW' in $FILE_PATH (expected MAJOR.MINOR.PATCH with an optional lowercase -suffix)" >&2
  exit 3
fi

echo "$RAW"
