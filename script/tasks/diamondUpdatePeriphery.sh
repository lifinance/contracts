#!/bin/bash

function diamondUpdatePeriphery() {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running diamondUpdatePeriphery now...."

  # load required resources
  source .env
  source script/config.sh
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

  # initialize LAST_CALL variable that will be used to exit the script (only when ERROR_ON_EXIT flag is true)
  local LAST_CALL=0

  # loop through all periphery contracts
  for CONTRACT in $CONTRACTS; do
    # check if contract is in target state, otherwise skip iteration
    TARGET_VERSION=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_CONTRACT_NAME")

    # only continue if contract was found in target state
    if [[ "$?" -eq 0 ]]; then
      # get contract address from deploy log
      if [[ "$CONTRACT" == "RelayerCelerIM" ]]; then
        # special handling for RelayerCelerIM
        # >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
        if [[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]]; then
          local CONTRACT_ADDRESS=$(jq -r '.RelayerCelerIMMutable // "0x"' "$ADDRS")
        elif [[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamondImmutable" ]]; then
          local CONTRACT_ADDRESS=$(jq -r '.RelayerCelerIMImmutable // "0x"' "$ADDRS")
        else
          error "invalid value for DIAMOND_CONTRACT_NAME: ($DIAMOND_CONTRACT_NAME) in function diamondUpdatePeriphery()"
        fi
        # <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
      else
        local CONTRACT_ADDRESS=$(jq -r --arg CONTRACT_NAME "$CONTRACT" '.[$CONTRACT_NAME] // "0x"' "$ADDRS")
      fi

      # check if address available, otherwise throw error and skip iteration
      if [ "$CONTRACT_ADDRESS" != "0x" ]; then
        # check if has already been added to diamond
        KNOWN_ADDRESS=$(getPeripheryAddressFromDiamond "$NETWORK" "$DIAMOND_ADDRESS" "$CONTRACT")

        if [ "$KNOWN_ADDRESS" != "$CONTRACT_ADDRESS" ]; then
          # register contract
          register "$NETWORK" "$DIAMOND_ADDRESS" "$CONTRACT" "$CONTRACT_ADDRESS" "$ENVIRONMENT"
          LAST_CALL=$?

          if [ $LAST_CALL -eq 0 ]; then
            echo "[info] contract $CONTRACT successfully registered on diamond $DIAMOND_ADDRESS"
          fi
        else
          echo "[info] contract $CONTRACT is already registered on diamond $DIAMOND_ADDRESS - no action needed"
        fi
      else
        warning "no address found for periphery contract $CONTRACT in this file: $ADDRS >> please deploy contract first"
        LAST_CALL=1
      fi
    else
      warning "contract $CONTRACT not found in target state file. ACTION REQUIRED: Update target state file and try again if this contract should be included."
    fi
  done

  # check the return code the last call
  if [ $LAST_CALL -ne 0 ]; then
    # end this script according to flag
    if [[ "$EXIT_ON_ERROR" == "true" ]]; then
      exit 1
    fi
  fi

  # update diamond log file
  if [[ "$DIAMOND_CONTRACT_NAME" == "LiFiDiamond" ]]; then
    saveDiamondPeriphery "$NETWORK" "$ENVIRONMENT" true
  else
    saveDiamondPeriphery "$NETWORK" "$ENVIRONMENT" false
  fi

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< diamondUpdatePeriphery completed"
}

register() {
  local NETWORK="$1"
  local DIAMOND=$2
  local CONTRACT_NAME=$3
  local ADDR=$4
  local RPC_URL=$(getRPCUrl $NETWORK) || checkFailure $? "get rpc url"
  local ENVIRONMENT=$5

  # register periphery contract
  local ATTEMPTS=1

  # logging for debug purposes
  echoDebug "in function register"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "DIAMOND=$DIAMOND"
  echoDebug "CONTRACT_NAME=$CONTRACT_NAME"
  echoDebug "ADDR=$ADDR"
  echoDebug "RPC_URL=$RPC_URL"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echo ""

  # check that the contract is actually deployed
  local CODE_SIZE=$(cast codesize "$ADDR" --rpc-url "$RPC_URL")
  if [ $CODE_SIZE -eq 0 ]; then
    error "contract $CONTRACT_NAME is not deployed on network $NETWORK - exiting script now"
    return 1
  fi

  while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    # try to execute call
    if [[ "$DEBUG" == *"true"* ]]; then
      # print output to console
      echoDebug "trying to register periphery contract $CONTRACT_NAME in diamond on network $NETWORK now - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION) "

      # ensure that gas price is below maximum threshold (for mainnet only)
      doNotContinueUnlessGasIsBelowThreshold "$NETWORK"

      if [[ "$ENVIRONMENT" == "production" ]]; then
        # set SEND_PROPOSALS_DIRECTLY_TO_DIAMOND to true when deploying a new network so that transactions are not proposed to SAFE (since deployer is still the diamond contract owner during deployment)
        if [ "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" == "true" ]; then
          echo "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND is activated - registering '${CONTRACT_NAME}' as periphery on diamond '${DIAMOND_ADDRESS}' in network $NETWORK now..."
          cast send "$DIAMOND" 'registerPeripheryContract(string,address)' "$CONTRACT_NAME" "$ADDR" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --rpc-url "$RPC_URL" --legacy
        else
          # propose registerPeripheryContract transaction to multisig safe
          local CALLDATA=$(cast calldata "registerPeripheryContract(string,address)" "$CONTRACT_NAME" "$ADDR")

          DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")
          
          # Get timelock controller address if it exists
          local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")
          TIMELOCK_ADDRESS=$(jq -r '.LiFiTimelockController // "0x"' "./deployments/${NETWORK}.${FILE_SUFFIX}json")
          
          # Check if timelock is enabled and available
          if [[ "$USE_TIMELOCK_CONTROLLER" == "true" && "$TIMELOCK_ADDRESS" != "0x" ]]; then
            # Use timelock controller instead of diamond for proposals
            TARGET_ADDRESS="$TIMELOCK_ADDRESS"
            echo "[info] Using timelock controller at $TIMELOCK_ADDRESS for periphery registration"
            
            # Get the minimum delay from the timelock controller
            MIN_DELAY=$(bun -e "
              import { createPublicClient, http, parseAbi } from 'viem';
              import { getViemChainForNetworkName } from './script/utils/viemScriptHelpers.js';
              
              const chain = getViemChainForNetworkName('$NETWORK');
              const client = createPublicClient({
                chain,
                transport: http('$RPC_URL'),
              });
              
              const timelockAbi = parseAbi([
                'function getMinDelay() view returns (uint256)',
              ]);
              
              async function getMinDelay() {
                try {
                  const delay = await client.readContract({
                    address: '$TIMELOCK_ADDRESS',
                    abi: timelockAbi,
                    functionName: 'getMinDelay',
                  });
                  console.log(delay.toString());
                } catch (error) {
                  console.log('3600'); // Default to 1 hour if there's an error
                }
              }
              
              getMinDelay();
            ")
            
            # Encode the schedule function call
            SCHEDULE_CALLDATA=$(bun -e "
              import { encodeFunctionData, parseAbi } from 'viem';
              
              const timelockAbi = parseAbi([
                'function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay) returns (bytes32)',
              ]);
              
              // Create a unique salt based on the current timestamp
              const salt = '0x' + Date.now().toString(16).padStart(64, '0');
              
              // Encode the schedule function call
              const calldata = encodeFunctionData({
                abi: timelockAbi,
                functionName: 'schedule',
                args: [
                  '$DIAMOND_ADDRESS',  // target
                  0n,                  // value
                  '$CALLDATA',         // data
                  '0x0000000000000000000000000000000000000000000000000000000000000000', // predecessor (empty)
                  salt,                // salt
                  BigInt($MIN_DELAY),  // delay
                ],
              });
              
              console.log(calldata);
            ")
            
            echo "[info] Encoded schedule call with minimum delay of $MIN_DELAY seconds"
            CALLDATA="$SCHEDULE_CALLDATA"
          else
            # Use diamond address directly
            TARGET_ADDRESS="$DIAMOND_ADDRESS"
            echo "[info] Using diamond directly at $DIAMOND_ADDRESS for periphery registration"
          fi

          echo "Now proposing registerPeripheryContract('${CONTRACT_NAME}','${ADDR}') to '${TARGET_ADDRESS}' with calldata $CALLDATA"
          bun script/deploy/safe/propose-to-safe.ts --to "$TARGET_ADDRESS" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$SAFE_SIGNER_PRIVATE_KEY"
        fi
      else
        # just register the diamond (no multisig required)
        cast send "$DIAMOND" 'registerPeripheryContract(string,address)' "$CONTRACT_NAME" "$ADDR" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --rpc-url "$RPC_URL" --legacy
      fi

      #      cast send 0xd37c412F1a782332a91d183052427a5336438cD3 'registerPeripheryContract(string,address)' "Executor" "0x68895782994F1d7eE13AD210b63B66c81ec7F772" --private-key "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" --rpc-url $RPC_URL" --legacy
    else
      # do not print output to console
      if [[ "$ENVIRONMENT" == "production" ]]; then
        # set SEND_PROPOSALS_DIRECTLY_TO_DIAMOND to true when deploying a new network so that transactions are not proposed to SAFE (since deployer is still the diamond contract owner during deployment)
        if [ "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" == "true" ]; then
          echo "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND is activated - registering '${CONTRACT_NAME}' as periphery on diamond '${DIAMOND_ADDRESS}' in network $NETWORK now..."
          cast send "$DIAMOND" 'registerPeripheryContract(string,address)' "$CONTRACT_NAME" "$ADDR" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --rpc-url "$RPC_URL" --legacy
        else
          # propose registerPeripheryContract transaction to multisig safe
          local CALLDATA=$(cast calldata "registerPeripheryContract(string,address)" "$CONTRACT_NAME" "$ADDR")
          echoDebug "Calldata: $CALLDATA"

          DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME")
          echoDebug "DIAMOND_ADDRESS: $DIAMOND_ADDRESS"
          echoDebug "NETWORK: $NETWORK"
          
          # Get timelock controller address if it exists
          local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")
          TIMELOCK_ADDRESS=$(jq -r '.LiFiTimelockController // "0x"' "./deployments/${NETWORK}.${FILE_SUFFIX}json")
          
          # Check if timelock is enabled and available
          if [[ "$USE_TIMELOCK_CONTROLLER" == "true" && "$TIMELOCK_ADDRESS" != "0x" ]]; then
            # Use timelock controller instead of diamond for proposals
            TARGET_ADDRESS="$TIMELOCK_ADDRESS"
            echoDebug "Using timelock controller at $TIMELOCK_ADDRESS for periphery registration"
            
            # Get the minimum delay from the timelock controller
            MIN_DELAY=$(bun -e "
              import { createPublicClient, http, parseAbi } from 'viem';
              import { getViemChainForNetworkName } from './script/utils/viemScriptHelpers.js';
              
              const chain = getViemChainForNetworkName('$NETWORK');
              const client = createPublicClient({
                chain,
                transport: http('$RPC_URL'),
              });
              
              const timelockAbi = parseAbi([
                'function getMinDelay() view returns (uint256)',
              ]);
              
              async function getMinDelay() {
                try {
                  const delay = await client.readContract({
                    address: '$TIMELOCK_ADDRESS',
                    abi: timelockAbi,
                    functionName: 'getMinDelay',
                  });
                  console.log(delay.toString());
                } catch (error) {
                  console.log('3600'); // Default to 1 hour if there's an error
                }
              }
              
              getMinDelay();
            ")
            
            # Encode the schedule function call
            SCHEDULE_CALLDATA=$(bun -e "
              import { encodeFunctionData, parseAbi } from 'viem';
              
              const timelockAbi = parseAbi([
                'function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay) returns (bytes32)',
              ]);
              
              // Create a unique salt based on the current timestamp
              const salt = '0x' + Date.now().toString(16).padStart(64, '0');
              
              // Encode the schedule function call
              const calldata = encodeFunctionData({
                abi: timelockAbi,
                functionName: 'schedule',
                args: [
                  '$DIAMOND_ADDRESS',  // target
                  0n,                  // value
                  '$CALLDATA',         // data
                  '0x0000000000000000000000000000000000000000000000000000000000000000', // predecessor (empty)
                  salt,                // salt
                  BigInt($MIN_DELAY),  // delay
                ],
              });
              
              console.log(calldata);
            ")
            
            echoDebug "Encoded schedule call with minimum delay of $MIN_DELAY seconds"
            CALLDATA="$SCHEDULE_CALLDATA"
          else
            # Use diamond address directly
            TARGET_ADDRESS="$DIAMOND_ADDRESS"
            echoDebug "Using diamond directly at $DIAMOND_ADDRESS for periphery registration"
          fi

          echo "Now proposing registerPeripheryContract('${CONTRACT_NAME}','${ADDR}') to '${TARGET_ADDRESS}' with calldata $CALLDATA"
          bun script/deploy/safe/propose-to-safe.ts --to "$TARGET_ADDRESS" --calldata "$CALLDATA" --network "$NETWORK" --rpcUrl "$RPC_URL" --privateKey "$SAFE_SIGNER_PRIVATE_KEY"
        fi
      else
        # just register the diamond (no multisig required)
        cast send "$DIAMOND" 'registerPeripheryContract(string,address)' "$CONTRACT_NAME" "$ADDR" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --rpc-url "$RPC_URL" --legacy >/dev/null 2>&1
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
    return 1
  fi
}
