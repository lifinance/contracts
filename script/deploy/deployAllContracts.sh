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
  source script/tasks/diamondSyncWhitelist.sh
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

  # make sure that proposals are sent to diamond directly (for production deployments)
  # this must run even when starting from later stages
  if [[ "$ENVIRONMENT" == "production" && "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" != "true" ]]; then
    echo "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND is unset or set to false in your .env file"
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

  # Ask user where to start the deployment process
  echo "Which stage would you like to start from?"
  START_FROM=$(
    gum choose \
      "1) Initial setup and CREATE3Factory deployment" \
      "2) Deploy core facets" \
      "3) Deploy diamond and update with core facets" \
      "4) Set approval for refund wallet" \
      "5) Deploy non-core facets and add to diamond" \
      "6) Deploy periphery contracts" \
      "7) Add periphery to diamond" \
      "8) Update whitelist.json and execute sync whitelist script" \
      "9) Fund PauserWallet" \
      "10) Update ERC20Proxy" \
      "11) Run health check only" \
      "12) Ownership transfer to timelock (production only)"
  )

  # make sure that proposals are sent to diamond directly (for production deployments)
  if [[ "$ENVIRONMENT" == "production" && "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" != "true" ]]; then
    echo "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND is unset or set to false in your .env file"
    echo "This script requires SEND_PROPOSALS_DIRECTLY_TO_DIAMOND to be true for PRODUCTION deployments"
    echo "Would you like to set it to true for this execution? (y/n)"
    read -r response || response=""
    if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
      export SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true
      echo "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND set to true for this execution"
    else
      echo "Continuing with SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=false (STAGING deployment???)"
    fi
  fi

  # Extract the stage number from the selection (e.g. "12) ...")
  # Important: do NOT substring-match "1)" as it would also match "10)", "11)", "12)".
  if [[ "$START_FROM" =~ ^([0-9]+)\) ]]; then
    START_STAGE="${BASH_REMATCH[1]}"
  else
    error "invalid selection: $START_FROM - exiting script now"
    exit 1
  fi

  if [[ "$START_STAGE" -lt 1 || "$START_STAGE" -gt 12 ]]; then
    error "invalid selection (stage out of range): $START_FROM - exiting script now"
    exit 1
  fi

  echo "Starting from stage $START_STAGE: $START_FROM"
  echo ""

  # since we only support mutable diamonds, no need to ask user to select diamond type
  local DIAMOND_CONTRACT_NAME="LiFiDiamond"

  # Stage 1: Initial setup and CREATE3Factory deployment
  if [[ $START_STAGE -le 1 ]]; then
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 1: Initial setup and CREATE3Factory deployment"

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
    diamondUpdateFacet "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" "UpdateCoreFacets" false

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "update core facets in $DIAMOND_CONTRACT_NAME on network $NETWORK"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< core facets update completed"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 3 completed"
  fi

  # Stage 4: Set approval for refund wallet
  if [[ $START_STAGE -le 4 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 4: Set approval for refund wallet"

    # approve refund wallet to execute refund-related functions
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now approving refund wallet to execute functions listed in config/global.json"
    updateFacetConfig "" "$ENVIRONMENT" "$NETWORK" "ApproveRefundWalletInDiamond" "$DIAMOND_CONTRACT_NAME"
    checkFailure $? "update approve refund wallet to execute refund-related functions"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< refund wallet approved"

    echo ""
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

  # Stage 7: Add periphery to diamond
  if [[ $START_STAGE -le 7 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 7: Add periphery to diamond"

    # Register periphery contracts in the diamond's PeripheryRegistryFacet
    # This stores the contract name -> address mapping on-chain in the diamond contract.
    # The diamond can then look up periphery contract addresses by name using getPeripheryContract().
    diamondUpdatePeriphery "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" true false ""

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 7 completed"
  fi

  # Stage 8: Update whitelist.json and execute sync whitelist script
  if [[ $START_STAGE -le 8 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 8: Update whitelist.json and execute sync whitelist script"

    # Sync whitelist data from config files to the diamond contract on-chain
    # This whitelists contracts and their function selectors in the WhitelistManagerFacet
    echo ""
    diamondSyncWhitelist "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 8 completed"
  fi

  # Stage 9: Fund PauserWallet
  if [[ $START_STAGE -le 9 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 9: Fund PauserWallet"
    # get pauserWallet address
    local PAUSER_WALLET_ADDRESS
    PAUSER_WALLET_ADDRESS=$(getValueFromJSONFile "./config/global.json" "pauserWallet")
    if [[ $? -ne 0 ]]; then
      error "failed to read pauserWallet address from ./config/global.json"
      exit 1
    fi
    if [[ -z "$PAUSER_WALLET_ADDRESS" || "$PAUSER_WALLET_ADDRESS" == "null" ]]; then
      error "PauserWallet address not found. Cannot fund PauserWallet"
      exit 1
    fi

    # get RPC URL
    local RPC_URL
    RPC_URL=$(getRPCUrl "$NETWORK")
    if [[ $? -ne 0 ]]; then
      error "failed to obtain RPC URL for network $NETWORK"
      exit 1
    fi
    if [[ -z "$RPC_URL" ]]; then
      error "RPC URL is empty for network $NETWORK"
      exit 1
    fi

    # get balance in current network
    BALANCE=$(cast balance "$PAUSER_WALLET_ADDRESS" --rpc-url "$RPC_URL")
    checkFailure $? "get PauserWallet balance for $PAUSER_WALLET_ADDRESS on $NETWORK"
    echo "PauserWallet Balance: $BALANCE"

    if [[ "$BALANCE" == "0" ]]; then
      echo "PauserWallet balance is 0. How much wei would you like to send to $PAUSER_WALLET_ADDRESS?"
      read -r FUNDING_AMOUNT || FUNDING_AMOUNT=""

      # Validate that FUNDING_AMOUNT is a non-empty numeric value
      if [[ -z "$FUNDING_AMOUNT" ]] || ! [[ "$FUNDING_AMOUNT" =~ ^[0-9]+$ ]]; then
        error "Invalid funding amount. Please provide a valid wei amount (numeric value)."
        exit 1
      fi

      local PRIVATE_KEY_TO_USE
      PRIVATE_KEY_TO_USE=$(getPrivateKey "$NETWORK" "$ENVIRONMENT")
      if [[ $? -ne 0 || -z "$PRIVATE_KEY_TO_USE" ]]; then
        error "could not determine private key for network $NETWORK in $ENVIRONMENT environment"
        exit 1
      fi

      echo "Funding PauserWallet $PAUSER_WALLET_ADDRESS with $FUNDING_AMOUNT wei"
      universalCast "sendValue" "$NETWORK" "$ENVIRONMENT" "$PAUSER_WALLET_ADDRESS" "$FUNDING_AMOUNT" "$PRIVATE_KEY_TO_USE"
      checkFailure $? "fund PauserWallet $PAUSER_WALLET_ADDRESS on $NETWORK"
    fi

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 9 completed"
  fi

  # Stage 10: Update ERC20Proxy
  if [[ $START_STAGE -le 10 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 10: Update ERC20Proxy"

    # Register Executor as authorized caller in ERC20Proxy
    # This allows the Executor contract to transfer tokens on behalf of users
    updateERC20Proxy "$NETWORK" "$ENVIRONMENT"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 10 completed"
  fi

  # Stage 11: Run health check only
  if [[ $START_STAGE -le 11 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 11: Run health check only"
    bun script/deploy/healthCheck.ts --network "$NETWORK" --environment "$ENVIRONMENT"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 11 completed"

    # Pause and ask user if they want to continue with ownership transfer
    if [[ "$ENVIRONMENT" == "production" ]]; then
      echo ""
      echo "Health check completed. Do you want to continue with ownership transfer to timelock?"
      echo "This should only be done if the health check shows only diamond ownership errors."
      echo "Continue with stage 12 (ownership transfer)? (y/n)"
      read -r response
      if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        echo "Proceeding with stage 12..."
      else
        echo "Skipping stage 12 - ownership transfer cancelled by user"
        echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployAllContracts completed"
        return
      fi
    fi
  fi

  # Stage 12: Ownership transfer to timelock (production only)
  if [[ $START_STAGE -le 12 ]]; then
    if [[ "$ENVIRONMENT" == "production" ]]; then
      echo ""
      echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 12: Ownership transfer to timelock (production only)"

      # make sure SAFE_ADDRESS is available (if starting in stage 12 it's not available yet)
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

      # Step 1: Initiate ownership transfer (must be sent directly by current owner = deployer, not proposed)
      echo "Sending transferOwnership(timelock) from deployer wallet (current diamond owner)..."
      local TRANSFER_CALLDATA
      TRANSFER_CALLDATA=$(cast calldata "transferOwnership(address)" "$TIMELOCK_ADDRESS")
      PRIVATE_KEY_DEPLOYER=$(getPrivateKey "$NETWORK" "production") || {
        error "Failed to get deployer private key for $NETWORK"
        exit 1
      }
      universalCast "sendRaw" "$NETWORK" "production" "$DIAMOND_ADDRESS" "$TRANSFER_CALLDATA" "$PRIVATE_KEY_DEPLOYER"
      checkFailure $? "transferOwnership to LiFiTimelockController ($TIMELOCK_ADDRESS)"
      echo "Ownership transfer to LiFiTimelockController ($TIMELOCK_ADDRESS) initiated"
      echo ""

      # Step 2: acceptOwnershipTransfer() — always propose on EVM (Tron: direct send, no Safe).
      # Bash sendOrPropose (used by universalCast "send") does NOT check SEND_PROPOSALS_DIRECTLY_TO_DIAMOND; for EVM production it always calls propose-to-safe.ts.
      echo "Proposing acceptOwnershipTransfer() to multisig ($SAFE_ADDRESS) via LiFiTimelockController ($TIMELOCK_ADDRESS)..."
      universalCast "send" "$NETWORK" "production" "$DIAMOND_ADDRESS" "acceptOwnershipTransfer()" "" "true" "$PRIVATE_KEY_PRODUCTION"
      checkFailure $? "propose acceptOwnershipTransfer to Safe"
      echo "Acceptance of ownership transfer proposed to multisig ($SAFE_ADDRESS)"
      echo ""
      # ------------------------------------------------------------
    else
      echo "Stage 12 skipped - ownership transfer to timelock is only for production environment"
    fi

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 12 completed"
  fi


  echo "[info] updating diamond logs for network $NETWORK in environment $ENVIRONMENT"
  updateDiamondLogForNetwork "$NETWORK" "$ENVIRONMENT"
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< updating diamond logs completed"


  echo ""
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployAllContracts completed"
}
