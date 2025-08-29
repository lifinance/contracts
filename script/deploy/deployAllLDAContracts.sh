#!/bin/bash

deployAllLDAContracts() {
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start deployAllLDAContracts"

  # load required resources
  source script/config.sh
  source script/helperFunctions.sh
  source script/deploy/deployAndStoreCREATE3Factory.sh
  source script/deploy/deployLDACoreFacets.sh
  source script/deploy/deployFacetAndAddToLDADiamond.sh
  source script/tasks/ldaDiamondUpdateFacet.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"

  # load env variables
  source .env

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # logging for debug purposes
  echo ""
  echoDebug "in function deployAllLDAContracts"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echo ""

  # Ask user where to start the LDA deployment process
  echo "Which LDA deployment stage would you like to start from?"
  START_FROM=$(
    gum choose \
      "1) Initial setup and CREATE3Factory deployment" \
      "2) Deploy LDA core facets" \
      "3) Deploy LDA diamond and update with core facets" \
      "4) Deploy LDA DEX facets and add to diamond" \
      "5) Run LDA health check only"
  )

  # Extract the stage number from the selection
  if [[ "$START_FROM" == *"1)"* ]]; then
    START_STAGE=1
  elif [[ "$START_FROM" == *"2)"* ]]; then
    START_STAGE=2
  elif [[ "$START_FROM" == *"3)"* ]]; then
    START_STAGE=3
  elif [[ "$START_FROM" == *"4)"* ]]; then
    START_STAGE=4
  elif [[ "$START_FROM" == *"5)"* ]]; then
    START_STAGE=5
  else
    error "invalid selection: $START_FROM - exiting script now"
    exit 1
  fi

  echo "Starting LDA deployment from stage $START_STAGE: $START_FROM"
  echo ""

  # LDA Diamond contract name
  local LDA_DIAMOND_CONTRACT_NAME="LDADiamond"

  # Stage 1: Initial setup and CREATE3Factory deployment
  if [[ $START_STAGE -le 1 ]]; then
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 1: Initial setup and CREATE3Factory deployment"

    # make sure that proposals are sent to diamond directly (for production deployments)
    if [[ "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" == "false" ]]; then
      echo "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND is set to false in your .env file"
      echo "This script requires SEND_PROPOSALS_DIRECTLY_TO_DIAMOND to be true for PRODUCTION deployments"
      echo "Would you like to set it to true for this execution? (y/n)"
      read -r response
      if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        export SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true
        echo "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND set to true for this execution"
      else
        echo "Continuing with SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=false (STAGING deployment???)"
      fi
    fi

    # add RPC URL to MongoDB if needed
    CREATE3_ADDRESS=$(getValueFromJSONFile "./config/networks.json" "$NETWORK.create3Factory")
    if [[ -z "$CREATE3_ADDRESS" || "$CREATE3_ADDRESS" == "null" ]]; then
      echo ""
      echo "Adding RPC URL from networks.json to MongoDB and fetching all URLs"
      bun add-network-rpc --network "$NETWORK" --rpc-url "$(getRpcUrlFromNetworksJson "$NETWORK")"
      bun fetch-rpcs
      # reload .env file to have the new RPC URL available
      source .env
    fi

    # get deployer wallet balance
    BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")
    echo "Deployer Wallet Balance: $BALANCE"
    if [[ -z "$BALANCE" || "$BALANCE" == "0" ]]; then
      echo "Deployer wallet does not have any balance in network $NETWORK. Please fund the wallet and try again"
      exit 1
    fi

    echo "[info] deployer wallet balance in this network: $BALANCE"
    echo ""
    checkRequiredVariablesInDotEnv "$NETWORK"

    echo "isZkEVM: $(isZkEvmNetwork "$NETWORK")"

    # deploy CREATE3Factory if needed
    if isZkEvmNetwork "$NETWORK"; then
      echo "zkEVM network detected, skipping CREATE3Factory deployment"
    else
      if [[ -z "$CREATE3_ADDRESS" || "$CREATE3_ADDRESS" == "null" ]]; then
        deployAndStoreCREATE3Factory "$NETWORK" "$ENVIRONMENT"
        checkFailure $? "deploy CREATE3Factory to network $NETWORK"
        echo ""
      else
        echo "CREATE3Factory already deployed for $NETWORK (address: $CREATE3_ADDRESS), skipping CREATE3Factory deployment."
      fi
    fi

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 1 completed"
  fi

  # Stage 2: Deploy LDA core facets
  if [[ $START_STAGE -le 2 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 2: Deploy LDA core facets"

    # deploy LDA core facets
    deployLDACoreFacets "$NETWORK" "$ENVIRONMENT"
    echo ""

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 2 completed"
  fi

  # Stage 3: Deploy LDA diamond and update with core facets
  if [[ $START_STAGE -le 3 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 3: Deploy LDA diamond and update with core facets"

    # get current LDA diamond contract version
    local VERSION=$(getCurrentContractVersion "$LDA_DIAMOND_CONTRACT_NAME")

    # deploy LDA diamond
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying $LDA_DIAMOND_CONTRACT_NAME now"
    deploySingleContract "$LDA_DIAMOND_CONTRACT_NAME" "$NETWORK" "$ENVIRONMENT" "$VERSION" "true" "true"

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "deploy contract $LDA_DIAMOND_CONTRACT_NAME to network $NETWORK"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< $LDA_DIAMOND_CONTRACT_NAME successfully deployed"

    # update LDA diamond with core facets
    echo ""
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now updating core facets in LDA diamond contract"
    ldaDiamondUpdateFacet "$NETWORK" "$ENVIRONMENT" "$LDA_DIAMOND_CONTRACT_NAME" "UpdateLDACoreFacets" false

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "update LDA core facets in $LDA_DIAMOND_CONTRACT_NAME on network $NETWORK"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< LDA core facets update completed"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 3 completed"
  fi

  # Stage 4: Deploy LDA DEX facets and add to diamond
  if [[ $START_STAGE -le 4 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 4: Deploy LDA DEX facets and add to diamond"

    # deploy all LDA DEX facets and add to diamond
    echo ""
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now deploying LDA DEX facets and adding to diamond contract"
    
    # get all LDA facet contract names (excluding core facets)
    local LDA_FACETS_PATH="script/deploy/facets/LDA/"
    
    # Read LDA core facets from config for exclusion
    local GLOBAL_CONFIG_PATH="./config/global.json"
    if [[ ! -f "$GLOBAL_CONFIG_PATH" ]]; then
      error "Global config file not found: $GLOBAL_CONFIG_PATH"
      return 1
    fi

    # Get LDA core facets from JSON config
    local LDA_CORE_FACETS_JSON=$(jq -r '.ldaCoreFacets[]' "$GLOBAL_CONFIG_PATH")
    local LDA_CORE_FACETS=()
    while IFS= read -r facet; do
      LDA_CORE_FACETS+=("$facet")
    done <<< "$LDA_CORE_FACETS_JSON"

    # Add LDADiamond to exclusions and build regex
    LDA_CORE_FACETS+=("LDADiamond")
    local EXCLUDED_LDA_FACETS_REGEXP="^($(printf '%s|' "${LDA_CORE_FACETS[@]}"))"
    EXCLUDED_LDA_FACETS_REGEXP="${EXCLUDED_LDA_FACETS_REGEXP%|})$"

    # loop through LDA facet contract names
    for DEPLOY_SCRIPT in $(ls -1 "$LDA_FACETS_PATH" | grep '^Deploy.*\.s\.sol$'); do
      FACET_NAME=$(echo "$DEPLOY_SCRIPT" | sed -e 's/Deploy//' -e 's/\.s\.sol$//')
      
      if ! [[ "$FACET_NAME" =~ $EXCLUDED_LDA_FACETS_REGEXP ]]; then
        # check if facet is existing in target state JSON for LDA
        TARGET_VERSION=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$FACET_NAME" "$LDA_DIAMOND_CONTRACT_NAME")

        # check result
        if [[ $? -ne 0 ]]; then
          echo "[info] No matching entry found in target state file for NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, CONTRACT=$FACET_NAME >> no deployment needed"
        else
          # deploy LDA facet and add to LDA diamond
          deployFacetAndAddToLDADiamond "$NETWORK" "$ENVIRONMENT" "$FACET_NAME" "$LDA_DIAMOND_CONTRACT_NAME" "$TARGET_VERSION"
        fi
      fi
    done
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< LDA DEX facets part completed"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 4 completed"
  fi

  # Stage 5: Run LDA health check only
  if [[ $START_STAGE -le 5 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 5: Run LDA health check only"
    echo "[info] LDA health check functionality will be implemented later"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 5 completed"
  fi

  echo ""
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployAllLDAContracts completed"
}
