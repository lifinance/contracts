#!/bin/bash


update() {
  # load env variables
	source .env

  # check if env variable "PRODUCTION" is true, otherwise deploy as staging
	if [[ -z "$PRODUCTION" ]]; then
		FILE_SUFFIX="staging."
	fi

	# prompt user to choose which diamond to update (standard or immutable)
	echo "Please select which diamond to update:"
	SELECTION=$(gum choose "1) Mutable (default)" "2) Immutable")

  # get user-selected network from list
  NETWORK=$(cat ./networks | gum filter --placeholder "Network...")

  if [[ "$SELECTION" == *"default"* ]]; then
      echo "Updating mutable diamond on $NETWORK"
      USE_DEF_DIAMOND=true
  else
      echo "Updating immutable diamond on $NETWORK"
      USE_DEF_DIAMOND=false
  fi

	# get user-selected script from list
	SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Update' | gum filter --placeholder "Diamond Update Script")

  # execute script
  attempts=1 # initialize attempts to 0

  while [ $attempts -lt 11 ]; do
    echo "Trying to execute $SCRIPT now - attempt ${attempts}"
    # try to execute call
	  RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_DEF_DIAMOND forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy)

    # check the return code the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq 11 ]; then
    echo "Failed to execute $SCRIPT"
    exit 1
  fi

  echo $RAW_RETURN_DATA
  # extract the "logs" property and its contents from return data
	CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
  # extract the "returns" property and its contents from logs
	RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2> /dev/null)
  #echo $RETURN_DATA
	echo $CLEAN_RETURN_DATA | jq 2> /dev/null

	facets=$(echo $RETURN_DATA | jq -r '.facets.value')

	saveDiamond $NETWORK $USE_DEF_DIAMOND "$facets"

  echo "$SCRIPT successfully executed on network $NETWORK"
}

saveDiamond() {
	source .env

	if [[ -z "$PRODUCTION" ]]; then
		FILE_SUFFIX="staging."
	fi

  # store function arguments in variables
	NETWORK=$1
	USE_DEF_DIAMOND=$2
	FACETS=$(echo $3 | tr -d '[' | tr -d ']' | tr -d ',')
	FACETS=$(printf '"%s",' $FACETS | sed 's/,*$//')

  # define path for json file based on which diamond was used
  if [[ "$USE_DEF_DIAMOND" == "true" ]]; then
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.${FILE_SUFFIX}json"
  else
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.immutable.${FILE_SUFFIX}json"
  fi

	# create an empty json if it does not exist
	if [[ ! -e $DIAMOND_FILE ]]; then
		echo "{}" >"$DIAMOND_FILE"
	fi
	result=$(cat "$DIAMOND_FILE" | jq -r ". + {\"facets\": [$FACETS] }" || cat "$DIAMOND_FILE")
	printf %s "$result" >"$DIAMOND_FILE"
}

checkFailure() {
	if [[ $? -ne 0 ]]; then
		echo "Failed to update diamond"
		exit 1
	fi
}


update
