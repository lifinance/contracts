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

  # determine full (relative) path of deploy script
  SCRIPT_PATH=$DEPLOY_SCRIPT_DIRECTORY"$SCRIPT.s.sol"

  # set flag for mutable/immutable diamond
  USE_MUTABLE_DIAMOND=$([[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]] && echo true || echo false)

  # logging for debug purposes
  echoDebug "updating $DIAMOND_CONTRACT_NAME on $NETWORK with address $DIAMOND_ADDRESS in $ENVIRONMENT environment with script $SCRIPT (FILE_SUFFIX=$FILE_SUFFIX, USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND)"

  # check if update script exists
  local FULL_SCRIPT_PATH=""$DEPLOY_SCRIPT_DIRECTORY""$SCRIPT"".s.sol""
  if ! checkIfFileExists "$FULL_SCRIPT_PATH" >/dev/null; then
    error "could not find update script for $CONTRACT in this path: $FULL_SCRIPT_PATH". Aborting update.
    return 1
  fi

  # update diamond with new facet address (remove/replace of existing selectors happens in update script)
  attempts=1
  while [ $attempts -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to execute $SCRIPT on $DIAMOND_CONTRACT_NAME now - attempt ${attempts} (max attempts:$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"
    # check if command output should be printed to console
    if [[ "$DEBUG" == *"true"* ]]; then
      # check if we are deploying to PROD
      if [[ "$ENVIRONMENT" == "production" ]]; then
          # PROD: suggest diamondCut transaction to SAFE
          UPDATE_SCRIPT=$(echo "$DEPLOY_SCRIPT_DIRECTORY""$SCRIPT".s.sol)
          PRIVATE_KEY=$(getPrivateKey $NETWORK $ENVIRONMENT)
          echoDebug "Calculating facet cuts for $SCRIPT..."
          if [[ $NETWORK == "zksync" ]]; then
            RAW_RETURN_DATA=$(docker run --rm -it --volume .:/foundry -u $(id -u):$(id -g) -e FOUNDRY_PROFILE=zksync -e NO_BROADCAST=true -e NETWORK=$NETWORK -e FILE_SUFFIX=$FILE_SUFFIX -e USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND -e PRIVATE_KEY=$PRIVATE_KEY foundry-zksync forge script "$UPDATE_SCRIPT" -f $NETWORK -vvvvv --json --skip-simulation --legacy --slow --zksync)
          else
            RAW_RETURN_DATA=$(NO_BROADCAST=true NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$PRIVATE_KEY forge script "$UPDATE_SCRIPT" -f $NETWORK -vvvvv --json --skip-simulation --legacy)
          fi
          CLEAN_RETURN_DATA=$(echo "$RAW_RETURN_DATA" | grep -o '{\"logs.*}') # new version that removes non-JSON log output both before and after the JSON (old version removed only before)
          FACET_CUT=$(echo $CLEAN_RETURN_DATA | jq -r '.returns.cutData.value')
          echo ""
          echo "DiamondCut calldata: $FACET_CUT"
          echo ""

          if [ "$FACET_CUT" == "0x" ] || [ -z "$FACET_CUT" ]; then
            error "Unable to extract facet cut data from RPC response at logs.returns.cutData.value"
          else
            # set DEPLOY_NEW_NETWORK_MODE to true when deploying a new network so that transactions are not proposed to SAFE (since deployer is still the diamond contract owner during deployment)
            if [ "$DEPLOY_NEW_NETWORK_MODE" == "true" ]; then
              echo "DEPLOY_NEW_NETWORK_MODE is activated - executing facet cut for $SCRIPT on network $NETWORK..."
              RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND NO_BROADCAST=false PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvvv --json --broadcast --skip-simulation --legacy)
            else
              echo "Proposing facet cut for $SCRIPT on network $NETWORK..."
              DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")
              npx tsx script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$FACET_CUT" --network "$NETWORK" --rpcUrl "$(getRPCUrl $NETWORK)" --privateKey "$SAFE_SIGNER_PRIVATE_KEY"
            fi
          fi
        else
          # STAGING: just deploy normally without further checks
          RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND NO_BROADCAST=false PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvvv --json --broadcast --skip-simulation --legacy)
      fi
    else
      # check if we are deploying to PROD
      if [[ "$ENVIRONMENT" == "production" ]]; then
        # PROD: suggest diamondCut transaction to SAFE
        UPDATE_SCRIPT=$(echo "$DEPLOY_SCRIPT_DIRECTORY"Update"$SCRIPT".s.sol)
        PRIVATE_KEY=$(getPrivateKey $NETWORK $ENVIRONMENT)
        echoDebug "Calculating facet cuts for $SCRIPT..."
        RAW_RETURN_DATA=$(NO_BROADCAST=true NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND PRIVATE_KEY=$PRIVATE_KEY forge script "$UPDATE_SCRIPT" -f $NETWORK -vvvvv --json --skip-simulation --legacy)
        CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
        FACET_CUT=$(echo $CLEAN_RETURN_DATA | jq -r '.returns.cutData.value')
        if [ "$FACET_CUT" == "0x" ] || [ -z "$FACET_CUT" ]; then
          error "Unable to extract facet cut data from RPC response at logs.returns.cutData.value"
        else
          # set DEPLOY_NEW_NETWORK_MODE to true when deploying a new network so that transactions are not proposed to SAFE (since deployer is still the diamond contract owner during deployment)
          if [ "$DEPLOY_NEW_NETWORK_MODE" == "true" ]; then
            echo "DEPLOY_NEW_NETWORK_MODE is activated - executing facet cut for $script on network $NETWORK..."
            RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND NO_BROADCAST=false PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvvv --json --broadcast --skip-simulation --legacy)
          else
            echo "Proposing facet cut for $SCRIPT on network $NETWORK..."
            DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")
            npx tsx script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$FACET_CUT" --network "$NETWORK" --rpcUrl "$(getRPCUrl "$NETWORK")" --privateKey "$SAFE_SIGNER_PRIVATE_KEY"
          fi
        fi
      else
        # STAGING: just deploy normally without further checks
        RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND NO_BROADCAST=false PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvvv --json --broadcast --skip-simulation --legacy)
      fi
     fi
    RETURN_CODE=$?
    echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

    # check the return code the last call
    if [ "$RETURN_CODE" -eq 0 ]; then
      # only check the logs if deploying to staging, otherwise we are not calling the diamond and cannot expect any logs
      if [[ "$ENVIRONMENT" != "production" ]]; then
        # extract the "logs" property and its contents from return data
        CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
        # echoDebug "CLEAN_RETURN_DATA: $CLEAN_RETURN_DATA"

        # extract the "returns" property and its contents from logs
        RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2>/dev/null)
        # echoDebug "RETURN_DATA: $RETURN_DATA"

        # get the facet addresses that are known to the diamond from the return data
        FACETS=$(echo $RETURN_DATA | jq -r '.facets.value')
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

  # save facet addresses (only if deploying to PROD, otherwise we update the logs before the diamondCut tx gets signed in the SAFE)
  if [[ "$ENVIRONMENT" != "production" ]]; then
    saveDiamondFacets "$NETWORK" "$ENVIRONMENT" "$USE_MUTABLE_DIAMOND" "$FACETS"
  fi

  echo "[info] $SCRIPT successfully executed on network $NETWORK in $ENVIRONMENT environment"
  return 0
}
