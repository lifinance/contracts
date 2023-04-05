#!/bin/bash

# deploys all "core facet" contracts to the given network/environment
# core facets are contracts that are listed under CORE_FACETS in deployConfig.sh
deployCoreFacets() {
  echo ""
  echo "[info] ------ deploying core facets now...."

  # load config & helper functions
  source scripts/deploy/deployConfig.sh
  source scripts/deploy/deployHelperFunctions.sh
  source scripts/deploy/deploySingleContract.sh

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
    echo "[debug] in function deployCoreFacets"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
  fi

  # get list of all core facet contracts
  IFS=',' read -ra FACETS_ARRAY <<< "$CORE_FACETS"

  # loop through all contracts
  for CONTRACT in "${FACETS_ARRAY[@]}"; do
    echo ""
    # get current contract version
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")

    # check if contract is deployed already
    DEPLOYED=$(findContractInLogFile "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$CURRENT_VERSION")

    # check return code of findContractInLogFile
    if [[ "$?" -ne 0 ]]; then
      # contract not found in log file (= has not been deployed to this network/environment)
      # get deploy script name
      SCRIPT="Deploy""$CONTRACT"

      # call deploy script for current contract
      deploySingleContract "$CONTRACT" "$NETWORK" "$SCRIPT" "$ENVIRONMENT" "$CURRENT_VERSION"

      # check if function call was successful
      if [ $? -ne 0 ]
      then
        echo "[warning] deployment of contract $CONTRACT to network $NETWORK failed :("
      else
        echo "[info] deployment of contract $CONTRACT to network $NETWORK successful :)"
      fi
    else
      # contract found in log file
      echo "[info] contract $CONTRACT is deployed already in version $CURRENT_VERSION"
    fi
  done

  echo "[info] ------ core facets deployed (please check for warnings)"
  return 0
}
