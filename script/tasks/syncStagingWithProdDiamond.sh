#!/bin/bash

syncStagingWithProdDiamond() {
  # load required resources
  source .env
  source script/config.sh
  source script/helperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local DIAMOND_CONTRACT_NAME="$3"
  local SCRIPT="$4"
  local REPLACE_EXISTING_FACET="$5"

  # emit warning that this script is only designed for mutable diamond
  warning "THIS SCRIPT ONLY WORKS WITH THE MUTABLE DIAMOND"
  echo ""
  echo ""


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

  # get RPC URL for this network
  RPC_URL=$(getRPCUrl "$NETWORK")
    echoDebug "RPC_URL : $RPC_URL"


  # get diamond address from deployments log
  DIAMOND_PROD=$(jq -r '.'"LiFiDiamond" "./deployments/${NETWORK}.${FILE_SUFFIX}json")
  DIAMOND_STAGING=$(jq -r '.'"LiFiDiamond" "./deployments/${NETWORK}.staging.json")

  echoDebug "Prod diamond address   : $DIAMOND_PROD"
  echoDebug "Staging diamond address: $DIAMOND_STAGING"

    # if no diamond address was found, throw an error and exit the script
  if [[ -z "$DIAMOND_PROD" || -z "$DIAMOND_STAGING" ]]; then
  # if [[ -z "$DIAMOND_PROD" == "null" || "$DIAMOND_STAGING" == "null" ]]; then
    error "could not find all diamond addresses on network $NETWORK (staging: $DIAMOND_STAGING, prod: $DIAMOND_PROD)"
    return 1
  fi


  # get a list of registered facets in PROD diamond, check which of those facets is not registered in STAGING diamond
  # and register every facet that is missing on STAGING
  syncRegisteredFacets

  # go through each of these facets
    # check if already registered in staging diamond
    # if yes then check if all function selectors are registered
    # if no then add facet

  # check Periphery contracts
    # get a list of all (possible) Periphery contracts (all names)
    # go through all these names
      # check if Periphery is registered in diamond
      # if yes, add to staging diamond

  # update all DEX addresses with latest list (no comparison with prod diamond)
  # update all function selectors with latest list (no comparison with prod diamond)


  # # LOUPER_RESULT=$(louper-cli inspect diamond -a ${DIAMOND_PROD} -n ${NETWORK} --json)
  # echo "LOUPER: $LOUPER_RESULT"










  # # set flag for mutable/immutable diamond
  # USE_MUTABLE_DIAMOND=$([[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]] && echo true || echo false)

  # # logging for debug purposes
  # echoDebug "updating $DIAMOND_CONTRACT_NAME on $NETWORK with address $DIAMOND_ADDRESS in $ENVIRONMENT environment with script $SCRIPT (FILE_SUFFIX=$FILE_SUFFIX, USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND)"

  # # check if update script exists
  # local FULL_SCRIPT_PATH=""$DEPLOY_SCRIPT_DIRECTORY""$SCRIPT"".s.sol""
  # if ! checkIfFileExists "$FULL_SCRIPT_PATH" >/dev/null; then
  #   error "could not find update script for $CONTRACT in this path: $FULL_SCRIPT_PATH". Aborting update.
  #   return 1
  # fi

  # # update diamond with new facet address (remove/replace of existing selectors happens in update script)
  # attempts=1
  # while [ $attempts -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
  #   echo "[info] trying to execute $SCRIPT on $DIAMOND_CONTRACT_NAME now - attempt ${attempts} (max attempts:$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"
  #   # try to execute call
  #   if [[ "$DEBUG" == *"true"* ]]; then
  #     # print output to console
  #     RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND NO_BROADCAST=false PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy)
  #   else
  #     # do not print output to console
  #     RAW_RETURN_DATA=$(NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX USE_DEF_DIAMOND=$USE_MUTABLE_DIAMOND NO_BROADCAST=false PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$SCRIPT_PATH" -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy) 2>/dev/null
  #   fi
  #   RETURN_CODE=$?
  #   echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

  #   # check the return code the last call
  #   if [ "$RETURN_CODE" -eq 0 ]; then
  #     # extract the "logs" property and its contents from return data
  #     CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')

  #     # extract the "returns" property and its contents from logs
  #     RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2>/dev/null)
  #     #echoDebug "RETURN_DATA: $RETURN_DATA"

  #     # get the facet addresses that are known to the diamond from the return data
  #     FACETS=$(echo $RETURN_DATA | jq -r '.facets.value')
  #     if [[ $FACETS != "{}" ]]; then
  #       break # exit the loop if the operation was successful
  #     fi
  #   fi

  #   attempts=$((attempts + 1)) # increment attempts
  #   sleep 1                    # wait for 1 second before trying the operation again
  # done

  # # check if call was executed successfully or used all attempts
  # if [ $attempts -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
  #   error "failed to execute $SCRIPT on network $NETWORK in $ENVIRONMENT environment"
  #   return 1
  # fi

  # # save facet addresses
  # saveDiamondFacets "$NETWORK" "$ENVIRONMENT" "$USE_MUTABLE_DIAMOND" "$FACETS"

  echo "[info] staging diamond ($DIAMOND_STAGING) on network $NETWORK successfully synced with production diamond ($DIAMOND_PROD)"
  return 0
}

syncRegisteredFacets() {
  # get all facets that are registered in PROD diamond
  echo "[info] getting registered facets in STAGING diamond now"
  STAGING_FACETS_RAW=$(cast call "$DIAMOND_STAGING" "facetAddresses()" --rpc-url "$RPC_URL")
  STAGING_FACETS_DECODED=$(cast abi-decode "facets()(address[])" $STAGING_FACETS_RAW)

  echoDebug "STAGING_FACETS: $STAGING_FACETS_DECODED"

  echo "[info] getting registered facets in PROD diamond now"
  PROD_FACETS_RAW=$(cast call "$DIAMOND_PROD" "facets()" --rpc-url "$RPC_URL")



  # decode the data returned by the diamond to obtain facet addresses and related function selectors
  FACETS_DECODED=$(cast abi-decode "facets()((address,bytes4[])[])" $PROD_FACETS_RAW)


  # Remove the outer brackets
  FACETS_DECODED="${FACETS_DECODED#[(}"
  FACETS_DECODED="${FACETS_DECODED%)]}"

  # Use a temporary delimiter '****' to replace '), (' - [@dev: did not work with splitting by '), (']
  DELIMITER='****'
  FACETS_DECODED="${FACETS_DECODED//), (/$DELIMITER}"

  # Split by the unique delimiter
  IFS=$DELIMITER read -ra FACETS_ARRAY <<< "$FACETS_DECODED"

  # Iterate through the facets and their function selectors
  SELECTORS_TO_BE_REMOVED=()
  for RAW_VALUE in "${FACETS_ARRAY[@]}"; do
      # skip empty values
      if [[ -z "$RAW_VALUE" ]]; then
        continue
      fi

    # remove the trailing bracket
    RAW_VALUE="${RAW_VALUE%]}"

    # Use a temporary delimiter '****' to replace ', ['
    RAW_VALUE="${RAW_VALUE//, [/$DELIMITER}"

    # Split the raw value string by delimiter to separate address and selectors
    IFS=$DELIMITER read -ra PARTS <<< "$RAW_VALUE"

    # Extract the address and selectors
    FACET_ADDRESS=${PARTS[0]}
    if [[ ! -ze $FACET_ADDRESS ]]; then
      FACET_COUNT=$((FACET_COUNT + 1))
    fi
    SELECTORS=${PARTS[4]}

    # Clean up address and selectors
    FACET_ADDRESS=${FACET_ADDRESS//\'/}
    SELECTORS=${SELECTORS//[\[\]]/}

    # Print the address
    echo "Now checking facet with address: $FACET_ADDRESS"

    # check if this facet is already registered in STAGING diamond
    if [[ " ${STAGING_FACETS_DECODED[@]} " =~ " ${FACET_ADDRESS} " ]]; then
      # we assume here that function selectors match and continue with the next facet address
      echoDebug "Facet is registered in STAGING diamond. Continuing with the next address."
      continue
    else
      echoDebug "Facet is not registered in STAGING diamond."
    fi

    # Split selectors by ', ' and iterate through each selector
    # to check if one of the selectors is already registered in the diamond
    IFS=', ' read -r -a SELECTORS_RAW_ARRAY <<< "$SELECTORS"
    SELECTORS_ARRAY=()
    for SELECTOR_RAW in "${SELECTORS_RAW_ARRAY[@]}"; do
        # extract the actual function selector from the 32 bytes value
        SELECTOR=${SELECTOR_RAW:0:10}

        # make sure we have data
        if [[ ! -ze $SELECTOR ]]; then
          # count the selector
          SELECTOR_COUNT=$((SELECTOR_COUNT + 1))
        else
          error "Selector did not contain any data: $SELECTOR"
          continue
        fi

        #  add selector to new array
        SELECTOR_ARRAY+=($SELECTOR)

        # check if the function selector is registered in the STAGING diamond
        local REGISTERED_ADDRESS=$(getFacetAddressFromDiamond "$NETWORK" "$DIAMOND_STAGING" "$SELECTOR")
        if ! compareAddresses "$REGISTERED_ADDRESS" "$ZERO_ADDRESS" >/dev/null; then
          echoDebug "Selector is already registered in STAGING diamond and will be removed first: $SELECTOR"
          SELECTORS_TO_BE_REMOVED+=($SELECTOR)
        fi
    done

    # make a diamondCut call to remove all function selectors that are
    if [[ ${#SELECTORS_TO_BE_REMOVED[@]} -ne 0 ]]; then
      removeFunctionSelectorsFromStagingDiamond "$DIAMOND_STAGING" "$NETWORK" "$RPC_URL" "${SELECTORS_TO_BE_REMOVED[@]}"
    else
      echoDebug "No function selectors found that need to be removed first"
    fi

    # create diamond cut to add new facet with its function selectors
    addFunctionSelectorsToStagingDiamond "$DIAMOND_STAGING" "$NETWORK" "$RPC_URL" "$FACET_ADDRESS" "${SELECTORS_ARRAY[@]}"
    ADDED_COUNT=$((ADDED_COUNT + 1))

    # ISSUE: what about initiation of the facets?

    echo ""
  done

  echo "[info] ${FACET_COUNT} registered facet addresses with ${SELECTOR_COUNT} function selectors found in PROD diamond"
  echo "[info] ${ADDED_COUNT} of those facet addresses were added to the staging diamond"
}

addFunctionSelectorsToStagingDiamond() {
  # read function arguments into variables
  local DIAMOND_ADDRESS="$1"
  local NETWORK="$2"
  local RPC_URL="$3"
  local FACET_ADDRESS="$4"
  shift 4
  local SELECTORS=("$@")

  # prepare arguments for diamondCut call
  local FACET_CUT_ACTION="1" # (add == 1 according to enum)
  local DIAMOND_CUT_FUNCTION_SIGNATURE="diamondCut((address,uint8,bytes4[])[],address,bytes)"

  local TUPLE="[(""$ZERO_ADDRESS"",""$FACET_CUT_ACTION,["$SELECTORS"])]"

  # Encode the function call arguments with the encode command
  local ENCODED_ARGS=$(cast calldata "$DIAMOND_CUT_FUNCTION_SIGNATURE" "$TUPLE" "$ZERO_ADDRESS" "0x")

  ATTEMPTS=1
  while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to add facet $FACET_ADDRESS to staging diamond $DIAMOND_ADDRESS - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"

    # call diamond
    if [[ "$DEBUG" == *"true"* ]]; then
      # print output to console
      # TODO: UNDO <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<≤<<<<<
      # cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "staging")" --rpc-url "$RPC_URL" --legacy
      echoDebug "cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "staging")" --rpc-url "$RPC_URL" --legacy"

    else
      # do not print output to console
      # TODO: UNDO <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<≤<<<<<
      # cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "staging")" --rpc-url "$RPC_URL" --legacy >/dev/null 2>&1
      echoDebug "cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "staging")" --rpc-url "$RPC_URL" --legacy >/dev/null 2>&1"
    fi

    # check the return code the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    ATTEMPTS=$((ATTEMPTS + 1)) # increment ATTEMPTS
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all ATTEMPTS
  if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    error "failed to add facet $FACET_ADDRESS to staging diamond $DIAMOND_ADDRESS on network $NETWORK"
    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  echo "[info] facet successfully added"
}
removeFunctionSelectorsFromStagingDiamond() {
  # read function arguments into variables
  local DIAMOND_ADDRESS="$1"
  local NETWORK="$2"
  local RPC_URL="$3"
  shift 3
  local SELECTORS=("$@")

  # prepare arguments for diamondCut call
  local FACET_CUT_ACTION="2" # (remove == 2 according to enum)
  local DIAMOND_CUT_FUNCTION_SIGNATURE="diamondCut((address,uint8,bytes4[])[],address,bytes)"

  local TUPLE="[(""$ZERO_ADDRESS"",""$FACET_CUT_ACTION,["$SELECTORS"])]"

  # Encode the function call arguments with the encode command
  local ENCODED_ARGS=$(cast calldata "$DIAMOND_CUT_FUNCTION_SIGNATURE" "$TUPLE" "$ZERO_ADDRESS" "0x")

  ATTEMPTS=1
  while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to remove function selectors from diamond $DIAMOND_ADDRESS - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"

    # call diamond
    if [[ "$DEBUG" == *"true"* ]]; then
      # print output to console
      # TODO: UNDO <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<≤<<<<<
      # cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "staging")" --rpc-url "$RPC_URL" --legacy
      echoDebug "cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "staging")" --rpc-url "$RPC_URL" --legacy"
    else
      # do not print output to console
      # TODO: UNDO <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<≤<<<<<
      # cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "staging")" --rpc-url "$RPC_URL" --legacy >/dev/null 2>&1
      echoDebug "cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "staging")" --rpc-url "$RPC_URL" --legacy >/dev/null 2>&1"
    fi

    # check the return code the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    ATTEMPTS=$((ATTEMPTS + 1)) # increment ATTEMPTS
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all ATTEMPTS
  if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    error "failed to remove function selectors from $DIAMOND_ADDRESS on network $NETWORK"
    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  echo "[info] function selectors successfully removed"
}

syncStagingWithProdDiamond mainnet
