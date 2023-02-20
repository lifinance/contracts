#!/bin/bash

deploy() {
  # load env variables
	source .env

  # check if env variable "PRODUCTION" is true, otherwise deploy as staging
	if [[ -z "$PRODUCTION" ]]; then
		FILE_SUFFIX="staging."
	fi

  # get user-selected network from list
	NETWORK=$(cat ./networks | gum filter --placeholder "Network")
  # get user-selected network from list
	SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
	CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')

  # if selected contract is "LiFiDiamondImmutable" then use an adjusted salt for deployment to prevent clashes
  if [[ $CONTRACT = "LiFiDiamondImmutable" ]]; then
    # adjust contract name (remove "Immutable") since we are using our standard diamond contract
    CONTRACTADJ=$(echo "$CONTRACT" | sed 's/Immutable//')
    # get contract bytecode
    BYTECODE=$(forge inspect $CONTRACTADJ bytecode)
    # adds a string to the end of the bytecode to alter the salt but always produce deterministic results based on bytecode
    BYTECODEADJ="$BYTECODE"ffffffffffffffffffffffffffffffffffffffff
    # create salt with keccak(bytecode)
    SALT=$(cast keccak $BYTECODEADJ)
  else
    # in all other cases just create a salt based on the contract bytecode
    CONTRACTADJ=$CONTRACT
    BYTECODE=$(forge inspect $CONTRACT bytecode)
    SALT=$(cast keccak $BYTECODE)
  fi

  # display the name of the selected script that will be executed
	echo "Deploying $SCRIPT to $NETWORK"

  # execute script
	RAW_RETURN_DATA=$(SALT=$SALT NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy)
	checkFailure
  echo $RAW_RETURN_DATA
  # clean tx return data
	CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
	echo $CLEAN__RETURN_DATA | jq 2> /dev/null
	checkFailure

  # extract the "returns" field and its contents from the return data (+hide errors)
	RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2> /dev/null)

  # extract deployed-to address from return data
	deployed=$(echo $RETURN_DATA | jq -r '.deployed.value')
  # extract constructor arguments from return data
	args=$(echo $RETURN_DATA | jq -r '.constructorArgs.value // "0x00"')
	echo "$CONTRACT deployed on $NETWORK at address $deployed"

	saveContract $NETWORK $CONTRACT $deployed
	verifyContract $NETWORK $CONTRACTADJ $deployed $args
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
	echo "ADDRESS in verify: $ADDRESS"
	ARGS=$4
	API_KEY="$(tr '[:lower:]' '[:upper:]' <<< $NETWORK)_ETHERSCAN_API_KEY"
	if [ "$ARGS" = "0x" ]; then
		forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT "${!API_KEY}"
	else
		forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT --constructor-args $ARGS "${!API_KEY}"
	fi
}

checkFailure() {
	if [[ $? -ne 0 ]]; then
		echo "Failed to deploy $CONTRACT"
		exit 1
	fi
}

deploy
