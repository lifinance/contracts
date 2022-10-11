#!/bin/bash


deploy() {
	NETWORK=$(cat ./networks | gum filter --placeholder "Network...")
	SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum choose --cursor "Deploy Script > ")
	SALT=$(gum input --prompt "Salt: ")

	RAW_RETURN_DATA=$(SALT=$SALT NETWORK=$NETWORK forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy)
	RETURN_DATA=$(echo $RAW_RETURN_DATA | jq -r '.returns' 2> /dev/null)

	deployed=$(echo $RETURN_DATA | jq -r '.deployed.value')

	echo "$CONTRACT deployed on $NETWORK at address $deployed"

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

deploy
