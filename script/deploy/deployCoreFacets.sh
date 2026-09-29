#!/bin/bash

# deployCoreFacets: Deploy every core facet configured in global.json.
#
# Usage: deployCoreFacets NETWORK ENVIRONMENT [DIAMOND_CONTRACT_NAME]
#   NETWORK               - Network receiving the deployments
#   ENVIRONMENT           - Deployment environment
#   DIAMOND_CONTRACT_NAME - Optional: target-state diamond block (default: LiFiDiamond)
#
# Returns: 0 when every applicable core facet deploys; 1 when any deployment is refused
# Example: deployCoreFacets "arbitrum" "production" "LiFiDiamond"
deployCoreFacets() {
  echo ""
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying core facets now...."

  # load helper functions
  source script/helperFunctions.sh
  source script/deploy/deploySingleContract.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="${3:-LiFiDiamond}"

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

  # read gasZipChainId to determine if GasZipFacet should be deployed
  local GAS_ZIP_CHAIN_ID
  GAS_ZIP_CHAIN_ID=$(getValueFromJSONFile "$NETWORKS_JSON_FILE_PATH" "$NETWORK.gasZipChainId")

  local REFUSED=()

  # loop through all contracts
  for CONTRACT in "${FACETS_ARRAY[@]}"; do
    # skip GasZipFacet if network has no GasZip support
    if [[ "$CONTRACT" == "GasZipFacet" && "$GAS_ZIP_CHAIN_ID" == "0" ]]; then
      echo "[info] Skipping GasZipFacet deployment (gasZipChainId is 0 for $NETWORK)"
      continue
    fi
    # get current contract version
    local CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")

    # call deploy script for current contract
    # Collected rather than ignored, for the same reason the periphery loop collects: a
    # core facet that was refused (a version pin, or any other failure) is not deployed,
    # and a stage that returns 0 anyway hides it until the health check reports it missing.
    if ! deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$CURRENT_VERSION" "false" "$DIAMOND_CONTRACT_NAME"; then
      REFUSED+=("$CONTRACT")
    fi
  done

  if [[ ${#REFUSED[@]} -gt 0 ]]; then
    error "these core facets were not deployed: ${REFUSED[*]}"
    return 1
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< core facets deployed (please check for warnings)"
  echo ""
  return 0
}
