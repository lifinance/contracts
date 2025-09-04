#!/bin/bash

# deploys an LDA facet contract and adds it to LiFiDEXAggregatorDiamond contract
function deployFacetAndAddToLDADiamond() {
  # load env variables
  source .env

  # load config & helper functions
  source script/config.sh
  source script/helperFunctions.sh
  source script/deploy/deploySingleContract.sh
  source script/tasks/ldaDiamondUpdateFacet.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local FACET_CONTRACT_NAME="$3"
  local DIAMOND_CONTRACT_NAME="$4"
  local VERSION="$5"

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
    NETWORK=$(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH" | gum filter --placeholder "Network")
    checkRequiredVariablesInDotEnv $NETWORK
  fi

  # if no ENVIRONMENT was passed to this function, determine it
  if [[ -z "$ENVIRONMENT" ]]; then
    if [[ "$PRODUCTION" == "true" ]]; then
      # make sure that PRODUCTION was selected intentionally by user
      echo "    "
      echo "    "
      printf '\033[31m%s\031\n' "!!!!!!!!!!!!!!!!!!!!!!!! ATTENTION !!!!!!!!!!!!!!!!!!!!!!!!";
      printf '\033[33m%s\033[0m\n' "The config environment variable PRODUCTION is set to true";
      printf '\033[33m%s\033[0m\n' "This means you will be deploying LDA contracts to production";
      printf '\033[31m%s\031\n' "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!";
      echo "    "
      printf '\033[33m%s\033[0m\n' "Last chance: Do you want to skip?";
      PROD_SELECTION=$(gum choose \
          "yes" \
          "no" \
          )

      if [[ $PROD_SELECTION != "no" ]]; then
        echo "...exiting script"
        exit 0
      fi

      ENVIRONMENT="production"
    else
      ENVIRONMENT="staging"
    fi
  fi

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # if no FACET_CONTRACT_NAME was passed to this function, ask user to select it
  if [[ -z "$FACET_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which LDA facet you would like to deploy"
    local SCRIPT=$(ls -1 script/deploy/facets/LDA/ | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy LDA Script")
    FACET_CONTRACT_NAME=$(echo $SCRIPT | sed -e 's/Deploy//')
  fi

  # if no DIAMOND_CONTRACT_NAME was passed to this function, default to LDADiamond
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    DIAMOND_CONTRACT_NAME="LiFiDEXAggregatorDiamond"
  fi

  # get LDA diamond address from deployments script (using .lda. file suffix)
  local LDA_DEPLOYMENT_FILE="./deployments/${NETWORK}.lda.${FILE_SUFFIX}json"
  local DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "$LDA_DEPLOYMENT_FILE")

  # if no diamond address was found, throw an error and exit this script
  if [[ "$DIAMOND_ADDRESS" == "null" ]]; then
    error "could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file '$LDA_DEPLOYMENT_FILE' - exiting script now"
    return 1
  fi

  # if no VERSION was passed to this function, we assume that the latest version should be deployed
  if [[ -z "$VERSION" ]]; then
    VERSION=$(getCurrentContractVersion "$FACET_CONTRACT_NAME")
  fi

  # logging for debug purposes
  echo ""
  echoDebug "in function deployFacetAndAddToLDADiamond"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echoDebug "FACET_CONTRACT_NAME=$FACET_CONTRACT_NAME"
  echoDebug "DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "VERSION=$VERSION"

  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying LDA $FACET_CONTRACT_NAME for $DIAMOND_CONTRACT_NAME now...."

  # deploy LDA facet (using LDA-specific deploy script directory)
  deploySingleContract "$FACET_CONTRACT_NAME" "$NETWORK" "$ENVIRONMENT" "$VERSION" false "$DIAMOND_CONTRACT_NAME" "LDA"

  # check if function call was successful
  if [ $? -ne 0 ]
  then
    warning "this call was not successful: deploySingleContract $FACET_CONTRACT_NAME $NETWORK $ENVIRONMENT $VERSION false $DIAMOND_CONTRACT_NAME LDA"
    return 1
  fi

  # prepare LDA update script name
  local UPDATE_SCRIPT="Update$FACET_CONTRACT_NAME"

  # update LDA diamond
  ldaDiamondUpdateFacet "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" "$UPDATE_SCRIPT" true

  if [ $? -ne 0 ]
  then
    warning "this call was not successful: ldaDiamondUpdateFacet $NETWORK $ENVIRONMENT $DIAMOND_CONTRACT_NAME $UPDATE_SCRIPT true"
    return 1
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< LDA $FACET_CONTRACT_NAME successfully deployed and added to $DIAMOND_CONTRACT_NAME"
  return 0
}

