#!/bin/bash

deployAllContracts() {
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start deployAllContracts"

  # load required resources
  source script/config.sh
  source script/helperFunctions.sh
  source script/deploy/deployAndStoreCREATE3Factory.sh
  source script/deploy/deployCoreFacets.sh
  source script/deploy/deployFacetAndAddToDiamond.sh
  source script/deploy/deployPeripheryContracts.sh
  source script/tasks/diamondSyncDEXs.sh
  source script/tasks/diamondSyncSigs.sh
  source script/tasks/diamondUpdateFacet.sh
  source script/tasks/diamondUpdatePeriphery.sh
  source script/tasks/updateERC20Proxy.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"

  # load env variables
  source .env

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # logging for debug purposes
  echo ""
  echoDebug "in function deployAllContracts"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echo ""

  # Ask user where to start the deployment process
  echo "Which stage would you like to start from?"
  START_FROM=$(
    gum choose \
      "1) Initial setup and CREATE3Factory deployment" \
      "2) Deploy core facets" \
      "3) Deploy diamond and update with core facets" \
      "4) Set approvals (refund wallet and deployer wallet)" \
      "5) Deploy non-core facets and add to diamond" \
      "6) Deploy periphery contracts" \
      "7) Add periphery to diamond and update dexs.json" \
      "8) Execute dexs/sigs scripts and update ERC20Proxy" \
      "9) Run health check only" \
      "10) Ownership transfer to timelock (production only)"
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
  elif [[ "$START_FROM" == *"6)"* ]]; then
    START_STAGE=6
  elif [[ "$START_FROM" == *"7)"* ]]; then
    START_STAGE=7
  elif [[ "$START_FROM" == *"8)"* ]]; then
    START_STAGE=8
  elif [[ "$START_FROM" == *"9)"* ]]; then
    START_STAGE=9
  elif [[ "$START_FROM" == *"10)"* ]]; then
    START_STAGE=10
  else
    error "invalid selection: $START_FROM - exiting script now"
    exit 1
  fi

  echo "Starting from stage $START_STAGE: $START_FROM"
  echo ""

  # since we only support mutable diamonds, no need to ask user to select diamond type
  local DIAMOND_CONTRACT_NAME="LiFiDiamond"

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

    # add RPC URL to MongoDB
    # only add the RPC URL if no CREATE3Factory is deployed yet (if a CREATE3Factory is deployed that means we added an RPC already before)
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

    # deploy CREATE3Factory
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

    # deploy SAFE
    SAFE_ADDRESS=$(getValueFromJSONFile "./config/networks.json" "$NETWORK.safeAddress")
    if [[ -z "$SAFE_ADDRESS" || "$SAFE_ADDRESS" == "null" ]]; then
      echo "Deploying SAFE Proxy instance now (no safeAddress found in networks.json)"
      bun deploy-safe --network "$NETWORK"
      checkFailure $? "deploy Safe Proxy instance to network $NETWORK"
    else
      echo "SAFE already deployed for $NETWORK (safeAddress: $SAFE_ADDRESS), skipping deployment."
    fi

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 1 completed"
  fi

  # Stage 2: Deploy core facets
  if [[ $START_STAGE -le 2 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 2: Deploy core facets"

    # deploy core facets
    deployCoreFacets "$NETWORK" "$ENVIRONMENT"
    echo ""

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 2 completed"
  fi

  # Stage 3: Deploy diamond and update with core facets
  if [[ $START_STAGE -le 3 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 3: Deploy diamond and update with core facets"

    # get current diamond contract version
    local VERSION=$(getCurrentContractVersion "$DIAMOND_CONTRACT_NAME")

    # deploy diamond
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying $DIAMOND_CONTRACT_NAME now"
    deploySingleContract "$DIAMOND_CONTRACT_NAME" "$NETWORK" "$ENVIRONMENT" "$VERSION" "true"

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "deploy contract $DIAMOND_CONTRACT_NAME to network $NETWORK"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< $DIAMOND_CONTRACT_NAME successfully deployed"

    # update diamond with core facets
    echo ""
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now updating core facets in diamond contract"
    diamondUpdateFacet "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" "UpdateCoreFacets"

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "update core facets in $DIAMOND_CONTRACT_NAME on network $NETWORK"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< core facets update completed"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 3 completed"
  fi

  # Stage 4: Set approvals (refund wallet and deployer wallet)
  if [[ $START_STAGE -le 4 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 4: Set approvals (refund wallet and deployer wallet)"

    # approve refund wallet to execute refund-related functions
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now approving refund wallet to execute functions listed in config/global.json"
    updateFacetConfig "" "$ENVIRONMENT" "$NETWORK" "ApproveRefundWalletInDiamond" "$DIAMOND_CONTRACT_NAME"
    checkFailure $? "update approve refund wallet to execute refund-related functions"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< refund wallet approved"

    # approve deployer wallet to execute config-related functions
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now approving deployer wallet to execute functions listed in config/global.json"
    updateFacetConfig "" "$ENVIRONMENT" "$NETWORK" "ApproveDeployerWalletInDiamond" "$DIAMOND_CONTRACT_NAME"
    checkFailure $? "update approve deployer wallet to execute config-related functions"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployer wallet approved"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 4 completed"
  fi

  # Stage 5: Deploy non-core facets and add to diamond
  if [[ $START_STAGE -le 5 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 5: Deploy non-core facets and add to diamond"

    # deploy all non-core facets (that are in target_state.JSON) and add to diamond
    echo ""
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now deploying non-core facets and adding to diamond contract"
    # get all facet contract names
    local FACETS_PATH="$CONTRACT_DIRECTORY""Facets/"

    # prepare regExp to exclude core facets
    CORE_FACETS_OUTPUT=$(getCoreFacetsArray)
    checkFailure $? "retrieve core facets array from global.json"

    local EXCLUDED_FACETS_REGEXP="^($(echo "$CORE_FACETS_OUTPUT" | xargs | tr ' ' '|'))$"

    # loop through facet contract names
    for FACET_NAME in $(getContractNamesInFolder "$FACETS_PATH"); do
      if ! [[ "$FACET_NAME" =~ $EXCLUDED_FACETS_REGEXP ]]; then
        # check if facet is existing in target state JSON
        TARGET_VERSION=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$FACET_NAME" "$DIAMOND_CONTRACT_NAME")

        # check result
        if [[ $? -ne 0 ]]; then
          echo "[info] No matching entry found in target state file for NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, CONTRACT=$FACET_NAME >> no deployment needed"
        else
          # deploy facet and add to diamond
          deployFacetAndAddToDiamond "$NETWORK" "$ENVIRONMENT" "$FACET_NAME" "$DIAMOND_CONTRACT_NAME" "$TARGET_VERSION"
        fi
      fi
    done
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< non-core facets part completed"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 5 completed"
  fi

  # Stage 6: Deploy periphery contracts
  if [[ $START_STAGE -le 6 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 6: Deploy periphery contracts"

    # deploy periphery
    deployPeripheryContracts "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 6 completed"
  fi

  # Stage 7: Add periphery to diamond and update dexs.json
  if [[ $START_STAGE -le 7 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 7: Add periphery to diamond and update dexs.json"

    # update periphery registry
    diamondUpdatePeriphery "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" true false ""

    # add core periphery addresses to dexs.json for whitelisting in subsequent steps
    addPeripheryToDexsJson "$NETWORK" "$ENVIRONMENT"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 7 completed"
  fi

  # Stage 8: Execute dexs/sigs scripts and update ERC20Proxy
  if [[ $START_STAGE -le 8 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 8: Execute dexs/sigs scripts and update ERC20Proxy"

    # run sync dexs script
    echo ""
    diamondSyncDEXs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

    # run sync sigs script
    echo ""
    diamondSyncSigs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

    # register Executor as authorized caller in ERC20Proxy
    echo ""
    updateERC20Proxy "$NETWORK" "$ENVIRONMENT"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 8 completed"
  fi

  # Stage 9: Run health check only
  if [[ $START_STAGE -le 9 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 9: Run health check only"
    bun script/deploy/healthCheck.ts --network "$NETWORK"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 9 completed"

    # Pause and ask user if they want to continue with ownership transfer
    if [[ "$ENVIRONMENT" == "production" ]]; then
      echo ""
      echo "Health check completed. Do you want to continue with ownership transfer to timelock?"
      echo "This should only be done if the health check shows only diamond ownership errors."
      echo "Continue with stage 10 (ownership transfer)? (y/n)"
      read -r response
      if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        echo "Proceeding with stage 10..."
      else
        echo "Skipping stage 10 - ownership transfer cancelled by user"
        echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployAllContracts completed"
        return
      fi
    fi
  fi

  # Stage 10: Ownership transfer to timelock (production only)
  if [[ $START_STAGE -le 10 ]]; then
    if [[ "$ENVIRONMENT" == "production" ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 10: Ownership transfer to timelock (production only)"

      # make sure SAFE_ADDRESS is available (if starting in stage 10 it's not available yet)
      if [[ -z "$SAFE_ADDRESS" || "$SAFE_ADDRESS" == "null" ]]; then
        SAFE_ADDRESS=$(getValueFromJSONFile "./config/networks.json" "$NETWORK.safeAddress")
      fi

      # ------------------------------------------------------------
      # Prepare ownership transfer to Timelock
      echo ""
      echo "Preparing ownership transfer to Timelock"
      TIMELOCK_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiTimelockController")
      if [[ -z "$TIMELOCK_ADDRESS" ]]; then
        echo "Timelock address not found. Cannot prepare ownership transfer to Timelock"
        exit 1
      fi

      # get diamond address
      DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond")
      if [[ -z "$DIAMOND_ADDRESS" ]]; then
        echo "Diamond address not found. Cannot prepare ownership transfer to Timelock"
        exit 1
      fi

      # initiate ownership transfer
      echo "Initiating ownership transfer to LiFiTimelockController ($TIMELOCK_ADDRESS)"
      cast send "$DIAMOND_ADDRESS" "transferOwnership(address)" "$TIMELOCK_ADDRESS" --private-key "$PRIVATE_KEY_PRODUCTION" --rpc-url "$(getRPCUrl "$NETWORK")"  --legacy
      echo "Ownership transfer to LiFiTimelockController ($TIMELOCK_ADDRESS) initiated"
      echo ""

      echo ""
      echo "Proposing ownership transfer acceptance tx to multisig ($SAFE_ADDRESS) via LiFiTimelockController ($TIMELOCK_ADDRESS) "
      # propose tx with calldata 0x7200b829 = acceptOwnershipTransfer() to diamond (propose to multisig and wrap in timeloc calldata with --timelock flag)
      bun script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata 0x7200b829 --network "$NETWORK" --rpcUrl "$(getRPCUrl "$NETWORK")" --privateKey "$PRIVATE_KEY_PRODUCTION" --timelock
      echo "Ownership transfer acceptance proposed to multisig ($SAFE_ADDRESS) via LiFiTimelockController ($TIMELOCK_ADDRESS)"
      echo ""
      # ------------------------------------------------------------
    else
      echo "Stage 10 skipped - ownership transfer to timelock is only for production environment"
    fi

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 10 completed"
  fi


  echo ""
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployAllContracts completed"
}
