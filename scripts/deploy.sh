#!/bin/bash


deploy() {
	NETWORK=$(cat ./networks | gum filter --placeholder "Network")
	SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
	CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')
	BYTECODE=$(forge inspect $CONTRACT bytecode)
	SALT=$(cast keccak $BYTECODE)

	echo $SCRIPT

	RAW_RETURN_DATA=$(SALT=$SALT NETWORK=$NETWORK forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy)
	echo $RAW_RETURN_DATA | jq 2> /dev/null
	RETURN_DATA=$(echo $RAW_RETURN_DATA | jq -r '.returns' 2> /dev/null)

	deployed=$(echo $RETURN_DATA | jq -r '.deployed.value')
	args=$(echo $RETURN_DATA | jq -r '.constructorArgs.value // "0x"')

	echo "$CONTRACT deployed on $NETWORK at address $deployed"

	saveContract $NETWORK $CONTRACT $deployed
	verifyContract $NETWORK $CONTRACT $deployed $args
}

saveContract() {
	source .env

	if [[ -z "$PRODUCTION" ]]; then
		FILE_SUFFIX="staging."
	fi

	NETWORK=$1
	CONTRACT=$2
	ADDRESS=$3

	ADDRESSES_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

	# create an empty json if it does not exist
	if [[ ! -e $ADDRESSES_FILE ]]; then
		echo "{}" >"$ADDRESSES_FILE"
	fi
	result=$(cat "$ADDRESSES_FILE" | jq -r ". + {\"$CONTRACT\": \"$ADDRESS\"}" || cat "$ADDRESSES_FILE")
	printf %s "$result" >"$ADDRESSES_FILE"
}

verifyContract() {
	source .env

	NETWORK=$1
	CONTRACT=$2
	ADDRESS=$3
	ARGS=$4
	API_KEY="$(tr '[:lower:]' '[:upper:]' <<< $NETWORK)_ETHERSCAN_API_KEY"
	if [ "$ARGS" = "0x" ]; then
		forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT "${!API_KEY}"
	else
		forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT --constructor-args $ARGS "${!API_KEY}"
	fi
}
deploy
