#!/bin/bash


source scripts/deploy/deployConfig.sh
#source scripts/deploy/log4bash.sh


# DONE
function logContractDeploymentInfo {
  # read function arguments into variables
  local CONTRACT="$1"
  local NETWORK="$2"
  local TIMESTAMP="$3"
  local VERSION="$4"
  local OPTIMIZER_RUNS="$5"
  local CONSTRUCTOR_ARGS="$6"
  local ENVIRONMENT="$7"
  local ADDRESS="$8"

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function logContractDeploymentInfo"
    echo "[debug] CONTRACT=$CONTRACT"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] TIMESTAMP=$TIMESTAMP"
    echo "[debug] VERSION=$VERSION"
    echo "[debug] OPTIMIZER_RUNS=$OPTIMIZER_RUNS"
    echo "[debug] CONSTRUCTOR_ARGS=$CONSTRUCTOR_ARGS"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] ADDRESS=$ADDRESS"
  fi

  # Check if log FILE exists, if not create it
  if [ ! -f "$LOG_FILE_PATH" ]; then
    echo "{}" > "$LOG_FILE_PATH"
  fi

  # Check if log FILE already contains entry with same CONTRACT, NETWORK, ENVIRONMENT and VERSION
  checkIfJSONContainsEntry $CONTRACT $NETWORK $ENVIRONMENT $VERSION $LOG_FILE_PATH
  if [ $? -eq 1 ]; then
      echo "[warning]: deployment log FILE contained already an entry for (CONTRACT: $CONTRACT, NETWORK: $NETWORK, ENVIRONMENT: $ENVIRONMENT, VERSION: $VERSION). This is unexpected behaviour since an existing CONTRACT should not have been re-deployed. A new entry was added to the log FILE. "
  fi

  # Append new JSON object to log FILE
  jq -r --arg CONTRACT "$CONTRACT" \
      --arg NETWORK "$NETWORK" \
      --arg ENVIRONMENT "$ENVIRONMENT" \
      --arg VERSION "$VERSION" \
      --arg ADDRESS "$ADDRESS" \
      --arg OPTIMIZER_RUNS "$OPTIMIZER_RUNS" \
      --arg TIMESTAMP "$TIMESTAMP" \
      --arg CONSTRUCTOR_ARGS "$CONSTRUCTOR_ARGS" \
      '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION] += [{ ADDRESS: $ADDRESS, OPTIMIZER_RUNS: $OPTIMIZER_RUNS, TIMESTAMP: $TIMESTAMP, CONSTRUCTOR_ARGS: $CONSTRUCTOR_ARGS  }]' \
      "$LOG_FILE_PATH" > tmpfile && mv tmpfile "$LOG_FILE_PATH"

  echo "[info] contract deployment info added to log FILE (CONTRACT=$CONTRACT, NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, VERSION=$VERSION)"
}
function checkIfJSONContainsEntry {
  # read function arguments into variables
  CONTRACT=$1
  NETWORK=$2
  ENVIRONMENT=$3
  VERSION=$4
  FILEPATH=$5

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function checkIfJSONContainsEntry"
    echo "[debug] CONTRACT=$CONTRACT"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] VERSION=$VERSION"
    echo "[debug] FILEPATH=$FILEPATH"
  fi

  # Check if the entry already exists
  if jq -e --arg CONTRACT "$CONTRACT" \
         --arg NETWORK "$NETWORK" \
         --arg ENVIRONMENT "$ENVIRONMENT" \
         --arg VERSION "$VERSION" \
         '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION] != null' \
         "$FILEPATH" > /dev/null; then
      return 1
  else
      return 0
  fi
}
function findContractInLogFile() {
  # read function arguments into variables
  CONTRACT="$1"
  NETWORK="$2"
  ENVIRONMENT="$3"
  VERSION="$4"

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function function findContractInLogFile()"
    echo "[debug] CONTRACT=$CONTRACT"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] VERSION=$VERSION"
  fi

  # Check if log FILE exists
  if [ ! -f "$LOG_FILE_PATH" ]; then
    echo "[error] deployments log FILE does not exist in path $LOG_FILE_PATH"
    exit 1
  fi

  # find matching entry
    local TARGET_STATE_FILE=$(cat "$LOG_FILE_PATH")
    local RESULT=$(echo "$TARGET_STATE_FILE" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg VERSION "$VERSION" '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION][0]')

    if [[ "$RESULT" != "null" ]]; then
        # entry found - return TARGET_STATE_FILE and success error code
        echo "${RESULT[@]}"
        return 0
        #INFO:
        # returns the following values if a matching entry was found:
        # - ADDRESS
        # - OPTIMIZER_RUNS
        # - TIMESTAMP
        # - CONSTRUCTOR_ARGS
    else
        # entry not found - issue error message and return error code
        echo "[info] No matching entry found in deployments log FILE for CONTRACT=$CONTRACT, NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, VERSION=$VERSION"
        return 1
    fi
}
function getCurrentContractVersion() {

  # TODO: to be removed once contracts have their versions set
  echo "1.0.1"
  return 0

  # read function arguments into variables
  CONTRACT="$1"

  # get src FILE path for contract
  FILEPATH=$(getContractFilePath "$CONTRACT")
  wait

  # Check if FILE exists
  if [ ! -f "$FILEPATH" ]; then
      echo "[error]: the following filepath is invalid: $FILEPATH"
      return 1
  fi

  # Search for "contract_version::" in the FILE and store the first RESULT in the variable
  VERSION=$(grep "contract_version:" "$FILEPATH" | cut -d ' ' -f 3)

  # Check if VERSION is empty
  if [ -z "$VERSION" ]; then
      echo "[error]: 'contract_version' string not found in $FILEPATH."
      return 1
  fi

  echo "$VERSION"
}
function doesAddressContainBytecode() {
  # read ENVIRONMENT variables
  source .env

  # read function arguments into variables
  NETWORK="$1"
  ADDRESS="$2"

  # get correct node URL for given NETWORK
  NODE_URL_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<$NETWORK)"
  NODE_URL=${!NODE_URL_KEY}

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function doesAddressContainBytecode"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] ADDRESS=$ADDRESS"
  fi

  # check if NODE_URL is available
  if [ -z "$NODE_URL" ]; then
      echo "[error]: no node url found for NETWORK $NETWORK. Please update your .env FILE and make sure it has a value for the following key: $NODE_URL_KEY"
      return 1
  fi

  # get CONTRACT code from ADDRESS using web3
  contract_code=$(node -e "const Web3 = require('web3'); const web3 = new Web3('$NODE_URL'); web3.eth.getCode('$ADDRESS', (error, RESULT) => { console.log(RESULT); });")

  # return ƒalse if ADDRESS does not contain CONTRACT code, otherwise true
  if [[ $contract_code == "0x" ]]; then
    echo "false"
  else
    echo "true"
  fi
}
function checkFailure() {
  # read function arguments into variables
  RESULT=$1
  ERROR_MESSAGE=$2

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function checkFailure"
    echo "[debug] RESULT=$RESULT"
    echo "[debug] ERROR_MESSAGE=$ERROR_MESSAGE"
  fi

  # check RESULT code and display error message if code != 0
  if [[ $RESULT -ne 0 ]]; then
    echo "Failed to $ERROR_MESSAGE"
    exit 1
  fi
}
function getOptimizerRuns() {
  # define FILE path for foundry config FILE
  FILEPATH="foundry.toml"

  # Check if FILE exists
  if [ ! -f "$FILEPATH" ]; then
      echo "[error]: $FILEPATH does not exist."
      return 1
  fi

  # Search for "optimizer_runs =" in the FILE and store the first RESULT in the variable
  VERSION=$(grep "optimizer_runs =" $FILEPATH | cut -d ' ' -f 3)

  # Check if VERSION is empty
  if [ -z "$VERSION" ]; then
      echo "[error]: optimizer_runs string not found in $FILEPATH."
      return 1
  fi

  # return OPTIMIZER_RUNS value
  echo "$VERSION"

}
function saveContract() {
  # load env variables
  source .env

  # read function arguments into variables
  NETWORK=$1
  CONTRACT=$2
  ADDRESS=$3
  FILE_SUFFIX=$4

  # load JSON FILE that contains deployment addresses
  # TODO: use log FILE instead???
  ADDRESSES_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function saveContract"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] CONTRACT=$CONTRACT"
    echo "[debug] ADDRESS=$ADDRESS"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
    echo "[debug] ADDRESSES_FILE=$ADDRESSES_FILE"
  fi

  # create an empty json if it does not exist
  if [[ ! -e $ADDRESSES_FILE ]]; then
    echo "{}" >"$ADDRESSES_FILE"
  fi

  # add new address to address log FILE
  RESULT=$(cat "$ADDRESSES_FILE" | jq -r ". + {\"$CONTRACT\": \"$ADDRESS\"}" || cat "$ADDRESSES_FILE")
  printf %s "$RESULT" >"$ADDRESSES_FILE"
}
function verifyContract() {
  # TODO: only execute for selected NETWORKs
  # load env variables
  source .env

  # read function arguments into variables
  NETWORK=$1
  CONTRACT=$2
  ADDRESS=$3
  ARGS=$4

  # get API key for blockchain explorer
  API_KEY="$(tr '[:lower:]' '[:upper:]' <<<$NETWORK)_ETHERSCAN_API_KEY"

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function verifyContract"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] CONTRACT=$CONTRACT"
    echo "[debug] ADDRESS=$ADDRESS"
    echo "[debug] ARGS=$ARGS"
    echo "[debug] blockexplorer API_KEY=${API_KEY}"
    echo "[debug] blockexplorer API_KEY value=${!API_KEY}"
  fi

  # verify contract using forge
  MAX_RETRIES=$MAX_ATTEMPTS_PER_CONTRACT_VERIFICATION
  RETRY_COUNT=0
  COMMAND_STATUS=1

  while [ $COMMAND_STATUS -ne 0 -a $RETRY_COUNT -lt $MAX_RETRIES ]
  do
    if [ "$ARGS" = "0x" ]; then
      forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT -e "${!API_KEY}"
    else
      forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT --constructor-args $ARGS -e "${!API_KEY}"
    fi
    COMMAND_STATUS=$?
    RETRY_COUNT=$((RETRY_COUNT+1))
  done

  # check the return status of the contract verification call
  if [ $COMMAND_STATUS -ne 0 ]
  then
      echo "[warning] contract $CONTRACT in network $NETWORK could not be verified"
  else
      echo "[info] contract $CONTRACT in network $NETWORK successful verified"
  fi

  # return command status 0 (to make sure failed verification does not stop script)
  return 0
}
function getContractFilePath() {
  # read function arguments into variables
  CONTRACT="$1"

  # define directory to be searched
  local dir=$CONTRACT_DIRECTORY
  local FILENAME="$CONTRACT.sol"

  # find FILE path
  local file_path=$(find "${dir%/}" -name $FILENAME -print)

  # return FILE path or throw error if FILE path does not have a value
  if [ -n "$file_path" ]; then
      echo "$file_path"
  else
      echo "[error] could not find src FILE path for contract $CONTRACT"
      exit 1
  fi
}
function getIncludedNetworksArray() {
  # prepare required variables
  local FILE="$NETWORKS_FILE_PATH"
  local ARRAY=()

  # extract list of excluded networks from config
  local EXCLUDED_NETWORKS_REGEXP="^($(echo "$EXCLUDE_NETWORKS" | tr ',' '|'))$"

  # loop through networks list and add each network to ARRAY that is not excluded
  while IFS= read -r line; do
    if ! [[ "$line" =~ $EXCLUDED_NETWORKS_REGEXP ]]; then
      ARRAY+=("$line")
    fi
  done < "$FILE"

  # return ARRAY
  printf '%s\n' "${ARRAY[@]}"
}
function getFileSuffix() {
    # read function arguments into variables
    ENVIRONMENT="$1"

    # check if env variable "PRODUCTION" is true, otherwise deploy as staging
    if [[ "$ENVIRONMENT" == "production" ]]; then
      echo ""
    else
      echo "staging."
    fi
}
function getContractNamesInFolder() {
  # read function arguments into variables
  local FILEPATH=$1

  # Check if the path exists and is a directory
  if [ -d "$FILEPATH" ]; then
      # Create an empty ARRAY to store the FILE names
      local CONTRACTS=()

      # Loop through all the .sol files in the directory
      for FILE in "$FILEPATH"/*.sol; do
          # Extract the FILE name without the extension
          local name="$(basename "${FILE%.*}")"

          # Add the name to the ARRAY
          CONTRACTS+=("$name")
      done

      # Return the ARRAY
      echo "${CONTRACTS[@]}"
  else
      # Print an error message if the path is invalid
      echo "[error] the following path is not a valid directory: $FILEPATH"
  fi
  }
function getIncludedPeripheryContractsArray() {
  # prepare required variables
  local DIRECTORY_PATH="$CONTRACT_DIRECTORY""Periphery/"
  local ARRAY=()

  # extract list of excluded periphery contracts from config
  local EXCLUDE_CONTRACTS_REGEX="^($(echo "$EXCLUDE_PERIPHERY_CONTRACTS" | tr ',' '|'))$"

  # loop through contract names and add each name to ARRAY that is not excluded
  for CONTRACT in $(getContractNamesInFolder "$DIRECTORY_PATH"); do
    if ! [[ "$CONTRACT" =~ $EXCLUDE_CONTRACTS_REGEX ]]; then
      ARRAY+=("$CONTRACT")
    fi
  done

  # return ARRAY
  echo "${ARRAY[@]}"
}
function getIncludedFacetContractsArray() {
  # prepare required variables
  local DIRECTORY_PATH="$CONTRACT_DIRECTORY""Facets/"
  local ARRAY=()

  # extract list of excluded periphery contracts from config
  local EXCLUDE_CONTRACTS_REGEX="^($(echo "$EXCLUDE_FACET_CONTRACTS" | tr ',' '|'))$"

  # loop through contract names and add each name to ARRAY that is not excluded
  for CONTRACT in $(getContractNamesInFolder "$DIRECTORY_PATH"); do
    if ! [[ "$CONTRACT" =~ $EXCLUDE_CONTRACTS_REGEX ]]; then
      ARRAY+=("$CONTRACT")
    fi
  done

  # return ARRAY
  echo "${ARRAY[@]}"
}
function findContractVersionInTargetState() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  CONTRACT="$3"

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function findContractInTargetState()"
    echo "[debug] CONTRACT=$CONTRACT"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
  fi

  # Check if target state FILE exists
  if [ ! -f "$TARGET_STATE_PATH" ]; then
    echo "[error] target state FILE does not exist in path $TARGET_STATE_PATH"
    exit 1
  fi

  # find matching entry
    local TARGET_STATE_FILE=$(cat "$TARGET_STATE_PATH")
    local RESULT=$(echo "$TARGET_STATE_FILE" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg VERSION "$VERSION" '.[$NETWORK][$ENVIRONMENT][$CONTRACT]')

    if [[ "$RESULT" != "null" ]]; then
        # entry found
        # remove leading and trailing "
        RESULT_ADJUSTED=$(echo "$RESULT" | sed 's/"//g')

        # return TARGET_STATE_FILE and success error code
        echo "${RESULT_ADJUSTED}"
        return 0
    else
        # entry not found - issue error message and return error code
        echo "[info] No matching entry found in target state FILE for NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, CONTRACT=$CONTRACT"
        return 1
    fi
}
# WIP






# test cases for helper functions
function test__log_contract_info() {

  logContractDeploymentInfo "ContractName" "BSC" "<TIMESTAMP>" "1.0.0" "10000" "<args>" "staging" "0x1234"
  logContractDeploymentInfo "ContractName" "BSC" "<TIMESTAMP>" "1.0.1" "10000" "<args>" "staging" "0x4321"

  logContractDeploymentInfo "ContractName" "ETH" "<TIMESTAMP>" "1.0.0" "10000" "<args>" "staging" "0x1234"
  logContractDeploymentInfo "ContractName" "ETH" "<TIMESTAMP>" "1.0.1" "10000" "<args>" "staging" "0x4321"

  logContractDeploymentInfo "ContractName" "BSC" "<TIMESTAMP>" "1.0.0" "10000" "<args>" "production" "0x5555"
  logContractDeploymentInfo "ContractName" "BSC" "<TIMESTAMP>" "1.0.1" "10000" "<args>" "production" "0x6666"

  logContractDeploymentInfo "ContractName" "ETH" "<TIMESTAMP>" "1.0.0" "10000" "<args>" "production" "0x5555"
  logContractDeploymentInfo "ContractName" "ETH" "<TIMESTAMP>" "1.0.1" "10000" "<args>" "production" "0x6666"

  logContractDeploymentInfo "ContractName2" "BSC" "<TIMESTAMP>" "1.0.0" "10000" "<args>" "staging" "0x1234"
  logContractDeploymentInfo "ContractName2" "BSC" "<TIMESTAMP>" "1.0.1" "10000" "<args>" "staging" "0x4321"

  logContractDeploymentInfo "ContractName2" "ETH" "<TIMESTAMP>" "1.0.0" "10000" "<args>" "staging" "0x1234"
  logContractDeploymentInfo "ContractName2" "ETH" "<TIMESTAMP>" "1.0.1" "10000" "<args>" "staging" "0x4321"

}
function test_checkIfJSONContainsEntry() {
  checkIfJSONContainsEntry "ContractName" "BSC" "staging" "1.0.0"
  echo "should be 1: $?"

  checkIfJSONContainsEntry "ContractName" "BSC" "staging" "1.0.1"
  echo "should be 1: $?"

  checkIfJSONContainsEntry "ContractName" "ETH" "staging" "1.0.0"
  echo "should be 1: $?"

  checkIfJSONContainsEntry "ContractName" "ETH" "staging" "1.0.1"
  echo "should be 1: $?"

  checkIfJSONContainsEntry "ContractName2" "ETH" "staging" "1.0.1"
  echo "should be 1: $?"

  checkIfJSONContainsEntry "ContractName3" "ETH" "staging" "1.0.1"
  echo "should be 0: $?"

  checkIfJSONContainsEntry "ContractName" "POL" "staging" "1.0.1"
  echo "should be 0: $?"

  checkIfJSONContainsEntry "ContractName" "ETH" "production" "1.0.1"
  echo "should be 0: $?"

  checkIfJSONContainsEntry "ContractName" "ETH" "staging" "1.0.2"
  echo "should be 0: $?"





}
function test_findContractInLogFile() {
  findContractInLogFile "ContractName" "BSC" "staging" "1.0.0"
  match=($(findContractInLogFile "ContractName" "BSC" "staging" "1.0.0"))

  echo "Address: ${match[2]}"
  echo "Optimizer Runs: ${match[4]}"
  echo "Date: ${match[6]}"
  echo "Constructor Arguments: ${match[8]}"
}
function test_getCurrentContractVersion() {

  echo "should return error - VERSION string not found:"
  getCurrentContractVersion "src/Facets/AccessManagerFacet.sol"

  echo ""
  echo "should return error - FILE not found:"
  getCurrentContractVersion "src/Facets/nofile.sol"

  echo ""
  echo "should return '1.0.0':"
  getCurrentContractVersion "src/Facets/testfile.sol"



}
function test_doesAddressContainBytecode() {
  echo "should return true: $(doesAddressContainBytecode "BSC" "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae")"
  echo "should return false: $(doesAddressContainBytecode "BSC" "0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0")"
  echo "should return error message: $(doesAddressContainBytecode "NoNet" "0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0")"
}
function test_getOptimizerRuns() {
  echo "should return 1000000: $(getOptimizerRuns)"
}
function test_getContractFilePath() {
  echo "should return src/Periphery/Receiver.sol: $(getContractFilePath "Receiver")"
  echo "should return src/Facets/MultichainFacet.sol: $(getContractFilePath "MultichainFacet")"
  echo "should return src/LiFiDiamond.sol: $(getContractFilePath "LiFiDiamond")"
  echo "should throw error: $(getContractFilePath "noContract")"
}
function test_getIncludedNetworksArray() {
  NETWORKS=($(getIncludedNetworksArray))

  # print number of networks
  echo "should return 20: ${#NETWORKS[@]}"

  # print each network value
  for ((i=0; i<${#NETWORKS[@]}; i++)); do
    echo "networks[$i]: ${NETWORKS[$i]}"
  done

}
function test_getFileSuffix() {
  echo "should return '.staging': $(getFileSuffix "staging")"
  echo "should return '.staging': $(getFileSuffix "anyValue")"
  echo "should return '': $(getFileSuffix "production")"
}
function test_getContractNamesInFolder() {
  echo "should an ARRAY with all periphery contracts: $(getContractNamesInFolder "src/Periphery/")"
  echo "should an ARRAY with all facet contracts: $(getContractNamesInFolder "src/Facets/")"
}
function test_getIncludedPeripheryContractsArray() {
  echo "should return an ARRAY with all included periphery contracts: $(getIncludedPeripheryContractsArray)"
}
function test_getIncludedFacetContractsArray() {
  echo "should return an ARRAY with all included facet contracts: $(getIncludedFacetContractsArray)"
}
function test_findContractVersionInTargetState() {
  echo "should return '1.0.0: $(findContractVersionInTargetState "goerli" "production" "Executor")"
  echo "should return '1.0.1: $(findContractVersionInTargetState "goerli" "production" "Receiver")"
  echo "should return '1.0.0: $(findContractVersionInTargetState "goerli" "staging" "FeeCollector")"
  echo "should return '1.0.1: $(findContractVersionInTargetState "goerli" "staging" "RelayerCelerIM")"
}
