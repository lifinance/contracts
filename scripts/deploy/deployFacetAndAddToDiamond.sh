#!/bin/bash

# deploys a facet contract and adds it to a diamond contract
function deployFacetAndAddToDiamond() {
  # load env variables
  source .env

  # load config & helper functions
  source scripts/deploy/deployConfig.sh
  source scripts/deploy/deployHelperFunctions.sh
  source scripts/deploy/deploySingleContract.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local FACET_CONTRACT_NAME="$3"
  local DIAMOND_CONTRACT_NAME="$4"
  local VERSION="$5"

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    NETWORK=$(cat ./networks | gum filter --placeholder "Network")
    checkRequiredVariablesInDotEnv $NETWORK
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

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # if no FACET_CONTRACT_NAME was passed to this function, ask user to select it
  if [[ -z "$FACET_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which facet you would like to deploy"
    local SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
    FACET_CONTRACT_NAME=$(echo $SCRIPT | sed -e 's/Deploy//')
  fi

  # if no DIAMOND_CONTRACT_NAME was passed to this function, ask user to select it
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to update:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
    echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi

  # get diamond address from deployments script
  local DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "./deployments/${NETWORK}.${FILE_SUFFIX}json")

  # if no diamond address was found, throw an error and exit this script
  if [[ "$DIAMOND_ADDRESS" == "null" ]]; then
    error "could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file './deployments/${NETWORK}.${FILE_SUFFIX}json' - exiting script now"
    return 1
  fi

  # if no VERSION was passed to this function, we assume that the latest version should be deployed
  if [[ -z "$VERSION" ]]; then
    VERSION=$(getCurrentContractVersion "$FACET_CONTRACT_NAME")
  fi

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function deployFacetAndAddToDiamond"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
    echo "[debug] FACET_CONTRACT_NAME=$FACET_CONTRACT_NAME"
    echo "[debug] DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] VERSION=$VERSION"
  fi

  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying $FACET_CONTRACT_NAME for $DIAMOND_CONTRACT_NAME now...."

  # deploy facet
  deploySingleContract "$FACET_CONTRACT_NAME" "$NETWORK" "$ENVIRONMENT" "$VERSION"

  # TODO: reactivate or remove
  # check if function call was successful
  if [ $? -ne 0 ]
  then
    return 1
  #else
  #  echo "[info] deployment of facet $FACET_CONTRACT_NAME to network $NETWORK successful :)"
  fi

  # prepare update script name
  local UPDATE_SCRIPT="Update$FACET_CONTRACT_NAME"

  # update diamond
  diamondUpdate "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" "$UPDATE_SCRIPT" true

  # TODO: reactivate or remove
  # check if function call was successful
  #if [ $? -ne 0 ]
  #then
  #  error "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< $FACET_CONTRACT_NAME could not be added to $DIAMOND_CONTRACT_NAME on network $NETWORK. Please check for errors and repeat."
  #  return 1
  #else
  #  echo "[info] $FACET_CONTRACT_NAME successfully added to $DIAMOND_CONTRACT_NAME on network $NETWORK"
  #fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< $FACET_CONTRACT_NAME successfully deployed and added to $DIAMOND_CONTRACT_NAME"
  return 0
}
