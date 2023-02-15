#!/bin/bash



update() {
  # load env variables
	source .env

  # check if env variable "PRODUCTION" is true, otherwise deploy as staging
	if [[ -z "$PRODUCTION" ]]; then
		FILE_SUFFIX="staging."
	fi

  # get user-selected network from list
  NETWORK=$(cat ./networks | gum filter --placeholder "Network...")

  # define path of JSON file to get diamond address from
	ADDRS="deployments/$NETWORK.${FILE_SUFFIX}json"

  # get diamond address from path (finds any key that contains "LiFiDiamondImmutable", works with versioning (V1, V2 etc.)
  DIAMOND=$(jq 'to_entries[] | select(.key | contains("LiFiDiamondImmutable")) | .value' $ADDRS)

  gum style \
	--foreground 212 --border-foreground 213 --border double \
	--align center --width 50 --margin "1 2" --padding "2 4" \
	'!!! ATTENTION !!!'

  echo "Please check that this is the correct diamond address: $DIAMOND"
  echo "If you confirm the next prompt, this diamond will be made immutable"
  echo "Please check if you have added all necessary facets"
  echo "Once this script is completed, it is irreversible and the contract cannot be altered in any way"
  echo "    "
  echo "Last chance: Do you want to skip?"
  gum confirm && exit 1 || echo "OK, let's do it"

	# execute selected script
	RAW_RETURN_DATA=$(NETWORK=$NETWORK SALT="" FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=true forge script script/MakeLiFiDiamondImmutable.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy --tc DeployScript)
  checkFailure
  echo $RAW_RETURN_DATA

  echo ""
  echo "The diamond contract on network $NETWORK with address $DIAMOND is now immutable"
}

checkFailure() {
	if [[ $? -ne 0 ]]; then
		echo "Failed to make $DIAMOND immutable"
		exit 1
	fi
}

update

