#!/bin/bash

diamondUpdateFacet() {
  # load required resources
  source .env
  source script/config.sh
  source script/helperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"
  local SCRIPT="$4"
  local REPLACE_EXISTING_FACET="$5"

  # if no ENVIRONMENT was passed to this function, determine it
  if [[ -z "$ENVIRONMENT" ]]; then
    if [[ "$PRODUCTION" == "true" ]]; then
      # make sure that PRODUCTION was selected intentionally by user
      echo "    "
      echo "    "
      printf '\033[31m%s\031\n' "!!!!!!!!!!!!!!!!!!!!!!!! ATTENTION !!!!!!!!!!!!!!!!!!!!!!!!"
      printf '\033[33m%s\033[0m\n' "The config environment variable PRODUCTION is set to true"
      printf '\033[33m%s\033[0m\n' "This means you will be deploying contracts to production"
      printf '\033[31m%s\031\n' "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
      echo "    "
      printf '\033[33m%s\033[0m\n' "Last chance: Do you want to skip?"
      PROD_SELECTION=$(
        gum choose \
          "yes" \
          "no"
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

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    NETWORK=$(getUserSelectedNetwork)

    # check the return code the last call
    if [ $? -ne 0 ]; then
      echo "$NETWORK" # will contain an error message
      exit 1
    fi
    # get deployer wallet balance
    BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")

    echo "[info] selected network: $NETWORK"
    echo "[info] deployer wallet balance in this network: $BALANCE"
    echo ""
  fi

  # if no DIAMOND_CONTRACT_NAME was passed to this function, ask user to select diamond type
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to update:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
    echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # get diamond address from deployments script
  DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "./deployments/${NETWORK}.${FILE_SUFFIX}json")

  # if no diamond address was found, throw an error and exit the script
  if [[ "$DIAMOND_ADDRESS" == "null" ]]; then
    error "could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file './deployments/${NETWORK}.${FILE_SUFFIX}json' - exiting diamondUpdatePeripheryscript now"
    return 1
  fi

  # if no SCRIPT was passed to this function, ask user to select it
  if [[ -z "$SCRIPT" ]]; then
    echo "Please select which facet you would like to update"
    SCRIPT=$(ls -1 "$DEPLOY_SCRIPT_DIRECTORY" | sed -e 's/\.s.sol$//' | grep 'Update' | gum filter --placeholder "Update Script")
  fi

  # Handle script paths and extensions based on network type
  if isZkEvmNetwork "$NETWORK"; then
    SCRIPT_PATH="script/deploy/zksync/$SCRIPT.zksync.s.sol"
    # Check if the foundry-zksync binaries exist, if not fetch them
    install_foundry_zksync
  else
    SCRIPT_PATH=$DEPLOY_SCRIPT_DIRECTORY"$SCRIPT.s.sol"
  fi

  CONTRACT_NAME=$(basename "$SCRIPT_PATH" | sed 's/\.zksync\.s\.sol$//' | sed 's/\.s\.sol$//')

  # set flag for mutable/immutable diamond
  USE_MUTABLE_DIAMOND=$([[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]] && echo true || echo false)

  # logging for debug purposes
  echoDebug "updating $DIAMOND_CONTRACT_NAME on $NETWORK with address $DIAMOND_ADDRESS in $ENVIRONMENT environment with script $SCRIPT (FILE_SUFFIX=$FILE_SUFFIX, USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND)"

  # check if update script exists
  if ! checkIfFileExists "$SCRIPT_PATH" >/dev/null; then
    error "could not find update script for $CONTRACT_NAME in this path: $SCRIPT_PATH. Aborting update."
    return 1
  fi

  # update diamond with new facet address (remove/replace of existing selectors happens in update script)
  attempts=1
  while [ $attempts -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to execute $SCRIPT on $DIAMOND_CONTRACT_NAME now - attempt ${attempts} (max attempts:$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"
    # check if we are deploying to PROD
    if [[ "$ENVIRONMENT" == "production" && "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" != "true" ]]; then
      # PROD: suggest diamondCut transaction to SAFE

      PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT")
      echoDebug "Calculating facet cuts for $CONTRACT_NAME in path $SCRIPT_PATH..."

      if isZkEvmNetwork "$NETWORK"; then
        echo "zkEVM network detected"
        RAW_RETURN_DATA=$(FOUNDRY_PROFILE=zksync NO_BROADCAST=true NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$PRIVATE_KEY ./foundry-zksync/forge script "$SCRIPT_PATH" -f "$NETWORK" -vvvv --json --skip-simulation --slow --zksync)
      else
        # PROD (normal mode): suggest diamondCut transaction to SAFE
        RAW_RETURN_DATA=$(NO_BROADCAST=true NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$PRIVATE_KEY forge script "$SCRIPT_PATH" -f "$NETWORK" -vvvv --json --skip-simulation --legacy)


        # Extract cutData directly from the JSON output
        FACET_CUT=$(echo "$RAW_RETURN_DATA" | jq -r '.returns.cutData.value // empty' 2>/dev/null)
        echo "FACET_CUT: ($FACET_CUT)"
        echo ""

        if [[ "$FACET_CUT" != "0x" && -n "$FACET_CUT" ]]; then
          echo "Proposing facet cut for $CONTRACT_NAME on network $NETWORK..."
          DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")

          RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

          # Check if timelock is enabled and available
          TIMELOCK_ADDRESS=$(jq -r '.LiFiTimelockController // "0x"' "./deployments/${NETWORK}.${FILE_SUFFIX}json")

          if [[ "$USE_TIMELOCK_CONTROLLER" == "true" && "$TIMELOCK_ADDRESS" != "0x" ]]; then
            echo "[info] Using timelock controller for facet update"
            bun script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$FACET_CUT" --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$PRIVATE_KEY" --timelock
          else
            echo "[info] Using diamond directly for facet update"
            bun script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$FACET_CUT" --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$PRIVATE_KEY"
          fi
        else
          error "FacetCut is empty"
          return 1
        fi
      fi
    else
      # STAGING (or new network deployment): just deploy normally without further checks
      echo "Sending diamondCut transaction directly to diamond (staging or new network deployment)..."

      if isZkEvmNetwork "$NETWORK"; then
        RAW_RETURN_DATA=$(FOUNDRY_PROFILE=zksync ./foundry-zksync/forge script "$SCRIPT_PATH" -f "$NETWORK" --json --broadcast --skip-simulation --slow --zksync --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT"))
      else
        RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND NO_BROADCAST=false PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f "$NETWORK" -vvvv --json --broadcast --legacy)
      fi
    fi
    RETURN_CODE=$?
    echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

    # check the return code the last call
    if [ "$RETURN_CODE" -eq 0 ]; then
      # only check the logs if deploying to staging, otherwise we are not calling the diamond and cannot expect any logs
      if [[ "$ENVIRONMENT" != "production" ]]; then
        # extract the "returns" property directly from the JSON output
        RETURN_DATA=$(echo "$RAW_RETURN_DATA" | jq -r '.returns // empty' 2>/dev/null)
        # echoDebug "RETURN_DATA: $RETURN_DATA"

        # get the facet addresses that are known to the diamond from the return data
        FACETS=$(echo "$RETURN_DATA" | jq -r '.facets.value // "{}"')
        if [[ $FACETS != "{}" ]]; then
          break # exit the loop if the operation was successful
        fi
      else
        # if deploying to PROD and RETURN_CODE is OK then we can assume that the proposal to SAFE worked fine
        break
      fi
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all attempts
  if [ $attempts -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    error "failed to execute $SCRIPT on network $NETWORK in $ENVIRONMENT environment"
    return 1
  fi

  # save facet addresses (only if deploying to staging, otherwise we update the logs after the diamondCut tx gets signed in the SAFE)
  if [[ "$ENVIRONMENT" != "production" ]]; then
    saveDiamondFacets "$NETWORK" "$ENVIRONMENT" "$USE_MUTABLE_DIAMOND" "$FACETS"
  fi

  echo "[info] $SCRIPT successfully executed on network $NETWORK in $ENVIRONMENT environment"
  return 0
}
