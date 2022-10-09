#!/bin/bash

deploy() {
	NETWORK=$(cat ./networks | gum choose)
	CONTRACT=$(cat ./contracts | gum choose)
	SALT=$(gum input --prompt "Salt: ")

	RAW_RETURN_DATA=$(forge script "script/Deploy$CONTRACT.s.sol" -f $NETWORK -vvvv --json --silent --verify --skip-simulation --legacy)
	RETURN_DATA=$(echo $RAW_RETURN_DATA | jq -r '.returns' 2> /dev/null)

	deployed=$(echo $RETURN_DATA | jq -r '.factory.value')

	saveContract $NETWORK $CONTRACT $deployed
}

saveContract() {
	NETWORK=$1
	CONTRACT=$2
	ADDRESS=$3

	ADDRESSES_FILE=./deployments/$NETWORK.json

	# create an empty json if it does not exist
	if [[ ! -e $ADDRESSES_FILE ]]; then
		echo "{}" >"$ADDRESSES_FILE"
	fi
	result=$(cat "$ADDRESSES_FILE" | jq -r ". + {\"$CONTRACT\": \"$ADDRESS\"}")
	printf %s "$result" >"$ADDRESSES_FILE"
}

deploy $1
