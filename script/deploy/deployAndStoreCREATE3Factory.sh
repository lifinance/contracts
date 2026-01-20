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
  echo "Trying to deploy CREATE3Factory now"
  echo ""
  local PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT")

  # Set gas estimate multiplier (default to 200 if not set in .env)
  if [[ -z "$GAS_ESTIMATE_MULTIPLIER" ]]; then
    GAS_ESTIMATE_MULTIPLIER=200
  fi

  # Add skip simulation flag based on environment variable
  SKIP_SIMULATION_FLAG=$(getSkipSimulationFlag)

  # Execute, parse, and check return code
  if ! executeAndParse \
    "PRIVATE_KEY=\"$PRIVATE_KEY\" forge script script/deploy/facets/DeployCREATE3Factory.s.sol -f \"$NETWORK\" --json --broadcast $SKIP_SIMULATION_FLAG --slow --legacy --gas-estimate-multiplier \"$GAS_ESTIMATE_MULTIPLIER\"" \
    "true" \
    "❌ Deployment of CREATE3Factory failed on network $NETWORK" \
    "return"; then
    unset PRIVATE_KEY
    return 1
  fi
  unset PRIVATE_KEY

  # Extract deployed-to address from parsed return data
  FACTORY_ADDRESS=$(extractDeployedAddressFromRawReturnData "$RAW_RETURN_DATA" "$NETWORK")
	if [[ $? -ne 0 ]]; then
		error "❌ Could not extract deployed address from raw return data"
		return 1
	fi

  if [[ -z "$FACTORY_ADDRESS" || "$FACTORY_ADDRESS" == "null"  ]]; then
    error "Failed to obtain deployed contract address for CREATE3Factory on $NETWORK ($ENVIRONMENT)"
    return 1
  fi

	echo "✅ Successfully deployed to address $FACTORY_ADDRESS"

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

  # verify CREATE3Factory
  # verifyContract "$NETWORK" "CREATE3Factory" "$FACTORY_ADDRESS" "0x"

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< CREATE3Factory deployed (please check for warnings)"
  echo ""
  return 0
}
