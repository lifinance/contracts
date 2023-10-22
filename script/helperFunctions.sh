#!/bin/bash

# load env variables
source .env

# load script
source script/config.sh

ZERO_ADDRESS=0x0000000000000000000000000000000000000000
RED='\033[0;31m'   # Red color
GREEN='\033[0;32m' # Green color
GRAY='\033[0;37m'  # Light gray color
BLUE='\033[1;34m'  # Light blue color

NC='\033[0m' # No color

# >>>>> logging
function logContractDeploymentInfo_BACKUP {
  # read function arguments into variables
  local CONTRACT="$1"
  local NETWORK="$2"
  local TIMESTAMP="$3"
  local VERSION="$4"
  local OPTIMIZER_RUNS="$5"
  local CONSTRUCTOR_ARGS="$6"
  local ENVIRONMENT="$7"
  local ADDRESS="$8"
  local VERIFIED=$9

  if [[ "$ADDRESS" == "null" || -z "$ADDRESS" ]]; then
    error "trying to log an invalid address value (=$ADDRESS) for $CONTRACT on network $NETWORK (environment=$ENVIRONMENT). Please check and manually update the log with the correct address. "
  fi

  # logging for debug purposes
  echo ""
  echoDebug "in function logContractDeploymentInfo"
  echoDebug "CONTRACT=$CONTRACT"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "TIMESTAMP=$TIMESTAMP"
  echoDebug "VERSION=$VERSION"
  echoDebug "OPTIMIZER_RUNS=$OPTIMIZER_RUNS"
  echoDebug "CONSTRUCTOR_ARGS=$CONSTRUCTOR_ARGS"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "ADDRESS=$ADDRESS"
  echoDebug "VERIFIED=$VERIFIED"
  echo ""

  # Check if log FILE exists, if not create it
  if [ ! -f "$LOG_FILE_PATH" ]; then
    echo "{}" >"$LOG_FILE_PATH"
  fi

  # Check if log FILE already contains entry with same CONTRACT, NETWORK, ENVIRONMENT and VERSION
  checkIfJSONContainsEntry $CONTRACT $NETWORK $ENVIRONMENT $VERSION $LOG_FILE_PATH
  if [ $? -eq 1 ]; then
    echo "[warning]: deployment log file contained already an entry for (CONTRACT=$CONTRACT, NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, VERSION=$VERSION). This is unexpected behaviour since an existing CONTRACT should not have been re-deployed. A new entry was added to the log file. "
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
    --arg VERIFIED "$VERIFIED" \
    '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION] += [{ ADDRESS: $ADDRESS, OPTIMIZER_RUNS: $OPTIMIZER_RUNS, TIMESTAMP: $TIMESTAMP, CONSTRUCTOR_ARGS: $CONSTRUCTOR_ARGS, VERIFIED: $VERIFIED  }]' \
    "$LOG_FILE_PATH" >tmpfile && mv tmpfile "$LOG_FILE_PATH"

  echoDebug "contract deployment info added to log FILE (CONTRACT=$CONTRACT, NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, VERSION=$VERSION)"
} # will add, if entry exists already
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
  local VERIFIED="$9"
  local SALT="${10}"

  if [[ "$ADDRESS" == "null" || -z "$ADDRESS" ]]; then
    error "trying to log an invalid address value (=$ADDRESS) for $CONTRACT on network $NETWORK (environment=$ENVIRONMENT) to master log file. Log will not be updated. Please check and run this script again to secure deploy log data."
    return 1
  fi

  # logging for debug purposes
  echo ""
  echoDebug "in function logContractDeploymentInfo"
  echoDebug "CONTRACT=$CONTRACT"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "TIMESTAMP=$TIMESTAMP"
  echoDebug "VERSION=$VERSION"
  echoDebug "OPTIMIZER_RUNS=$OPTIMIZER_RUNS"
  echoDebug "CONSTRUCTOR_ARGS=$CONSTRUCTOR_ARGS"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "ADDRESS=$ADDRESS"
  echoDebug "VERIFIED=$VERIFIED"
  echoDebug "SALT=$SALT"
  echo ""

  # Check if log FILE exists, if not create it
  if [ ! -f "$LOG_FILE_PATH" ]; then
    echo "{}" >"$LOG_FILE_PATH"
  fi

  # Check if entry already exists in log FILE
  local existing_entry=$(jq --arg CONTRACT "$CONTRACT" \
    --arg NETWORK "$NETWORK" \
    --arg ENVIRONMENT "$ENVIRONMENT" \
    --arg VERSION "$VERSION" \
    '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION]' \
    "$LOG_FILE_PATH")

  # Update existing entry or add new entry to log FILE
  if [[ "$existing_entry" == "null" ]]; then
    jq --arg CONTRACT "$CONTRACT" \
      --arg NETWORK "$NETWORK" \
      --arg ENVIRONMENT "$ENVIRONMENT" \
      --arg VERSION "$VERSION" \
      --arg ADDRESS "$ADDRESS" \
      --arg OPTIMIZER_RUNS "$OPTIMIZER_RUNS" \
      --arg TIMESTAMP "$TIMESTAMP" \
      --arg CONSTRUCTOR_ARGS "$CONSTRUCTOR_ARGS" \
      --arg VERIFIED "$VERIFIED" \
      --arg SALT "$SALT" \
      '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION] += [{ ADDRESS: $ADDRESS, OPTIMIZER_RUNS: $OPTIMIZER_RUNS, TIMESTAMP: $TIMESTAMP, CONSTRUCTOR_ARGS: $CONSTRUCTOR_ARGS, SALT: $SALT, VERIFIED: $VERIFIED }]' \
      "$LOG_FILE_PATH" >tmpfile && mv tmpfile "$LOG_FILE_PATH"
  else
    jq --arg CONTRACT "$CONTRACT" \
      --arg NETWORK "$NETWORK" \
      --arg ENVIRONMENT "$ENVIRONMENT" \
      --arg VERSION "$VERSION" \
      --arg ADDRESS "$ADDRESS" \
      --arg OPTIMIZER_RUNS "$OPTIMIZER_RUNS" \
      --arg TIMESTAMP "$TIMESTAMP" \
      --arg CONSTRUCTOR_ARGS "$CONSTRUCTOR_ARGS" \
      --arg VERIFIED "$VERIFIED" \
      --arg SALT "$SALT" \
      '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION][-1] |= { ADDRESS: $ADDRESS, OPTIMIZER_RUNS: $OPTIMIZER_RUNS, TIMESTAMP: $TIMESTAMP, CONSTRUCTOR_ARGS: $CONSTRUCTOR_ARGS, SALT: $SALT, VERIFIED: $VERIFIED }' \
      "$LOG_FILE_PATH" >tmpfile && mv tmpfile "$LOG_FILE_PATH"
  fi

  echoDebug "contract deployment info added to log FILE (CONTRACT=$CONTRACT, NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, VERSION=$VERSION)"
} # will replace, if entry exists already
function getBytecodeFromLog() {

  # read function arguments into variables
  local CONTRACT="$1"
  local VERSION="$2"

  # read bytecode from storage file
  local RESULT=$(jq -r --arg CONTRACT "$CONTRACT" --arg VERSION "$VERSION" '.[$CONTRACT][$VERSION]' "$BYTECODE_STORAGE_PATH")

  # return result
  echo "$RESULT"
}
function logBytecode {
  # read function arguments into variables
  local CONTRACT="$1"
  local VERSION="$2"
  local BYTECODE="$3"

  # logging for debug purposes
  echo ""
  echoDebug "in function logBytecode"
  echoDebug "CONTRACT=$CONTRACT"
  echoDebug "VERSION=$VERSION"
  echo ""

  # Check if log FILE exists, if not create it
  if [ ! -f "$BYTECODE_STORAGE_PATH" ]; then
    echo "{}" >"$BYTECODE_STORAGE_PATH"
  fi

  # get bytecode from log
  local LOG_RESULT=$(getBytecodeFromLog "$CONTRACT" "$VERSION")

  # find matching entry in log
  if [ "$LOG_RESULT" == "null" ]; then
    # no match found - add entry
    # read file into variable
    JSON=$(cat "$BYTECODE_STORAGE_PATH")

    # Use jq to add a new entry to the JSON data
    JSON=$(echo "$JSON" | jq --arg CONTRACT "$CONTRACT" --arg VERSION "$VERSION" --arg BYTECODE "$BYTECODE" '.[$CONTRACT][$VERSION] = $BYTECODE')

    # Write the modified JSON data back to the file
    echo "$JSON" >"$BYTECODE_STORAGE_PATH"

    # if DEBUG
    echoDebug "bytecode added to storage file (CONTRACT=$CONTRACT, VERSION=$VERSION)"
  else
    # match found - check if bytecode matches
    if [ "$BYTECODE" != "$LOG_RESULT" ]; then
      warning "existing bytecode in log differs from bytecode produced by this run. Please check why this happens (e.g. code changed without version bump). Bytecode storage not updated."
      return 1
    else
      echoDebug "bytecode already exists in log, no action needed"
      return 0
    fi
  fi

  # Append new JSON object to log FILE
  JSON=$(echo "$JSON" | jq --arg contract_name "$CONTRACT_NAME" --arg version "$VERSION" --arg value "$VALUE" '.[$contract_name][$version] = $value')

}
function checkIfJSONContainsEntry {
  # read function arguments into variables
  CONTRACT=$1
  NETWORK=$2
  ENVIRONMENT=$3
  VERSION=$4
  FILEPATH=$5

  # Check if the entry already exists
  if jq -e --arg CONTRACT "$CONTRACT" \
    --arg NETWORK "$NETWORK" \
    --arg ENVIRONMENT "$ENVIRONMENT" \
    --arg VERSION "$VERSION" \
    '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION] != null' \
    "$FILEPATH" >/dev/null; then
    return 1
  else
    return 0
  fi
}
function findContractInMasterLog() {
  # read function arguments into variables
  local CONTRACT="$1"
  local NETWORK="$2"
  local ENVIRONMENT="$3"
  local VERSION="$4"

  local FOUND=false

  # Check if log file exists
  if [ ! -f "$LOG_FILE_PATH" ]; then
    echo "deployments log file does not exist in path $LOG_FILE_PATH. Please check and run the script again."
    exit 1
  fi

  # Process JSON data incrementally using jq
  entries=$(jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg VERSION "$VERSION" '
    . as $data |
    keys[] as $contract |
    $data[$contract] |
    keys[] as $network |
    $data[$contract][$network] |
    keys[] as $environment |
    $data[$contract][$network][$environment] |
    keys[] as $version |
    select($contract == $CONTRACT and $network == $NETWORK and $environment == $ENVIRONMENT and $version == $VERSION) |
    $data[$contract][$network][$environment][$version][0]
  ' "$LOG_FILE_PATH")

  # Loop through the entries
  while IFS= read -r entry; do
    if [[ -n "$entry" ]]; then # If entry is not empty
      FOUND=true
      echo "$entry"
    fi
  done <<<"$entries"

  if ! $FOUND; then
    echo "[info] No matching entry found in deployments log file for CONTRACT=$CONTRACT, NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, VERSION=$VERSION"
    exit 1
  fi

  exit 0
}
function findContractInMasterLogByAddress() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  TARGET_ADDRESS="$3"

  # Check if log file exists
  if [ ! -f "$LOG_FILE_PATH" ]; then
    error "deployments log file does not exist in path $LOG_FILE_PATH. Please check and run script again."
    exit 1
  fi

  # Read top-level keys into an array
  CONTRACTS=($(jq -r 'keys[]' "$LOG_FILE_PATH"))

  # Loop through the array of top-level keys
  for CONTRACT in "${CONTRACTS[@]}"; do

    # Read VERSION keys for the network
    VERSIONS=($(jq -r "if .${CONTRACT}.\"${NETWORK}\".${ENVIRONMENT} | type == \"object\" then .${CONTRACT}.\"${NETWORK}\".${ENVIRONMENT} | keys[] else empty end" "$LOG_FILE_PATH"))

    # go through all versions
    for VERSION in "${VERSIONS[@]}"; do

      # get values of current entry
      ENTRY=$(cat "$LOG_FILE_PATH" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg VERSION "$VERSION" '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION][0]')

      # extract necessary information from log
      ADDRESS=$(echo "$ENTRY" | awk -F'"' '/"ADDRESS":/{print $4}')

      # check if address matches with target address
      if [[ "$(echo $ADDRESS | tr '[:upper:]' '[:lower:]')" == "$(echo $TARGET_ADDRESS | tr '[:upper:]' '[:lower:]')" ]]; then
        JSON_ENTRY="{\"$ADDRESS\": {\"Name\": \"$CONTRACT\", \"Version\": \"$VERSION\"}}"
        echo "$JSON_ENTRY"
        exit 0
      fi
    done
  done

  echo "[info] address not found"
  exit 1
}
function getContractVersionFromMasterLog() {
  # read function arguments into variables
  local NETWORK=$1
  local ENVIRONMENT=$2
  local CONTRACT=$3
  local TARGET_ADDRESS=$4

  # special handling for CelerIMFacet
  if [[ "$CONTRACT" == *"CelerIMFacet"* ]]; then
    CONTRACT="CelerIMFacet"
  fi

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # check if the CONTRACT, NETWORK, and ENVIRONMENT keys exist in the JSON file
  EXISTS=$(cat "$LOG_FILE_PATH" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" '(.[$CONTRACT][$NETWORK][$ENVIRONMENT] // empty) != null')

  if [[ "$EXISTS" == "true" ]]; then
    # get all versions
    VERSIONS=($(jq -r ".${CONTRACT}.${NETWORK}.${ENVIRONMENT} | keys[]" "$LOG_FILE_PATH"))

    # loop through all versions
    for VERSION in "${VERSIONS[@]}"; do
      # read current entry
      ENTRY=$(cat "$LOG_FILE_PATH" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg VERSION "$VERSION" '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION][0]')

      # extract address
      ADDRESS=$(echo "$ENTRY" | awk -F'"' '/"ADDRESS":/{print $4}')

      # check if address matches
      if [[ "$(echo $ADDRESS | tr '[:upper:]' '[:lower:]')" == "$(echo $TARGET_ADDRESS | tr '[:upper:]' '[:lower:]')" ]]; then
        # return version
        echo "$VERSION"
        return 0
      fi
    done
  fi

  # no matching entry found
  return 1

}
function getHighestDeployedContractVersionFromMasterLog() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  CONTRACT=$3

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # check if the CONTRACT, NETWORK, and ENVIRONMENT keys exist in the JSON file
  EXISTS=$(cat "$LOG_FILE_PATH" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" '(.[$CONTRACT][$NETWORK][$ENVIRONMENT] // empty) != null')

  if [[ "$EXISTS" == "true" ]]; then
    # get all versions
    VERSIONS=($(jq -r ".${CONTRACT}.\"${NETWORK}\".${ENVIRONMENT} | keys[]" "$LOG_FILE_PATH"))

    # Initialize the highest version variable
    HIGHEST_VERSION="0.0.0"

    # Iterate over each version in the array
    for VERSION in "${VERSIONS[@]}"; do
      # Compare the current version with the highest version found so far
      if [[ "$VERSION" > "$HIGHEST_VERSION" ]]; then
        HIGHEST_VERSION="$VERSION"
      fi
    done

    # return the highest version
    if [[ "$HIGHEST_VERSION" != "0.0.0" ]]; then
      echo "$HIGHEST_VERSION"
      return 0
    fi
  fi

  # no matching entry found
  return 1

}
# <<<<< logging

# >>>>> reading and manipulation of deployment log files
function getContractNameFromDeploymentLogs() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  TARGET_ADDRESS=$3

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # load JSON FILE that contains deployment addresses
  ADDRESSES_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  if ! checkIfFileExists "$ADDRESSES_FILE" >/dev/null; then
    return 1
  fi

  # read all keys (i.e. names)
  FACET_NAMES=($(cat $ADDRESSES_FILE | jq -r 'keys[]'))

  # loop through all names
  for FACET in "${FACET_NAMES[@]}"; do
    # extract address
    ADDRESS=$(jq -r ".${FACET}" "$ADDRESSES_FILE")

    # check if address matches
    if [[ "$(echo $ADDRESS | tr '[:upper:]' '[:lower:]')" == "$(echo $TARGET_ADDRESS | tr '[:upper:]' '[:lower:]')" ]]; then
      echo "$FACET"
      return 0
    fi
  done

  return 1
}
function getContractAddressFromDeploymentLogs() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  CONTRACT=$3

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # load JSON FILE that contains deployment addresses
  ADDRESSES_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  if ! checkIfFileExists "$ADDRESSES_FILE" >/dev/null; then
    return 1
  fi

  # read address
  CONTRACT_ADDRESS=$(jq -r --arg CONTRACT "$CONTRACT" '.[$CONTRACT] // "0x"' "$ADDRESSES_FILE")

  if [[ "$CONTRACT_ADDRESS" == "0x" || "$CONTRACT_ADDRESS" == "" || "$CONTRACT_ADDRESS" == " " || -z "$CONTRACT_ADDRESS" ]]; then
    # address not found
    return 1
  else
    # address found
    echo "$CONTRACT_ADDRESS"
    return 0
  fi
}
function getContractInfoFromDiamondDeploymentLogByName() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  DIAMOND_TYPE=$3
  CONTRACT=$4

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # load JSON FILE that contains deployment addresses
  if [[ "$DIAMOND_TYPE" == "LiFiDiamond" ]]; then
    ADDRESSES_FILE="./deployments/${NETWORK//-/}.diamond.${FILE_SUFFIX}json"
  else
    ADDRESSES_FILE="./deployments/${NETWORK//-/}.diamond.immutable.${FILE_SUFFIX}json"
  fi

  # make sure file exists
  FILE_EXISTS=$(checkIfFileExists "$ADDRESSES_FILE")

  if [[ "$FILE_EXISTS" != "true" ]]; then
    error "attempted to access the following file that does not exist: $ADDRESSES_FILE"
    return 1
  fi

  # handling for facet contracts
  if [[ "$CONTRACT" == *"Facet"* ]]; then
    # Read top-level keys into an array
    FACET_ADDRESSES=($(jq -r ".${DIAMOND_TYPE}.Facets | keys[]" "$ADDRESSES_FILE"))

    # Loop through the array of top-level keys
    for FACET_ADDRESS in "${FACET_ADDRESSES[@]}"; do

      # Read name from log file
      CONTRACT_NAME=$(jq -r ".${DIAMOND_TYPE}.Facets.\"${FACET_ADDRESS}\".Name" "$ADDRESSES_FILE")

      if [[ "$CONTRACT_NAME" == "$CONTRACT" ]]; then
        # Read version from log file
        VERSION=$(jq -r ".${DIAMOND_TYPE}.Facets.\"${FACET_ADDRESS}\".Version" "$ADDRESSES_FILE")

        # create JSON entry from information
        JSON_ENTRY="{\"$FACET_ADDRESS\": {\"Name\": \"$CONTRACT_NAME\", \"Version\": \"$VERSION\"}}"

        # return JSON entry
        echo "$JSON_ENTRY"
        return 0
      fi
    done
  elif [[ "$CONTRACT" == *"LiFiDiamond"* ]]; then
    # handling for diamond contracts
    # get current version of diamond
    VERSION=$(getCurrentContractVersion "$CONTRACT")

    # try to find diamond address in master log file
    RESULT=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION")

    # check if contract info was found in log file
    if [[ $? -eq 0 ]]; then
      # extract address
      ADDRESS=$(echo "$RESULT" | jq -r ".ADDRESS ")

      # create JSON entry to match the return format for other contract types
      RESULT="{\"$ADDRESS\": {\"Name\": \"$CONTRACT\", \"Version\": \"$VERSION\"}}"

      echo "$RESULT"
      return 0
    fi
  else
    # handling for periphery contracts

    # Read top-level keys into an array
    PERIPHERY_CONTRACTS=($(jq -r ".${DIAMOND_TYPE}.Periphery | keys[]" "$ADDRESSES_FILE"))

    # Loop through the array of top-level keys
    for PERIPHERY_CONTRACT in "${PERIPHERY_CONTRACTS[@]}"; do

      # skip if contract name doesnt match with the one we are looking for
      if [[ "$PERIPHERY_CONTRACT" != "$CONTRACT" ]]; then
        continue
      fi

      # Read address from log file
      ADDRESS=$(jq -r ".${DIAMOND_TYPE}.Periphery.${CONTRACT}" "$ADDRESSES_FILE")

      # check if we can find the version of that contract/address in the deploy log
      RESULT=$(findContractInMasterLogByAddress "$NETWORK" "$ENVIRONMENT" "$ADDRESS")

      if [[ $? -ne 0 ]]; then
        return 1
      else
        echo "$RESULT"
        return 0
      fi
    done
  fi

  error "could not find contract info"
  return 1
}
function saveDiamond_DEPRECATED() {
  :'
  This contract version only saves the facet addresses as an array in the JSON file
  without any further information (such as version or name, like in the new function)
  '
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  USE_MUTABLE_DIAMOND=$3
  FACETS=$4

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # store function arguments in variables
  FACETS=$(echo $4 | tr -d '[' | tr -d ']' | tr -d ',')
  FACETS=$(printf '"%s",' $FACETS | sed 's/,*$//')

  # define path for json file based on which diamond was used
  if [[ "$USE_MUTABLE_DIAMOND" == "true" ]]; then
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.${FILE_SUFFIX}json"
  else
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.immutable.${FILE_SUFFIX}json"
  fi

  # create an empty json if it does not exist
  if [[ ! -e $DIAMOND_FILE ]]; then
    echo "{}" >"$DIAMOND_FILE"
  fi
  result=$(cat "$DIAMOND_FILE" | jq -r ". + {\"facets\": [$FACETS] }" || cat "$DIAMOND_FILE")
  printf %s "$result" >"$DIAMOND_FILE"
}
function saveDiamondFacets() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  USE_MUTABLE_DIAMOND=$3
  FACETS=$4

  # logging for debug purposes
  echo ""
  echoDebug "in function saveDiamondFacets"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND"
  echoDebug "FACETS=$FACETS"

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # store function arguments in variables
  FACETS=$(echo $4 | tr -d '[' | tr -d ']' | tr -d ',')
  FACETS=$(printf '"%s",' $FACETS | sed 's/,*$//')

  # define path for json file based on which diamond was used
  if [[ "$USE_MUTABLE_DIAMOND" == "true" ]]; then
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.${FILE_SUFFIX}json"
    DIAMOND_NAME="LiFiDiamond"
  else
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.immutable.${FILE_SUFFIX}json"
    DIAMOND_NAME="LiFiDiamondImmutable"
  fi

  # create an empty json that replaces the existing file
  echo "{}" >"$DIAMOND_FILE"

  # create an iterable FACETS array
  # Remove brackets from FACETS string
  FACETS_ADJ="${4#\[}"
  FACETS_ADJ="${FACETS_ADJ%\]}"
  # Split string into array
  IFS=', ' read -ra FACET_ADDRESSES <<<"$FACETS_ADJ"

  # loop through all facets
  for FACET_ADDRESS in "${FACET_ADDRESSES[@]}"; do
    # get a JSON entry from log file
    JSON_ENTRY=$(findContractInMasterLogByAddress "$NETWORK" "$ENVIRONMENT" "$FACET_ADDRESS")

    # check if contract was found in log file
    if [[ $? -ne 0 ]]; then
      warning "could not find any information about this facet address ($FACET_ADDRESS) in master log file while creating $DIAMOND_FILE (ENVIRONMENT=$ENVIRONMENT), "

      # try to find name of contract from network-specific deployments file
      # load JSON FILE that contains deployment addresses
      NAME=$(getContractNameFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$FACET_ADDRESS")

      # create JSON entry manually with limited information (address only)
      JSON_ENTRY="{\"$FACET_ADDRESS\": {\"Name\": \"$NAME\", \"Version\": \"\"}}"
    fi

    # add new entry to JSON file
    result=$(cat "$DIAMOND_FILE" | jq -r --argjson json_entry "$JSON_ENTRY" '.[$diamond_name] |= . + {Facets: (.Facets + $json_entry)}' --arg diamond_name "$DIAMOND_NAME" || cat "$DIAMOND_FILE")

    printf %s "$result" >"$DIAMOND_FILE"
  done

  # add information about registered periphery contracts
  saveDiamondPeriphery "$NETWORK" "$ENVIRONMENT" "$USE_MUTABLE_DIAMOND"
}
function saveDiamondPeriphery_MULTICALL_NOT_IN_USE() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  USE_MUTABLE_DIAMOND=$3

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # define path for json file based on which diamond was used
  if [[ "$USE_MUTABLE_DIAMOND" == "true" ]]; then
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.${FILE_SUFFIX}json"
    DIAMOND_NAME="LiFiDiamond"
  else
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.immutable.${FILE_SUFFIX}json"
    DIAMOND_NAME="LiFiDiamondImmutable"
  fi
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_NAME")

  echo "DIAMOND_ADDRESS: $DIAMOND_ADDRESS"
  echo "DEPLOYER_ADDRESS: $(getDeployerAddress "$NETWORK" "$ENVIRONMENT")"

  if [[ -z "$DIAMOND_ADDRESS" ]]; then
    error "could not find address for $DIAMOND_NAME in network-specific log file for network $NETWORK (ENVIRONMENT=$ENVIRONMENT)"
    return 1
  fi

  # get a list of all periphery contracts
  PERIPHERY_CONTRACTS=$(getIncludedPeripheryContractsArray)

  MULTICALL_DATA="["

  # loop through periphery contracts
  for CONTRACT in $PERIPHERY_CONTRACTS; do
    echo "CONTRACT: $CONTRACT"

    # Build the function call for the contract
    #DATA=$(echo -n "0x$(echo -n "getPeripheryContract()" | xxd -p -c 256)")
    CALLDATA=$(cast calldata "getPeripheryContract(string)" "$CONTRACT")

    echo "CALLDATA: $CALLDATA"

    #target structure [(address,calldata),(address,calldata)]

    # Add the call data and target address to the call array
    MULTICALL_DATA=$MULTICALL_DATA"($DIAMOND_ADDRESS,$CALLDATA),"

  done

  # remove trailing comma and add trailing bracket
  MULTICALL_DATA=${MULTICALL_DATA%?}"]"

  echo "MULTICALL_DATA: $MULTICALL_DATA"

  MULTICALL_ADDRESS="0xcA11bde05977b3631167028862bE2a173976CA11"

  attempts=1

  echo "before call"

  while [ $attempts -lt 11 ]; do
    echo "Trying to execute multicall now - attempt ${attempts}"
    # try to execute call
    MULTICALL_RESULTS=$(cast send "$MULTICALL_ADDRESS" "aggregate((address,bytes)[]) returns (uint256,bytes[])" "$MULTICALL_DATA" --private-key $(getPrivateKey "$NETWORK" "$ENVIRONMENT") --rpc-url "https://polygon-rpc.com" --legacy)

    # check the return code the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq 11 ]; then
    echo "Failed to execute multicall"
    exit 1
  fi

  #MULTICALL_RESULTS=$(cast send "$MULTICALL_ADDRESS" "aggregate((address,bytes)[]) returns (uint256,bytes[])" "$MULTICALL_DATA" --private-key "$PRIV_KEY" --rpc-url  "https://opt-mainnet.g.alchemy.com/v2/4y-BIUvj_mTGWHrsHZncoJyNolNjJrsT" --legacy)
  echo "after call"

  echo ""
  echo ""

  echo "MULTICALL_RESULTS: $MULTICALL_RESULTS"

  # check if diamond returns an address for this contract

  #

}
function saveDiamondPeriphery() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  USE_MUTABLE_DIAMOND=$3

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # get RPC URL
  RPC_URL=$(getRPCUrl "$NETWORK")

  # define path for json file based on which diamond was used
  if [[ "$USE_MUTABLE_DIAMOND" == "true" ]]; then
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.${FILE_SUFFIX}json"
    DIAMOND_NAME="LiFiDiamond"
  else
    DIAMOND_FILE="./deployments/${NETWORK}.diamond.immutable.${FILE_SUFFIX}json"
    DIAMOND_NAME="LiFiDiamondImmutable"
  fi
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_NAME")

  # make sure diamond address is available
  if [[ -z "$DIAMOND_ADDRESS" ]]; then
    error "could not find address for $DIAMOND_NAME in network-specific log file for network $NETWORK (ENVIRONMENT=$ENVIRONMENT)"
    return 1
  fi

  # logging for debug purposes
  echo ""
  echoDebug "in function saveDiamondPeriphery"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "USE_MUTABLE_DIAMOND=$USE_MUTABLE_DIAMOND"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echoDebug "RPC_URL=$RPC_URL"
  echoDebug "DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
  echoDebug "DIAMOND_FILE=$DIAMOND_FILE"

  # get a list of all periphery contracts
  PERIPHERY_CONTRACTS=$(getContractNamesInFolder "src/Periphery/")

  # loop through periphery contracts
  for CONTRACT in $PERIPHERY_CONTRACTS; do
    # get the address of this contract from diamond (will return ZERO_ADDRESS, if not registered)
    ADDRESS=$(cast call "$DIAMOND_ADDRESS" "getPeripheryContract(string) returns (address)" "$CONTRACT" --rpc-url "$RPC_URL")

    # check if address is ZERO_ADDRESS
    if [[ "$ADDRESS" == $ZERO_ADDRESS ]]; then
      ADDRESS=""
    fi

    # add new entry to JSON file
    result=$(cat "$DIAMOND_FILE" | jq -r ".$DIAMOND_NAME.Periphery += {\"$CONTRACT\": \"$ADDRESS\"}" || cat "$DIAMOND_FILE")
    printf %s "$result" >"$DIAMOND_FILE"
  done
}
function saveContract() {
  # read function arguments into variables
  local NETWORK=$1
  local CONTRACT=$2
  local ADDRESS=$3
  local FILE_SUFFIX=$4

  # load JSON FILE that contains deployment addresses
  ADDRESSES_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  # logging for debug purposes
  echo ""
  echoDebug "in function saveContract"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "CONTRACT=$CONTRACT"
  echoDebug "ADDRESS=$ADDRESS"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echoDebug "ADDRESSES_FILE=$ADDRESSES_FILE"

  if [[ "$ADDRESS" == *"null"* || -z "$ADDRESS" ]]; then
    error "trying to write a 'null' address to $ADDRESSES_FILE for $CONTRACT. Log file will not be updated."
    return 1
  fi

  # create an empty json if it does not exist
  if [[ ! -e $ADDRESSES_FILE ]]; then
    echo "{}" >"$ADDRESSES_FILE"
  fi

  # add new address to address log FILE
  RESULT=$(cat "$ADDRESSES_FILE" | jq -r ". + {\"$CONTRACT\": \"$ADDRESS\"}" || cat "$ADDRESSES_FILE")
  printf %s "$RESULT" >"$ADDRESSES_FILE"
}
# <<<<< reading and manipulation of deployment log files

# >>>>> working with directories and reading other files
function checkIfFileExists() {
  # read function arguments into variables
  local FILE_PATH="$1"

  # Check if FILE exists
  if [ ! -f "$FILE_PATH" ]; then
    echo "false"
    return 1
  else
    echo "true"
    return 0
  fi
}
function checkRequiredVariablesInDotEnv() {
  # read function arguments into variables
  local NETWORK=$1

  # skip for local network
  if [[ "$NETWORK" == "localanvil" ]]; then
    return 0
  fi

  # skip for local network
  if [[ "$NETWORK" == "localanvil" ]]; then
    return 0
  fi

  local PRIVATE_KEY="$PRIVATE_KEY"
  local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK" | sed s/-/_/g)"
  local RPC_URL="${!RPC}"

  local BLOCKEXPLORER_API="$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK" | sed s/-/_/g)""_ETHERSCAN_API_KEY"
  local BLOCKEXPLORER_API_KEY="${!BLOCKEXPLORER_API}"

  if [[ -z "$PRIVATE_KEY" || -z "$RPC_URL" || -z "$BLOCKEXPLORER_API_KEY" ]]; then
    # throw error if any of the essential keys is missing
    error "your .env file is missing essential entries for this network (required are: PRIVATE_KEY, $RPC and $BLOCKEXPLORER_API)"
    return 1
  fi

  # all good - continue
  return 0
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
    error "the following path is not a valid directory: $FILEPATH"
  fi
}
function getContractFilePath() {
  # read function arguments into variables
  CONTRACT="$1"

  #  # special handling for CelerIMFacet
  #  if [[ "$CONTRACT" == *"CelerIMFacet"* ]]; then
  #    CONTRACT="CelerIMFacetBase"
  #  fi

  # define directory to be searched
  local dir=$CONTRACT_DIRECTORY
  local FILENAME="$CONTRACT.sol"

  # find FILE path
  local file_path=$(find "${dir%/}" -name $FILENAME -print)

  # return FILE path or throw error if FILE path does not have a value
  if [ -n "$file_path" ]; then
    echo "$file_path"
  else
    error "could not find src FILE path for contract $CONTRACT"
    exit 1
  fi
}

function getCurrentContractVersion() {
  # read function arguments into variables
  local CONTRACT="$1"

  # get src FILE path for contract
  local FILEPATH=$(getContractFilePath "$CONTRACT")
  wait

  # Check if FILE exists
  if [ ! -f "$FILEPATH" ]; then
    error "the following filepath is invalid: $FILEPATH"
    return 1
  fi

  # Search for "@custom:version" in the file and store the first result in the variable
  local VERSION=$(grep "@custom:version" "$FILEPATH" | cut -d ' ' -f 3)

  # Check if VERSION is empty
  if [ -z "$VERSION" ]; then
    error "'@custom:version' string not found in $FILEPATH"
    return 1
  fi

  echo "$VERSION"
}
function getAllContractNames() {
  # read function arguments into variables
  EXCLUDE_CONFIG="$1"

  # will return the names of all contracts in the following folders:
  # src
  # src/Facets
  # src/Periphery

  # get all facet contracts
  local FACET_CONTRACTS=$(getIncludedAndSortedFacetContractsArray "$EXCLUDE_CONFIG")

  # get all periphery contracts
  local PERIPHERY_CONTRACTS=$(getIncludedPeripheryContractsArray "$EXCLUDE_CONFIG")

  # get all diamond contracts
  local DIAMOND_CONTRACTS=$(getContractNamesInFolder "src")

  # merge
  local ALL_CONTRACTS=("${DIAMOND_CONTRACTS[@]}" "${FACET_CONTRACTS[@]}" "${PERIPHERY_CONTRACTS[@]}")

  # Print the resulting array
  echo "${ALL_CONTRACTS[*]}"
}
function getFunctionSelectorFromContractABI() {
  # read function arguments into variables
  local CONTRACT_NAME="$1"
  local FUNCTION_NAME="$2"

  # Extract the ABI file for the specified contract
  local ABI="./out/$CONTRACT_NAME.sol/$CONTRACT_NAME.json"

  # Loop through methodIdentifiers in ABI
  for FUNCTION in $(jq -r '.methodIdentifiers | keys[]' "$ABI"); do
    # extract function name only from value
    CURRENT_FUNCTION_NAME=${FUNCTION%%(*}

    # If the identifier matches the provided function name, store it's signature and exit loop
    if [[ "$FUNCTION_NAME" == "$CURRENT_FUNCTION_NAME" ]]; then
      # get function identifier
      SIGNATURE=$(jq -r ".methodIdentifiers[\"$FUNCTION\"]" "$ABI")
      break
    fi
  done

  # return function signature
  echo "$SIGNATURE"

}
function getFunctionSelectorsFromContractABI() {
  # read function arguments into variables
  local CONTRACT_NAME="$1"

  # Extract the ABI file for the specified contract
  local ABI="./out/$CONTRACT_NAME.sol/$CONTRACT_NAME.json"

  # Extract the function selectors from the ABI file
  local SELECTORS=$(jq -r '.methodIdentifiers | join(",")' "$ABI")

  # Convert the comma-separated list of selectors to an array of bytes4 values
  local BYTES4_SELECTORS=()
  IFS=',' read -ra SELECTOR_ARRAY <<<"$SELECTORS"
  for SELECTOR in "${SELECTOR_ARRAY[@]}"; do
    BYTES4_SELECTORS+=("0x${SELECTOR}")
  done

  # return the selectors array
  echo "${BYTES4_SELECTORS[@]}"
}
function getOptimizerRuns() {
  # define FILE path for foundry config FILE
  FILEPATH="foundry.toml"

  # Check if FILE exists
  if [ ! -f "$FILEPATH" ]; then
    error ": $FILEPATH does not exist."
    return 1
  fi

  # Search for "optimizer_runs =" in the FILE and store the first RESULT in the variable
  VERSION=$(grep "optimizer_runs =" $FILEPATH | cut -d ' ' -f 3)

  # Check if VERSION is empty
  if [ -z "$VERSION" ]; then
    error ": optimizer_runs string not found in $FILEPATH."
    return 1
  fi

  # return OPTIMIZER_RUNS value
  echo "$VERSION"

}
function removeExistingEntriesFromTargetStateJSON() {
  local file="$1"
  local value="$2"

  # Check if the file exists
  if [ ! -f "$file" ]; then
    error "file not found: $file"
    return 1
  fi

  # Remove staging entries on level 2
  jq "map_values(del(.$value))" "$file" >"$file.tmp" && mv "$file.tmp" "$file"

  if [ $? -eq 0 ]; then
    echo "[info] existing '$value' entries removed successfully from target state file ($file)"
    return 0
  else
    error "failed to remove entries with value '$value'."
    rm "$temp_file" >/dev/null 2>&1
    return 1
  fi

}
function parseTargetStateGoogleSpreadsheet() {
  # read function arguments into variables
  local ENVIRONMENT="$1"

  # ensure spreadsheet ID is available
  if [[ "$ENVIRONMENT" == "production" ]]; then
    # check if config contains spreadsheet ID
    if [[ -z "$TARGET_STATE_SPREADSHEET_ID_PRODUCTION" ]]; then
      error "your config.sh file is missing key 'TARGET_STATE_SPREADSHEET_ID_PRODUCTION'. Please add it."
      exit 1
    else
      # construct spreadsheet URL
      SPREADSHEET_URL="https://docs.google.com/spreadsheets/d/${TARGET_STATE_SPREADSHEET_ID_PRODUCTION}"
      EXPORT_PARAMS="/export?exportFormat=csv"
    fi
  elif [[ "$ENVIRONMENT" == "staging" ]]; then
    # check if config contains spreadsheet ID
    if [[ -z "$TARGET_STATE_SPREADSHEET_ID_STAGING" ]]; then
      error "your config.sh file is missing key 'TARGET_STATE_SPREADSHEET_ID_STAGING'. Please add it."
      exit 1
    else
      # construct spreadsheet URL
      SPREADSHEET_URL="https://docs.google.com/spreadsheets/d/${TARGET_STATE_SPREADSHEET_ID_STAGING}"
      EXPORT_PARAMS="/export?exportFormat=csv"
    fi
  else
    error "an unexpected ENVIRONMENT value was passed to parseTargetStateGoogleSpreadsheet: ($ENVIRONMENT). Script cannot continue."
    exit 1
  fi

  # load google sheets into CSV file
  CSV_FILE_PATH="newTest.csv"
  curl -L "$SPREADSHEET_URL""$EXPORT_PARAMS" -o $CSV_FILE_PATH 2>/dev/null

  echo "Updating $ENVIRONMENT target state from this Google sheet now: $SPREADSHEET_URL"
  echo ""

  # remove existing entries from target state JSON file
  removeExistingEntriesFromTargetStateJSON "$TARGET_STATE_PATH" "$ENVIRONMENT"

  # make sure existing entries were removed properly (to prevent corrupted target state)
  if [[ $? -ne 0 ]]; then
    error "unable to remove existing $ENVIRONMENT values from target state file ($TARGET_STATE_PATH). Cannot proceed."
    exit 1
  fi

  NETWORKS_START_AT_LINE=0
  FACETS_STARTS_AT_COLUMN=3 # this value is hardcoded and not expected to change

  # process the CSV file line by line
  LINE_NUMBER=0
  while IFS= read -r LINE; do
    # Increment the line number
    ((LINE_NUMBER++))

#    echoDebug "LINE $LINE_NUMBER: $LINE"

    # find and store the row that contains all the contract names (determined by recognizing hardcoded value in cell A1)
    if [[ "$LINE" == *"Blue = Periphery"* ]]; then
      # Remove the unneeded values from the line
      STRING_TO_REMOVE='  Blue = Periphery",EXAMPLE,,'
      CONTRACTS_LINE=$(echo "$LINE" | sed "s/^${STRING_TO_REMOVE}//")

      # Split the line by comma into an array
      IFS=',' read -ra LINE_ARRAY <<<"$CONTRACTS_LINE"

      # Create an iterable array that only contains facet names
      CONTRACTS_ARRAY=()
      for ((i = 0; i < ${#LINE_ARRAY[@]}; i += 2)); do
        # extract contract name (might include "" or the values "FACETS"/"PERIPHERY/END")
        CONTRACT_NAME=${LINE_ARRAY[i]}

        # add contract name to array
        CONTRACTS_ARRAY+=("$CONTRACT_NAME")
      done
      #        break
    fi

    # find row with the first network ('mainnet'), do not execute again once it has been found
    if [[ "$NETWORKS_START_AT_LINE" == 0 && $LINE == "mainnet"* ]]; then
      NETWORKS_START_AT_LINE=$LINE_NUMBER
    fi

    # lines containing network-specific data will start earliest in line 130
    if [[ $NETWORKS_START_AT_LINE != 0 && $((LINE_NUMBER)) -ge "$NETWORKS_START_AT_LINE" ]]; then

      # extract network name
      NETWORK=$(echo "$LINE" | cut -d',' -f1)

      if [[ "$NETWORK" == "<placeholder>" ]]; then
        echoDebug "skipping network (placeholder)"
        continue
      fi

      if [[ "$NETWORK" == "DEACTIVATED" ]]; then
        echoDebug "reached deactivated network2 - ending script parsing now"
        break
      fi

      # check if this line contains data (=starts with a network name), otherwise skip to next line
      if [[ ! -z "$NETWORK" ]]; then
        echo ""
        echo "NETWORK: $NETWORK"

        # Split the line by comma into an array
        IFS=',' read -ra LINE_ARRAY <<<"$LINE"

        CONTRACT_INDEX=0
        # iterate through the array (start with index 5 to skip network name and EXAMPLE columns)
        for ((INDEX = "$FACETS_STARTS_AT_COLUMN"; INDEX < ${#LINE_ARRAY[@]}; INDEX += 1)); do
          # read cell value and current contract into variables
          CELL_VALUE=${LINE_ARRAY[$INDEX]}
          CONTRACT=${CONTRACTS_ARRAY[$CONTRACT_INDEX]}

          # increase facet index for next iteration
          if ((INDEX % 2 == 0)); then
            ((CONTRACT_INDEX += 1))
          fi

          # skip the iteration if the contract is empty (=empty placeholder column for future contracts)
          if [[ -z "$CONTRACT" ]]; then
            echoDebug "skipping iteration (no contract name in column)"
            continue
          fi

          # skip the iteration if contract is placeholder
          if [[ "$CONTRACT" == "<placeholder>" ]]; then
            echoDebug "skipping iteration (placeholder)"
            continue
          fi

          # skip the iteration if the contract is empty (=empty placeholder column for future contracts)
          if [[ -z "$CELL_VALUE" ]]; then
            echoDebug "skipping iteration (no value in cell)"
            continue
          fi

          # end the loop if contract is empty (=reached the end of the facet columns)
          if [[ "$CONTRACT" == "END" ]]; then
            break
          fi

          # determine diamond type based on odd/even column index
          if ((INDEX % 2 == 0)); then
            DIAMOND_TYPE="LiFiDiamondImmutable"
          else
            DIAMOND_TYPE="LiFiDiamond"
          fi

          # get current contract version and save in variable
          CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")

          # check if cell value is "latest" >> find version
          if [[ "$CELL_VALUE" == "latest" ]]; then

            # make sure version was returned properly
            if [[ "$?" -ne 0 ]]; then
              warning "could not find current contract version for contract $CONTRACT"
            fi

            # echo warning that sheet needs to be updated
            warning "the latest version for contract $CONTRACT is $CURRENT_VERSION. Please update this for network $NETWORK in the Google sheet"

            # use current version for target state
            VERSION=$CURRENT_VERSION
          else
            # check if cell value looks like a version tag
            if isVersionTag "$CELL_VALUE"; then

              # check if current version in repo is higher than version in target state
              if [[ "$CURRENT_VERSION" != "$CELL_VALUE" ]]; then
                warning "Requested version ($CELL_VALUE) of $CONTRACT in $NETWORK for $DIAMOND_TYPE differs from current version ($CURRENT_VERSION). Update target state file?"
              fi

              # store cell value as target version
              VERSION=$CELL_VALUE
            else
              continue
            fi
          fi

          # if code reached here that means we should have a valid target state entry that needs to be added
          addContractVersionToTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_TYPE" "$VERSION" true
          echo "addContractVersionToTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_TYPE" "$VERSION" true"

        done
      fi
    fi
  done <"$CSV_FILE_PATH"

  # delete CSV file
  rm $CSV_FILE_PATH

  return 0
}
function getBytecodeFromArtifact() {
  # read function arguments into variables
  local contract="$1"

  # get filepath
  local file_path="out/$contract.sol/$contract.json"

  # ensure file exists
  if ! checkIfFileExists "$file_path" >/dev/null; then
    error "file does not exist: $file_path (access attempted by function 'getBytecodeFromArtifact')"
    return 1
  fi

  # read bytecode value from json
  bytecode_json=$(getValueFromJSONFile "$file_path" "bytecode.object")

  # Check if the value obtained starts with "0x"
  if [[ $bytecode_json == 0x* ]]; then
    echo "$bytecode_json"
    return 0
  else
    error "no bytecode found for $contract in file $file_path. Script cannot continue."
    exit 1
  fi
}

# <<<<< working with directories and reading other files

# >>>>> writing to blockchain & verification
function verifyContract() {
  # read function arguments into variables
  local NETWORK=$1
  local CONTRACT=$2
  local ADDRESS=$3
  local ARGS=$4

  API_KEY="$(tr '[:lower:]' '[:upper:]' <<<$NETWORK | sed s/-/_/g)_ETHERSCAN_API_KEY"

  # logging for debug purposes
  echo ""
  echoDebug "in function verifyContract"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "CONTRACT=$CONTRACT"
  echoDebug "ADDRESS=$ADDRESS"
  echoDebug "ARGS=$ARGS"
  echoDebug "blockexplorer API_KEY=${API_KEY}"
  echoDebug "blockexplorer API_KEY value=${!API_KEY}"

  if [[ -n "$DO_NOT_VERIFY_IN_THESE_NETWORKS" ]]; then
    case ",$DO_NOT_VERIFY_IN_THESE_NETWORKS," in
    *,"$NETWORK",*)
      echoDebug "network $NETWORK is excluded for contract verification, therefore verification of contract $CONTRACT will be skipped"
      return 1
      ;;
    esac
  fi

  # verify contract using forge
  MAX_RETRIES=$MAX_ATTEMPTS_PER_CONTRACT_VERIFICATION
  RETRY_COUNT=0
  COMMAND_STATUS=1
  CONTRACT_FILE_PATH=$(getContractFilePath "$CONTRACT")
  FULL_PATH="$CONTRACT_FILE_PATH"":""$CONTRACT"
  CHAIN_ID=$(getChainId "$NETWORK")

  if [ $? -ne 0 ]; then
    warning "could not find chainId for network $NETWORK (was this network recently added? Then update helper function 'getChainId'"
  fi

  while [ $COMMAND_STATUS -ne 0 -a $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if [ "$ARGS" = "0x" ]; then
      # only show output if DEBUG flag is activated
      if [[ "$DEBUG" == *"true"* ]]; then
        forge verify-contract --watch --chain "$NETWORK" "$ADDRESS" "$FULL_PATH" -e "${!API_KEY}"
      else
        forge verify-contract --watch --chain "$NETWORK" "$ADDRESS" "$FULL_PATH" -e "${!API_KEY}" >/dev/null 2>&1
      fi
    else
      # only show output if DEBUG flag is activated
      if [[ "$DEBUG" == *"true"* ]]; then
        forge verify-contract --watch --chain "$NETWORK" "$ADDRESS" "$FULL_PATH" --constructor-args $ARGS -e "${!API_KEY}"
      else
        forge verify-contract --watch --chain "$NETWORK" "$ADDRESS" "$FULL_PATH" --constructor-args $ARGS -e "${!API_KEY}" >/dev/null 2>&1
      fi
    fi
    COMMAND_STATUS=$?
    RETRY_COUNT=$((RETRY_COUNT + 1))
  done

  # check the return status of the contract verification call
  if [ $COMMAND_STATUS -ne 0 ]; then
    warning "$CONTRACT on $NETWORK with address $ADDRESS could not be verified"
  else
    echo "[info] $CONTRACT on $NETWORK with address $ADDRESS successfully verified"
    return 0
  fi

  echo "[info] trying to verify $CONTRACT on $NETWORK with address $ADDRESS using Sourcify now"
  forge verify-contract \
    "$ADDRESS" \
    "$CONTRACT" \
    --chain-id "$CHAIN_ID" \
    --verifier sourcify

  echo "[info] checking Sourcify verification now"
  forge verify-check $ADDRESS \
    --chain-id "$CHAIN_ID" \
    --verifier sourcify

  if [ $? -ne 0 ]; then
    # verification apparently failed
    warning "[info] $CONTRACT on $NETWORK with address $ADDRESS could not be verified using Sourcify"
    return 1
  else
    # verification successful
    echo "[info] $CONTRACT on $NETWORK with address $ADDRESS successfully verified using Sourcify"
    return 0
  fi
}
function verifyAllUnverifiedContractsInLogFile() {
  # Check if target state FILE exists
  if [ ! -f "$LOG_FILE_PATH" ]; then
    error "log file does not exist in path $LOG_FILE_PATH"
    exit 1
  fi

  echo "[info] checking log file for unverified contracts"

  # initate counter
  local COUNTER=0

  # Read top-level keys into an array
  CONTRACTS=($(jq -r 'keys[]' "$LOG_FILE_PATH"))

  # Loop through the array of top-level keys
  for CONTRACT in "${CONTRACTS[@]}"; do

    # Read second-level keys for the current top-level key
    NETWORKS=($(jq -r ".${CONTRACT} | keys[]" "$LOG_FILE_PATH"))

    # Loop through the array of second-level keys
    for NETWORK in "${NETWORKS[@]}"; do

      #      if [[ $NETWORK != "mainnet" ]]; then
      #        continue
      #      fi

      # Read ENVIRONMENT keys for the network
      ENVIRONMENTS=($(jq -r --arg contract "$CONTRACT" --arg network "$NETWORK" '.[$contract][$network] | keys[]' "$LOG_FILE_PATH"))

      # go through all environments
      for ENVIRONMENT in "${ENVIRONMENTS[@]}"; do

        # Read VERSION keys for the network
        VERSIONS=($(jq -r --arg contract "$CONTRACT" --arg network "$NETWORK" --arg environment "$ENVIRONMENT" '.[$contract][$network][$environment] | keys[]' "$LOG_FILE_PATH"))

        # go through all versions
        for VERSION in "${VERSIONS[@]}"; do

          # get values of current entry
          ENTRY=$(cat "$LOG_FILE_PATH" | jq -r --arg contract "$CONTRACT" --arg network "$NETWORK" --arg environment "$ENVIRONMENT" --arg version "$VERSION" '.[$contract][$network][$environment][$version][0]')

          # extract necessary information from log
          ADDRESS=$(echo "$ENTRY" | awk -F'"' '/"ADDRESS":/{print $4}')
          VERIFIED=$(echo "$ENTRY" | awk -F'"' '/"VERIFIED":/{print $4}')
          OPTIMIZER_RUNS=$(echo "$ENTRY" | awk -F'"' '/"OPTIMIZER_RUNS":/{print $4}')
          TIMESTAMP=$(echo "$ENTRY" | awk -F'"' '/"TIMESTAMP":/{print $4}')
          CONSTRUCTOR_ARGS=$(echo "$ENTRY" | awk -F'"' '/"CONSTRUCTOR_ARGS":/{print $4}')

          # check if contract is verified
          if [[ "$VERIFIED" != "true" ]]; then
            echo ""
            echo "[info] trying to verify contract $CONTRACT on $NETWORK with address $ADDRESS...."
            if [[ "$DEBUG" == *"true"* ]]; then
              verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$CONSTRUCTOR_ARGS"
            else
              verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$CONSTRUCTOR_ARGS" 2>/dev/null
            fi

            # check result
            if [ $? -eq 0 ]; then
              # update log file
              logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER_RUNS" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS" "true" "$SALT"

              # increase COUNTER
              COUNTER=$((COUNTER + 1))
            fi
          fi
        done
      done
    done
  done

  echo "[info] done (verified contracts: $COUNTER)"
}
function removeFacetFromDiamond() {
  # read function arguments into variables
  local DIAMOND_ADDRESS="$1"
  local FACET_NAME="$2"
  local NETWORK="$3"
  local ENVIRONMENT="$4"
  local EXIT_ON_ERROR="$5"

  # get function selectors of facet
  FUNCTION_SELECTORS=$(getFunctionSelectorsOfCurrentContract "$DIAMOND_ADDRESS" "$FACET_NAME" "$NETWORK" "$ENVIRONMENT" false)

  # convert the function selector array to a comma-separated list
  SELECTORS_LIST="$(echo "${FUNCTION_SELECTORS[@]}" | sed 's/ /,/g')"

  # get ABI of facet
  local ABI="./out/$FACET_NAME.sol/$FACET_NAME.json"

  # get RPC URL
  local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

  local ZERO_ADDRESS=0x0000000000000000000000000000000000000000

  # go through list of facet selectors and find out which of those is known by the diamond
  for SELECTOR in $FUNCTION_SELECTORS; do
    # get address of facet in diamond
    local FACET_ADDRESS=$(getFacetAddressFromSelector "$DIAMOND_ADDRESS" "$FACET_NAME" "$NETWORK" "$SELECTOR")

    # check if facet address could be obtained
    if [[ $? -ne 0 ]]; then
      # display error message
      echo "$FACET_ADDRESS"
      # exit script
      return 1
    fi

    # if not zero address => add to list of selectors
    if [ "$FACET_ADDRESS" != "$ZERO_ADDRESS" ]; then
      if [[ -z "$SELECTORS_LIST2" ]]; then
        # initiate list
        KNOWN_SELECTORS="$SELECTOR"
      else
        # add to list
        KNOWN_SELECTORS+=",$SELECTOR"
      fi
    fi
  done

  # prepare arguments for diamondCut call
  local FACET_CUT_ACTION="2" # (remove == 2 according to enum)
  local DIAMOND_CUT_FUNCTION_SIGNATURE="diamondCut((address,uint8,bytes4[])[],address,bytes)"

  local TUPLE="[(""$ZERO_ADDRESS"",""$FACET_CUT_ACTION,["$KNOWN_SELECTORS"])]"

  # Encode the function call arguments with the encode command
  local ENCODED_ARGS=$(cast calldata "$DIAMOND_CUT_FUNCTION_SIGNATURE" "$TUPLE" "$ZERO_ADDRESS" "0x")

  ATTEMPTS=1
  while [ $ATTEMPTS -le "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "[info] trying to remove $FACET_NAME  from diamond $DIAMOND_ADDRESS - attempt ${ATTEMPTS} (max attempts: $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION)"

    # call diamond
    if [[ "$DEBUG" == *"true"* ]]; then
      # print output to console
      cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --rpc-url "${!RPC}" --legacy
    else
      # do not print output to console
      cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$(getPrivateKey "$NETWORK" "$ENVIRONMENT")" --rpc-url "${!RPC}" --legacy >/dev/null 2>&1
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
    error "failed to remove $FACET_NAME from $DIAMOND_ADDRESS on network $NETWORK"
    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  echoDebug "successfully removed $FACET_NAME from $DIAMOND_ADDRESS on network $NETWORK"
} # needs to be fixed before using again
function confirmOwnershipTransfer() {
  # read function arguments into variables
  local address="$1"
  local network="$2"
  local private_key="$3"

  attempts=1 # initialize attempts to 0

  # get RPC URL
  rpc_url=$(getRPCUrl "$network")

  while [ $attempts -lt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; do
    echo "Trying to confirm ownership transfer on contract with address ($address) - attempt ${attempts}"
    # try to execute call
    cast send "$address" "confirmOwnershipTransfer()" --rpc-url "$rpc_url" --private-key "$private_key" 2>/dev/null

    # check the return code the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]; then
    error "Failed to confirm ownership transfer"
    return 1
  fi

  return 0
}
# <<<<< writing to blockchain & verification

function updateAllContractsToTargetState() {
  # Check if target state FILE exists
  if [ ! -f "$TARGET_STATE_PATH" ]; then
    error "target state FILE does not exist in path $TARGET_STATE_PATH"
    exit 1
  fi

  echo ""
  echo "[info] now comparing target state to actual deployed contracts"

  # initiate counter
  local COUNTER=0

  # Read top-level keys into an array
  NETWORKS=($(jq -r 'keys[]' "$TARGET_STATE_PATH"))

  # Loop through the array of top-level keys
  for NETWORK in "${NETWORKS[@]}"; do
    echo "[info] current network: $NETWORK"

    # Read ENVIRONMENT keys for the network
    ENVIRONMENTS=($(jq -r ".${NETWORK} | keys[]" "$TARGET_STATE_PATH"))

    # Loop through the array of second-level keys
    for ENVIRONMENT in "${ENVIRONMENTS[@]}"; do
      echo "[info]  current environment: $ENVIRONMENT"

      # Read diamond name keys for the network
      DIAMOND_NAMES=($(jq -r ".${NETWORK}.${ENVIRONMENT} | keys[]" "$TARGET_STATE_PATH"))

      # go through all diamond names
      for DIAMOND_NAME in "${DIAMOND_NAMES[@]}"; do
        echo "[info]   current diamond type: $DIAMOND_NAME"
        echo ""
        echo "[info]    current contract $DIAMOND_NAME: "

        DIAMOND_DEPLOYMENT_REQUIRED=false

        # get address of current diamond
        DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_NAME")

        # extract diamond target version
        DIAMOND_TARGET_VERSION=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$DIAMOND_NAME" "$DIAMOND_NAME")

        # check if diamond address was found (if not, deploy first since it's needed for the rest)
        if [[ "$?" -ne 0 ]]; then
          echo ""
          echo "[info]     diamond address not found - need to deploy diamond first"

          # deploy diamond contract
          deploySingleContract "$DIAMOND_NAME" "$NETWORK" "$ENVIRONMENT" "$TARGET_VERSION" "true" 2>/dev/null

          # check if last command was executed successfully, otherwise exit script with error message
          checkFailure $? "deploy contract $DIAMOND_NAME to network $NETWORK"

          # get new diamond address from log
          DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_NAME")

          echo "[info]     diamond contract deployed to $DIAMOND_ADDRESS - deploying core facets now"
          echo ""

          # deploy and add core facets
          echo ""
          deployCoreFacets "$NETWORK" "$ENVIRONMENT" 2>/dev/null

          # check if last command was executed successfully, otherwise exit script with error message
          checkFailure $? "deploy core facets to network $NETWORK"
          echo "[info]     core facets deployed - updating $DIAMOND_NAME now"

          # update diamond with core facets
          echo ""
          diamondUpdateFacet "$NETWORK" "$ENVIRONMENT" "$DIAMOND_NAME" "UpdateCoreFacets" false 2>/dev/null

          # check if last command was executed successfully, otherwise exit script with error message
          checkFailure $? "update core facets in $DIAMOND_NAME on network $NETWORK"
          echo "[info]     core facets added to $DIAMOND_NAME"
        else
          # check if diamond matches current version
          # (need to do that first, otherwise facets might be updated to old diamond before diamond gets updated)
          # check version of known diamond
          KNOWN_VERSION=$(getContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$DIAMOND_NAME" "$DIAMOND_ADDRESS")

          # check result
          if [[ "$?" -ne 0 ]]; then
            # no version available > needs to be deployed
            echo "[info]     could not extract current version from log file for $DIAMOND_NAME with address $DIAMOND_ADDRESS" # TODO: remove
            DIAMOND_DEPLOYMENT_REQUIRED=true
          else
            # match with target version
            if [[ ! "$KNOWN_VERSION" == "$DIAMOND_TARGET_VERSION" ]]; then
              echo "[info]     $DIAMOND_NAME versions do not match (current version=$KNOWN_VERSION, target version=$DIAMOND_TARGET_VERSION)" # TODO: remove
              DIAMOND_DEPLOYMENT_REQUIRED=true
            else
              echo "[info]     $DIAMOND_NAME  is already deployed in target version ($TARGET_VERSION)"
            fi
          fi
        fi

        # check if diamond deployment is required and deploy, if needed
        if [[ "$DIAMOND_DEPLOYMENT_REQUIRED" == "true" ]]; then
          # TODO: activate
          #deploySingleContract "$DIAMOND_NAME" "$NETWORK" "$ENVIRONMENT" "$TARGET_VERSION" "true" 2>/dev/null
          DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND_NAME")

          echo "[info]     $DIAMOND_NAME deployed to address $DIAMOND_ADDRESS"
        fi

        # ensure that diamond address is now available
        if [[ -z $DIAMOND_ADDRESS ]]; then
          error "    failed to deploy diamond (or get its address) - cannot continue. Please run script again."
          exit 1
        fi
        DEPLOYMENT_REQUIRED=false

        # Read contract keys for the network
        CONTRACTS=($(jq -r ".${NETWORK}.${ENVIRONMENT}.${DIAMOND_NAME} | keys[]" "$TARGET_STATE_PATH"))

        echo ""

        # go through all contracts
        for CONTRACT in "${CONTRACTS[@]}"; do
          DEPLOYMENT_REQUIRED=false

          # skip for LiFiDiamond contracts (since they have already been checked above)
          if [[ "$CONTRACT" == *"LiFiDiamond"* ]]; then
            continue
          fi

          echo "[info]    current contract $CONTRACT: "

          # get values of current entry
          TARGET_VERSION=$(cat "$TARGET_STATE_PATH" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg DIAMOND_NAME "$DIAMOND_NAME" '.[$NETWORK][$ENVIRONMENT][$DIAMOND_NAME][$CONTRACT]')
          # remove "
          TARGET_VERSION=$(echo "$TARGET_VERSION" | sed 's/^"//;s/"$//')

          # determine contract type (periphery or facet)
          if [[ "$CONTRACT" == *"Facet"* ]]; then
            CONTRACT_TYPE="Facet"
          else
            CONTRACT_TYPE="Periphery"
          fi

          if [[ "$CONTRACT_TYPE" == "Facet" ]]; then
            # case: facet contract
            # check if current contract is known by diamond
            CONTRACT_INFO=$(getContractInfoFromDiamondDeploymentLogByName "$NETWORK" "$ENVIRONMENT" "$DIAMOND_NAME" $CONTRACT)

            # check result
            if [[ "$?" -ne 0 ]]; then
              # not known by diamond > needs to be deployed
              DEPLOYMENT_REQUIRED=true
            else
              # known by diamond
              # extract version
              #ADDRESS=$(echo "$CONTRACT_INFO" | jq -r 'keys[]' ) # TODO: remove
              KNOWN_VERSION=$(echo "$CONTRACT_INFO" | jq -r '.[].Version')

              # check if current version matches with target version
              if [[ ! "$KNOWN_VERSION" == "$TARGET_VERSION" ]]; then
                echo "[info]     versions do not match ($TARGET_VERSION!=$KNOWN_VERSION)" # TODO: remove
                DEPLOYMENT_REQUIRED=true
              else
                echo "[info]     contract $CONTRACT is already deployed in target version ($TARGET_VERSION)"
              fi
            fi

          elif [[ "$CONTRACT_TYPE" == "Periphery" ]]; then
            # case: periphery contract
            # check if current contract is known by diamond
            KNOWN_ADDRESS=$(getPeripheryAddressFromDiamond "$NETWORK" "$DIAMOND_ADDRESS" "$CONTRACT")

            # check result
            if [[ "$?" -ne 0 ]]; then
              # not known by diamond > needs to be deployed
              DEPLOYMENT_REQUIRED=true
            else
              # check version of known address
              KNOWN_VERSION=$(getContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$KNOWN_ADDRESS")

              # check result
              if [[ "$?" -ne 0 ]]; then
                # not known by diamond > needs to be deployed
                echo "[info]     versions do not match ($TARGET_VERSION!=$KNOWN_VERSION)" # TODO: remove
                DEPLOYMENT_REQUIRED=true
              else
                # match with target version
                if [[ ! "$KNOWN_VERSION" == "$TARGET_VERSION" ]]; then
                  echo "[info]     versions do not match ($TARGET_VERSION!=$KNOWN_VERSION)" # TODO: remove
                  DEPLOYMENT_REQUIRED=true
                else
                  echo "[info]     contract $CONTRACT is already deployed in target version ($TARGET_VERSION)"
                fi
              fi
            fi
          fi

          if [[ "$DEPLOYMENT_REQUIRED" == "true" ]]; then
            echo "[info]     now deploying $CONTRACT and adding it to $DIAMOND_NAME"
            # TODO: activate
            #deployAndAddContractToDiamond "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_NAME" "$TARGET_VERSION" 2>/dev/null
            if [[ "$?" -eq 0 ]]; then
              echo "[info]     $CONTRACT successfully deployed and added to $DIAMOND_NAME"
            else
              error "   $CONTRACT was not successfully deployed and added to $DIAMOND_NAME - please investigate and try again"
            fi
          fi
          echo ""
        done
      done
    done
  done

  echo "[info] done (updated contracts: $COUNTER)"
} # TODO: WIP
function getAddressOfDeployedContractFromDeploymentsFiles() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  DIAMOND_TYPE=$3
  CONTRACT=$4

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  if [[ "$DIAMOND_TYPE" == *"Immutable"* ]]; then
    DIAMOND_SUFFIX=".immutable"
  fi

  # get file path of deployments file
  #FILE_PATH="deployments/$NETWORK$DIAMOND_SUFFIX$FILE_SUFFIX.json"
  FILE_PATH="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  echo "FILE_PATH: $FILE_PATH"

}
function getAllNetworksArray() {
  # prepare required variables
  local FILE="$NETWORKS_FILE_PATH"
  local ARRAY=()

  # loop through networks list and add each network to ARRAY that is not excluded
  while IFS= read -r line; do
    ARRAY+=("$line")
  done <"$FILE"

  # return ARRAY
  printf '%s\n' "${ARRAY[@]}"
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
  done <"$FILE"

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
  # read function arguments into variables
  EXCLUDE_CONFIG="$1"

  # prepare required variables
  local DIRECTORY_PATH="$CONTRACT_DIRECTORY""Facets/"
  local ARRAY=()

  # extract list of excluded periphery contracts from config
  local EXCLUDE_CONTRACTS_REGEX="^($(echo "$EXCLUDE_FACET_CONTRACTS" | tr ',' '|'))$"

  # loop through contract names and add each name to ARRAY that is not excluded
  for CONTRACT in $(getContractNamesInFolder "$DIRECTORY_PATH"); do
    if [[ "$EXCLUDE_CONFIG" == "true" ]]; then
      if ! [[ "$CONTRACT" =~ $EXCLUDE_CONTRACTS_REGEX ]]; then
        ARRAY+=("$CONTRACT")
      fi
    else
      ARRAY+=("$CONTRACT")
    fi

  done

  # return ARRAY
  echo "${ARRAY[@]}"
}
function getIncludedAndSortedFacetContractsArray() {
  # read function arguments into variables
  EXCLUDE_CONFIG="$1"

  # get all facet contracts
  FACET_CONTRACTS=($(getIncludedFacetContractsArray "$EXCLUDE_CONFIG"))

  # convert CORE_FACETS into an array
  CORE_FACETS_ARRAY=($(echo "$CORE_FACETS" | tr ',' ' '))

  # initialize empty arrays for core and non-core facet contracts
  CORE_FACET_CONTRACTS=()
  OTHER_FACET_CONTRACTS=()

  # loop through FACET_CONTRACTS and sort into core and non-core arrays
  for contract in "${FACET_CONTRACTS[@]}"; do
    is_core=0
    for core_facet in "${CORE_FACETS_ARRAY[@]}"; do
      if [[ $contract == $core_facet ]]; then
        is_core=1
        break
      fi
    done

    if [[ $is_core == 1 ]]; then
      CORE_FACET_CONTRACTS+=("$contract")
    else
      OTHER_FACET_CONTRACTS+=("$contract")
    fi
  done

  # sort the arrays
  CORE_FACET_CONTRACTS=($(printf '%s\n' "${CORE_FACET_CONTRACTS[@]}" | sort))
  OTHER_FACET_CONTRACTS=($(printf '%s\n' "${OTHER_FACET_CONTRACTS[@]}" | sort))

  # merge the arrays
  SORTED_FACET_CONTRACTS=("${CORE_FACET_CONTRACTS[@]}" "${OTHER_FACET_CONTRACTS[@]}")

  # print the sorted array
  echo "${SORTED_FACET_CONTRACTS[*]}"
}
function userDialogSelectDiamondType() {
  # ask user to select diamond type
  SELECTION=$(
    gum choose \
      "1) Mutable" \
      "2) Immutable"
  )

  # select correct contract name based on user selection
  if [[ "$SELECTION" == *"1)"* ]]; then
    DIAMOND_CONTRACT_NAME="LiFiDiamond"
  elif [[ "$SELECTION" == *"2)"* ]]; then
    DIAMOND_CONTRACT_NAME="LiFiDiamondImmutable"
  else
    error "invalid value selected: $SELECTION - exiting script now"
    exit 1
  fi

  # return contract name
  echo "$DIAMOND_CONTRACT_NAME"
}
function getUserSelectedNetwork() {
  # get user-selected network
  local NETWORK=$(cat ./networks | gum filter --placeholder "Network...")

  # if no value was returned (e.g. when pressing ESC, end script)
  if [[ -z "$NETWORK" ]]; then
    error "invalid network selection"
    return 1
  fi

  # make sure all required .env variables are set
  checkRequiredVariablesInDotEnv "$NETWORK"

  echo "$NETWORK"
  return 0
}
function determineEnvironment() {
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

    echo "production"
  else
    echo "staging"
  fi
}
function checkFailure() {
  # read function arguments into variables
  RESULT=$1
  ERROR_MESSAGE=$2

  # check RESULT code and display error message if code != 0
  if [[ $RESULT -ne 0 ]]; then
    echo "Failed to $ERROR_MESSAGE"
    exit 1
  fi
}

# >>>>> output to console
function echoDebug() {
  # read function arguments into variables
  MESSAGE=$1

  # write message to console if debug flag is set to true
  if [[ $DEBUG == "true" ]]; then
    printf "$BLUE[debug] %s$NC\n" "$MESSAGE"
  fi
}
function error() {
  printf '\033[31m[error] %s\033[0m\n' "$1"
}
function warning() {
  printf '\033[33m[warning] %s\033[0m\n' "$1"
}
# <<<<< output to console

# >>>>> Reading and manipulation of target state JSON file
function addContractVersionToTargetState() {
  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  CONTRACT_NAME=$3
  DIAMOND_NAME=$4
  VERSION=$5
  UPDATE_EXISTING=$6

  # check if entry already exists
  ENTRY_EXISTS=$(jq ".\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" // empty" $TARGET_STATE_PATH)

  # check if entry should be updated and log warning if debug flag is set
  if [[ -n "$ENTRY_EXISTS" ]]; then
    if [[ "$UPDATE_EXISTING" == *"false"* ]]; then
      warning "target state file already contains an entry for NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, and CONTRACT_NAME:$CONTRACT_NAME."
      # exit script
      return 1
    else
      echoDebug "target state file already contains an entry for NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, and CONTRACT_NAME:$CONTRACT_NAME. Updating version."
    fi
  fi

  # add or update target state file
  jq ".\"${NETWORK}\" = (.\"${NETWORK}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" = \"${VERSION}\"" $TARGET_STATE_PATH >temp.json && mv temp.json $TARGET_STATE_PATH
}
function updateExistingContractVersionInTargetState() {
  # this function will update only existing entries, not add new ones

  # read function arguments into variables
  NETWORK=$1
  ENVIRONMENT=$2
  CONTRACT_NAME=$3
  DIAMOND_NAME=$4
  VERSION=$5

  # check if entry already exists
  ENTRY_EXISTS=$(jq ".\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" // empty" $TARGET_STATE_PATH)

  # check if entry should be updated and log warning if debug flag is set
  if [[ -n "$ENTRY_EXISTS" ]]; then
    echo "[info]: updating version in target state file: NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, CONTRACT_NAME:$CONTRACT_NAME, new VERSION: $VERSION."
    # add or update target state file
    jq ".\"${NETWORK}\" = (.\"${NETWORK}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" = \"${VERSION}\"" $TARGET_STATE_PATH >temp.json && mv temp.json $TARGET_STATE_PATH
  else
    echo "[info]: target state file does not contain an entry for NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, and CONTRACT_NAME:$CONTRACT_NAME that could be updated."
    # exit script
    return 1
  fi
}
function updateContractVersionInAllIncludedNetworks() {
  # read function arguments into variables
  local ENVIRONMENT=$1
  local CONTRACT_NAME=$2
  local DIAMOND_NAME=$3
  local VERSION=$4

  # get an array with all networks
  local NETWORKS=$(getIncludedNetworksArray)

  # go through all networks
  for NETWORK in $NETWORKS; do
    # update existing entries
    updateExistingContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT_NAME" "$DIAMOND_NAME" "$VERSION"
  done
}
function addNewContractVersionToAllIncludedNetworks() {
  # read function arguments into variables
  local ENVIRONMENT=$1
  local CONTRACT_NAME=$2
  local DIAMOND_NAME=$3
  local VERSION=$4
  local UPDATE_EXISTING=$5

  # get an array with all networks
  local NETWORKS=$(getIncludedNetworksArray)

  # go through all networks
  for NETWORK in $NETWORKS; do
    # update existing entries
    addContractVersionToTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT_NAME" "$DIAMOND_NAME" "$VERSION" "$UPDATE_EXISTING"
  done
}
function addNewNetworkWithAllIncludedContractsInLatestVersions() {
  # read function arguments into variables
  local NETWORK=$1
  local ENVIRONMENT=$2
  local DIAMOND_NAME=$3

  if [[ -z "$NETWORK" || -z "$ENVIRONMENT" || -z "$DIAMOND_NAME" ]]; then
    error "function addNewNetworkWithAllIncludedContractsInLatestVersions called with invalid parameters: NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, DIAMOND_NAME=$DIAMOND_NAME"
    return 1
  fi

  # get all facet contracts
  local FACET_CONTRACTS=$(getIncludedAndSortedFacetContractsArray)

  # get all periphery contracts
  local PERIPHERY_CONTRACTS=$(getIncludedPeripheryContractsArray)

  # merge all contracts into one array
  local ALL_CONTRACTS=("$DIAMOND_NAME" "${FACET_CONTRACTS[@]}" "${PERIPHERY_CONTRACTS[@]}")

  # go through all contracts
  for CONTRACT in ${ALL_CONTRACTS[*]}; do
    # get current contract version
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")

    # add to target state json
    addContractVersionToTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_NAME" "$CURRENT_VERSION" true
    if [ $? -ne 0 ]; then
      error "could not add contract version to target state for NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, CONTRACT=$CONTRACT, DIAMOND_NAME=$DIAMOND_NAME, VERSION=$CURRENT_VERSION"
    fi
  done
}
function findContractVersionInTargetState() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  CONTRACT="$3"
  DIAMOND_NAME=$4

  # Check if target state FILE exists
  if [ ! -f "$TARGET_STATE_PATH" ]; then
    error "target state FILE does not exist in path $TARGET_STATE_PATH"
    exit 1
  fi

  # find matching entry
  local TARGET_STATE_FILE=$(cat "$TARGET_STATE_PATH")
  local RESULT=$(echo "$TARGET_STATE_FILE" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg DIAMOND_NAME "$DIAMOND_NAME" '.[$NETWORK][$ENVIRONMENT][$DIAMOND_NAME][$CONTRACT]')

  if [[ "$RESULT" != "null" ]]; then
    # entry found
    # remove leading and trailing "
    RESULT_ADJUSTED=$(echo "$RESULT" | sed 's/"//g')

    # return TARGET_STATE_FILE and success error code
    echo "${RESULT_ADJUSTED}"
    return 0
  else
    # entry not found - issue error message and return error code
    echo "[info] No matching entry found in target state file for NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, CONTRACT=$CONTRACT"
    return 1
  fi
}
# <<<<<< Reading and manipulation of target state JSON file

# >>>>>> read from blockchain
function getContractAddressFromSalt() {
  # read function arguments into variables
  local SALT=$1
  local NETWORK=$2
  local CONTRACT_NAME=$3
  local ENVIRONMENT=$4

  # get RPC URL
  local RPC_URL="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK" | sed s/-/_/g)"

  # get deployer address
  local DEPLOYER_ADDRESS=$(getDeployerAddress "$NETWORK" "$ENVIRONMENT")

  # get actual deploy salt (as we do in DeployScriptBase:  keccak256(abi.encodePacked(saltPrefix, contractName));)
  # prepare web3 code to be executed
  jsCode="const Web3 = require('web3');
    const web3 = new Web3();
    const result = web3.utils.soliditySha3({t: 'string', v: '$SALT'},{t: 'string', v: '$CONTRACT_NAME'})
    console.log(result);"

  # execute code using web3
  ACTUAL_SALT=$(node -e "$jsCode")

  # call create3 factory to obtain contract address
  RESULT=$(cast call "$CREATE3_FACTORY_ADDRESS" "getDeployed(address,bytes32) returns (address)" "$DEPLOYER_ADDRESS" "$ACTUAL_SALT" --rpc-url "${!RPC_URL}")

  # return address
  echo "$RESULT"

}
function getDeployerAddress() {
  # read function arguments into variables
  local NETWORK=$1
  local ENVIRONMENT=$2

  PRIV_KEY="$(getPrivateKey "$NETWORK" "$ENVIRONMENT")"

  # prepare web3 code to be executed
  jsCode="const Web3 = require('web3');
    const web3 = new Web3();
    const deployerAddress = (web3.eth.accounts.privateKeyToAccount('$PRIV_KEY')).address
    const checksumAddress = web3.utils.toChecksumAddress(deployerAddress);
    console.log(checksumAddress);"

  # execute code using web3
  DEPLOYER_ADDRESS=$(node -e "$jsCode")

  # return deployer address
  echo "$DEPLOYER_ADDRESS"
}
function getDeployerBalance() {
  # read function arguments into variables
  local NETWORK=$1
  local ENVIRONMENT=$2

  # get RPC URL
  RPC_URL=$(getRPCUrl "$NETWORK")

  # get deployer address
  ADDRESS=$(getDeployerAddress "$NETWORK" "$ENVIRONMENT")

  # get balance in given network
  BALANCE=$(cast balance "$ADDRESS" --rpc-url "$RPC_URL")

  # return formatted balance
  echo "$(echo "scale=10;$BALANCE / 1000000000000000000" | bc)"
}
function doesDiamondHaveCoreFacetsRegistered() {
  # read function arguments into variables
  local DIAMOND_ADDRESS="$1"
  local NETWORK="$2"
  local FILE_SUFFIX="$3"

  # get file with deployment addresses
  DEPLOYMENTS_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK")

  # get list of all core facet contracts from config
  IFS=',' read -ra FACETS_NAMES <<<"$CORE_FACETS"

  # get a list of all facets that the diamond knows
  local KNOWN_FACET_ADDRESSES=$(cast call "$DIAMOND_ADDRESS" "facets() returns ((address,bytes4[])[])" --rpc-url "$RPC_URL") 2>/dev/null
  if [ $? -ne 0 ]; then
    echoDebug "not all core facets are registered in the diamond"
    return 1
  fi

  # extract the IDiamondLoupe.Facet tuples
  tuples=($(echo "${KNOWN_FACET_ADDRESSES:1:${#KNOWN_FACET_ADDRESSES}-2}" | sed 's/),(/) /g' | sed 's/[()]//g'))

  # extract the addresses from the tuples into an array
  ADDRESSES=()
  for tpl in "${tuples[@]}"; do
    tpl="${tpl// /}"  # remove spaces
    tpl="${tpl//\'/}" # remove single quotes
    addr="${tpl%%,*}" # extract address from tuple
    ADDRESSES+=("$addr")
  done

  # loop through all contracts
  for FACET_NAME in "${FACETS_NAMES[@]}"; do
    # get facet address from deployments file
    local FACET_ADDRESS=$(jq -r ".$FACET_NAME" "$DEPLOYMENTS_FILE")
    # check if the address is not included in the diamond
    if ! [[ " ${ADDRESSES[@]} " =~ " ${FACET_ADDRESS} " ]]; then
      echoDebug "not all core facets are registered in the diamond"

      # not included, return error code
      return 1
    fi
  done
  return 0
}
function getPeripheryAddressFromDiamond() {
  # read function arguments into variables
  local NETWORK="$1"
  local DIAMOND_ADDRESS="$2"
  local PERIPHERY_CONTRACT_NAME="$3"

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK")

  # call diamond to check for periphery address
  PERIPHERY_CONTRACT_ADDRESS=$(cast call "$DIAMOND_ADDRESS" "getPeripheryContract(string) returns (address)" "$PERIPHERY_CONTRACT_NAME" --rpc-url "${RPC_URL}")

  if [[ "$PERIPHERY_CONTRACT_ADDRESS" == "$ZERO_ADDRESS" ]]; then
    return 1
  else
    echo "$PERIPHERY_CONTRACT_ADDRESS"
    return 0
  fi
}
function getFacetFunctionSelectorsFromDiamond() {
  # THIS FUNCTION NEEDS TO BE UPDATED/FIXED BEFORE BEING USED AGAIN

  # read function arguments into variables
  local DIAMOND_ADDRESS="$1"
  local FACET_NAME="$2"
  local NETWORK="$3"
  local ENVIRONMENT="$4"
  local EXIT_ON_ERROR="$5"

  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # get facet address from deployments JSON
  local FILE_PATH="deployments/$NETWORK.${FILE_SUFFIX}json"
  local FACET_ADDRESS=$(jq -r ".$FACET_NAME" $FILE_PATH)

  # check if facet address was found
  if [[ -z "$FACET_ADDRESS" ]]; then
    error "no address found for $FACET_NAME in $FILE_PATH"
    return 1
  fi

  # get RPC URL
  local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

  # get path of diamond log file
  local DIAMOND_FILE_PATH="deployments/$NETWORK.diamond.${FILE_SUFFIX}json"

  # search in DIAMOND_FILE_PATH for the given address
  if jq -e ".facets | index(\"$FACET_ADDRESS\")" "$DIAMOND_FILE_PATH" >/dev/null; then # << this does not yet reflect the new file structure !!!!!!
    # get function selectors from diamond (function facetFunctionSelectors)
    local ATTEMPTS=1
    while [[ -z "$FUNCTION_SELECTORS" && $ATTEMPTS -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]]; do
      # get address of facet in diamond
      local FUNCTION_SELECTORS=$(cast call "$DIAMOND_ADDRESS" "facetFunctionSelectors(address) returns (bytes4[])" "$FACET_ADDRESS" --rpc-url "${!RPC}")
      ((ATTEMPTS++))
      sleep 1
    done

    if [[ "$ATTEMPTS" -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]]; then
      error "could not get facet address after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts, exiting."
      return 1
    fi
  else
    error "$FACET_NAME with address $FACET_ADDRESS is not known by diamond $DIAMOND_ADDRESS on network $NETWORK in $ENVIRONMENT environment. Please check why you tried to remove this facet from the diamond."
    return 1
  fi

  # return the selectors array
  echo "${FUNCTION_SELECTORS[@]}"
}
function getFacetAddressFromSelector() {
  # read function arguments into variables
  local DIAMOND_ADDRESS="$1"
  local FACET_NAME="$2"
  local NETWORK="$3"
  local FUNCTION_SELECTOR="$4"

  #echo "FUNCTION_SELECTOR in Func: $FUNCTION_SELECTOR"

  # get RPC URL
  local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"

  # loop until FACET_ADDRESS has a value or maximum attempts are reached
  local FACET_ADDRESS
  local ATTEMPTS=1
  while [[ -z "$FACET_ADDRESS" && $ATTEMPTS -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]]; do
    # get address of facet in diamond
    FACET_ADDRESS=$(cast call "$DIAMOND_ADDRESS" "facetAddress(bytes4) returns (address)" "$FUNCTION_SELECTOR" --rpc-url "${!RPC}")
    ((ATTEMPTS++))
    sleep 1
  done

  if [[ "$ATTEMPTS" -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]]; then
    error "could not get facet address after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts, exiting."
    return 1
  fi

  echo "$FACET_ADDRESS"
  return 0
}
function doesFacetExistInDiamond() {
  # read function arguments into variables
  local DIAMOND_ADDRESS=$1
  local FACET_NAME=$2
  local NETWORK=$3

  # get all facet selectors of the facet to be checked
  local SELECTORS=$(getFunctionSelectorsFromContractABI "$FACET_NAME")

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK")

  # loop through facet selectors and see if this selector is known by the diamond
  for SELECTOR in $SELECTORS; do
    # call diamond to get address of facet for given selector
    local RESULT=$(cast call "$DIAMOND_ADDRESS" "facetAddress(bytes4) returns (address)" "$SELECTOR" --rpc-url "$RPC_URL")

    # if result != address(0) >> facet selector is known
    if [[ "$RESULT" != "0x0000000000000000000000000000000000000000" ]]; then
      echo "true"
      return 0
    fi
  done

  echo "false"
  return 0
}
function doesAddressContainBytecode() {
  # read function arguments into variables
  NETWORK="$1"
  ADDRESS="$2"

  # check address value
  if [[ "$ADDRESS" == "null" || "$ADDRESS" == "" ]]; then
    echo "[warning]: trying to verify deployment at invalid address: ($ADDRESS)"
    return 1
  fi

  # get correct node URL for given NETWORK
  NODE_URL_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<$NETWORK | sed s/-/_/g)"
  NODE_URL=${!NODE_URL_KEY}

  # check if NODE_URL is available
  if [ -z "$NODE_URL" ]; then
    error ": no node url found for NETWORK $NETWORK. Please update your .env FILE and make sure it has a value for the following key: $NODE_URL_KEY"
    return 1
  fi

  # make sure address is in correct checksum format
  jsCode="const Web3 = require('web3');
    const web3 = new Web3();
    const address = '$ADDRESS';
    const checksumAddress = web3.utils.toChecksumAddress(address);
    console.log(checksumAddress);"
  CHECKSUM_ADDRESS=$(node -e "$jsCode")

  # get CONTRACT code from ADDRESS using web3
  jsCode="const Web3 = require('web3');
    const web3 = new Web3('$NODE_URL');
    web3.eth.getCode('$CHECKSUM_ADDRESS', (error, RESULT) => { console.log(RESULT); });"
  contract_code=$(node -e "$jsCode")

  # return ƒalse if ADDRESS does not contain CONTRACT code, otherwise true
  if [[ "$contract_code" == "0x" || "$contract_code" == "" ]]; then
    echo "false"
  else
    echo "true"
  fi
}
function getFacetAddressFromDiamond() {
  # read function arguments into variables
  local NETWORK="$1"
  local DIAMOND_ADDRESS="$2"
  local SELECTOR="$3"

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK")

  local RESULT=$(cast call "$DIAMOND_ADDRESS" "facetAddress(bytes4) returns (address)" "$SELECTOR" --rpc-url "$RPC_URL")

  echo "$RESULT"
}
function getCurrentGasPrice() {
  # read function arguments into variables
  local NETWORK=$1

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK")

  GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL")

  echo "$GAS_PRICE"
}
function getContractOwner() {
  # read function arguments into variables
  local network=$1
  local environment=$2
  local contract=$3

  # get RPC URL
  rpc_url=$(getRPCUrl "$network")

  # get contract address
  local address=$(getContractAddressFromDeploymentLogs "$network" "$environment" "$contract")

  # check if address was found
  if [[ $? -ne 0 || -z $address ]]; then
    echoDebug "could not find address of '$contract' in network-specific deploy log"
    return 1
  fi

  # get owner
  owner=$(cast call "$address" "owner()" --rpc-url "$rpc_url")

  if [[ $? -ne 0 || -z $owner ]]; then
    echoDebug "unable to retrieve owner of $contract with address $address on network $network ($environment)"
    return 1
  fi

  echo "$owner"
  return 0
}
function getPendingContractOwner() {
  # read function arguments into variables
  local network=$1
  local environment=$2
  local contract=$3

  # get RPC URL
  rpc_url=$(getRPCUrl "$network")

  # get contract address
  local address=$(getContractAddressFromDeploymentLogs "$network" "$environment" "$contract")

  # check if address was found
  if [[ $? -ne 0 || -z $address ]]; then
    echoDebug "could not find address of '$contract' in network-specific deploy log"
    return 1
  fi

  # get owner
  owner=$(cast call "$address" "pendingOwner()" --rpc-url "$rpc_url")

  if [[ $? -ne 0 || -z $owner ]]; then
    echoDebug "unable to retrieve pending owner of $contract with address $address on network $network ($environment)"
    return 1
  fi

  echo "$owner"
  return 0
}
# <<<<<< read from blockchain

# >>>>>> miscellaneous
function doNotContinueUnlessGasIsBelowThreshold() {
  # read function arguments into variables
  local NETWORK=$1

  if [ "$NETWORK" != "mainnet" ]; then
    return 0
  fi

  echo "ensuring gas price is below maximum threshold as defined in config (for mainnet only)"

  # Start the do-while loop
  while true; do
    # Get the current gas price
    CURRENT_GAS_PRICE=$(getCurrentGasPrice "mainnet")

    # Check if the counter variable has reached 10
    if [ "$MAINNET_MAXIMUM_GAS_PRICE" -gt "$CURRENT_GAS_PRICE" ]; then
      # If the counter variable has reached 10, exit the loop
      echo "gas price ($CURRENT_GAS_PRICE) is below maximum threshold ($MAINNET_MAXIMUM_GAS_PRICE) - continuing with script execution"
      return 0
    else
      echo "gas price ($CURRENT_GAS_PRICE) is above maximum ($MAINNET_MAXIMUM_GAS_PRICE) - waiting..."
      echo ""
    fi

    # wait 5 seconds before checking gas price again
    sleep 5
  done
}
function getRPCUrl() {
  # read function arguments into variables
  local NETWORK=$1

  # get RPC KEY
  RPC_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK" | sed s/-/_/g)"

  # return RPC URL
  echo "${!RPC_KEY}"
}
function playNotificationSound() {
  if [[ "$NOTIFICATION_SOUNDS" == *"true"* ]]; then
    afplay ./script/deploy/resources/notification.mp3
  fi
}
function deployAndAddContractToDiamond() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  CONTRACT="$3"
  DIAMOND_CONTRACT_NAME="$4"
  VERSION="$5"

  # logging for debug purposes
  echo ""
  echoDebug "in function deployAndAddContractToDiamond"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "CONTRACT=$CONTRACT"
  echoDebug "DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
  echoDebug "VERSION=$VERSION"
  echo ""

  # check which type of contract we are deploying
  if [[ "$CONTRACT" == *"Facet"* ]]; then
    # deploying a facet
    deployFacetAndAddToDiamond "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_CONTRACT_NAME" "$VERSION"
    return 0
  elif [[ "$CONTRACT" == *"LiFiDiamond"* ]]; then
    # deploying a diamond
    deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" false
    return 0
  else
    # deploy periphery contract
    deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" false "$DIAMOND_CONTRACT_NAME"

    # save return code
    RETURN_CODE1=$?

    # update periphery registry in diamond
    diamondUpdatePeriphery "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" false false "$CONTRACT"
    RETURN_CODE2=$?

    if [[ "$RETURN_CODE1" -eq 0 || "$RETURN_CODE2" -eq 0 ]]; then
      return 0
    else
      return 1
    fi
  fi

  # there was an error if we reach this code
  return 1
}
function getPrivateKey() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"

  # skip for local network
  if [[ "$NETWORK" == "localanvil" || "$NETWORK" == "LOCALANVIL" ]]; then
    echo "$PRIVATE_KEY_ANVIL"
    return 0
  fi

  # check environment value
  if [[ "$ENVIRONMENT" == *"staging"* ]]; then
    # check if env variable is set/available
    if [[ -z "$PRIVATE_KEY" ]]; then
      error "could not find PRIVATE_KEY value in your .env file"
      return 1
    else
      echo "$PRIVATE_KEY"
      return 0
    fi
  else
    # check if env variable is set/available
    if [[ -z "$PRIVATE_KEY_PRODUCTION" ]]; then
      error "could not find PRIVATE_KEY_PRODUCTION value in your .env file"
      return 1
    else
      echo "$PRIVATE_KEY_PRODUCTION"
      return 0
    fi
  fi
}
function getChainId() {
  # read function arguments into variables
  NETWORK="$1"

  # return chainId
  case $NETWORK in
  "mainnet")
    echo "1"
    return 0
    ;;
  "bsc")
    echo "56"
    return 0
    ;;
  "polygon")
    echo "137"
    return 0
    ;;
  "gnosis")
    echo "100"
    return 0
    ;;
  "fantom")
    echo "250"
    return 0
    ;;
  "okx")
    echo "66"
    return 0
    ;;
  "avalanche")
    echo "43114"
    return 0
    ;;
  "arbitrum")
    echo "42161"
    return 0
    ;;
  "optimism")
    echo "10"
    return 0
    ;;
  "moonriver")
    echo "1285"
    return 0
    ;;
  "moonbeam")
    echo "1284"
    return 0
    ;;
  "celo")
    echo "42220"
    return 0
    ;;
  "fuse")
    echo "122"
    return 0
    ;;
  "cronos")
    echo "25"
    return 0
    ;;
  "velas")
    echo "106"
    return 0
    ;;
  "harmony")
    echo "1666600000"
    return 0
    ;;
  "evmos")
    echo "9001"
    return 0
    ;;
  "aurora")
    echo "1313161554"
    return 0
    ;;
  "boba")
    echo "288"
    return 0
    ;;
  "nova")
    echo "87"
    return 0
    ;;
  "goerli")
    echo "5"
    return 0
    ;;
  "bsc-testnet")
    echo "97"
    return 0
    ;;
  "sepolia")
    echo "11155111"
    return 0
    ;;
  "mumbai")
    echo "80001"
    return 0
    ;;
  "lineatest")
    echo "59140"
    return 0
    ;;
  "linea")
    echo "59144"
    return 0
    ;;
  "localanvil")
    echo "31337"
    return 0
    ;;
  *)
    return 1
    ;;
  esac

}
function printDeploymentsStatus() {
  # read function arguments into variables
  ENVIRONMENT="$1"
  echo ""
  echo "+--------------------------------------+------------+------------+-----------+"
  printf "+------------------------- ENVIRONMENT: %-10s --------------------------+\n" "$ENVIRONMENT"
  echo "+--------------------------------------+-----------+-------------+-----------+"
  echo "|                                      |  target   |   target    |           |"
  echo "|       Facet (latest version)         | (mutable) | (immutable) |  current  |"
  echo "+--------------------------------------+-----------+-------------+-----------+"

  # Check if target state FILE exists
  if [ ! -f "$TARGET_STATE_PATH" ]; then
    error "target state FILE does not exist in path $TARGET_STATE_PATH"
    exit 1
  fi

  # get an arrqay with all contracts (sorted: diamonds, coreFacets, nonCoreFacets, periphery)
  local ALL_CONTRACTS=$(getAllContractNames "false")

  # get a list of all networks
  local NETWORKS=$(getAllNetworksArray)

  # define column width for table
  FACET_COLUMN_WIDTH=38
  TARGET_COLUMN_WIDTH=11
  CURRENT_COLUMN_WIDTH=10

  # go through all contracts
  for CONTRACT in ${ALL_CONTRACTS[*]}; do
    # get current contract version
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${CURRENT_COLUMN_WIDTH}s|\n" " $CONTRACT ($CURRENT_VERSION)" "" "" ""

    for NETWORK in ${NETWORKS[*]}; do
      PRINTED=false
      #echo "  NETWORK: $NETWORK"

      # get highest deployed version from master log
      HIGHEST_VERSION_DEPLOYED=$(getHighestDeployedContractVersionFromMasterLog "$NETWORK" "$ENVIRONMENT" "$CONTRACT")
      RETURN_CODE3=$?

      # check if contract has entry in target state
      TARGET_VERSION_DIAMOND=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamond")
      RETURN_CODE1=$?
      TARGET_VERSION_DIAMOND_IMMUTABLE=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamondImmutable")
      RETURN_CODE2=$?

      if [ "$RETURN_CODE1" -eq 0 ]; then
        TARGET_ENTRY_1=$TARGET_VERSION_DIAMOND
      else
        TARGET_ENTRY_1=""
      fi

      if [ "$RETURN_CODE2" -eq 0 ]; then
        TARGET_ENTRY_2=$TARGET_VERSION_DIAMOND_IMMUTABLE
      else
        TARGET_ENTRY_2=""
      fi

      if [[ "$RETURN_CODE1" -eq 0 || "$RETURN_CODE2" -eq 0 ]]; then
        #echo "TARGET_VERSION_DIAMOND: $TARGET_VERSION_DIAMOND"
        printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${CURRENT_COLUMN_WIDTH}s|\n" "  -$NETWORK" "  $TARGET_ENTRY_1" "  $TARGET_ENTRY_2" "  $HIGHEST_VERSION_DEPLOYED"
      fi

    done

    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${CURRENT_COLUMN_WIDTH}s|\n" "" "" "" ""

  done
  echo "+--------------------------------------+------------+------------+-----------+"
  return 0
}
function printDeploymentsStatusV2() {
  # read function arguments into variables
  ENVIRONMENT="$1"

  OUTPUT_FILE_PATH="target_vs_deployed_""$ENVIRONMENT"".txt"

  echo ""
  echo "+------------------------------------------------------------------------------+"
  echo "+------------------------- TARGET STATE vs. ACTUAL STATE ----------------------+"
  echo "+                                                                              +"
  echo "+ (will only list networks for which an entry exists in target or deploy log)  +"
  echo "+------------------------------------------------------------------------------+"
  printf "+-------------------------- ENVIRONMENT: %-10s ---------------------------+\n" "$ENVIRONMENT"
  echo "+--------------------------------------+-------------------+-------------------+"
  echo "|                                      |      mutable      |     immutable     |"
  echo "|      Contract (latest version)       | target : deployed | target : deployed |"
  echo "+--------------------------------------+-------------------+-------------------+"

  echo "" >$OUTPUT_FILE_PATH
  echo "+------------------------------------------------------------------------------+" >>$OUTPUT_FILE_PATH
  echo "+------------------------- TARGET STATE vs. ACTUAL STATE ----------------------+" >>$OUTPUT_FILE_PATH
  echo "+                                                                              +" >>$OUTPUT_FILE_PATH
  echo "+ (will only list networks for which an entry exists in target or deploy log)  +" >>$OUTPUT_FILE_PATH
  echo "+------------------------------------------------------------------------------+" >>$OUTPUT_FILE_PATH
  printf "+-------------------------- ENVIRONMENT: %-10s ---------------------------+\n" "$ENVIRONMENT" >>$OUTPUT_FILE_PATH
  echo "+--------------------------------------+-------------------+-------------------+" >>$OUTPUT_FILE_PATH
  echo "|                                      |      mutable      |     immutable     |" >>$OUTPUT_FILE_PATH
  echo "|      Contract (latest version)       | target : deployed | target : deployed |" >>$OUTPUT_FILE_PATH
  echo "+--------------------------------------+-------------------+-------------------+" >>$OUTPUT_FILE_PATH

  # Check if target state FILE exists
  if [ ! -f "$TARGET_STATE_PATH" ]; then
    error "target state FILE does not exist in path $TARGET_STATE_PATH"
    exit 1
  fi

  # get an arrqay with all contracts (sorted: diamonds, coreFacets, nonCoreFacets, periphery)
  local ALL_CONTRACTS=$(getAllContractNames "false")

  # get a list of all networks
  local NETWORKS=$(getIncludedNetworksArray)

  # define column width for table
  FACET_COLUMN_WIDTH=38
  TARGET_COLUMN_WIDTH=18

  # go through all contracts
  for CONTRACT in ${ALL_CONTRACTS[*]}; do
    #      if [ "$CONTRACT" != "LiFiDiamondImmutable" ] ; then
    #        continue
    #      fi

    # get current contract version
    CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s|\n" " $CONTRACT ($CURRENT_VERSION)" "" "" ""
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s|\n" " $CONTRACT ($CURRENT_VERSION)" "" "" "" >>$OUTPUT_FILE_PATH

    # go through all networks
    for NETWORK in ${NETWORKS[*]}; do
      # skip any network that is a testnet
      if [[ "$TEST_NETWORKS" == *"$NETWORK"* ]]; then
        continue
      fi

      # (re-)set entry values
      TARGET_ENTRY_1="  -  "
      TARGET_ENTRY_2="  -  "
      DEPLOYED_ENTRY_1="  -  "
      DEPLOYED_ENTRY_2="  -  "
      KNOWN_VERSION=""
      MUTABLE_ENTRY_COMBINED=""
      IMMUTABLE_ENTRY_COMBINED=""

      # check if contract has entry in target state
      TARGET_VERSION_DIAMOND=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamond")
      RETURN_CODE1=$?
      TARGET_VERSION_DIAMOND_IMMUTABLE=$(findContractVersionInTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "LiFiDiamondImmutable")
      RETURN_CODE2=$?

      # if entry was found in target state, prepare data for entry in table (if not default value will be used to preserve formatting)
      if [ "$RETURN_CODE1" -eq 0 ]; then
        TARGET_ENTRY_1=$TARGET_VERSION_DIAMOND
      fi
      if [ "$RETURN_CODE2" -eq 0 ]; then
        TARGET_ENTRY_2=$TARGET_VERSION_DIAMOND_IMMUTABLE
      fi

      # check if contract has entry in diamond deployment log
      LOG_INFO_DIAMOND=$(getContractInfoFromDiamondDeploymentLogByName "$NETWORK" "$ENVIRONMENT" "LiFiDiamond" "$CONTRACT")
      RETURN_CODE3=$?
      LOG_INFO_DIAMOND_IMMUTABLE=$(getContractInfoFromDiamondDeploymentLogByName "$NETWORK" "$ENVIRONMENT" "LiFiDiamondImmutable" "$CONTRACT")
      RETURN_CODE4=$?

      # check if entry was found in diamond deployment log (if version == null, replace with "unknown")
      if [ "$RETURN_CODE3" -eq 0 ]; then
        KNOWN_VERSION=$(echo "$LOG_INFO_DIAMOND" | jq -r '.[].Version')
        if [[ "$KNOWN_VERSION" == "null" || "$KNOWN_VERSION" == "" ]]; then
          DEPLOYED_ENTRY_1=" n/a"
        else
          DEPLOYED_ENTRY_1=$KNOWN_VERSION
        fi
      fi
      if [ "$RETURN_CODE4" -eq 0 ]; then
        KNOWN_VERSION=$(echo "$LOG_INFO_DIAMOND_IMMUTABLE" | jq -r '.[].Version')

        if [[ "$KNOWN_VERSION" == "null" || "$KNOWN_VERSION" == "" ]]; then
          DEPLOYED_ENTRY_2=" n/a"
        else
          DEPLOYED_ENTRY_2=$KNOWN_VERSION
        fi
      fi

      # print new line if any entry was found in either target state or diamond deploy log
      if [[ "$RETURN_CODE1" -eq 0 || "$RETURN_CODE2" -eq 0 || "$RETURN_CODE3" -eq 0 || "$RETURN_CODE4" -eq 0 ]]; then
        # prepare entries (to preserve formatting)
        MUTABLE_ENTRY_COMBINED="$TARGET_ENTRY_1"" : ""$DEPLOYED_ENTRY_1"
        IMMUTABLE_ENTRY_COMBINED="$TARGET_ENTRY_2"" : ""$DEPLOYED_ENTRY_2"

        if [ "$CONTRACT" == "LiFiDiamond" ]; then
          IMMUTABLE_ENTRY_COMBINED=""
        elif [ "$CONTRACT" == "LiFiDiamondImmutable" ]; then
          MUTABLE_ENTRY_COMBINED=""
        fi

        # determine color codes
        COLOR_CODE_1=$NC
        COLOR_CODE_2=$NC
        if [[ "$TARGET_ENTRY_1" != *"-"* && "$DEPLOYED_ENTRY_1" != *"-"* ]]; then
          if [[ "$TARGET_ENTRY_1" == "$DEPLOYED_ENTRY_1" ]]; then
            COLOR_CODE_1=$GREEN
          else
            COLOR_CODE_1=$RED
          fi
        fi
        if [[ "$TARGET_ENTRY_2" != *"-"* && "$DEPLOYED_ENTRY_2" != *"-"* ]]; then
          if [[ "$TARGET_ENTRY_2" == "$DEPLOYED_ENTRY_2" ]]; then
            COLOR_CODE_2=$GREEN
          else
            COLOR_CODE_2=$RED
          fi
        fi

        # print new line in table view
        printf "|%-${FACET_COLUMN_WIDTH}s| $COLOR_CODE_1 %-15s $NC | $COLOR_CODE_2 %-15s $NC |\n" "  -$NETWORK" " $MUTABLE_ENTRY_COMBINED" " $IMMUTABLE_ENTRY_COMBINED"
        printf "|%-${FACET_COLUMN_WIDTH}s| %-17s | %-17s |\n" "  -$NETWORK" " $MUTABLE_ENTRY_COMBINED" " $IMMUTABLE_ENTRY_COMBINED" >>$OUTPUT_FILE_PATH
      fi
    done

    # print empty line
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s|\n" "" "" "" ""
    printf "|%-${FACET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s| %-${TARGET_COLUMN_WIDTH}s|\n" "" "" "" "" >>$OUTPUT_FILE_PATH
  done

  # print closing line
  echo "+--------------------------------------+-------------------+-------------------+"
  echo "+--------------------------------------+-------------------+-------------------+" >>$OUTPUT_FILE_PATH
  return 0

  playNotificationSound
}
function checkDeployRequirements() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  CONTRACT="$3"

  echo ""
  echoDebug "checking if all information required for deployment is available for $CONTRACT on $NETWORK in $ENVIRONMENT environment"

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # part 1: check configData requirements
  CONFIG_REQUIREMENTS=($(jq -r --arg CONTRACT "$CONTRACT" '.[$CONTRACT].configData | select(type == "object") | keys[]' "$DEPLOY_REQUIREMENTS_PATH"))

  # check if configData requirements were found
  if [ ${#CONFIG_REQUIREMENTS[@]} -gt 0 ]; then
    # go through array with requirements
    for REQUIREMENT in "${CONFIG_REQUIREMENTS[@]}"; do
      # get configFileName
      CONFIG_FILE=$(jq -r --arg CONTRACT "$CONTRACT" --arg REQUIREMENT "$REQUIREMENT" '.[$CONTRACT].configData[$REQUIREMENT].configFileName' "$DEPLOY_REQUIREMENTS_PATH")

      # get keyInConfigFile
      KEY_IN_FILE=$(jq -r --arg CONTRACT "$CONTRACT" --arg REQUIREMENT "$REQUIREMENT" '.[$CONTRACT].configData[$REQUIREMENT].keyInConfigFile' "$DEPLOY_REQUIREMENTS_PATH")
      # replace '<NETWORK>' with actual network, if needed
      KEY_IN_FILE=${KEY_IN_FILE//<NETWORK>/$NETWORK}

      # get full config file path
      CONFIG_FILE_PATH="$DEPLOY_CONFIG_FILE_PATH""$CONFIG_FILE"

      # check if file exists
      if ! checkIfFileExists "$CONFIG_FILE_PATH" >/dev/null; then
        error "file does not exist: $CONFIG_FILE_PATH (access attempted by function 'checkDeployRequirements')"
        return 1
      fi

      # try to read value from config file
      VALUE=$(jq -r "$KEY_IN_FILE" "$CONFIG_FILE_PATH")

      # check if data is available in config file
      if [[ "$VALUE" != "null" && "$VALUE" != "" ]]; then
        echoDebug "address information for parameter $REQUIREMENT found in $CONFIG_FILE_PATH"
      else
        echoDebug "address information for parameter $REQUIREMENT not found in $CONFIG_FILE_PATH"

        # check if it's allowed to deploy with zero address
        DEPLOY_FLAG=$(jq -r --arg CONTRACT "$CONTRACT" --arg REQUIREMENT "$REQUIREMENT" '.[$CONTRACT].configData[$REQUIREMENT].allowToDeployWithZeroAddress' "$DEPLOY_REQUIREMENTS_PATH")

        # continue with script depending on DEPLOY_FLAG
        if [[ "$DEPLOY_FLAG" == "true" ]]; then
          # if yes, deployment is OK
          warning "contract $CONTRACT will be deployed with zero address as argument for parameter $REQUIREMENT since this information was missing in $CONFIG_FILE_PATH for network $NETWORK"
        else
          # if no, return "do not deploy"
          error "contract $CONTRACT cannot be deployed with zero address as argument for parameter $REQUIREMENT and this information is missing in $CONFIG_FILE_PATH for network $NETWORK"
          return 1
        fi
      fi
    done
  fi

  # part 2: check required contractAddresses
  # read names of required contract addresses into array
  DEPENDENCIES=($(jq -r --arg CONTRACT "$CONTRACT" '.[$CONTRACT].contractAddresses | select(type == "object") | keys[]' "$DEPLOY_REQUIREMENTS_PATH"))

  # check if dependencies were found
  if [ ${#DEPENDENCIES[@]} -gt 0 ]; then
    # get file name for network deploy log
    ADDRESSES_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

    # check if file exists
    if ! checkIfFileExists "$ADDRESSES_FILE" >/dev/null; then
      error "file does not exist: $ADDRESSES_FILE (access attempted by function 'checkDeployRequirements')"
      return 1
    fi
    # go through array
    for DEPENDENCY in "${DEPENDENCIES[@]}"; do
      # get contract address from deploy file
      echoDebug "now looking for address of contract $DEPENDENCY in file $ADDRESSES_FILE"
      ADDRESS=$(jq -r --arg DEPENDENCY "$DEPENDENCY" '.[$DEPENDENCY]' "$ADDRESSES_FILE")

      # check if contract address is available in log file
      if [[ "$ADDRESS" != "null" && "$ADDRESS" == *"0x"* ]]; then
        echoDebug "address information for contract $DEPENDENCY found"
      else
        echoDebug "address information for contract $DEPENDENCY not found"

        # check if it's allowed to deploy with zero address
        DEPLOY_FLAG=$(jq -r --arg CONTRACT "$CONTRACT" --arg DEPENDENCY "$DEPENDENCY" '.[$CONTRACT].contractAddresses[$DEPENDENCY].allowToDeployWithZeroAddress' "$DEPLOY_REQUIREMENTS_PATH")

        # continue with script depending on DEPLOY_FLAG
        if [[ "$DEPLOY_FLAG" == "true" ]]; then
          # if yes, deployment is OK
          warning "contract $CONTRACT will be deployed with zero address as argument for parameter $DEPENDENCY since this information was missing in $ADDRESSES_FILE for network $NETWORK"
        else
          # if no, return "do not deploy"
          error "contract $CONTRACT cannot be deployed with zero address as argument for parameter $DEPENDENCY and this information is missing in $ADDRESSES_FILE for network $NETWORK"
          return 1
        fi
      fi
    done
  fi
  return 0
}
function isVersionTag() {
  # read function arguments into variable
  local STRING=$1

  # define version tag pattern
  local PATTERN="^[0-9]+\.[0-9]+\.[0-9]+$"

  if [[ $STRING =~ $PATTERN ]]; then
    return 0
  else
    return 1
  fi
}
function deployCreate3FactoryToAnvil() {
  # deploy create3Factory
  RAW_RETURN_DATA=$(PRIVATE_KEY=$PRIVATE_KEY_ANVIL forge script lib/create3-factory/script/Deploy.s.sol --fork-url http://localhost:8545 --broadcast --silent)

  # extract address of deployed factory contract
  ADDRESS=$(echo "$RAW_RETURN_DATA" | grep -o -E 'Contract Address: 0x[a-fA-F0-9]{40}' | grep -o -E '0x[a-fA-F0-9]{40}')

  # update value of CREATE3_FACTORY_ADDRESS .env variable
  export CREATE3_FACTORY_ADDRESS=$ADDRESS
  echo "$ADDRESS"
}
function getValueFromJSONFile() {
  # read function arguments into variable
  local FILE_PATH=$1
  local KEY=$2

  # check if file exists
  if ! checkIfFileExists "$FILE_PATH" >/dev/null; then
    error "file does not exist: $FILE_PATH (access attempted by function 'getValueFromJSONFile')"
    return 1
  fi

  # extract and return value from file
  VALUE=$(cat "$FILE_PATH" | jq -r ".$KEY")
  echo "$VALUE"
}
function compareAddresses() {
  # read function arguments into variable
  local address_1=$1
  local address_2=$2

  # count characters / analyze format
  local address_1_chars=${#address_1}
  local address_2_chars=${#address_2}

  # shorten address1
  if [[ $address_1_chars -gt 42 ]]; then
    address_1_short="0x"${address_1: -40}
  else
    address_1_short=$address_1
  fi

  # shorten address2
  if [[ "$address_2_chars" -gt 64 ]]; then
    address_2_short="0x"${address_2: -40}
  else
    address_2_short=$address_2
  fi

  # convert both addresses to lowercase
  address_1_short_upper=$(echo "$address_1_short" | tr '[:upper:]' '[:lower:]')
  address_2_short_upper=$(echo "$address_2_short" | tr '[:upper:]' '[:lower:]')

  # compare
  if [[ $address_1_short_upper == $address_2_short_upper ]]; then
    echo true
    return 0
  else
    echo false
    return 1
  fi
}
# <<<<<< miscellaneous

# >>>>>> helpers to set/update deployment files/logs/etc
function updateDiamondLogs() {
  # read function arguments into variable
  local NETWORK=$1

  # if no network was passed to this function, update all networks
  if [[ -z $NETWORK ]]; then
    # get array with all network names
    NETWORKS=($(getIncludedNetworksArray))
  else
    NETWORKS=($NETWORK)
  fi

  echo ""
  echo "Now updating all diamond logs on network(s): ${NETWORKS[*]}"
  echo ""

  ENVIRONMENTS=("production" "staging")
  DIAMONDS=("LiFiDiamond" "LiFiDiamondImmutable")

  # loop through all networks
  for NETWORK in "${NETWORKS[@]}"; do
    echo ""
    echo "current Network: $NETWORK"

    # >>>>  limit here to a certain network, if needed
    #    if [[ $NETWORK == "optimism" ]]; then
    #      continue
    #    fi

    # get RPC URL
    local RPC_URL="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$NETWORK")"
    RPC_URL=${!RPC_URL}
    echo "RPC_URL: $RPC_URL"

    for ENVIRONMENT in "${ENVIRONMENTS[@]}"; do
      echo " -----------------------"
      echo " current ENVIRONMENT: $ENVIRONMENT"

      # >>>>  limit here to a certain environment, if needed
      #      if [[ $ENVIRONMENT == "staging" ]]; then
      #        continue
      #      fi

      for DIAMOND in "${DIAMONDS[@]}"; do
        echo "  -----------------------"
        echo "  current DIAMOND: $DIAMOND"

        # >>>>  limit here to a certain diamond type, if needed
        #        if [[ $DIAMOND == "LiFiDiamond" ]]; then
        #          continue
        #        fi

        # define diamond type flag
        if [[ $DIAMOND == "LiFiDiamondImmutable" ]]; then
          USE_MUTABLE_DIAMOND=false
        else
          USE_MUTABLE_DIAMOND=true
        fi

        # get diamond address
        DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$DIAMOND")

        if [[ $? -ne 0 ]]; then
          continue
        else
          echo "    diamond address: $DIAMOND_ADDRESS"
        fi

        echo "    RPC_URL: $RPC_URL"

        # get list of facets
        # execute script
        attempts=1 # initialize attempts to 0

        while [ $attempts -lt 11 ]; do
          echo "    Trying to get facets for diamond $DIAMOND_ADDRESS now - attempt ${attempts}"
          # try to execute call
          KNOWN_FACET_ADDRESSES=$(cast call "$DIAMOND_ADDRESS" "facetAddresses() returns (address[])" --rpc-url "$RPC_URL") 2>/dev/null

          # check the return code the last call
          if [ $? -eq 0 ]; then
            break # exit the loop if the operation was successful
          fi

          attempts=$((attempts + 1)) # increment attempts
          sleep 1                    # wait for 1 second before trying the operation again
        done

        if [ $attempts -eq 11 ]; then
          echo "Failed to get facets"
        fi

        if [[ -z $KNOWN_FACET_ADDRESSES ]]; then
          echo "    no facets found"
          saveDiamondPeriphery "$NETWORK" "$ENVIRONMENT" "$USE_MUTABLE_DIAMOND"
        else
          saveDiamondFacets "$NETWORK" "$ENVIRONMENT" "$USE_MUTABLE_DIAMOND" "$KNOWN_FACET_ADDRESSES"
          # saveDiamondPeriphery is executed as part of saveDiamondFacets
        fi

        # check result
        if [[ $? -ne 0 ]]; then
          echo "    error"
        else
          echo "    updated"
        fi

        echo ""
      done
      echo ""
    done
    echo ""
  done
  playNotificationSound
}
# <<<<<< helpers to set/update deployment files/logs/etc

# test cases for helper functions
function test_logContractDeploymentInfo() {

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
function test_findContractInMasterLog() {
  findContractInMasterLog "DiamondCutFacet" "optimism" "production" "1.0.0"
  match=($(findContractInMasterLog "DiamondCutFacet" "optimism" "production" "1.0.0"))

  echo "Address: ${match[2]}"
  echo "Optimizer Runs: ${match[4]}"
  echo "Date: ${match[6]}"
  echo "Constructor Arguments: ${match[8]}"
}
function test_getCurrentContractVersion() {

  echo "should return error - VERSION string not found:"
  getCurrentContractVersion "AccessManagerFacet"

  echo ""
  echo "should return error - FILE not found:"
  getCurrentContractVersion "nofile"

  echo ""
  echo "should return '1.0.0':"
  getCurrentContractVersion "testfile"

  echo ""
  echo "should return '1.0.0':"
  getCurrentContractVersion "Executor"

  echo ""
  echo "should return '1.0.0':"
  getCurrentContractVersion "Receiver"

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
  for ((i = 0; i < ${#NETWORKS[@]}; i++)); do
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
  echo "should return an ARRAY with all included facet contracts: $(getIncludedFacetContractsArray "true")"
}
function test_findContractVersionInTargetState() {
  echo "should return '1.0.0: $(findContractVersionInTargetState "goerli" "production" "Executor")"
  echo "should return '1.0.1: $(findContractVersionInTargetState "goerli" "production" "Receiver")"
  echo "should return '1.0.0: $(findContractVersionInTargetState "goerli" "staging" "FeeCollector")"
  echo "should return '1.0.1: $(findContractVersionInTargetState "goerli" "staging" "RelayerCelerIM")"
}
function test_userDialogSelectDiamondType() {
  echo ""
  echo "Please select which type of diamond contract to deploy:"
  echo "should return 'LiFiDiamondImmutable': $(userDialogSelectDiamondType)"
}
function test_getFunctionSelectorsFromContractABI() {
  echo "should return {}: $(getFunctionSelectorsFromContractABI "LiFiDiamond")"
  echo "should return selectors: $(getFunctionSelectorsFromContractABI "MultichainFacet")"
}
function test_doesFacetExistInDiamond() {
  echo "should return 'true': $(doesFacetExistInDiamond "0x89fb2F8F0B6046b1Aec2915bdaAE20487395a03b" "OwnershipFacet" "goerli")"
  echo "should return 'false': $(doesFacetExistInDiamond "0x89fb2F8F0B6046b1Aec2915bdaAE20487395a03b" "HopFacet" "goerli")"
}
function test_getFunctionSelectorFromContractABI() {
  echo "should return 'ebbaa1cb': $(getFunctionSelectorFromContractABI "AllBridgeFacet" "startBridgeTokensViaAllBridge")"
  echo "should return 'aeb116de': $(getFunctionSelectorFromContractABI "AxelarFacet" "executeCallViaAxelar")"
  echo "should return 'aeb116de': $(getFunctionSelectorFromContractABI "DiamondCutFacet" "executeCallViaAxelar")"
}
function test_removeFacetFromDiamond() {
  removeFacetFromDiamond "0x89fb2F8F0B6046b1Aec2915bdaAE20487395a03b" "HopFacetOptimized" "goerli"
  removeFacetFromDiamond "0x89fb2F8F0B6046b1Aec2915bdaAE20487395a03b" "StargateFacet" "goerli"
}
function test_getFacetFunctionSelectorsFromDiamond() {
  echo "should return '[0x23452b9c,0x7200b829,0x8da5cb5b,0xf2fde38b]': $(getFacetFunctionSelectorsFromDiamond "0x1D7554F2EF87Faf41f9c678cF2501497D38c014f" "OwnershipFacet" "mainnet" "staging")"
  echo "should return '[0x536db266,0xfbb2d381,0xfcd8e49e,0x9afc19c7,0x44e2b18c,0x2d2506a9,0x124f1ead,0xc3a6a96b]': $(getFacetFunctionSelectorsFromDiamond "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" "DexManagerFacet" "bsc" "production")"
}
function test_doesDiamondHaveCoreFacetsRegistered() {
  doesDiamondHaveCoreFacetsRegistered "0x1D7554F2EF87Faf41f9c678cF2501497D38c014f" "mainnet" "staging"
  #doesDiamondHaveCoreFacetsRegistered "0x1D7554F2EF87Faf41f9c678cF2501497D38c014f" "mumbai" "staging"
}
function test_addContractVersionToTargetState() {
  addContractVersionToTargetState "mumbai" "production" "TESTNAME2" "LiFiDiamond" "1.0.6" true
  addContractVersionToTargetState "mumbai" "production" "TESTNAME2" "LiFiDiamond" "2.0.6" true
  addContractVersionToTargetState "mumbai" "staging" "TESTNAME2" "LiFiDiamond" "2.0.6" true
  addContractVersionToTargetState "mumbai" "staging" "TESTNAME2" "LiFiDiamond" "1.0.6" true

}
function test_updateExistingContractVersionInTargetState() {
  updateExistingContractVersionInTargetState "mumbai" "staging" "TESTNAME2" "LiFiDiamond" "1.1.9"
}
function test_updateContractVersionInAllIncludedNetworks() {
  updateContractVersionInAllIncludedNetworks "production" "TESTNAME2" "LiFiDiamond" "2.0.0"
}
function test_addNewContractVersionToAllIncludedNetworks() {
  addNewContractVersionToAllIncludedNetworks "production" "newContract" "LiFiDiamondImmutable" "1.0.0"
}
function test_addNewNetworkWithAllIncludedContractsInLatestVersions() {
  addNewNetworkWithAllIncludedContractsInLatestVersions "newNetwork3" "production" "LiFiDiamondImmutable"
}
function test_checkIfFileExists() {
  echo "should be true: $(checkIfFileExists "./script/DeployCelerIMFacet.s.sol")"
  echo "should be false: $(checkIfFileExists "./script/NoScript.s.sol")"
}
function test_getFacetAddressFromDiamond() {
  getFacetAddressFromDiamond "arbitrum" "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" "0xc5ae0fe6"
}
function test_getAddressOfDeployedContractFromDeploymentsFiles() {
  getAddressOfDeployedContractFromDeploymentsFiles "mumbai" "staging" "LiFiDiamondImmutable" "ContractName"
}
function test_findContractInMasterLogByAddress() {
  #findContractInMasterLogByAddress"optimism" "production" "0x49d195D3138D4E0E2b4ea88484C54AEE45B04B9F"
  findContractInMasterLogByAddress "optimism" "production" "0x49d195D3138D4E0E2b4ea88484C54AEE45B04BFd"
}
function test_getContractAddressFromDeploymentLogs() {
  echo "should be '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE': $(getContractAddressFromDeploymentLogs "arbitrum" "production" "LiFiDiamond")"
  echo "should be '0xC4B590a0E2d7e965a2Fb3647d672B5DD97E8d068': $(getContractAddressFromDeploymentLogs "arbitrum" "production" "Receiver")"
  echo "should be '0x856FF421D9b354ba1E909e26655E159F5Bd04F2E': $(getContractAddressFromDeploymentLogs "celo" "production" "ERC20Proxy")"
  echo "should be '': $(getContractAddressFromDeploymentLogs "testNetwork" "production" "LiFiDiamond")"
}
function test_getContractInfoFromDiamondDeploymentLogByName() {
  getContractInfoFromDiamondDeploymentLogByName "mainnet" "production" "LiFiDiamond" "OwnershipFacet"
  getContractInfoFromDiamondDeploymentLogByName "testNetwork" "production" "LiFiDiamond" "noFacet"
}
function test_updateAllContractsToTargetState() {
  updateAllContractsToTargetState
}
function test_getPeripheryAddressFromDiamond() {
  getPeripheryAddressFromDiamond "mainnet" "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" "Executor"
}
function test_getContractVersionFromMasterLog() {
  echo "should return '1.0.0': $(getContractVersionFromMasterLog "optimism" "production" "DexManagerFacet" "0x64D41a7B52CA910f4995b1df33ea68471138374b")"
  echo "should return '': $(getContractVersionFromMasterLog "optimism" "production" "DexManagerFacet" "0x64D41a7B52CA910f4995b1df33ea68471138374")"
  echo "should return '': $(getContractVersionFromMasterLog "optimism" "production" "DeBridgeFacet" "0x64D41a7B52CA910f4995b1df33ea68471138374")"
  echo "should return '': $(getContractVersionFromMasterLog "testNetwork" "production" "LiFiDiamond" "0x64D41a7B52CA910f4995b1df33ea68471138374")"
}
function test_getContractNameFromDeploymentLogs() {
  echo "should return 'LiFiDiamond': $(getContractNameFromDeploymentLogs "mainnet" "production" "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE")"
}

function test_tmp() {

  CONTRACT="CelerIMFacetMutable"
  NETWORK="polygonzkevm"
  ADDRESS="0x4D476e7D7dbBAF55c04987523f9307Ede62b4689"
  ENVIRONMENT="production"
  VERSION="2.0.0"
  DIAMOND_CONTRACT_NAME="LiFiDiamondImmutable"
  ARGS="0x0000000000000000000000003ad9d0648cdaa2426331e894e980d0a5ed16257f000000000000000000000000156cebba59deb2cb23742f70dcb0a11cc775591f000000000000000000000000bebcdb5093b47cd7add8211e4c77b6826af7bc5f0000000000000000000000000000000000000000000000000000000000000000"

  #  ADDRESS=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "ERC20Proxy");
  #  if [[ "$ADDRESS" != "$ZERO_ADDRESS" ]]; then
  #    error "ERC20Proxy ownership was not transferred to address(0)"
  #    exit 1
  #  fi
  getPeripheryAddressFromDiamond "$NETWORK" "0x9b11bc9FAc17c058CAB6286b0c785bE6a65492EF" "RelayerCelerIM"
}
