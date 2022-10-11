#!/bin/bash


update() {
	NETWORK=$(cat ./networks | gum filter --placeholder "Network...")
	SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'DiamondUpdate' | gum choose --cursor "Diamond Update Script > ")

	RAW_RETURN_DATA=$(NETWORK=$NETWORK forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy)
	RETURN_DATA=$(echo $RAW_RETURN_DATA | jq -r '.returns' 2> /dev/null)
	echo $RETURN_DATA
}

update
