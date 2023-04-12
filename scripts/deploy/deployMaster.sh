#!/bin/bash

# TODO
# - check fo


# - implement all deploy use cases
#   - use case 4 is still missing
# - improve logging (use external library for console logging)
# - add verify contract use case (use bytecode and settings from storage)

# - clean code
#   - local before variables
#   - variable names uppercase
#   - make environment / file suffix global variables
#   - add function descriptions in helper functions

# - update docs / notion
#   - add info about SALT env variable to deploy new contracts
# - write article
# - for immutable diamond we need to run some specific script - add to deploy script
# - improve the handling of several similar log file entries
# - add fancy stuff
#   - script runtime
# - offer to exclude bytecode verification and adapt ensureENV for networks for which we dont have a functioning block explorer

# known limitations:
#   - we currently cannot replace any of the core facets with our scripts
#   - log can contain several entries of the same contract in same version - need to define which of those to return


ENVIRONMENT=""
FILE_SUFFIX=""


deployMaster() {
  # load env variables
  source .env

  # load deploy scripts & helper functions
  source scripts/deploy/deploySingleContract.sh
  source scripts/deploy/deployAllContracts.sh
  source scripts/deploy/deployHelperFunctions.sh
  source scripts/sync-dexs.sh
  source scripts/sync-sigs.sh
  source scripts/deploy/diamondUpdate.sh
  source scripts/deploy/deployFacetAndAddToDiamond.sh
  source scripts/deploy/updatePeriphery.sh

  # determine environment (production/staging)
  # TODO: also check where else this needs to be replaced
    # check if env variable "PRODUCTION" is true (or not set at all), otherwise deploy as staging
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

  # ask user to choose a deploy use case
  echo ""
  echo "Please choose one of the following options:"
  local SELECTION=$(gum choose \
    "1) Deploy one specific contract to one network"\
    "2) Deploy one specific contract to all networks (=new contract)"\
    "3) Deploy all contracts to one selected network (=new network)" \
    "4) Deploy all (missing) contracts for all networks (actual vs. target)" \
    "5) Execute a script" \
    "6) Batch update _targetState.json file" \
    )

  # use case 1: Deploy one specific contract to one network
  if [[ "$SELECTION" == *"1)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy one specific contract to one network"

    # call deploy script
    deploySingleContract ""

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "deploy contract $CONTRACT to network $NETWORK"

    # TODO: add code that asks if contract is a facet that should be added to diamond in one go and call deployFacetAndAddToDiamond
    #TODO: run update script if deployed contract was a facet
    #TODO: run updatePeriphery script if deployed contract was a periphery contract

  # use case 2: Deploy one specific contract to all networks (=new contract)
  elif [[ "$SELECTION" == *"2)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy one specific contract to all networks"

    # get user-selected deploy script and contract from list
    local SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
    local CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')

    # get current contract version
    local VERSION=$(getCurrentContractVersion "$CONTRACT")
    wait

    # get array with all network names
    local NETWORKS=($(getIncludedNetworksArray))

    # loop through all networks
    for NETWORK in "${NETWORKS[@]}"; do
      echo ""
      echo "[info] Now deploying contract $CONTRACT to network $NETWORK...."

      # get deployer wallet balance
      BALANCE=$(getDeployerBalance "$NETWORK")
      echo "[info] deployer wallet balance in this network: $BALANCE"
      echo ""

      # call deploy script for current network
      deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION"

      # check if function call was successful
      echo ""
      if [ $? -ne 0 ]
      then
        echo "[warning] deployment of contract $CONTRACT to network $NETWORK failed :("
      else
        echo "[info] deployment of contract $CONTRACT to network $NETWORK successful :)"
      fi
    done

  # use case 3: Deploy all contracts to one selected network (=new network)
  elif [[ "$SELECTION" == *"3)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy all contracts to one selected network (=new network)"

    # get user-selected network from list
    local NETWORK=$(cat ./networks | gum filter --placeholder "Network")
    # get deployer wallet balance
    BALANCE=$(getDeployerBalance "$NETWORK")

    echo "[info] selected network: $NETWORK"
    echo "[info] deployer wallet balance in this network: $BALANCE"
    echo ""
    checkRequiredVariablesInDotEnv $NETWORK

    # call deploy script
    deployAllContracts "$NETWORK" "$ENVIRONMENT"

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "deploy all contracts to network $NETWORK"


  # use case 4: Deploy all (missing) contracts for all networks (actual vs. target)
  elif [[ "$SELECTION" == *"4)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy all (missing) contracts for all networks"

    #TODO: implement
    echo "[error] this use case is not yet implemented"
    exit 1
    # go through each network in target state
      # get list of contracts in array
      # go through each contract
        # compare actual vs. target
        # deploy if needed

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
      diamondUpdate
    elif [[ "$SELECTION2" == *"2)"* ]]; then
      echo ""
      echo "[info] selected use case: Run updatePeriphery.sh script"
      updatePeriphery "" "" "" "" true
    elif [[ "$SELECTION2" == *"3)"* ]]; then
      echo ""
      echo "[info] selected use case: Run sync-dexs.sh script"
      syncDEXs "" "" "" true
    elif [[ "$SELECTION2" == *"4)"* ]]; then
      echo ""
      echo "[info] selected use case: Run sync-sigs.sh script"
      syncSIGs "" "" "" true
    else
      echo "[error] invalid use case selected ('$SELECTION2') - exiting script"
      exit 1
    fi

  # use case 6: Update _targetState.json file
  elif [[ "$SELECTION" == *"6)"* ]]; then
    echo ""
    echo "[info] selected use case: Batch update _targetState.json file"

    echo ""
    echo "Please choose one of the following options:"
    local SELECTION2=$(gum choose \
      "1) Update the version of a contract on all networks"\
      "2) Add a new network with all (included) contracts"\
      )
    echo "$SELECTION2"

    if [[ "$SELECTION2" == *"1)"* ]]; then
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

      echo ""
      echo "[info] now updating contract version "

      # update target state json
      updateContractVersionInAllIncludedNetworks "$ENVIRONMENT" "$SELECTED_CONTRACT" "$NEW_VERSION"



    elif [[ "$SELECTION2" == *"2)"* ]]; then
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

      DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
      echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"

      echo "[info] adding a new network '$NETWORK_NAME' with all contracts including $DIAMOND_CONTRACT_NAME to target state file"
      addNewNetworkWithAllIncludedContractsInLatestVersions "$NETWORK_NAME" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"
      # check if function call was successful
      if [ $? -eq 0 ]
      then
        echo "[info] ...success"
      else
        echo "[error] script ended with error code. Please turn on DEBUG flag and check for details"
      fi
    else
      echo "[error] invalid use case selected ('$SELECTION2') - exiting script"
      exit 1
    fi
    echo ""
    echo "[info] ...Batch update _targetState.json file successfully completed"
  else
    echo "[error] invalid use case selected ('$SELECTION') - exiting script"
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
