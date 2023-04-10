#!/bin/bash

# TODO
# - check if contract is already deployed before deploying it again
# - implement all deploy use cases
#   - use case 4 is still missing
# - improve logging (use external library for console logging)
# - add verify contract use case (use bytecode and settings from storage)
# - verify only in included networks
# - write scripts to update targetState JSON
#   - add new network with all contracts to target JSON
#   - bump version of specific contract on all networks
# - clean code
#   - local before variables
#   - variable names uppercase
#   - make environment / file suffix global variables
# - update docs / notion
#   - add info about SALT env variable to deploy new contracts
# - write article
# - for immutable diamond we need to run some specific script - add to deploy script
# - improve the handling of several similar log file entries
# - add fancy stuff
#   - show deployer wallet balance before/after
#   - script runtime

# known limitations:
#   - we currently cannot replace any of the core facets with our scripts
#   - log can contain several entries of the same contract in same version - need to define which of those to return



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
  local ENVIRONMENT=$(determineEnvironment)

  # ask user to choose a deploy use case
  echo ""
  echo "Please choose one of the following options:"
  local SELECTION=$(gum choose \
    "1) Deploy one specific contract to one network"\
    "2) Deploy one specific contract to all networks (=new contract)"\
    "3) Deploy all contracts to one selected network (=new network)" \
    "4) Deploy all (missing) contracts for all networks (actual vs. target)" \
    "5) Run sync-sigs.sh script" \
    "6) Run sync-dexs.sh script" \
    "7) Run updatePeriphery.sh script" \
    "8) Run diamondUpdate.sh script" \
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
    echo "[info] selected network: $NETWORK"
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

  # use case 5: Run sync-sigs.sh script
  elif [[ "$SELECTION" == *"5)"* ]]; then
    echo ""
    echo "[info] selected use case: Run sync-sigs.sh script"
    syncSIGs "" "" "" true

  # use case 6: Run sync-dexs.sh script
  elif [[ "$SELECTION" == *"6)"* ]]; then
    echo ""
    echo "[info] selected use case: Run sync-dexs.sh script"
    syncDEXs "" "" "" true

  # use case 7: Run updatePeriphery.sh script
  elif [[ "$SELECTION" == *"7)"* ]]; then
    echo ""
    echo "[info] selected use case: Run updatePeriphery.sh script"
    updatePeriphery "" "" "" "" true

  # use case 8: Run diamondUpdate.sh script
  elif [[ "$SELECTION" == *"8)"* ]]; then
    echo ""
    echo "[info] selected use case: Run diamondUpdate.sh script"
    diamondUpdate

  else
    echo "[error] invalid use case selected ('$SELECTION') - exiting script"
    exit 1
  fi

  # inform user and end script
  echo ""
  echo "[info] deployMaster script successfully executed"
  echo ""
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "[info] PLEASE CHECK THE LOG CAREFULLY FOR WARNINGS AND ERRORS"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
}


deployMaster
