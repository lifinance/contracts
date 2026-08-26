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

# Fail here rather than letting jq emit an empty selector list, which would encode as a
# no-op diamond cut instead of an error.
if [[ ! -f "$ARTIFACT" ]]; then
  echo "contract-selectors.sh: no build artifact at $ARTIFACT" >&2
  exit 1
fi

SELECTORS=$(jq --argjson exclude "$filter" -r '.methodIdentifiers | . | del(.. | select(. == $exclude[])) | join(",")'  "$ARTIFACT")
cast abi-encode "f(bytes4[])" "[$SELECTORS]"
