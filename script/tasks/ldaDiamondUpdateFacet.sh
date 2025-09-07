#!/bin/bash

# executes a diamond update script to update an LDA facet on LiFiDEXAggregatorDiamond
function ldaDiamondUpdateFacet() {

  # load required variables and helper functions
  source script/config.sh
  source script/helperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"
  local UPDATE_SCRIPT="$4"

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
    NETWORK=$(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH" | gum filter --placeholder "Network")
    checkRequiredVariablesInDotEnv $NETWORK
  fi

  # if no ENVIRONMENT was passed to this function, determine it
  if [[ -z "$ENVIRONMENT" ]]; then
    if [[ "$PRODUCTION" == "true" ]]; then
      # make sure that PRODUCTION was selected intentionally by user
      echo "    "
      echo "    "
      printf '\033[31m%s\031\n' "!!!!!!!!!!!!!!!!!!!!!!!! ATTENTION !!!!!!!!!!!!!!!!!!!!!!!!";
      printf '\033[33m%s\033[0m\n' "The config environment variable PRODUCTION is set to true";
      printf '\033[33m%s\033[0m\n' "This means you will be updating LDA contracts in production";
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
  fi

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # if no DIAMOND_CONTRACT_NAME was passed to this function, default to LiFiDEXAggregatorDiamond
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    DIAMOND_CONTRACT_NAME="LiFiDEXAggregatorDiamond"
  fi

  # if no UPDATE_SCRIPT was passed to this function, ask user to select it
  if [[ -z "$UPDATE_SCRIPT" ]]; then
    echo ""
    echo "Please select which LDA update script you would like to execute"
    local SCRIPT=$(ls -1 script/deploy/facets/LDA/ | sed -e 's/\.s.sol$//' | grep 'Update' | gum filter --placeholder "Update LDA Script")
    UPDATE_SCRIPT="$SCRIPT"
  fi

  # set LDA-specific script directory (use ZkSync path for ZkSync networks)
  if isZkEvmNetwork "$NETWORK"; then
    LDA_UPDATE_SCRIPT_PATH="script/deploy/zksync/LDA/${UPDATE_SCRIPT}.zksync.s.sol"
  else
    LDA_UPDATE_SCRIPT_PATH="script/deploy/facets/LDA/${UPDATE_SCRIPT}.s.sol"
  fi

  # check if LDA update script exists
  if ! checkIfFileExists "$LDA_UPDATE_SCRIPT_PATH" >/dev/null; then
    error "could not find LDA update script for $UPDATE_SCRIPT in this path: $LDA_UPDATE_SCRIPT_PATH."
    return 1
  fi

  local LDA_DEPLOYMENT_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"
  local DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "$LDA_DEPLOYMENT_FILE")

  # if no diamond address was found, throw an error and exit this script
  if [[ "$DIAMOND_ADDRESS" == "null" ]]; then
    error "could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file '$LDA_DEPLOYMENT_FILE' - exiting script now"
    return 1
  fi

  # set flag for LDA diamond (always false since LiFiDEXAggregatorDiamond is not the default diamond)
  USE_LDA_DIAMOND=false

  if [[ -z "$GAS_ESTIMATE_MULTIPLIER" ]]; then
    GAS_ESTIMATE_MULTIPLIER=130 # this is foundry's default value
  fi

  # execute LDA diamond update script
  local attempts=1

  while [ $attempts -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to execute LDA diamond update script $UPDATE_SCRIPT now - attempt ${attempts} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION) "

    # ensure that gas price is below maximum threshold (for mainnet only)
    doNotContinueUnlessGasIsBelowThreshold "$NETWORK"

    # try to execute call (use ZkSync forge for ZkSync networks)
    if isZkEvmNetwork "$NETWORK"; then
      # For ZkSync networks, use ZkSync-specific forge and compile first
      echo "[info] Compiling contracts with ZkSync compiler for LDA diamond update..."
      FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync
      RAW_RETURN_DATA=$(FOUNDRY_PROFILE=zksync NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_LDA_DIAMOND PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") ./foundry-zksync/forge script "$LDA_UPDATE_SCRIPT_PATH" -f "$NETWORK" -vvvvv --json --broadcast --skip-simulation --slow --zksync --gas-estimate-multiplier "$GAS_ESTIMATE_MULTIPLIER")
    else
      # For regular networks, use regular forge
      RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_LDA_DIAMOND PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$LDA_UPDATE_SCRIPT_PATH" -f "$NETWORK" -vvvvv --json --broadcast --slow --gas-estimate-multiplier "$GAS_ESTIMATE_MULTIPLIER")
    fi

    local RETURN_CODE=$?

    # print return data only if debug mode is activated
    echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

    # check return data for error message (regardless of return code as this is not 100% reliable)
    if [[ $RAW_RETURN_DATA == *"\"logs\":[]"* && $RAW_RETURN_DATA == *"\"returns\":{}"* ]]; then
      warning "The transaction was executed but the return value suggests that no logs were emitted"
      warning "This happens if contracts are already up-to-date."
      warning "This may also be a sign that the transaction was not executed properly."
      warning "Please check manually if the transaction was executed and if the LDA diamond was updated"
      echo ""
      return 0
    fi

    # check the return code the last call
    if [ "$RETURN_CODE" -eq 0 ]; then
      # extract the "returns" property directly from the JSON output
      RETURN_DATA=$(echo "$RAW_RETURN_DATA" | jq -r '.returns // empty' 2>/dev/null)
      
      # get the facet addresses that are known to the diamond from the return data
      FACETS=$(echo "$RETURN_DATA" | jq -r '.facets.value // "{}"')
      if [[ $FACETS != "{}" ]]; then
        echo "[info] LDA diamond update was successful"
        return 0 # exit the loop if the operation was successful
      fi
    fi

    echo "[error] Call failed with error code $RETURN_CODE"
    echo "[error] Error message: $RAW_RETURN_DATA"

    attempts=$((attempts + 1))

    # exit the loop if this was the last attempt
    if [ $attempts -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
      error "max attempts reached, execution of LDA diamond update for $UPDATE_SCRIPT failed"
      return 1
    fi

    # wait a bit before retrying
    echo "retrying in $TIME_TO_WAIT_BEFORE_RETRY_ON_ERROR seconds..."
    sleep $TIME_TO_WAIT_BEFORE_RETRY_ON_ERROR
  done

  return 1
}