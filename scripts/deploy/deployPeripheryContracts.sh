#!/bin/bash



deployPeripheryContracts() {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying periphery contracts now...."

  # load config & helper functions
  source scripts/config.sh
  source scripts/deploy/resources/deployHelperFunctions.sh
  source scripts/deploy/deploySingleContract.sh

  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  DIAMOND_CONTRACT_NAME="$3"

  # load env variables
  source .env

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  #TODO: add code to fill variables for standalone call

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo "[debug] in function deployPeripheryContracts"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
  fi

  # get names of all periphery contracts (that are not excluded in config)
  PERIPHERY_CONTRACTS=$(getIncludedPeripheryContractsArray)

  # loop through all contracts
  for CONTRACT in $PERIPHERY_CONTRACTS; do

    # get current contract version
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")

    # check if contract is deployed already
    # TODO: change to check for actual deployment?
    # TODO: do I have to change logfile structure for diamond type, too?
    DEPLOYED=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$CURRENT_VERSION")

    # check return code of findContractInLogFile
    if [[ "$?" -ne 0 ]]; then
      # contract not found in log file (= has not been deployed to this network/environment)
      # check if contract is present in target state JSON (=should be deployed)
      TARGET_VERSION=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_CONTRACT_NAME")
      RETURN_VALUE="$?"

      if [[ "$DEBUG" == *"true"* ]]; then
        echo "[debug] target version for $CONTRACT extracted from target state: $TARGET_VERSION (current version in repo: $CURRENT_VERSION)"
      fi


      # check return code of findContractVersionInTargetState
      if [[ "$RETURN_VALUE" -ne 0 ]]; then
        # no matching entry found in target state file, no deployment needed
        echo "[info] contract $CONTRACT not found in target state file > no deployment needed"
      else
        # matching entry found - should be deployed in target version
        if [[ "$CURRENT_VERSION" == "$TARGET_VERSION" ]]; then
          # target state version and current version match > deploy contract
          # call deploy script for current contract
          deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$CURRENT_VERSION"

          # TODO: reactivate or remove
          # check if function call was successful
          #if [ $? -ne 0 ]
          #then
          #  warning "deployment of contract $CONTRACT to network $NETWORK failed :("
          #else
          #  echo "[info] deployment of contract $CONTRACT to network $NETWORK successful :)"
          #fi
        else
          # target state version and current version do not match > throw warning and skip iteration
          warning "target state version does not match with current version (contract=$CONTRACT, target_version=$TARGET_VERSION, current_version=$CURRENT_VERSION) >> contract will not be deployed"
          continue
        fi
      fi
    else
      # contract found in log file
      echo "[info] contract $CONTRACT is deployed already in version $CURRENT_VERSION"
    fi
  done

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< periphery contracts deployed (please check for warnings)"
  return 0
}



