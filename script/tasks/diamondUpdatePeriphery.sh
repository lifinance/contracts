#!/bin/bash

function diamondUpdatePeriphery() {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running diamondUpdatePeriphery now...."

  # load required resources
  # Note: .env is already sourced in the parent script, so we don't need to source it again
  # This prevents overwriting exported variables like SEND_PROPOSALS_DIRECTLY_TO_DIAMOND
  source script/helperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local DIAMOND_CONTRACT_NAME="$3"
  local UPDATE_ALL="$4"
  local EXIT_ON_ERROR="$5"
  local CONTRACT=$6

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
	  NETWORK=$(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH" | gum filter --placeholder "Network")
    checkRequiredVariablesInDotEnv $NETWORK
  fi

  # if no DIAMOND_CONTRACT_NAME was passed to this function, ask user to select diamond type
  if [[ -z "$DIAMOND_CONTRACT_NAME" ]]; then
    echo ""
    echo "Please select which type of diamond contract to update:"
    DIAMOND_CONTRACT_NAME=$(userDialogSelectDiamondType)
    echo "[info] selected diamond type: $DIAMOND_CONTRACT_NAME"
  fi

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # get diamond address from deployments script
  DIAMOND_ADDRESS=$(jq -r '.'"$DIAMOND_CONTRACT_NAME" "./deployments/${NETWORK}.${FILE_SUFFIX}json")

  # if no diamond address was found, throw an error and exit the script
  if [[ "$DIAMOND_ADDRESS" == "null" ]]; then
    error "could not find address for $DIAMOND_CONTRACT_NAME on network $NETWORK in file './deployments/${NETWORK}.${FILE_SUFFIX}json' - exiting diamondUpdatePeriphery script now"
    return 1
  fi

  # determine which periphery contracts to update
  if [[ -z "$UPDATE_ALL" || "$UPDATE_ALL" == "false" ]]; then
    # check to see if a single contract was passed that should be upgraded
    if [[ -z "$CONTRACT" ]]; then
      # get a list of all periphery contracts
      local PERIPHERY_PATH="$CONTRACT_DIRECTORY""Periphery/"
      PERIPHERY_CONTRACTS=$(getContractNamesInFolder "$PERIPHERY_PATH")
      PERIPHERY_CONTRACTS_ARR=($(echo "$PERIPHERY_CONTRACTS" | tr ',' ' '))

      # ask user to select contracts to be updated
      CONTRACTS=$(gum choose --no-limit "${PERIPHERY_CONTRACTS_ARR[@]}")
    else
      CONTRACTS=$CONTRACT
    fi
  else
    # get all periphery contracts that are not excluded by config
    CONTRACTS=$(getIncludedPeripheryContractsArray)
  fi

  # logging for debug purposes
  echoDebug "in function updatePeriphery"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echoDebug "UPDATE_ALL=$UPDATE_ALL"
  echoDebug "CONTRACTS=($CONTRACTS)"
  echo ""

  # get path of deployment file to extract contract addresses from it
  if [[ -z "$FILE_SUFFIX" ]]; then
    ADDRS="deployments/$NETWORK$FILE_SUFFIX.json"
  else
    ADDRS="deployments/$NETWORK.$FILE_SUFFIX""json"
  fi

  # Sticky failure flag: only ever set to 1, never reset, so a later contract's success
  # cannot mask an earlier one's failure. Drives the EXIT_ON_ERROR exit below and this
  # function's return code.
  local LAST_CALL=0

  # Single predicate for "Safe-propose vs direct broadcast", used by saveDiamondPeriphery below.
  local SHOULD_PROPOSE_TO_SAFE=false
  if [[ "$ENVIRONMENT" == "production" && "${SEND_PROPOSALS_DIRECTLY_TO_DIAMOND:-}" != "true" ]] \
     && ! isTestnetNetwork "$NETWORK"; then
    SHOULD_PROPOSE_TO_SAFE=true
  fi

  # A registration of a diamond-called periphery contract is proposed in the
  # same timelock batch as its whitelist writes: proposed alone, it executes
  # into a registry entry the diamond is not allowed to call. Every route is
  # decided, and every refusal made, before the first proposal is created.
  local PAIRED_NAMES=()
  local PAIRED_ADDRESSES=()
  local PLAIN_NAMES=()
  local PLAIN_ADDRESSES=()
  local REFUSED=false

  # loop through all periphery contracts (no target state check; same as facet update flow)
  for CONTRACT in $CONTRACTS; do
    # get contract address from deploy log
    local CONTRACT_ADDRESS=$(jq -r --arg CONTRACT_NAME "$CONTRACT" '.[$CONTRACT_NAME] // "0x"' "$ADDRS")

    # check if address available, otherwise throw error and skip iteration
    if [ "$CONTRACT_ADDRESS" != "0x" ]; then
      # verify function selectors match their signatures in global.json
      local GLOBAL_JSON="config/global.json"
      if [ -f "$GLOBAL_JSON" ]; then
        local SELECTOR_DATA=$(jq -r --arg CONTRACT "$CONTRACT" '.whitelistPeripheryFunctions[$CONTRACT] // [] | .[] | "\(.signature)|\(.selector)"' "$GLOBAL_JSON" 2>/dev/null)

        if [ -n "$SELECTOR_DATA" ]; then
          local VERIFICATION_FAILED=false
          while IFS='|' read -r SIGNATURE EXPECTED_SELECTOR; do
            if [ -n "$SIGNATURE" ] && [ -n "$EXPECTED_SELECTOR" ]; then
              if ! verifySelectorMatchesSignature "$SIGNATURE" "$EXPECTED_SELECTOR"; then
                local CALCULATED=$(cast sig "$SIGNATURE" 2>/dev/null)
                error "Selector mismatch for $CONTRACT:"
                error "  Signature: $SIGNATURE"
                error "  Expected selector: $EXPECTED_SELECTOR"
                error "  Calculated selector: $CALCULATED"
                VERIFICATION_FAILED=true
              fi
            fi
          done <<< "$SELECTOR_DATA"

          if [ "$VERIFICATION_FAILED" = true ]; then
            error "Function selector verification failed for $CONTRACT. Please fix global.json before proceeding."
            LAST_CALL=1
            continue
          fi
        fi
      fi

      # check if has already been added to diamond
      KNOWN_ADDRESS=$(getPeripheryAddressFromDiamond "$NETWORK" "$DIAMOND_ADDRESS" "$CONTRACT")

      if [ "$KNOWN_ADDRESS" != "$CONTRACT_ADDRESS" ]; then
        if [[ "$SHOULD_PROPOSE_TO_SAFE" == "true" ]]; then
          local ROUTE_RC=0
          bunx tsx script/tasks/proposePeripheryWithWhitelist.ts --contract "$CONTRACT" --networks "$NETWORK" --address "$CONTRACT_ADDRESS" --preflight || ROUTE_RC=$?
          if [[ "$ROUTE_RC" -eq 0 ]]; then
            PAIRED_NAMES+=("$CONTRACT")
            PAIRED_ADDRESSES+=("$CONTRACT_ADDRESS")
          elif [[ "$ROUTE_RC" -eq 3 ]]; then
            PLAIN_NAMES+=("$CONTRACT")
            PLAIN_ADDRESSES+=("$CONTRACT_ADDRESS")
          else
            error "[$NETWORK] $CONTRACT $CONTRACT_ADDRESS cannot be proposed with its whitelist writes (see above)"
            REFUSED=true
          fi
        else
          PLAIN_NAMES+=("$CONTRACT")
          PLAIN_ADDRESSES+=("$CONTRACT_ADDRESS")
        fi
      else
        echo "[info] contract $CONTRACT is already registered on diamond $DIAMOND_ADDRESS - no action needed"
      fi
    else
      warning "no address found for periphery contract $CONTRACT in this file: $ADDRS >> please deploy contract first"
      LAST_CALL=1
    fi
  done

  if [[ "$REFUSED" == "true" ]]; then
    error "[$NETWORK] nothing was proposed: update config/whitelist.json for the contract(s) above first, then re-run"
    if [[ "$EXIT_ON_ERROR" == "true" ]]; then
      exit 1
    fi
    return 1
  fi

  local I
  for I in "${!PLAIN_NAMES[@]}"; do
    if register "$NETWORK" "$DIAMOND_ADDRESS" "${PLAIN_NAMES[$I]}" "${PLAIN_ADDRESSES[$I]}" "$ENVIRONMENT"; then
      echo "[info] contract ${PLAIN_NAMES[$I]} successfully registered on diamond $DIAMOND_ADDRESS"
    else
      # latch: a failure must not be reset to 0 by a later successful iteration
      LAST_CALL=1
    fi
  done

  if [[ ${#PAIRED_NAMES[@]} -gt 0 ]]; then
    local PAIRED_NAMES_CSV PAIRED_ADDRESSES_CSV
    PAIRED_NAMES_CSV=$(IFS=,; echo "${PAIRED_NAMES[*]}")
    PAIRED_ADDRESSES_CSV=$(IFS=,; echo "${PAIRED_ADDRESSES[*]}")
    if registerWithWhitelist "$NETWORK" "$DIAMOND_ADDRESS" "$PAIRED_NAMES_CSV" "$PAIRED_ADDRESSES_CSV"; then
      echo "[info] registration of $PAIRED_NAMES_CSV proposed together with its whitelist writes on diamond $DIAMOND_ADDRESS"
    else
      LAST_CALL=1
    fi
  fi

  # check the return code the last call
  if [ $LAST_CALL -ne 0 ]; then
    # end this script according to flag
    if [[ "$EXIT_ON_ERROR" == "true" ]]; then
      exit 1
    fi
  fi

  # Update diamond log file when registration was sent directly (staging, testnet,
  # SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true). For Safe proposals the log gets updated
  # after the SAFE tx is signed.
  if [[ "$SHOULD_PROPOSE_TO_SAFE" != "true" ]]; then
    if [[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]]; then
      saveDiamondPeriphery "$NETWORK" "$ENVIRONMENT" true
    else
      saveDiamondPeriphery "$NETWORK" "$ENVIRONMENT" false
    fi
  fi

  if [[ "$LAST_CALL" -ne 0 ]]; then
    error "diamondUpdatePeriphery failed to register at least one contract on network $NETWORK"
    return 1
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< diamondUpdatePeriphery completed"
  return 0
}

# registerWithWhitelist: Proposes the registration of diamond-called periphery
# contracts and the diamond's whitelist sync as one timelock scheduleBatch.
#
# Usage: registerWithWhitelist NETWORK DIAMOND NAMES ADDRESSES
#   NETWORK   - Network name
#   DIAMOND   - Diamond the contracts are registered on
#   NAMES     - Comma-separated registry names
#   ADDRESSES - Comma-separated addresses, parallel to NAMES
#
# Returns: 0 once the proposal is created, 1 when every attempt failed
# Example: registerWithWhitelist "fuse" "$DIAMOND_ADDRESS" "TokenWrapper" "0x254b..."
function registerWithWhitelist() {
  local NETWORK="$1"
  local DIAMOND="$2"
  local NAMES="$3"
  local ADDRESSES="$4"
  local ATTEMPTS=1

  while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    doNotContinueUnlessGasIsBelowThreshold "$NETWORK"
    echo "Now proposing registerPeripheryContract for ${NAMES} together with the whitelist writes in one timelock batch"
    if bunx tsx script/tasks/proposePeripheryWithWhitelist.ts --contract "$NAMES" --networks "$NETWORK" --address "$ADDRESSES" --diamond "$DIAMOND"; then
      return 0
    fi
    ATTEMPTS=$((ATTEMPTS + 1))
    sleep 1
  done

  error "failed to propose the registration of $NAMES with its whitelist writes on network $NETWORK"
  return 1
}

register() {
  local NETWORK="$1"
  local DIAMOND=$2
  local CONTRACT_NAME=$3
  local ADDR=$4
  local RPC_URL=$(getRPCUrl $NETWORK) || checkFailure $? "get rpc url"
  local ENVIRONMENT=$5

  # make sure GAS_ESTIMATE_MULTIPLIER is set
  if [[ -z "$GAS_ESTIMATE_MULTIPLIER" ]]; then
    GAS_ESTIMATE_MULTIPLIER=130 # this is foundry's default value
  fi

  # register periphery contract
  local ATTEMPTS=1

  # logging for debug purposes
  echoDebug "in function register"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "DIAMOND=$DIAMOND"
  echoDebug "CONTRACT_NAME=$CONTRACT_NAME"
  echoDebug "ADDR=$ADDR"
  echoDebug "RPC_URL=$(redactRpcUrl "$RPC_URL")"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "GAS_ESTIMATE_MULTIPLIER=$GAS_ESTIMATE_MULTIPLIER (default value: 130, set in .env for example to 200 for doubling Foundry's estimate)"
  echo ""

  # check that the contract is actually deployed
  local CODE_SIZE=$(cast codesize "$ADDR" --rpc-url "$RPC_URL")
  if [ $CODE_SIZE -eq 0 ]; then
    error "contract $CONTRACT_NAME is not deployed on network $NETWORK - exiting script now"
    return 1
  fi

  # helper function to get gas limit with multiplier applied
  getGasLimitWithMultiplier() {
    local ESTIMATED_GAS=$(cast estimate "$DIAMOND" 'registerPeripheryContract(string,address)' "$CONTRACT_NAME" "$ADDR" --rpc-url "$RPC_URL" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" 2>/dev/null)
    if [ $? -eq 0 ] && [ -n "$ESTIMATED_GAS" ]; then
      # Multiply by multiplier (130 = 1.3x, 200 = 2x, etc.)
      echo $((ESTIMATED_GAS * GAS_ESTIMATE_MULTIPLIER / 100))
    else
      # If estimation fails, return empty (universalCast send will estimate automatically)
      echo ""
    fi
  }

  # SHOULD_PROPOSE_TO_SAFE is set by the calling diamondUpdatePeriphery function and
  # is visible here via bash dynamic scoping; do not redeclare.

  while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    # calculate gas limit with multiplier
    local GAS_LIMIT=$(getGasLimitWithMultiplier)
    local GAS_LIMIT_ARGS=()
    if [ -n "$GAS_LIMIT" ] && [ "$GAS_LIMIT" -gt 0 ] 2>/dev/null; then
      GAS_LIMIT_ARGS=("--gas-limit" "$GAS_LIMIT")
      echoDebug "Using gas limit: $GAS_LIMIT (estimated gas * $GAS_ESTIMATE_MULTIPLIER / 100)"
    else
      echoDebug "Gas estimation failed or returned invalid value, universalCast send will estimate automatically"
    fi

    # try to execute call
    if [[ "$DEBUG" == *"true"* ]]; then
      # print output to console
      echoDebug "trying to register periphery contract $CONTRACT_NAME in diamond on network $NETWORK now - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION) "

      # ensure that gas price is below maximum threshold (for mainnet only)
      doNotContinueUnlessGasIsBelowThreshold "$NETWORK"

      if [[ "$SHOULD_PROPOSE_TO_SAFE" == "true" ]]; then
        # Propose registerPeripheryContract to Safe with timelock wrapping.
        local CALLDATA
        CALLDATA=$(cast calldata "registerPeripheryContract(string,address)" "$CONTRACT_NAME" "$ADDR") || {
          error "[$NETWORK] failed to encode registerPeripheryContract calldata for $CONTRACT_NAME"
          return 1
        }
        if [[ -z "$CALLDATA" || "$CALLDATA" == "0x" ]]; then
          error "[$NETWORK] empty calldata for registerPeripheryContract($CONTRACT_NAME, $ADDR)"
          return 1
        fi

        local DIAMOND_ADDRESS
        DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")

        echo "Now proposing registerPeripheryContract('${CONTRACT_NAME}','${ADDR}') to diamond with timelock wrapping"
        bun script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --timelock
      else
        # Staging, testnet, or SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true: register directly on the diamond
        universalCast "send" "$NETWORK" "$ENVIRONMENT" "$DIAMOND" "registerPeripheryContract(string,address)" "$CONTRACT_NAME $ADDR"
      fi
    else
      # do not print output to console
      if [[ "$SHOULD_PROPOSE_TO_SAFE" == "true" ]]; then
        # Propose registerPeripheryContract to Safe with timelock wrapping.
        local CALLDATA
        CALLDATA=$(cast calldata "registerPeripheryContract(string,address)" "$CONTRACT_NAME" "$ADDR") || {
          error "[$NETWORK] failed to encode registerPeripheryContract calldata for $CONTRACT_NAME"
          return 1
        }
        if [[ -z "$CALLDATA" || "$CALLDATA" == "0x" ]]; then
          error "[$NETWORK] empty calldata for registerPeripheryContract($CONTRACT_NAME, $ADDR)"
          return 1
        fi
        echoDebug "Calldata: $CALLDATA"

        local DIAMOND_ADDRESS
        DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")
        echoDebug "DIAMOND_ADDRESS: $DIAMOND_ADDRESS"
        echoDebug "NETWORK: $NETWORK"

        echo "Now proposing registerPeripheryContract('${CONTRACT_NAME}','${ADDR}') to diamond with timelock wrapping"
        bun script/deploy/safe/propose-to-safe.ts --to "$DIAMOND_ADDRESS" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --timelock
      else
        # Staging, testnet, or SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true: register directly on the diamond
        universalCast "send" "$NETWORK" "$ENVIRONMENT" "$DIAMOND" "registerPeripheryContract(string,address)" "$CONTRACT_NAME $ADDR" >/dev/null 2>&1
      fi
    fi

    # check the return code the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    ATTEMPTS=$((ATTEMPTS + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all attempts
  if [ $ATTEMPTS -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    error "failed to register $CONTRACT_NAME in diamond on network $NETWORK"
    printf '\033[0;33m%s\033[0m\n' "   If the error was FunctionDoesNotExist (0xa9ad62f8), PeripheryRegistryFacet may not be attached to the diamond."
    printf '\033[0;33m%s\033[0m\n' "   Run Stage 3 (Deploy diamond and update with core facets) or run the UpdatePeripheryRegistryFacet script, then retry Stage 7."
    return 1
  fi
}
