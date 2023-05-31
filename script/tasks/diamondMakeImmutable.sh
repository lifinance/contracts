#!/bin/bash


diamondMakeImmutable() {
  # load env variables
	source .env

  # load config & helper functions
  source script/deploy/resources/deployHelperFunctions.sh

  # read function arguments into variables
  # the first parameter is unused/empty
  ENVIRONMENT="$2"
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # get user-selected network from list
  NETWORK=$(cat ./networks | gum filter --placeholder "Network")
  checkRequiredVariablesInDotEnv $NETWORK

  # define path of JSON file to get diamond address from
	ADDRS="deployments/$NETWORK.${FILE_SUFFIX}json"

  # get diamond address from path (finds any key that contains "LiFiDiamondImmutable", works with versioning
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
	attempts=1  # initialize attempts to 0

  while [ $attempts -lt 11 ]
  do
    echo "Trying to make diamond $DIAMOND immutable now - attempt ${attempts}"
    # try to execute call
    RAW_RETURN_DATA=$(NETWORK=$NETWORK SALT="" FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=false PRIVATE_KEY=$(getPrivateKey "$ENVIRONMENT") forge script script/tasks/solidity/MakeLiFiDiamondImmutable.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy --tc DeployScript)
    RETURN_CODE=$?

    # print return data only if debug mode is activated
    echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

    # check return data for error message (regardless of return code as this is not 100% reliable)
    if [[ $RAW_RETURN_DATA == *"\"logs\":[]"* && $RAW_RETURN_DATA == *"\"returns\":{}"* ]]; then
      # try to extract error message and throw error
      ERROR_MESSAGE=$(echo "$RAW_RETURN_DATA" | sed -n 's/.*0\\0\\0\\0\\0\(.*\)\\0\".*/\1/p')
      if [[ $ERROR_MESSAGE == "" ]]; then
        error "execution of deploy script failed. Could not extract error message. RAW_RETURN_DATA: $RAW_RETURN_DATA"
      else
        error "execution of deploy script failed with message: $ERROR_MESSAGE"
      fi

    # check the return code the last call
    elif [ $RETURN_CODE -eq 0 ]; then
      break  # exit the loop if the operation was successful
    fi

    attempts=$((attempts+1))  # increment attempts
    sleep 1  # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq 11 ]
  then
      echo "Failed to make $DIAMOND immutable"
      exit 1
  fi

  echo $RAW_RETURN_DATA

  echo ""
  echo "The diamond contract on network $NETWORK with address $DIAMOND is now immutable"
}



