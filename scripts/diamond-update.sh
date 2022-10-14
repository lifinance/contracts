#!/bin/bash


update() {
	NETWORK=$(cat ./networks | gum filter --placeholder "Network...")
	SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Update' | gum filter --placeholder "Diamond Update Script")

	RAW_RETURN_DATA=$(NETWORK=$NETWORK forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy)
	RETURN_DATA=$(echo $RAW_RETURN_DATA | jq -r '.returns' 2> /dev/null)
	echo $RAW_RETURN_DATA
	
	facets=$(echo $RETURN_DATA | jq -r '.facets.value')

	saveDiamond $NETWORK "$facets"

}

saveDiamond() {
	NETWORK=$1
	FACETS=$(echo $2 | tr -d '[' | tr -d ']' | tr -d ',')
	FACETS=$(printf '"%s",' $FACETS | sed 's/,*$//')

	DIAMOND_FILE=./deployments/$NETWORK.diamond.json

	# create an empty json if it does not exist
	if [[ ! -e $DIAMOND_FILE ]]; then
		echo "{}" >"$DIAMOND_FILE"
	fi
	result=$(cat "$DIAMOND_FILE" | jq -r ". + {\"facets\": [$FACETS] }" || cat "$DIAMOND_FILE")
	printf %s "$result" >"$DIAMOND_FILE"
}


update
