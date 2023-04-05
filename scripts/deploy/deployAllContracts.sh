#!/bin/bash

deployAllContracts() {
  # load config & helper functions
  source scripts/deploy/deployConfig.sh
  source scripts/deploy/deployHelperFunctions.sh
  source scripts/deploy/deployPeripheryContracts.sh
  source scripts/deploy/deployCoreFacets.sh
  source scripts/deploy/diamondUpdate.sh
  #source scripts/update-periphery.sh


  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"

  # load env variables
  source .env

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function deployAllContracts"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
  fi

  # ask user which diamond type to deploy
  echo ""
  echo "Please select which type of diamond contract to deploy:"
  SELECTION=$(gum choose \
    "1) Mutable"\
    "2) Immutable"\
    )

  if [[ "$SELECTION" == *"1)"* ]]; then
    DIAMOND_CONTRACT_NAME="LiFiDiamond"
  elif [[ "$SELECTION" == *"2)"* ]]; then
    DIAMOND_CONTRACT_NAME="LiFiDiamondImmutable"
  else
    echo "[error] invalid value selected: $SELECTION - exiting script now"
    exit 1
  fi

  # deploy core facets
  deployCoreFacets "$NETWORK" "$ENVIRONMENT"

  # prepare deploy script name for diamond
  DIAMOND_SCRIPT="Deploy""$DIAMOND_CONTRACT_NAME"

  # get current diamond contract version
  VERSION=$(getCurrentContractVersion "$DIAMOND_CONTRACT_NAME")

  # deploy diamond
  deploySingleContract "$DIAMOND_CONTRACT_NAME" "$NETWORK" "$DIAMOND_SCRIPT" "$ENVIRONMENT" "$VERSION"

  # check if last command was executed successfully, otherwise exit script with error message
  checkFailure $? "deploy contract $DIAMOND_CONTRACT_NAME to network $NETWORK"

  # update diamond with core facets
  echo ""
  echo "[info] now updating core facets in diamond contract"
  diamondUpdate "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" "$FILE_SUFFIX" "UpdateCoreFacets"

  # run sync dexs script

  # run sync sigs script

  # deploy facets
    # configure facets, where needed

  # update diamond

  # deploy periphery
  deployPeripheryContracts "$NETWORK" "$ENVIRONMENT"

  # update periphery registry
  #updatePeriphery #TODO: needs to be updated to accept parameters





  echo "Press button to continue"
  read

}

deployAllContracts "goerli" "staging"

