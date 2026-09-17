#!/bin/bash



deployPeripheryContracts() {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying periphery contracts now...."

  # load helper functions
  # Note: .env is already sourced in the parent script, so we don't need to source it again
  # This prevents overwriting exported variables like SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  source script/helperFunctions.sh
  source script/deploy/deploySingleContract.sh

  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  DIAMOND_CONTRACT_NAME="$3"

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  #TODO: add code to fill variables for standalone call

  # logging for debug purposes
  echoDebug "in function deployPeripheryContracts"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echoDebug "DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"

  # get names of all periphery contracts (that are not excluded in config)
  PERIPHERY_CONTRACTS=$(getIncludedPeripheryContractsArray)

  # get names of all security contracts (that are not excluded in config)
  SECURITY_CONTRACTS=$(getIncludedSecurityContractsArray)

  # combine periphery and security contracts
  AUXILIARY_CONTRACTS="$PERIPHERY_CONTRACTS $SECURITY_CONTRACTS"

  local REFUSED=()

  # loop through all contracts
  for CONTRACT in $AUXILIARY_CONTRACTS; do

    # get current contract version
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")

    # check if contract is present in target state JSON (=if it should be deployed)
    TARGET_VERSION=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_CONTRACT_NAME")
    RETURN_VALUE="$?"

    echoDebug "target version for $CONTRACT extracted from target state: $TARGET_VERSION (current version in repo: $CURRENT_VERSION)"

    # check return code of findContractVersionInTargetState
    if [[ "$RETURN_VALUE" -ne 0 ]]; then
      # no matching entry found in target state file, no deployment needed
      echo "[info] contract $CONTRACT not found in target state file > no deployment needed"
    else
      # A pin that disagrees with the repo is refused inside deploySingleContract. The
      # refusal is collected rather than ignored: a contract target state declares but
      # nothing deployed is exactly what every health check then reports as missing, and
      # a run that returns 0 hides it.
      if ! deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$CURRENT_VERSION"; then
        REFUSED+=("$CONTRACT")
      fi
    fi
  done

  if [[ ${#REFUSED[@]} -gt 0 ]]; then
    error "these periphery contracts were not deployed: ${REFUSED[*]}"
    return 1
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< periphery contracts deployed (please check for warnings)"
  return 0
}


