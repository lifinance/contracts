#!/bin/bash

# deploys all "core facet" contracts to the given network/environment
# core facets are contracts that are listed under coreFacets in global.json
deployCoreFacets() {
  echo ""
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying core facets now...."

  # load config & helper functions
  source script/config.sh
  source script/helperFunctions.sh
  source script/deploy/deploySingleContract.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"

  # load env variables
  source .env

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # logging for debug purposes
  echo ""
  echoDebug "in function deployCoreFacets"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echo ""

  # get list of all core facet contracts
  FACETS_ARRAY=($(getCoreFacetsArray))
  checkFailure $? "retrieve core facets array from global.json"

  # loop through all contracts
  for CONTRACT in "${FACETS_ARRAY[@]}"; do
    # get current contract version
    local CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")

    # call deploy script for current contract
    deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$CURRENT_VERSION" "false"
  done
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< core facets deployed (please check for warnings)"
  echo ""
  return 0
}
