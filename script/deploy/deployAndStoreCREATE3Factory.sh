#!/bin/bash

# deploys a CREATE3Factory
# stores the deployed-to address in networks.json
deployAndStoreCREATE3Factory() {
  # load config & helper functions
  source script/config.sh
  source script/helperFunctions.sh

  # make sure script was called with sufficient parameters
  if [ "$#" -lt 2 ]; then
    error "Usage: deployAndStoreCREATE3Factory <NETWORK> <ENVIRONMENT>"
    return 1
  fi

  echo ""
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying CREATE3Factory now...."


  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"

  # load env variables
  source .env

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # logging for debug purposes
  echo ""
  echoDebug "in function deployAndStoreCREATE3Factory"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echo ""

  # deploy CREATE3Factory
  local PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT")
	RAW_RETURN_DATA=$(PRIVATE_KEY="$PRIVATE_KEY" forge script script/deploy/facets/DeployCREATE3Factory.s.sol -f $NETWORK -vvvv --verify --json --legacy --broadcast --skip-simulation --gas-limit 2000000)
	RETURN_CODE=$?
	CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
  echo "CLEAN_RETURN_DATA: $CLEAN_RETURN_DATA"
	RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2>/dev/null)

	if [[ $RETURN_CODE -ne 0 ]]; then
		error "❌ Deployment of CREATE3Factory failed"
		return 1
	fi


  # obtain deployed-to address
	FACTORY_ADDRESS=$(echo $RETURN_DATA | jq -r '.deployed.value')
	echo "✅ Successfully deployed to address $FACTORY_ADDRESS"

  if [[ -z "$FACTORY_ADDRESS" || "$FACTORY_ADDRESS" == "null"  ]]; then
    error "Failed to obtain deployed contract address for CREATE3Factory on $NETWORK ($ENVIRONMENT)"
    return 1
  fi

  # check if network exists in networks.json
  if ! jq -e --arg net "$NETWORK" '.[$net]' "$NETWORKS_JSON_FILE_PATH" >/dev/null; then
    error "Network \"$NETWORK\" does not exist in networks.json"
    return 1
  fi

  # update create3Factory field in networks.json
  tmpfile=$(mktemp)
  if ! jq --arg net "$NETWORK" --arg addr "$FACTORY_ADDRESS" \
    '(.[$net].create3Factory) = $addr' "$NETWORKS_JSON_FILE_PATH" > "$tmpfile"; then
    error "Failed to update networks.json"
    rm -f "$tmpfile"
    return 1
  fi

  mv "$tmpfile" "$NETWORKS_JSON_FILE_PATH"
  echo "Stored CREATE3Factory address ($FACTORY_ADDRESS) in networks.json for network \"$NETWORK\""

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< CREATE3Factory deployed (please check for warnings)"
  echo ""
  return 0
}
