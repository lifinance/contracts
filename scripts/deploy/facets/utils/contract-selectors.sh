#!/bin/bash
declare -a EXCLUDE
IFS=" "
read -a EXCLUDE <<< $(sed 's/0x//g' <<< "$2")
filter='[]'  # Empty JSON array
for x in "${EXCLUDE[@]}"; do
  filter=$(jq -n --arg x "$x" --argjson exclude "$filter" '$exclude + [$x]')
done

SELECTORS=$(jq --argjson exclude "$filter" -r '.methodIdentifiers | . | del(.. | select(. == $exclude[])) | join(",")'  ./out/$1.sol/$1.json)
cast abi-encode "f(bytes4[])" "[$SELECTORS]"
