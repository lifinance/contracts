#!/bin/bash
declare -a EXCLUDE
IFS=" "
read -a EXCLUDE <<< $(sed 's/0x//g' <<< "$2")
filter='[]'  # Empty JSON array
for x in "${EXCLUDE[@]}"; do
  filter=$(jq -n --arg x "$x" --argjson exclude "$filter" '$exclude + [$x]')
done

ARTIFACTS_DIR="${3:-./out}"
ARTIFACT="$ARTIFACTS_DIR/$1.sol/$1.json"

# Every failure below otherwise yields an empty selector list, which encodes as a valid
# no-op diamond cut rather than an error - the caller cannot tell the two apart.
if [[ ! -f "$ARTIFACT" ]]; then
  echo "contract-selectors.sh: no build artifact at $ARTIFACT" >&2
  exit 1
fi

if ! SELECTORS=$(jq --argjson exclude "$filter" -er '.methodIdentifiers | . | del(.. | select(. == $exclude[])) | join(",")'  "$ARTIFACT"); then
  echo "contract-selectors.sh: could not read methodIdentifiers from $ARTIFACT" >&2
  exit 1
fi

if [[ -z "$SELECTORS" ]]; then
  echo "contract-selectors.sh: no selectors left for $1 in $ARTIFACT" >&2
  exit 1
fi
cast abi-encode "f(bytes4[])" "[$SELECTORS]"
