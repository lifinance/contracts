#!/bin/bash

# LiFi DEX Aggregator (LDA) full deployment script
# - checks prerequisites of core facets (defined in ldaCoreFacets in global.json)
# - deploys LDA diamond contract
# - adds core facets to LDA diamond
# - deploys and adds LDA-specific facets
# - creates LDA deployment logs
# - runs health check
# - transfers ownership to multisig (production only)

deployAllLDAContracts() {
  echo "[info] ====================================================================="
  echo "[info] Starting LiFi DEX Aggregator (LDA) Diamond deployment"
  echo "[info] ====================================================================="

  # load required resources
  source script/config.sh
  source script/helperFunctions.sh
  source script/deploy/deployFacetAndAddToDiamond.sh
  source script/tasks/diamondUpdateFacet.sh

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

  # LDA Diamond contract name
  local LDA_DIAMOND_CONTRACT_NAME="LiFiDEXAggregatorDiamond"

  # =========================================================================
  # STEP 1: Check prerequisites - ensure core facets are deployed
  # =========================================================================
  echo ""
  echo "[info] STEP 1: Checking LDA core facets availability..."
  
  # Check if regular network deployment file exists (where core facets should be)
  local REGULAR_DEPLOYMENT_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"
  if [[ ! -f "$REGULAR_DEPLOYMENT_FILE" ]]; then
    echo ""
    echo "[ERROR] ❌ LiFi DEX Aggregator (LDA) Diamond deployment failed!"
    echo "[ERROR] Regular network deployment file not found: $REGULAR_DEPLOYMENT_FILE"
    echo "[ERROR] LDA requires core facets from the regular LiFi Diamond deployment."
    echo "[ERROR] Please deploy the regular LiFi Diamond first using option 3 in the script master menu."
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

  echo "[info] Checking for ${#LDA_CORE_FACETS[@]} LDA core facets: ${LDA_CORE_FACETS[*]}"
  
  local MISSING_FACETS=()
  
  # Check each LDA core facet exists in regular deployment logs
  for FACET_NAME in "${LDA_CORE_FACETS[@]}"; do
    local FACET_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$FACET_NAME")
    
    if [[ -z "$FACET_ADDRESS" ]]; then
      echo "[error] ❌ LDA core facet $FACET_NAME not found"
      MISSING_FACETS+=("$FACET_NAME")
    else
      echo "[info] ✅ LDA core facet $FACET_NAME found at: $FACET_ADDRESS"
    fi
  done
  
  # If any facets are missing, fail the deployment
  if [[ ${#MISSING_FACETS[@]} -gt 0 ]]; then
    echo ""
    echo "[ERROR] ❌ LDA deployment failed!"
    echo "[ERROR] Missing core facets: ${MISSING_FACETS[*]}"
    echo "[ERROR] Please deploy the regular LiFi Diamond first."
    echo ""
    return 1
  fi
  
  echo "[info] ✅ All LDA core facets are available"

  # =========================================================================
  # STEP 2: Deploy LDA Diamond
  # =========================================================================
  echo ""
  echo "[info] STEP 2: Deploying LDA Diamond..."
  
  # get current LDA diamond contract version
  local VERSION=$(getCurrentContractVersion "$LDA_DIAMOND_CONTRACT_NAME")
  local BYTECODE=$(getBytecodeFromArtifact "$LDA_DIAMOND_CONTRACT_NAME")
  local SALT_INPUT="$BYTECODE""$SALT"
  local DEPLOYSALT=$(cast keccak "$SALT_INPUT")
  
  # Determine the correct deploy script path based on network type
  if isZkEvmNetwork "$NETWORK"; then
    local DEPLOY_SCRIPT_PATH="script/deploy/zksync/LDA/DeployLiFiDEXAggregatorDiamond.zksync.s.sol"
    echo "[info] Deploying $LDA_DIAMOND_CONTRACT_NAME using ZkSync script..."
    
    # Compile contracts with ZkSync compiler first
    echo "[info] Compiling contracts with ZkSync compiler..."
    FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync
    checkFailure $? "compile contracts with ZkSync compiler"
    
    
    # For ZkSync networks, use ZkSync-specific deployment with DEPLOYSALT and regular file suffix
    local RAW_RETURN_DATA=$(FOUNDRY_PROFILE=zksync DEPLOYSALT=$DEPLOYSALT NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT=$DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS=$DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") DIAMOND_TYPE=$DIAMOND_TYPE ./foundry-zksync/forge script "$DEPLOY_SCRIPT_PATH" -f "$NETWORK" -vvvvv --json --broadcast --skip-simulation --slow --zksync --gas-estimate-multiplier "${GAS_ESTIMATE_MULTIPLIER:-130}")
  else
    local DEPLOY_SCRIPT_PATH="script/deploy/facets/LDA/DeployLiFiDEXAggregatorDiamond.s.sol"
    
    # Get required deployment variables for CREATE3 deployment
    local CREATE3_FACTORY_ADDRESS=$(getCreate3FactoryAddress "$NETWORK")
    
    echo "[info] Deploying $LDA_DIAMOND_CONTRACT_NAME using CREATE3 factory..."
    # Deploy the LDA diamond using CREATE3 factory
    local RAW_RETURN_DATA=$(DEPLOYSALT=$DEPLOYSALT CREATE3_FACTORY_ADDRESS=$CREATE3_FACTORY_ADDRESS NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT=$DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS=$DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") DIAMOND_TYPE=$DIAMOND_TYPE forge script "$DEPLOY_SCRIPT_PATH" -f "$NETWORK" -vvvvv --json --broadcast --legacy --slow --gas-estimate-multiplier "${GAS_ESTIMATE_MULTIPLIER:-130}")
  fi
  
  # Extract deployed address
  local LDA_DIAMOND_ADDRESS=$(extractDeployedAddressFromRawReturnData "$RAW_RETURN_DATA" "$NETWORK")
  if [[ -z "$LDA_DIAMOND_ADDRESS" || "$LDA_DIAMOND_ADDRESS" == "null" ]]; then
    error "❌ Failed to deploy $LDA_DIAMOND_CONTRACT_NAME - could not extract address"
    return 1
  fi
  
  echo "[info] ✅ $LDA_DIAMOND_CONTRACT_NAME deployed at: $LDA_DIAMOND_ADDRESS"
  
  # Save contract in regular network deployment file
  saveContract "$NETWORK" "$LDA_DIAMOND_CONTRACT_NAME" "$LDA_DIAMOND_ADDRESS" "$FILE_SUFFIX"

  # =========================================================================
  # STEP 3: Add core facets to LDA Diamond
  # =========================================================================
  echo ""
  echo "[info] STEP 3: Adding core facets to LDA Diamond..."
  
  diamondUpdateFacet "$NETWORK" "$ENVIRONMENT" "$LDA_DIAMOND_CONTRACT_NAME" "UpdateLDACoreFacets"
  
  if [ $? -ne 0 ]; then
    error "❌ Failed to add core facets to LDA Diamond"
    return 1
  fi
  
  echo "[info] ✅ Core facets added to LDA Diamond"

  # =========================================================================
  # STEP 4: Deploy and add LDA-specific facets
  # =========================================================================
  echo ""
  echo "[info] STEP 4: Deploying and adding LDA-specific facets..."
  
  # Get all LDA facet contract names from the LDA Facets directory
  local LDA_FACETS_PATH="src/Periphery/LDA/Facets/"
  echo "[info] Getting LDA facets from directory: $LDA_FACETS_PATH"
  
  # Deploy all non-core LDA facets and add to diamond
  for FACET_NAME in $(getContractNamesInFolder "$LDA_FACETS_PATH"); do
    echo "[info] Deploying and adding LDA facet: $FACET_NAME"
    
    # get current contract version
    local FACET_VERSION=$(getCurrentContractVersion "$FACET_NAME")
    
    # deploy LDA facet and add to diamond using unified function
    deployFacetAndAddToDiamond "$NETWORK" "$ENVIRONMENT" "$FACET_NAME" "$LDA_DIAMOND_CONTRACT_NAME" "$FACET_VERSION"
    
    # check if deployment was successful
    if [ $? -eq 0 ]; then
      echo "[info] ✅ LDA facet $FACET_NAME deployed and added"
    else
      error "❌ Failed to deploy LDA facet $FACET_NAME"
      return 1
    fi
  done
  
  echo "[info] ✅ All LDA facets deployed and added"

  # =========================================================================
  # STEP 5: Create LDA diamond deployment logs
  # =========================================================================
  echo ""
  echo "[info] STEP 5: Creating LDA diamond deployment logs..."
  
  # Update LDA diamond logs to create/populate the <network>.lda.diamond.json file
  updateDiamondLogs "$ENVIRONMENT" "$NETWORK" "LiFiDEXAggregatorDiamond"
  
  if [ $? -ne 0 ]; then
    error "❌ Failed to update LDA diamond logs"
    return 1
  fi
  
  echo "[info] ✅ LDA diamond logs created"

  # =========================================================================
  # STEP 6: Run health check
  # =========================================================================
  echo ""
  echo "[info] STEP 6: Running LDA health check..."
  
  bun script/deploy/ldaHealthCheck.ts --network "$NETWORK" --environment "$ENVIRONMENT"
  
  if [ $? -ne 0 ]; then
    warning "⚠️ LDA health check failed - please review the output above"
    echo "Continuing with ownership transfer..."
  else
    echo "[info] ✅ LDA health check passed"
  fi

  # =========================================================================
  # STEP 7: Transfer ownership to multisig (production only)
  # =========================================================================
  if [[ "$ENVIRONMENT" == "production" ]]; then
    echo ""
    echo "[info] STEP 7: Transferring LDA Diamond ownership to multisig..."
    
    # Get SAFE address from networks.json
    local SAFE_ADDRESS=$(jq -r ".${NETWORK}.safeAddress" "./config/networks.json")
    if [[ -z "$SAFE_ADDRESS" || "$SAFE_ADDRESS" == "null" ]]; then
      error "❌ SAFE address not found in networks.json for network $NETWORK"
      return 1
    fi
    
    echo "[info] Transferring LDA Diamond ownership to multisig: $SAFE_ADDRESS"
    
    # Transfer ownership directly to multisig
    cast send "$LDA_DIAMOND_ADDRESS" "transferOwnership(address)" "$SAFE_ADDRESS" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --rpc-url "$(getRPCUrl "$NETWORK")" --legacy
    
    if [ $? -eq 0 ]; then
      echo "[info] ✅ LDA Diamond ownership transferred to multisig: $SAFE_ADDRESS"
    else
      error "❌ Failed to transfer LDA Diamond ownership"
      return 1
    fi
  else
    echo ""
    echo "[info] STEP 7: Skipping ownership transfer (staging environment)"
  fi

  # =========================================================================
  # DEPLOYMENT COMPLETE
  # =========================================================================
  echo ""
  echo "[info] ====================================================================="
  echo "[info] ✅ LiFi DEX Aggregator (LDA) Diamond deployment COMPLETE!"
  echo "[info] ====================================================================="
  echo "[info] LDA Diamond Address: $LDA_DIAMOND_ADDRESS"
  echo "[info] Network: $NETWORK"
  echo "[info] Environment: $ENVIRONMENT"
  if [[ "$ENVIRONMENT" == "production" ]]; then
    echo "[info] Owner: $SAFE_ADDRESS (multisig)"
  else
    echo "[info] Owner: $(getDeployerAddress "" "$ENVIRONMENT") (deployer)"
  fi
  echo "[info] ====================================================================="
  
  return 0
}