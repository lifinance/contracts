#!/bin/bash

# TODO

# - update master script to be able to call all other scripts
#   >>> including the solidity update config scripts


# - add verify contract use case (use bytecode and settings from storage)
# - create function that checks if contract is deployed (get bytecode, predict address, check bytecode at address)
# - return master log to store all deployments (and return latest when inquired)
# - add use case to only remove a facet
# - check if use case 4 will also check if a contract is added to diamond already
# - create use case to deploy and add all periphery (or check if target state use case covers it)
# - merging two branches with deployments in same network (does it cause merge-conflicts?)




# - clean code
#   - local before variables
#   - make environment / file suffix global variables
#   - add function descriptions in helper functions

# - write article
# - for immutable diamond we need to run some specific script - add to deploy script

# - add fancy stuff
#   - script runtime
#   -  add low balance warnings and currency symbols for deployer wallet balance



scriptMaster() {
  # load env variables
  source .env

  # load deploy scripts & helper functions
  source scripts/deploy/deploySingleContract.sh
  source scripts/deploy/deployAllContracts.sh
  source scripts/deploy/resources/deployHelperFunctions.sh
  source scripts/tasks/sync-dexs.sh
  source scripts/tasks/sync-sigs.sh
  source scripts/tasks/diamondUpdate.sh
  source scripts/deploy/deployFacetAndAddToDiamond.sh
  source scripts/deploy/deployPeripheryContracts.sh
  source scripts/tasks/updatePeriphery.sh

  # determine environment: check if .env variable "PRODUCTION" is set to true
  if [[ "$PRODUCTION" == "true" ]]; then
    # make sure that PRODUCTION was selected intentionally by user
    echo "    "
    echo "    "
    printf '\033[31m%s\031\n' "!!!!!!!!!!!!!!!!!!!!!!!! ATTENTION !!!!!!!!!!!!!!!!!!!!!!!!";
    printf '\033[33m%s\033[0m\n' "The config environment variable PRODUCTION is set to true";
    printf '\033[33m%s\033[0m\n' "This means you will be deploying contracts to production";
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

  # ask user to choose a deploy use case
  echo ""
  echo "You are deploying from this address: $(getDeployerAddress "$ENVIRONMENT")"
  echo ""
  echo "Please choose one of the following options:"
  local SELECTION=$(gum choose \
    "1) Deploy one specific contract to one network"\
    "2) Deploy one specific contract to all (not-excluded) networks (=new contract)"\
    "3) Deploy all contracts to one selected network (=new network)" \
    "4) Deploy all (missing) contracts for all networks (actual vs. target) - NOT YET IMPLEMENTED" \
    "5) Execute a script" \
    "6) Batch update _targetState.json file" \
    "7) Verify all unverified contracts" \
    )

  # use case 1: Deploy one specific contract to one network
  if [[ "$SELECTION" == *"1)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy one specific contract to one network"

    # get user-selected network from list
    local NETWORK=$(cat ./networks | gum filter --placeholder "Network")

    echo "[info] selected network: $NETWORK"
    echo "[info] loading deployer wallet balance..."

    # get deployer wallet balance
    BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")

    echo "[info] deployer wallet balance in this network: $BALANCE"
    echo ""
    checkRequiredVariablesInDotEnv $NETWORK

    # get user-selected deploy script and contract from list
    SCRIPT=$(ls -1 "$DEPLOY_SCRIPT_DIRECTORY" | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
    CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')

    # check if new contract should be added to diamond after deployment (only check for
    if [[ ! "$CONTRACT" == *"LiFiDiamond"* ]]; then
      echo ""
      echo "Do you want to add this contract to a diamond after deployment?"
      ADD_TO_DIAMOND=$(gum choose \
          "yes - to LiFiDiamond"\
          "yes - to LiFiDiamondImmutable"\
          " no - do not update any diamond"\
          )
    fi

    #TODO: add code to select a contract version (or use latest as default)
    # get current contract version
    local VERSION=$(getCurrentContractVersion "$CONTRACT")

    # check if contract should be added after deployment
    if [[ "$ADD_TO_DIAMOND" == *"yes"* ]]; then
      echo "[info] selected option: $ADD_TO_DIAMOND"

      # determine the name of the LiFiDiamond contract and call helper function with correct diamond name
      if [[ "$ADD_TO_DIAMOND" == *"LiFiDiamondImmutable"* ]]; then
        deployAndAddContractToDiamond "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamondImmutable" "$VERSION"
      else
        deployAndAddContractToDiamond "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamond" "$VERSION"
      fi
    else
      # just deploy the contract
      deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "" false
    fi

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "deploy contract $CONTRACT to network $NETWORK"
  # use case 2: Deploy one specific contract to all networks (=new contract)
  elif [[ "$SELECTION" == *"2)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy one specific contract to all networks"

    # get user-selected deploy script and contract from list
    local SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
    local CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')

    # check if new contract should be added to diamond after deployment
    if [[ ! "$CONTRACT" == *"LiFiDiamond"* ]]; then
      echo ""
      echo "Do you want to add this contract to a diamond after deployment?"
      local ADD_TO_DIAMOND=$(gum choose \
          "yes - to LiFiDiamond"\
          "yes - to LiFiDiamondImmutable"\
          " no - do not update any diamond"\
          )
    fi

    #TODO: add code to select a contract version (or use latest as default)

    # get current contract version
    local VERSION=$(getCurrentContractVersion "$CONTRACT")

    # get array with all network names
    local NETWORKS=($(getIncludedNetworksArray))

    # loop through all networks
    for NETWORK in "${NETWORKS[@]}"; do
      echo ""
      echo ""
      echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now deploying contract $CONTRACT to network $NETWORK...."

      # get deployer wallet balance
      BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")
      echo "[info] deployer wallet balance in this network: $BALANCE"
      echo ""

      # check if contract should be added after deployment
      if [[ "$ADD_TO_DIAMOND" == *"yes"* ]]; then
        # determine the name of the LiFiDiamond contract and call helper function with correct diamond name
        if [[ "$ADD_TO_DIAMOND" == *"LiFiDiamondImmutable"* ]]; then
          deployAndAddContractToDiamond "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamondImmutable" "$VERSION"
        else
          deployAndAddContractToDiamond "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamond" "$VERSION"
        fi
      else
        # just deploy the contract
        deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" false
      fi

      echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< network $NETWORK done"
    done

    playNotificationSound

  # use case 3: Deploy all contracts to one selected network (=new network)
  elif [[ "$SELECTION" == *"3)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy all contracts to one selected network (=new network)"

    # get user-selected network from list
    local NETWORK=$(cat ./networks | gum filter --placeholder "Network")
    # get deployer wallet balance
    BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")

    echo "[info] selected network: $NETWORK"
    echo "[info] deployer wallet balance in this network: $BALANCE"
    echo ""
    checkRequiredVariablesInDotEnv "$NETWORK"

    # call deploy script
    deployAllContracts "$NETWORK" "$ENVIRONMENT"

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "deploy all contracts to network $NETWORK"

    playNotificationSound

  # use case 4: Deploy all (missing) contracts for all networks (actual vs. target)
  elif [[ "$SELECTION" == *"4)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy all (missing) contracts for all networks"

    #TODO: implement
    error "this use case is not yet implemented"
    exit 1
    # go through each network in target state
      # get list of contracts in array
      # go through each contract
        # compare actual vs. target
        # deploy if needed

  playNotificationSound



  # use case 5: Execute a script
  elif [[ "$SELECTION" == *"5)"* ]]; then
    echo ""
    echo "Please select which script you would like to execute"

    local SELECTION2=$(gum choose \
      "1) Run diamondUpdate.sh script" \
      "2) Run updatePeriphery.sh script" \
      "3) Run sync-dexs.sh script" \
      "4) Run sync-sigs.sh script" \
      )

    if [[ "$SELECTION2" == *"1)"* ]]; then
      echo ""
      echo "[info] selected use case: Run diamondUpdate.sh script"
      diamondUpdate "" "$ENVIRONMENT"
    elif [[ "$SELECTION2" == *"2)"* ]]; then
      echo ""
      echo "[info] selected use case: Run updatePeriphery.sh script"
      updatePeriphery "" "$ENVIRONMENT" "" false true ""
    elif [[ "$SELECTION2" == *"3)"* ]]; then
      echo ""
      echo "[info] selected use case: Run sync-dexs.sh script"
      syncDEXs "" "$ENVIRONMENT" "" true
    elif [[ "$SELECTION2" == *"4)"* ]]; then
      echo ""
      echo "[info] selected use case: Run sync-sigs.sh script"
      syncSIGs "" "$ENVIRONMENT" "" true
    else
      error "invalid use case selected ('$SELECTION2') - exiting script"
      exit 1
    fi

  # use case 6: Update _targetState.json file
  elif [[ "$SELECTION" == *"6)"* ]]; then
    echo ""
    echo "[info] selected use case: Batch update _targetState.json file"

    # ask user to select a diamond type for which to update contract versions
    echo "[info] Please select for which diamond type you want to update contract version(s):"
    SELECTION=$(gum choose \
      "1) Mutable"\
      "2) Immutable"\
      "3) Both"\

      )
    echo "[info] selected option: $SELECTION"

    echo ""
    echo "Please choose one of the following options:"
    local SELECTION2=$(gum choose \
      "1) Add a new contract to all (not-excluded) networks"\
      "2) Update the version of a contract on all (not-excluded) networks"\
      "3) Add a new network with all (not-excluded) contracts"\
      )
    echo "$SELECTION2"

    if [[ "$SELECTION2" == *"1)"* ]]; then
      # case: "1) 1) Add a new contract to all networks"

      # get names of all contracts
      ALL_CONTRACT_NAMES=($(getAllContractNames))

      # Prompt the user to select a contract to be updated
      echo ""
      echo "Please select the contract that you would like to add:"
      PS3="Selection: "
      select SELECTED_CONTRACT in "${ALL_CONTRACT_NAMES[@]}"; do
        if [[ -n "$SELECTED_CONTRACT" ]]; then
          break
        else
          echo "Invalid selection. Please try again."
        fi
      done

      # Print the selected contract
      echo ""
      echo "[info] selected contract: $SELECTED_CONTRACT"

      # get current contract version
      CURRENT_VERSION=$(getCurrentContractVersion "$SELECTED_CONTRACT")

      # ask user which version to update to
      echo ""
      echo "Please enter the new contract version or just press enter to use current contract version ($CURRENT_VERSION):"
      read NEW_VERSION


      # determine the version
      USE_VERSION="${NEW_VERSION:-$CURRENT_VERSION}"
      echo "[info] selected version: $USE_VERSION"

      echo ""
      echo "Please select an environment:"
      local ENVIRONMENT=$(gum choose \
        "staging"\
        "production"\
        )
      echo "[info] selected environment: $ENVIRONMENT"

      echo ""
      echo "[info] now adding contract version to target state file"
      # update target state json
      if [[ "$SELECTION" == *"1)"* ]]; then
        addNewContractVersionToAllIncludedNetworks "$ENVIRONMENT" "$SELECTED_CONTRACT" "LiFiDiamond" "$USE_VERSION" true
      elif [[ "$SELECTION" == *"2)"* ]]; then
        addNewContractVersionToAllIncludedNetworks "$ENVIRONMENT" "$SELECTED_CONTRACT" "LiFiDiamondImmutable" "$USE_VERSION" true
      elif [[ "$SELECTION" == *"3)"* ]]; then
        addNewContractVersionToAllIncludedNetworks "$ENVIRONMENT" "$SELECTED_CONTRACT" "LiFiDiamond" "$USE_VERSION" true
        addNewContractVersionToAllIncludedNetworks "$ENVIRONMENT" "$SELECTED_CONTRACT" "LiFiDiamondImmutable" "$USE_VERSION" true
      else
        error "invalid value selected: $SELECTION - exiting script now"
        exit 1
      fi
    elif [[ "$SELECTION2" == *"2)"* ]]; then
      # case: "2) Update the version of a contract on all networks"
      # get names of all contracts
      ALL_CONTRACT_NAMES=($(getAllContractNames))

      # Prompt the user to select a contract to be updated
      echo ""
      echo "Please select the contract for which you want to update the target version in all networks:"
      PS3="Selection: "
      select SELECTED_CONTRACT in "${ALL_CONTRACT_NAMES[@]}"; do
        if [[ -n "$SELECTED_CONTRACT" ]]; then
          break
        else
          echo "Invalid selection. Please try again."
        fi
      done

      # Print the selected contract
      echo ""
      echo "[info] selected contract: $SELECTED_CONTRACT"

      # get current contract version
      CURRENT_VERSION=$(getCurrentContractVersion "$SELECTED_CONTRACT")

      # ask user which version to update to
      echo ""
      echo "Please enter the new contract version (current contract version=$CURRENT_VERSION):"
      read NEW_VERSION


      echo ""
      echo "Please select an environment:"
      local ENVIRONMENT=$(gum choose \
        "staging"\
        "production"\
        )
      echo "[info] selected environment: $ENVIRONMENT"

      # TODO: add determine diamond type

      echo ""
      echo "[info] now updating contract version "

      # update target state json
      if [[ "$SELECTION" == *"1)"* ]]; then
        updateContractVersionInAllIncludedNetworks "$ENVIRONMENT" "$SELECTED_CONTRACT" "LiFiDiamond" "$NEW_VERSION"
      elif [[ "$SELECTION" == *"2)"* ]]; then
        updateContractVersionInAllIncludedNetworks "$ENVIRONMENT" "$SELECTED_CONTRACT" "LiFiDiamondImmutable" "$NEW_VERSION"
      elif [[ "$SELECTION" == *"3)"* ]]; then
        updateContractVersionInAllIncludedNetworks "$ENVIRONMENT" "$SELECTED_CONTRACT" "LiFiDiamond" "$NEW_VERSION"
        updateContractVersionInAllIncludedNetworks "$ENVIRONMENT" "$SELECTED_CONTRACT" "LiFiDiamondImmutable" "$NEW_VERSION"
      else
        error "invalid value selected: $SELECTION - exiting script now"
        exit 1
      fi
    elif [[ "$SELECTION2" == *"3)"* ]]; then
      # case: "3) Add a new network with all (included) contracts"
      # TODO: adapt here for diamond contract type
      echo "Please enter the name of the new network:"
      read NETWORK_NAME
      echo ""
      echo "[info] selected network: $NETWORK_NAME"

      echo "Please select an environment:"
      local ENVIRONMENT=$(gum choose \
        "staging"\
        "production"\
        )
      echo "[info] selected environment: $ENVIRONMENT"
      echo ""

      echo "[info] now adding a new network '$NETWORK_NAME' with all contracts to target state file (selected diamond type: $SELECTION)"
      # update target state json
      if [[ "$SELECTION" == *"1)"* ]]; then
        addNewNetworkWithAllIncludedContractsInLatestVersions "$NETWORK_NAME" "$ENVIRONMENT" "LiFiDiamond"
      elif [[ "$SELECTION" == *"2)"* ]]; then
        addNewNetworkWithAllIncludedContractsInLatestVersions "$NETWORK_NAME" "$ENVIRONMENT" "LiFiDiamondImmutable"
      elif [[ "$SELECTION" == *"3)"* ]]; then
        addNewNetworkWithAllIncludedContractsInLatestVersions "$NETWORK_NAME" "$ENVIRONMENT" "LiFiDiamond"
        addNewNetworkWithAllIncludedContractsInLatestVersions "$NETWORK_NAME" "$ENVIRONMENT" "LiFiDiamondImmutable"
      else
        error "invalid value selected: $SELECTION - exiting script now"
        exit 1
      fi

      # check if function call was successful
      if [ $? -eq 0 ]
      then
        echo "[info] ...success"
        exit 0
      else
        error "script ended with error code. Please turn on DEBUG flag and check for details"
        exit 1
      fi
    else
      error "invalid use case selected ('$SELECTION2') - exiting script"
      exit 1
    fi
    echo ""
    echo "[info] ...Batch update _targetState.json file successfully completed"
  # use case 7: Verify all unverified contracts
  elif [[ "$SELECTION" == *"7)"* ]]; then
    verifyAllUnverifiedContractsInLogFile
    playNotificationSound
  else
    error "invalid use case selected ('$SELECTION') - exiting script"
    exit 1
  fi

  # inform user and end script
  echo ""
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "[info] PLEASE CHECK THE LOG CAREFULLY FOR WARNINGS AND ERRORS"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
}

deployMaster

