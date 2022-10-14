#!/bin/bash
read -a EXCLUDE <<< "$2"
exclude='[]'  # Empty JSON array
for x in "${EXCLUDE[@]}"; do
  exclude=$(jq -n --arg x "$x" --argjson exclude "$exclude" '$exclude + [$x]')
done

SELECTORS=$(jq --argjson exclude "$exclude" -r '.methodIdentifiers | . | del(.. | select(. == $exclude[])) | join(",")'  ./out/$1.sol/$1.json)
cast abi-encode "f(bytes4[])" "[$SELECTORS]" 
