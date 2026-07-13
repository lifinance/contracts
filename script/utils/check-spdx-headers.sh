#!/bin/bash
# check-spdx-headers.sh: Verifies [CONV:LICENSE] SPDX headers on our own Solidity files.
# For every .sol file under src/, script/, or test/:
#   line 1 must be exactly "// SPDX-License-Identifier: LGPL-3.0-only"
#   line 2 must be the pragma statement (immediately follows the header, no blank
#           line / NatSpec / directive in between)
# Genuine external copies retain their original upstream license and are
# allowlisted in EXTERNAL_COPIES below.
#
# Usage: script/utils/check-spdx-headers.sh [FILE ...]
#   FILE - Optional: repo-relative .sol path(s) to check. Paths outside src/, script/,
#          and test/ are ignored. Without arguments, scans all .sol files in those
#          three directories.
#
# Returns: exit 0 if all checked files comply, exit 1 after listing every violation.
# Example: script/utils/check-spdx-headers.sh
# Example: script/utils/check-spdx-headers.sh src/Facets/PolygonBridgeFacet.sol
set -euo pipefail

EXPECTED_HEADER='// SPDX-License-Identifier: LGPL-3.0-only'

# External copies retain their original license + source note per [CONV:LICENSE].
# Do NOT add our own files here — fix their header instead.
EXTERNAL_COPIES=(
  # SushiSwap RouteProcessor4 copy (upstream first line: UNLICENSED)
  "src/Periphery/LiFiDEXAggregator.sol"
  # Circle CCTP TokenMessenger interface (upstream: Apache-2.0)
  "src/Interfaces/ITokenMessenger.sol"
)

is_external_copy() {
  local FILE="$1"
  for EXTERNAL_COPY in "${EXTERNAL_COPIES[@]}"; do
    if [[ "$FILE" == "$EXTERNAL_COPY" ]]; then
      return 0
    fi
  done
  return 1
}

FILES=()
if [[ $# -gt 0 ]]; then
  FILES=("$@")
else
  while IFS= read -r FILE; do
    FILES+=("$FILE")
  done < <(find src script test -name '*.sol' -type f)
fi

VIOLATIONS=""
for FILE in "${FILES[@]:-}"; do
  [[ "$FILE" == *.sol && -f "$FILE" ]] || continue
  [[ "$FILE" == src/* || "$FILE" == script/* || "$FILE" == test/* ]] || continue
  is_external_copy "$FILE" && continue

  FIRST_LINE=$(sed -n '1p' "$FILE")
  SECOND_LINE=$(sed -n '2p' "$FILE")
  if [[ "$FIRST_LINE" != "$EXPECTED_HEADER" ]]; then
    VIOLATIONS="${VIOLATIONS}${FILE}: line 1 must be the SPDX header, found \"${FIRST_LINE}\""$'\n'
  elif [[ "$SECOND_LINE" != "pragma solidity"* ]]; then
    VIOLATIONS="${VIOLATIONS}${FILE}: line 2 must be the pragma statement, found \"${SECOND_LINE}\""$'\n'
  fi
done

if [[ -n "$VIOLATIONS" ]]; then
  echo "[CONV:LICENSE] Each .sol file under src/, script/, or test/ must start with exactly:"
  echo "  $EXPECTED_HEADER"
  echo "  pragma solidity ...;"
  echo "(the pragma must immediately follow the SPDX header on line 2 — no blank line,"
  echo "NatSpec, or directive in between; external copies keep their original license"
  echo "and must be allowlisted in script/utils/check-spdx-headers.sh)"
  echo ""
  printf '%s' "$VIOLATIONS" | sed 's/^/  /'
  exit 1
fi

exit 0
