#!/bin/bash

# deploys LDA core facets
deployLDACoreFacets() {
  # load config & helper functions
  source script/config.sh
  source script/helperFunctions.sh
  source script/deploy/deploySingleContract.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"

  # load env variables
  source .env

  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start deployLDACoreFacets"

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # logging for debug purposes
  echo ""
  echoDebug "in function deployLDACoreFacets"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echo ""

  # Read LDA core facets from global.json config file
  local GLOBAL_CONFIG_PATH="./config/global.json"
  if [[ ! -f "$GLOBAL_CONFIG_PATH" ]]; then
    error "Global config file not found: $GLOBAL_CONFIG_PATH"
    return 1
  fi

  # Extract LDA core facets from JSON config
  local LDA_CORE_FACETS_JSON=$(jq -r '.ldaCoreFacets[]' "$GLOBAL_CONFIG_PATH")
  local LDA_CORE_FACETS=()
  while IFS= read -r facet; do
    LDA_CORE_FACETS+=("$facet")
  done <<< "$LDA_CORE_FACETS_JSON"

  echo "[info] Found ${#LDA_CORE_FACETS[@]} LDA core facets in config: ${LDA_CORE_FACETS[*]}"

  # loop through LDA core facets and deploy them
  for FACET_NAME in "${LDA_CORE_FACETS[@]}"; do
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying LDA core facet: $FACET_NAME"

    # get current contract version
    local VERSION=$(getCurrentContractVersion "$FACET_NAME")

    # deploy the LDA core facet
    deploySingleContract "$FACET_NAME" "$NETWORK" "$ENVIRONMENT" "$VERSION" "false" "true"

    # check if last command was executed successfully
    if [ $? -eq 0 ]; then
      echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< LDA core facet $FACET_NAME successfully deployed"
    else
      error "failed to deploy LDA core facet $FACET_NAME to network $NETWORK"
      return 1
    fi
  done

  echo ""
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployLDACoreFacets completed"
  
  return 0
}
