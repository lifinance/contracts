#!/bin/bash

# TODO
# - implement all deploy use cases
# - improve logging (use external library for console logging)
# - store bytecode in separate storage
# - wrap deploy calls in do-while loop until address contains bytecode
# - add verify contract use case (use bytecode and settings from storage)
# - verify only in included networks
# - add verified (true/false) to log
# - write scripts to update targetState JSON
#   - add new network with all contracts to target JSON
# - clean code
#   - local before variables
#   - variable names uppercase
# - improve update-periphery script
#   - should be applicable for immutable and mutable
#   - should get periphery contract names from config







deployMaster() {
  # load env variables
  source .env

  # load deploy scripts & helper functions
  source scripts/deploy/deploySingleContract.sh
  source scripts/deploy/deployAllContracts.sh
  source scripts/deploy/deployHelperFunctions.sh

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
    echo "Last chance: Do you want to skip?"
    gum confirm && exit 1 || echo "OK, continuing to deploy to PRODUCTION"

    # set ENVIRONMENT variable
    ENVIRONMENT="production"
  else
    # set ENVIRONMENT variable
    ENVIRONMENT="staging"
  fi

  # ask user to choose a deploy use case
  echo ""
  echo "Please select what you would like to do:"
  SELECTION=$(gum choose \
    "1) Deploy one specific contract to one network"\
    "2) Deploy one specific contract to all networks (=new contract)"\
    "3) Deploy all contracts to one selected network (=new network)" \
    "4) Deploy all (missing) contracts for all networks (actual vs. target)" \
    )

  # use case 1: Deploy one specific contract to one network
  if [[ "$SELECTION" == *"1)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy one specific contract to one network"

    # get user-selected network from list
    NETWORK=$(cat ./networks | gum filter --placeholder "Network")
    echo "[info] selected network: $NETWORK"

    # get user-selected deploy script and contract from list
    SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
    CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')

    # get current contract version
    VERSION=$(getCurrentContractVersion "$CONTRACT")
    wait

    # call deploy script
    deploySingleContract "$CONTRACT" "$NETWORK" "$SCRIPT" "$ENVIRONMENT" "$VERSION"

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "deploy contract $CONTRACT to network $NETWORK"

    #TODO: run update script if deployed contract was a facet

  # use case 2: Deploy one specific contract to all networks (=new contract)
  elif [[ "$SELECTION" == *"2)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy one specific contract to all networks"

    # get user-selected deploy script and contract from list
    SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
    CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')

    # get current contract version
    VERSION=$(getCurrentContractVersion "$CONTRACT")
    wait

    # get array with all network names
    NETWORKS=($(getIncludedNetworksArray))

    # loop through all networks
    for NETWORK in "${NETWORKS[@]}"; do
      echo ""
      echo "[info] Now deploying contract $CONTRACT to network $NETWORK...."

      # call deploy script for current network
      deploySingleContract "$CONTRACT" "$NETWORK" "$SCRIPT" "$ENVIRONMENT" "$VERSION"

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
    NETWORK=$(cat ./networks | gum filter --placeholder "Network")
    echo "[info] selected network: $NETWORK"

    # call deploy script
    deployAllContracts "$NETWORK" "$ENVIRONMENT"

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "deploy all contracts to network $NETWORK"


  # use case 4: Deploy all (missing) contracts for all networks (actual vs. target)
  elif [[ "$SELECTION" == *"4)"* ]]; then
    echo ""
    echo "[info] selected use case: Deploy all (missing) contracts for all networks"

    # go through each network in target state
      # get list of contracts in array
      # go through each contract
        # compare actual vs. target
        # deploy if needed


  else
    echo "[error] invalid use case selection - exiting script"
    return 1
  fi


  # inform user and end script
  echo ""
  echo "[info] deployMaster script successfully executed"
  return 0


}


deployMaster
