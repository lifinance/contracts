#!/bin/bash


diamondUpdate() {
  # load required resources
  source .env
  source scripts/deploy/deployConfig.sh
  source scripts/deploy/deployHelperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"
  local SCRIPT="$4"
  local REPLACE_EXISTING_FACET="$5"

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    NETWORK=$(getUserSelectedNetwork)

    # check the return code the last call
    if [ $? -ne 0 ]; then
      echo "$NETWORK" # will contain an error message
      exit 1
    fi
    # get deployer wallet balance
    BALANCE=$(getDeployerBalance "$NETWORK")

    echo "[info] selected network: $NETWORK"
    echo "[info] deployer wallet balance in this network: $BALANCE"
    echo ""
  fi

  # if no ENVIRONMENT was passed to this function, determine it
  if [[ -z "$ENVIRONMENT" ]]; then
    if [[ "$PRODUCTION" == "true" ]]; then
      # make sure that PRODUCTION was selected intentionally by user
      gum style \
      --foreground 212 --border-foreground 213 --border double \
      --align center --width 50 --margin "1 2" --padding "2 4" \
      '!!! ATTENTION !!!'

      echo "Your environment variable PRODUCTION is set to true"
      echo "This means you will be deploying contracts to production"
      echo "    "
      echo "Do you want to skip?"
      gum confirm && exit 1 || echo "OK, continuing to deploy to PRODUCTION"

      ENVIRONMENT="production"
    else
      ENVIRONMENT="staging"
    fi
  fi

  # if no DIAMOND_CONTRACT_NAME was passed to this function, ask user to select diamond type
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to update:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
    echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi

  # get diamond address from deployments script
  DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "./deployments/${NETWORK}.${FILE_SUFFIX}json")

  # if no diamond address was found, throw an error and exit the script
  if [[ "$DIAMOND_ADDRESS" == "null" ]]; then
    echo "[error] could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file './deployments/${NETWORK}.${FILE_SUFFIX}json' - exiting updatePeriphery script now"
    return 1
  fi

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # if no SCRIPT was passed to this function, ask user to select it
  if [[ -z "$SCRIPT" ]]; then
    echo "Please select which facet you would like to update"
    SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Update' | gum filter --placeholder "Update Script")
  fi

  # set flag for mutable/immutable diamond
  USE_MUTABLE_DIAMOND=$( [[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]] && echo true || echo false )

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo "[debug] updating $DIAMOND_CONTRACT_NAME on $NETWORK with address $DIAMOND_ADDRESS in $ENVIRONMENT environment with script $SCRIPT (FILE_SUFFIX=$FILE_SUFFIX, USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND)"
  fi

    # check if update script exists
  local FULL_SCRIPT_PATH=""$DEPLOY_SCRIPT_DIRECTORY""$SCRIPT"".s.sol""
  if ! checkIfFileExists "$FULL_SCRIPT_PATH" >/dev/null; then
    echo "[error] could not find update script for $CONTRACT in this path: $FULL_SCRIPT_PATH". Aborting update.
    return 1
  fi

  # special handling for core facets since there we have several contracts in one call
  if [ "$SCRIPT" == "UpdateCoreFacets" ]; then
    if [[ "$DEBUG" == *"true"* ]]; then
      echo "[debug] in diamondUpdate for UpdateCoreFacets"
    fi
    # set facet contract name for logging
    local FACET_CONTRACT_NAME="CoreFacets"

    # check if core facets should be replaced
    if [[ "$REPLACE_EXISTING_FACET" == *"true"* ]]; then
        echo "[error] this case is not yet implemented (>> replace existing CoreFacets)"
        exit 1
    else
      if [[ "$DEBUG" == *"true"* ]]; then
        echo "[debug] in diamondUpdate for CoreFacets with REPLACE_EXISTING_FACET=$REPLACE_EXISTING_FACET"
        # check if diamond knows core facets already
        doesDiamondHaveCoreFacetsRegistered "$DIAMOND_ADDRESS" "$NETWORK" "$FILE_SUFFIX"
      else
        # check if diamond knows core facets already
        doesDiamondHaveCoreFacetsRegistered "$DIAMOND_ADDRESS" "$NETWORK" "$FILE_SUFFIX" 2>/dev/null
      fi

      # check the return code the last call
      if [ $? -eq 0 ]; then
        local FACET_EXISTS=true
      fi
    fi
  else
    # in case: update single facet
    # get facet name from script
    local FACET_CONTRACT_NAME=${SCRIPT//Update/}

    # check if diamond contract already knows this facet
    local FACET_EXISTS=$(doesFacetExistInDiamond "$DIAMOND_ADDRESS" "$FACET_CONTRACT_NAME" "$NETWORK")
  fi

  # deploy facet if it exists
  if [ "$FACET_EXISTS" == "true" ]; then
    if [ "$REPLACE_EXISTING_FACET" == "true" ]; then
      if [[ "$DEBUG" == *"true"* ]]; then
        echo "[debug] trying to remove existing $FACET_NAME from diamond $DIAMOND_ADDRESS in $ENVIRONMENT environment on network $NETWORK now"
      fi
      # remove old facet
      removeFacetFromDiamond "$DIAMOND_ADDRESS" "$FACET_NAME" "$NETWORK" "$ENVIRONMENT" false

      # check the return code the last call
      if [ $? -ne 0 ]; then
        echo "[error] could not remove function selectors for $FACET_NAME from $DIAMOND_CONTRACT_NAME with address $DIAMOND_ADDRESS on network $NETWORK"
        return 1
      fi
    else
      echo "[info] $DIAMOND_CONTRACT_NAME with address $DIAMOND_ADDRESS already knows $FACET_CONTRACT_NAME and script was set to not replace it."
      return 0
    fi
  fi

  # deploy new facet
  attempts=1

  # TODO log details only if debug is on
  while [ $attempts -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to execute $SCRIPT on $DIAMOND_CONTRACT_NAME now - attempt ${attempts} (max attempts:$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"
    # try to execute call
    if [[ "$DEBUG" == *"true"* ]]; then
      # print output to console
      RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy)
    else
      # do not print output to console
      RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --verify --skip-simulation --legacy) 2>/dev/null
    fi
    # check the return code the last call
    if [ $? -eq 0 ]; then
        # extract the "logs" property and its contents from return data
        CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')

        # extract the "returns" property and its contents from logs
        RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2> /dev/null)

        # get the facet addresses that are known to the diamond from the return data
        FACETS=$(echo $RETURN_DATA | jq -r '.FACETS.value')
        if [[ $FACETS != "{}" ]]; then
          break # exit the loop if the operation was successful
        fi
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all attempts
  if [ $attempts -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    echo "[error] failed to execute $SCRIPT on network $NETWORK in $ENVIRONMENT environment"
    return 1
  fi

  # log return data
  if [[ "$DEBUG" == *"true"* ]]; then
      echo "[debug] return data: $RAW_RETURN_DATA"
  fi

  # save facet addresses
  saveDiamond "$NETWORK" "$USE_MUTABLE_DIAMOND" "$FACETS"

  echo "[info] $SCRIPT successfully executed on network $NETWORK in $ENVIRONMENT environment"
  return 0
}

saveDiamond() {
	source .env

	if [[ -z "$PRODUCTION" ]]; then
		FILE_SUFFIX="staging."
	fi

  # store function arguments in variables
	NETWORK=$1
	USE_MUTABLE_DIAMOND=$2
	FACETS=$(echo $3 | tr -d '[' | tr -d ']' | tr -d ',')
	FACETS=$(printf '"%s",' $FACETS | sed 's/,*$//')

  # define path for json file based on which diamond was used
  if [[ "$USE_MUTABLE_DIAMOND" == "true" ]]; then
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
