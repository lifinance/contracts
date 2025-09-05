#!/bin/bash

# Function to check if all LDA core facets are deployed
checkLDACoreFacetsExist() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start checkLDACoreFacetsExist"
  
  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")
  
  # Check if regular network deployment file exists (where core facets should be)
  local REGULAR_DEPLOYMENT_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"
  if [[ ! -f "$REGULAR_DEPLOYMENT_FILE" ]]; then
    echo ""
    echo "[ERROR] ❌ LiFiDEXAggregator deployment failed!"
    echo "[ERROR] Regular network deployment file not found: $REGULAR_DEPLOYMENT_FILE"
    echo "[ERROR] LDA core facets are deployed as part of the regular LiFi Diamond deployment."
    echo "[ERROR] Please deploy the regular LiFi Diamond first using option 3 in the script master menu."
    echo "[ERROR] This will deploy the core facets that LDA Diamond requires."
    echo ""
    return 1
  fi
  
  # Read LDA core facets from global.json config file
  local GLOBAL_CONFIG_PATH="./config/global.json"
  if [[ ! -f "$GLOBAL_CONFIG_PATH" ]]; then
    error "Global config file not found: $GLOBAL_CONFIG_PATH"
    return 1
  fi

  # Extract LDA core facets from JSON config
  local LDA_CORE_FACETS_JSON=$(jq -r '.ldaCoreFacets[]' "$GLOBAL_CONFIG_PATH")
  local LDA_CORE_FACETS=()
  while IFS= read -r facet; do
    LDA_CORE_FACETS+=("$facet")
  done <<< "$LDA_CORE_FACETS_JSON"

  echo "[info] Found ${#LDA_CORE_FACETS[@]} LDA core facets in config: ${LDA_CORE_FACETS[*]}"
  echo "[info] Checking for core facets in regular deployment file: $REGULAR_DEPLOYMENT_FILE"
  
  local MISSING_FACETS=()
  
  # Check each LDA core facet exists in regular deployment logs (not LDA-specific logs)
  for FACET_NAME in "${LDA_CORE_FACETS[@]}"; do
    echo "[info] Checking if LDA core facet exists: $FACET_NAME"
    
    # Check if facet address exists in regular deployment logs (shared with regular LiFi Diamond)
    local FACET_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$FACET_NAME")
    
    if [[ -z "$FACET_ADDRESS" ]]; then
      echo "[error] LDA core facet $FACET_NAME not found in regular deployment logs for network $NETWORK"
      MISSING_FACETS+=("$FACET_NAME")
    else
      echo "[info] ✅ LDA core facet $FACET_NAME found at address: $FACET_ADDRESS"
    fi
  done
  
  # If any facets are missing, fail the deployment
  if [[ ${#MISSING_FACETS[@]} -gt 0 ]]; then
    echo ""
    echo "[ERROR] ❌ LiFiDEXAggregator deployment failed!"
    echo "[ERROR] The following LDA core facets are missing from network $NETWORK regular deployment logs:"
    for missing_facet in "${MISSING_FACETS[@]}"; do
      echo "[ERROR]   - $missing_facet"
    done
    echo ""
    echo "[ERROR] LDA core facets are deployed as part of the regular LiFi Diamond deployment."
    echo "[ERROR] Please deploy the regular LiFi Diamond first using option 3 in the script master menu."
    echo "[ERROR] This will deploy the core facets (DiamondCutFacet, DiamondLoupeFacet, OwnershipFacet) that LDA Diamond requires."
    echo ""
    return 1
  fi
  
  echo "[info] ✅ All LDA core facets are available in regular deployment logs"
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< checkLDACoreFacetsExist completed"
  
  return 0
}

# Function to get LDA facet contract names from the LDA Facets directory
getLDAFacetContractNames() {
  local LDA_FACETS_PATH="src/Periphery/LDA/Facets/"
  
  # Check if the LDA Facets directory exists
  if [ ! -d "$LDA_FACETS_PATH" ]; then
    error "LDA Facets directory not found: $LDA_FACETS_PATH"
    return 1
  fi
  
  # Get contract names using the existing helper function
  local LDA_FACETS=$(getContractNamesInFolder "$LDA_FACETS_PATH")
  echo "$LDA_FACETS"
}

deployAllLDAContracts() {
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start deployAllLDAContracts"

  # load required resources
  source script/config.sh
  source script/helperFunctions.sh
  source script/deploy/deployAndStoreCREATE3Factory.sh
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
      "2) Check LDA core facets availability" \
      "3) Deploy LDA diamond" \
      "4) Update LDA diamond with core facets" \
      "5) Deploy non-core LDA facets and add to diamond" \
      "6) Update LDA diamond deployment logs" \
      "7) Run LDA health check only" \
      "8) Ownership transfer to timelock (production only)"
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
  else
    error "invalid selection: $START_FROM - exiting script now"
    exit 1
  fi

  echo "Starting LDA deployment from stage $START_STAGE: $START_FROM"
  echo ""

  # LDA Diamond contract name
  local LDA_DIAMOND_CONTRACT_NAME="LiFiDEXAggregatorDiamond"

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

  # Stage 2: Check LDA core facets availability (instead of deploying them)
  if [[ $START_STAGE -le 2 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 2: Check LDA core facets availability"

    # check if LDA core facets are available in deployment logs
    checkLDACoreFacetsExist "$NETWORK" "$ENVIRONMENT"
    
    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "verify LDA core facets availability for network $NETWORK"
    echo ""

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 2 completed"
  fi

  # Stage 3: Deploy LDA diamond
  if [[ $START_STAGE -le 3 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 3: Deploy LDA diamond"

    # get current LDA diamond contract version
    local VERSION=$(getCurrentContractVersion "$LDA_DIAMOND_CONTRACT_NAME")

    # deploy LDA diamond directly (avoid infinite loop with deploySingleContract special case)
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying $LDA_DIAMOND_CONTRACT_NAME now"
    
    # Call the deploy script directly instead of going through deploySingleContract
    # to avoid the infinite loop caused by the special case detection
    local DEPLOY_SCRIPT_PATH="script/deploy/facets/LDA/DeployLiFiDEXAggregatorDiamond.s.sol"
    local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")
    
    # For LDA contracts, modify FILE_SUFFIX to include "lda."
    if [[ "$ENVIRONMENT" == "production" ]]; then
      FILE_SUFFIX="lda."
    else
      FILE_SUFFIX="lda.staging."
    fi
    
    # Get required deployment variables
    local BYTECODE=$(getBytecodeFromArtifact "$LDA_DIAMOND_CONTRACT_NAME")
    local CREATE3_FACTORY_ADDRESS=$(getCreate3FactoryAddress "$NETWORK")
    local SALT_INPUT="$BYTECODE""$SALT"
    local DEPLOYSALT=$(cast keccak "$SALT_INPUT")
    local CONTRACT_ADDRESS=$(getContractAddressFromSalt "$DEPLOYSALT" "$NETWORK" "$LDA_DIAMOND_CONTRACT_NAME" "$ENVIRONMENT")
    
    # Deploy the LDA diamond using forge script directly with all required environment variables
    local RAW_RETURN_DATA=$(DEPLOYSALT=$DEPLOYSALT CREATE3_FACTORY_ADDRESS=$CREATE3_FACTORY_ADDRESS NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT=$DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS=$DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") DIAMOND_TYPE=$DIAMOND_TYPE forge script "$DEPLOY_SCRIPT_PATH" -f "$NETWORK" -vvvvv --json --broadcast --legacy --slow --gas-estimate-multiplier "${GAS_ESTIMATE_MULTIPLIER:-130}")
    
    # Extract deployed address
    local ADDRESS=$(extractDeployedAddressFromRawReturnData "$RAW_RETURN_DATA" "$NETWORK")
    if [[ -z "$ADDRESS" || "$ADDRESS" == "null" ]]; then
      error "failed to deploy $LDA_DIAMOND_CONTRACT_NAME - could not extract address"
      return 1
    fi
    
    echo "[info] $LDA_DIAMOND_CONTRACT_NAME deployed to $NETWORK at address $ADDRESS"
    
    # Save contract in network-specific deployment files
    saveContract "$NETWORK" "$LDA_DIAMOND_CONTRACT_NAME" "$ADDRESS" "$FILE_SUFFIX"
    
    # Also save to the regular network deployment file for complete network tracking
    local REGULAR_FILE_SUFFIX
    if [[ "$ENVIRONMENT" == "production" ]]; then
      REGULAR_FILE_SUFFIX=""
    else
      REGULAR_FILE_SUFFIX="staging."
    fi
    saveContract "$NETWORK" "$LDA_DIAMOND_CONTRACT_NAME" "$ADDRESS" "$REGULAR_FILE_SUFFIX"

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "deploy contract $LDA_DIAMOND_CONTRACT_NAME to network $NETWORK"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< $LDA_DIAMOND_CONTRACT_NAME successfully deployed"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 3 completed"
  fi

  # Stage 4: Update LDA diamond with core facets
  if [[ $START_STAGE -le 4 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 4: Update LDA diamond with core facets"

    # update LDA diamond with core facets
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now updating core facets in LDA diamond contract"
    ldaDiamondUpdateFacet "$NETWORK" "$ENVIRONMENT" "$LDA_DIAMOND_CONTRACT_NAME" "UpdateLDACoreFacets" false

    # check if last command was executed successfully, otherwise exit script with error message
    checkFailure $? "update LDA core facets in $LDA_DIAMOND_CONTRACT_NAME on network $NETWORK"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< LDA core facets update completed"

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 4 completed"
  fi

  # Stage 5: Deploy non-core LDA facets and add to diamond
  if [[ $START_STAGE -le 5 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 5: Deploy non-core LDA facets and add to diamond"

    # Get all LDA facet contract names from the LDA Facets directory
    local LDA_FACETS_PATH="src/Periphery/LDA/Facets/"
    echo "[info] Getting LDA facets from directory: $LDA_FACETS_PATH"
    
    # Read LDA core facets to exclude them from non-core deployment
    local GLOBAL_CONFIG_PATH="./config/global.json"
    local LDA_CORE_FACETS_JSON=$(jq -r '.ldaCoreFacets[]' "$GLOBAL_CONFIG_PATH")
    local LDA_CORE_FACETS=()
    while IFS= read -r facet; do
      LDA_CORE_FACETS+=("$facet")
    done <<< "$LDA_CORE_FACETS_JSON"

    # prepare regExp to exclude LDA core facets
    local EXCLUDED_LDA_FACETS_REGEXP="^($(echo "${LDA_CORE_FACETS[@]}" | tr ' ' '|'))$"
    
    echo "[info] LDA core facets to exclude: ${LDA_CORE_FACETS[*]}"
    echo "[info] Exclusion regex: $EXCLUDED_LDA_FACETS_REGEXP"

    # Deploy all non-core LDA facets and add to diamond
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now deploying non-core LDA facets and adding to diamond contract"
    
    # loop through LDA facet contract names
    for FACET_NAME in $(getContractNamesInFolder "$LDA_FACETS_PATH"); do
      echo "[info] Processing LDA facet: $FACET_NAME"
      
      # Skip if this is a core facet (already handled in previous stages)
      if [[ "$FACET_NAME" =~ $EXCLUDED_LDA_FACETS_REGEXP ]]; then
        echo "[info] Skipping LDA core facet: $FACET_NAME (already handled)"
        continue
      fi
      
      echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying non-core LDA facet: $FACET_NAME"
      
      # get current contract version
      local FACET_VERSION=$(getCurrentContractVersion "$FACET_NAME")
      
      # deploy LDA facet and add to diamond
      deployFacetAndAddToLDADiamond "$NETWORK" "$ENVIRONMENT" "$FACET_NAME" "$LDA_DIAMOND_CONTRACT_NAME" "$FACET_VERSION"
      
      # check if deployment was successful
      if [ $? -eq 0 ]; then
        echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< LDA facet $FACET_NAME successfully deployed and added to $LDA_DIAMOND_CONTRACT_NAME"
      else
        error "failed to deploy and add LDA facet $FACET_NAME to $LDA_DIAMOND_CONTRACT_NAME on network $NETWORK"
        return 1
      fi
    done
    
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< non-core LDA facets deployment completed"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 5 completed"
  fi

  # Stage 6: Update LDA diamond deployment logs
  if [[ $START_STAGE -le 6 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 6: Update LDA diamond deployment logs"
    echo "[info] Updating LDA diamond logs to populate .lda.diamond.json file..."
    
    # Update LDA diamond logs to create/populate the .lda.diamond.json file
    updateLDADiamondLogs "$ENVIRONMENT" "$NETWORK"
    
    # check if last command was executed successfully
    checkFailure $? "update LDA diamond logs for network $NETWORK"
    
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< LDA diamond logs updated successfully"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 6 completed"
  fi

  # Stage 7: Run LDA health check
  if [[ $START_STAGE -le 7 ]]; then
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 7: Run LDA health check only"
    bun script/deploy/ldaHealthCheck.ts --network "$NETWORK" --environment "$ENVIRONMENT"
    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 7 completed"

    # Pause and ask user if they want to continue with ownership transfer (for production)
    if [[ "$ENVIRONMENT" == "production" && $START_STAGE -eq 7 ]]; then
      echo ""
      echo "Health check completed. Do you want to continue with ownership transfer to timelock?"
      echo "This should only be done if the health check shows only diamond ownership errors."
      echo "Continue with stage 8 (ownership transfer)? (y/n)"
      read -r response
      if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
        echo "Proceeding with stage 8..."
      else
        echo "Skipping stage 8 - ownership transfer cancelled by user"
        echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployAllLDAContracts completed"
        return
      fi
    fi
  fi

  # Stage 8: Ownership transfer to timelock (production only)
  if [[ $START_STAGE -le 8 ]]; then
    if [[ "$ENVIRONMENT" == "production" ]]; then
      echo ""
      echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> STAGE 8: Ownership transfer to timelock (production only)"

      # make sure SAFE_ADDRESS is available (if starting in stage 8 it's not available yet)
      SAFE_ADDRESS=$(getValueFromJSONFile "./config/networks.json" "$NETWORK.safeAddress")
      if [[ -z "$SAFE_ADDRESS" || "$SAFE_ADDRESS" == "null" ]]; then
        echo "SAFE address not found in networks.json. Cannot prepare ownership transfer to Timelock"
        exit 1
      fi

      # ------------------------------------------------------------
      # Prepare ownership transfer to Timelock
      echo ""
      echo "Preparing LDA Diamond ownership transfer to Timelock"
      TIMELOCK_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiTimelockController")
      if [[ -z "$TIMELOCK_ADDRESS" ]]; then
        echo "Timelock address not found. Cannot prepare ownership transfer to Timelock"
        exit 1
      fi

      # get LDA diamond address
      LDA_DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$LDA_DIAMOND_CONTRACT_NAME")
      if [[ -z "$LDA_DIAMOND_ADDRESS" ]]; then
        echo "LDA Diamond address not found. Cannot prepare ownership transfer to Timelock"
        exit 1
      fi

      # initiate ownership transfer
      echo "Initiating LDA Diamond ownership transfer to LiFiTimelockController ($TIMELOCK_ADDRESS)"
      cast send "$LDA_DIAMOND_ADDRESS" "transferOwnership(address)" "$TIMELOCK_ADDRESS" --private-key "$PRIVATE_KEY_PRODUCTION" --rpc-url "$(getRPCUrl "$NETWORK")" --legacy
      echo "LDA Diamond ownership transfer to LiFiTimelockController ($TIMELOCK_ADDRESS) initiated"
      echo ""

      echo ""
      echo "Proposing LDA Diamond ownership transfer acceptance tx to multisig ($SAFE_ADDRESS) via LiFiTimelockController ($TIMELOCK_ADDRESS)"
      # propose tx with calldata 0x79ba5097 = confirmOwnershipTransfer() to LDA diamond (propose to multisig and wrap in timelock calldata with --timelock flag)
      bun script/deploy/safe/propose-to-safe.ts --to "$LDA_DIAMOND_ADDRESS" --calldata 0x79ba5097 --network "$NETWORK" --rpcUrl "$(getRPCUrl "$NETWORK")" --privateKey "$PRIVATE_KEY_PRODUCTION" --timelock
      echo "LDA Diamond ownership transfer acceptance proposed to multisig ($SAFE_ADDRESS) via LiFiTimelockController ($TIMELOCK_ADDRESS)"
      echo ""
      # ------------------------------------------------------------
    else
      echo "Stage 8 skipped - ownership transfer to timelock is only for production environment"
    fi

    echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< STAGE 8 completed"
  fi

  echo ""
  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< deployAllLDAContracts completed"
}
