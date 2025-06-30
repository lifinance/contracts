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
  source script/tasks/diamondSyncWhitelistedAddresses.sh
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


  # make sure that config is set correctly
  if [[ "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" == "false" ]]; then
    echo "Please set SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true in your config.sh when deploying a new network"
    exit 1
  fi


  # since we only support mutable diamonds, no need to ask user to select diamond type
  local DIAMOND_CONTRACT_NAME="LiFiDiamond"

  # add RPC URL to MongoDB
  echo ""
  echo "Adding RPC URL from networks.json to MongoDB and fetching all URLs"
  bun add-network-rpc --network "$NETWORK" --rpc-url "$(getRpcUrlFromNetworksJson "$NETWORK")"
  bun fetch-rpcs

  # get deployer wallet balance
  BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")
  echo "Balance: $BALANCE"
  if [[ -z "$BALANCE" || "$BALANCE" == "0" ]]; then
    echo "Deployer wallet does not have any balance in network $NETWORK. Please fund the wallet and try again"
    exit 1
  fi

  echo "[info] deployer wallet balance in this network: $BALANCE"
  echo ""
  checkRequiredVariablesInDotEnv "$NETWORK"

  # deploy CREATE3Factory
  deployAndStoreCREATE3Factory "$NETWORK" "$ENVIRONMENT"
  checkFailure $? "deploy CREATE3Factory to network $NETWORK"
  echo ""

  # deploy SAFE
  echo ""
  echo "Deploying SAFE Proxy instance now"
  bun deploy-safe --network "$NETWORK"
  checkFailure $? "deploy Safe Proxy instance to network $NETWORK"

  # deploy core facets
  deployCoreFacets "$NETWORK" "$ENVIRONMENT"
  echo ""

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

  # deploy periphery
  deployPeripheryContracts "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

  # update periphery registry
  diamondUpdatePeriphery "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" true false ""

  # add core periphery addresses to whitelistedAddresses.json for whitelisting in subsequent steps
  addPeripheryToWhitelistedAddressesJson "$NETWORK" "$ENVIRONMENT"

  # run sync whitelisted addresses script
  echo ""
  diamondSyncWhitelistedAddresses "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

  # run sync sigs script
  echo ""
  diamondSyncSigs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME"

  # register Executor as authorized caller in ERC20Proxy
  echo ""
  updateERC20Proxy "$NETWORK" "$ENVIRONMENT"

  if [[ "$ENVIRONMENT" == "production" ]]; then
    # ------------------------------------------------------------
    # Prepare ownership transfer to Timelock
    echo ""
    echo "Preparing ownership transfer to Timelock"
    TIMELOCK_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiTimelockController")
    if [[ -z "$TIMELOCK_ADDRESS" ]]; then
      echo "Timelock address not found. Cannot prepare ownership transfer to Timelock"
      exit 1
    fi

    # initiate ownership transfer
    echo "Initiating ownership transfer to LiFiTimelockController ($TIMELOCK_ADDRESS)"
    cast send "$DIAMOND_ADDRESS" "transferOwnership(address)" "$TIMELOCK_ADDRESS" --private-key "$PRIVATE_KEY_PRODUCTION" --rpc-url "$RPC_URL"  --legacy
    echo "Ownership transfer to LiFiTimelockController ($TIMELOCK_ADDRESS) initiated"
    echo ""

    echo ""
    echo "Proposing ownership transfer acceptance tx to multisig ($SAFE_ADDRESS) via LiFiTimelockController ($TIMELOCK_ADDRESS) "
    # propose tx with calldata 0x7200b829 = acceptOwnershipTransfer() to diamond (propose to multisig and wrap in timeloc calldata with --timelock flag)
    bun script/deploy/safe/propose-to-safe.ts --to "$DIAMOND" --calldata 0x7200b829 --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$PRIVATE_KEY_PRODUCTION" --timelock
    echo "Ownership transfer acceptance proposed to multisig ($SAFE_ADDRESS) via LiFiTimelockController ($TIMELOCK_ADDRESS)"
    echo ""
    # ------------------------------------------------------------
  fi


  echo ""
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployAllContracts completed"
}
