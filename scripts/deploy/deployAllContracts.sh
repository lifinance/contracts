#!/bin/bash

deployAllContracts() {
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start deployAllContracts"

  # load required resources
  source scripts/deploy/resources/deployConfig.sh
  source scripts/deploy/resources/deployHelperFunctions.sh
  source scripts/deploy/deployPeripheryContracts.sh
  source scripts/deploy/deployCoreFacets.sh
  source scripts/tasks/diamondUpdate.sh
  source scripts/tasks/sync-dexs.sh
  source scripts/tasks/sync-sigs.sh
  source scripts/deploy/deployFacetAndAddToDiamond.sh
  source scripts/tasks/updatePeriphery.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"

  # load env variables
  source .env

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function deployAllContracts"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
    echo ""
  fi

  # ask user which diamond type to deploy
  echo ""
  echo "Please select which type of diamond contract to deploy:"
  local DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
  echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"

  # deploy core facets
  deployCoreFacets "$NETWORK" "$ENVIRONMENT"
  echo ""

  # prepare deploy script name for diamond
  local DIAMOND_SCRIPT="Deploy""$DIAMOND_CONTRACT_NAME"

  # get current diamond contract version
  local VERSION=$(getCurrentContractVersion "$DIAMOND_CONTRACT_NAME")

  # deploy diamond
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying $DIAMOND_CONTRACT_NAME now"
  deploySingleContract "$DIAMOND_CONTRACT_NAME" "$NETWORK" "$ENVIRONMENT" "$VERSION" "true"

  # check if last command was executed successfully, otherwise exit script with error message
  checkFailure $? "deploy contract $DIAMOND_CONTRACT_NAME to network $NETWORK"
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< $DIAMOND_CONTRACT_NAME successfully deployed"

  # update diamond with core facets
  echo ""
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now updating core facets in diamond contract"
  diamondUpdate "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" "UpdateCoreFacets" false
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< core facets update completed"

  # check if last command was executed successfully, otherwise exit script with error message
  checkFailure $? "update core facets in $DIAMOND_CONTRACT_NAME on network $NETWORK"

  # run sync dexs script
  echo ""
  syncDEXs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

  # run sync sigs script
  echo ""
  syncSIGs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

  # deploy all non-core facets (that are in target_state.JSON) and add to diamond
  echo ""
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now deploying non-core facets and adding to diamond contract"
  # get all facet contract names
  local FACETS_PATH="$CONTRACT_DIRECTORY""Facets/"

  # prepare regExp to exclude core facets
  local EXCLUDED_FACETS_REGEXP="^($(echo "$CORE_FACETS" | tr ',' '|'))$"

  # loop through facet contract names
  for FACET_NAME in $(getContractNamesInFolder "$FACETS_PATH"); do
    if ! [[ "$FACET_NAME" =~ $EXCLUDED_FACETS_REGEXP ]]; then
      # check if facet is existing in target state JSON
      TARGET_VERSION=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$FACET_NAME" "$DIAMOND_CONTRACT_NAME")

      # check result
      if [[ $? -ne 0 ]]; then
        echo "[info] No matching entry found in target state file for NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, CONTRACT=$FACET_NAME >> no deployment needed"
      else
        # deploy facet and add to diamond
        deployFacetAndAddToDiamond "$NETWORK" "$ENVIRONMENT" "$FACET_NAME" "$DIAMOND_CONTRACT_NAME" "$TARGET_VERSION"
      fi
    fi
  done
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< non-core facets part completed"

  # deploy periphery
  deployPeripheryContracts "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

  # update periphery registry
  updatePeriphery "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" true false ""

  echo ""
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployAllContracts completed"
}

