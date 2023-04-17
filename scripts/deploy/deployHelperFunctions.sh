#!/bin/bash
#TODO: sort & comment functions

# load env variables
source .env

# load scripts
source scripts/deploy/deployConfig.sh




# >>>>> logging
# writes information about a deployed contract into the log file (path is specified in config)
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
    echo "[debug] VERIFIED=$VERIFIED"
    echo ""
  fi

  # Check if log FILE exists, if not create it
  if [ ! -f "$LOG_FILE_PATH" ]; then
    echo "{}" > "$LOG_FILE_PATH"
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
      "$LOG_FILE_PATH" > tmpfile && mv tmpfile "$LOG_FILE_PATH"

  if [[ "$DEBUG" == *"true"* ]]; then
    echo "[info] contract deployment info added to log FILE (CONTRACT=$CONTRACT, NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, VERSION=$VERSION)"
  fi
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
    echo "[debug] VERIFIED=$VERIFIED"
    echo ""
  fi

  # Check if log FILE exists, if not create it
  if [ ! -f "$LOG_FILE_PATH" ]; then
    echo "{}" > "$LOG_FILE_PATH"
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
       '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION] += [{ ADDRESS: $ADDRESS, OPTIMIZER_RUNS: $OPTIMIZER_RUNS, TIMESTAMP: $TIMESTAMP, CONSTRUCTOR_ARGS: $CONSTRUCTOR_ARGS, VERIFIED: $VERIFIED }]' \
       "$LOG_FILE_PATH" > tmpfile && mv tmpfile "$LOG_FILE_PATH"
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
       '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION][-1] |= { ADDRESS: $ADDRESS, OPTIMIZER_RUNS: $OPTIMIZER_RUNS, TIMESTAMP: $TIMESTAMP, CONSTRUCTOR_ARGS: $CONSTRUCTOR_ARGS, VERIFIED: $VERIFIED }' \
       "$LOG_FILE_PATH" > tmpfile && mv tmpfile "$LOG_FILE_PATH"
  fi

  if [[ "$DEBUG" == *"true"* ]]; then
    echo "[info] contract deployment info added to log FILE (CONTRACT=$CONTRACT, NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, VERSION=$VERSION)"
  fi
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
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function logBytecode"
    echo "[debug] CONTRACT=$CONTRACT"
    echo "[debug] VERSION=$VERSION"
    echo ""
  fi

  # Check if log FILE exists, if not create it
  if [ ! -f "$BYTECODE_STORAGE_PATH" ]; then
    echo "{}" > "$BYTECODE_STORAGE_PATH"
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
    echo "$JSON" > "$BYTECODE_STORAGE_PATH"

    # if DEBUG
    if [[ "$DEBUG" == *"true"* ]]; then
      echo "[info] bytecode added to storage file (CONTRACT=$CONTRACT, VERSION=$VERSION)"
    fi
  else
    # match found - check if bytecode matches
    if [ "$BYTECODE" != "$LOG_RESULT" ]; then
      echo "[warning] existing bytecode in log differs from bytecode produced by this run. Please check why this happens (e.g. code changed without version bump). Bytecode storage not updated."
      return 1
    else
      if [[ "$DEBUG" == *"true"* ]]; then
        echo "[debug] bytecode already exists in log, no action needed"
      fi
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

  # Check if log file exists
  if [ ! -f "$LOG_FILE_PATH" ]; then
    echo "[error] deployments log file does not exist in path $LOG_FILE_PATH. Please check and run script again."
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
      echo "[info] No matching entry found in deployments log file for CONTRACT=$CONTRACT, NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, VERSION=$VERSION"
      return 1
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
      echo "[error]: the following filepath is invalid: $FILEPATH"
      return 1
  fi

  # Search for "@custom:version" in the file and store the first result in the variable
  local VERSION=$(grep "@custom:version" "$FILEPATH" | cut -d ' ' -f 3)

  # Check if VERSION is empty
  if [ -z "$VERSION" ]; then
      echo "[error]: '@custom:version' string not found in $FILEPATH"
      return 1
  fi

  echo "$VERSION"
}
# <<<<< logging


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

  if [[ -n "$DO_NOT_VERIFY_IN_THESE_NETWORKS" &&  "$NETWORK" == *"$DO_NOT_VERIFY_IN_THESE_NETWORKS"* ]]; then
    echo " it is true that the string '$NETWORK' is a substring of '$DO_NOT_VERIFY_IN_THESE_NETWORKS' "
      if [[ "$DEBUG" == *"true"* ]]; then
        echo "[debug] network $NETWORK is excluded for contract verification, therefore verification of contract $CONTRACT will be skipped"
        return 0
      fi
  fi

  # verify contract using forge
  MAX_RETRIES=$MAX_ATTEMPTS_PER_CONTRACT_VERIFICATION
  RETRY_COUNT=0
  COMMAND_STATUS=1

  while [ $COMMAND_STATUS -ne 0 -a $RETRY_COUNT -lt $MAX_RETRIES ]
  do
    if [ "$ARGS" = "0x" ]; then
      # only show output if DEBUG flag is activated
      if [[ "$DEBUG" == *"true"* ]]; then
        forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT -e "${!API_KEY}"
      else
        forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT -e "${!API_KEY}" >/dev/null 2>&1
      fi
    else
      # only show output if DEBUG flag is activated
      if [[ "$DEBUG" == *"true"* ]]; then
        forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT --constructor-args $ARGS -e "${!API_KEY}"
      else
        forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT --constructor-args $ARGS -e "${!API_KEY}"  >/dev/null 2>&1
      fi
    fi
    COMMAND_STATUS=$?
    RETRY_COUNT=$((RETRY_COUNT+1))
  done

  # check the return status of the contract verification call
  if [ $COMMAND_STATUS -ne 0 ]
  then
    echo "[warning] $CONTRACT on $NETWORK with address $ADDRESS could not be verified"
    return 1
  else
    echo "[info] $CONTRACT on $NETWORK with address $ADDRESS successfully verified"
  fi

  # return command status 0 (to make sure failed verification does not stop script)
  return 0
}
function verifyAllUnverifiedContractsInLogFile() {
  local log_file=$LOG_FILE_PATH

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

     # Read ENVIRONMENT keys for the network
     ENVIRONMENTS=($(jq -r ".${CONTRACT}.${NETWORK} | keys[]" "$LOG_FILE_PATH"))

      # go through all environments
      for ENVIRONMENT in "${ENVIRONMENTS[@]}"; do

         # Read VERSION keys for the network
         VERSIONS=($(jq -r ".${CONTRACT}.${NETWORK}.${ENVIRONMENT} | keys[]" "$LOG_FILE_PATH"))

        # go through all versions
        for VERSION in "${VERSIONS[@]}"; do

          # get values of current entry
          ENTRY=$(cat "$LOG_FILE_PATH" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg VERSION "$VERSION" '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION][0]')

          # extract necessary information from log
          ADDRESS=$(echo "$ENTRY" | awk -F'"' '/"ADDRESS":/{print $4}')
          VERIFIED=$(echo "$ENTRY" | awk -F'"' '/"VERIFIED":/{print $4}')
          OPTIMIZER_RUNS=$(echo "$ENTRY" | awk -F'"' '/"OPTIMIZER_RUNS":/{print $4}')
          TIMESTAMP=$(echo "$ENTRY" | awk -F'"' '/"TIMESTAMP":/{print $4}')
          CONSTRUCTOR_ARGS=$(echo "$ENTRY" | awk -F'"' '/"CONSTRUCTOR_ARGS":/{print $4}')

          # check if contract is verified
          if [[ "$VERIFIED" != "true" ]]
          then
            echo ""
            echo "[info] trying to verify contract $CONTRACT on $NETWORK with address $ADDRESS...."
            verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$CONSTRUCTOR_ARGS"

            # check result
            if [ $? -eq 0 ]; then
              # update log file
              logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER_RUNS" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS" "true"

              # increase COUNTER
              COUNTER++
            fi
          fi
        done
      done
    done
  done

  echo "[info] done (verified contracts: $COUNTER)"
}


function tmp() {
    # Check if contract needs to be verified
    if [[ "$VERIFIED" == "false" ]]; then
        echo "Verifying contract: $CONTRACT, Network: $NETWORK, Environment: $ENVIRONMENT, Version: $VERSION"

        # Replace the following line with your command to verify the contract
        # You can use the variables extracted from the log entry as input to your command
        verifyContractCommand "$CONTRACT" "$VERSION" "$ENVIRONMENT" "$ADDRESS"

        # Update the log file to mark contract as verified
        jq --arg CONTRACT "$CONTRACT" \
           --arg NETWORK "$NETWORK" \
           --arg ENVIRONMENT "$ENVIRONMENT" \
           --arg VERSION "$VERSION" \
           '.[$CONTRACT][$NETWORK][$ENVIRONMENT][$VERSION][-1].VERIFIED = "true"' \
           "$LOG_FILE_PATH" > tmpfile && mv tmpfile "$LOG_FILE_PATH"





    fi
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
function getAllContractNames() {
  # will return the names of all contracts in the following folders:
  # src
  # src/Facets
  # src/Periphery

  # get all facet contracts
  local FACET_CONTRACTS=$(getIncludedAndSortedFacetContractsArray)

  # get all periphery contracts
  local PERIPHERY_CONTRACTS=$(getIncludedPeripheryContractsArray)

  # get all diamond contracts
  local DIAMOND_CONTRACTS=$(getContractNamesInFolder "src")

  # merge
  local ALL_CONTRACTS=("${FACET_CONTRACTS[@]}" "${PERIPHERY_CONTRACTS[@]}" "${DIAMOND_CONTRACTS[@]}")

  # Print the resulting array
  echo "${ALL_CONTRACTS[*]}"
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
function getIncludedAndSortedFacetContractsArray() {
  # get all facet contracts
  FACET_CONTRACTS=($(getIncludedFacetContractsArray))

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
function findContractVersionInTargetState() {
  # read function arguments into variables
  NETWORK="$1"
  ENVIRONMENT="$2"
  CONTRACT="$3"
  DIAMOND_NAME=$4

  # Check if target state FILE exists
  if [ ! -f "$TARGET_STATE_PATH" ]; then
    echo "[error] target state FILE does not exist in path $TARGET_STATE_PATH"
    exit 1
  fi

  # find matching entry
    local TARGET_STATE_FILE=$(cat "$TARGET_STATE_PATH")
    local RESULT=$(echo "$TARGET_STATE_FILE" | jq --arg CONTRACT "$CONTRACT" --arg NETWORK "$NETWORK" --arg ENVIRONMENT "$ENVIRONMENT" --arg DIAMOND_NAME "$DIAMOND_NAME" --arg VERSION "$VERSION" '.[$NETWORK][$ENVIRONMENT][$DIAMOND_NAME][$CONTRACT]')

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
function userDialogSelectDiamondType() {
  # ask user to select diamond type
  SELECTION=$(gum choose \
    "1) Mutable"\
    "2) Immutable"\
    )

  # select correct contract name based on user selection
  if [[ "$SELECTION" == *"1)"* ]]; then
    DIAMOND_CONTRACT_NAME="LiFiDiamond"
  elif [[ "$SELECTION" == *"2)"* ]]; then
    DIAMOND_CONTRACT_NAME="LiFiDiamondImmutable"
  else
    echo "[error] invalid value selected: $SELECTION - exiting script now"
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
    echo "[error] invalid network selection"
    return 1
  fi

  # make sure all required .env variables are set
  checkRequiredVariablesInDotEnv "$NETWORK"

  echo "$NETWORK"
  return 0
}

function determineEnvironment() {
  # check if env variable "PRODUCTION" is true (or not set at all), otherwise deploy as staging
  if [[ "$PRODUCTION" == "true" ]]; then
    # make sure that PRODUCTION was selected intentionally by user
    gum style \
    --foreground 212 --border-foreground 213 --border double \
    --align center --width 50 --margin "1 2" --padding "2 4" \
    '!!! ATTENTION !!!'

    echo "Your environment variable PRODUCTION is set to true"
    echo "This means you will be deploying contracts to production"
    echo "    "
    echo "Do you want to skip?"
    gum confirm && exit 1 || echo "OK, continuing to deploy to PRODUCTION"

    echo "production"
  else
    echo "staging"
  fi
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
  IFS=',' read -ra SELECTOR_ARRAY <<< "$SELECTORS"
  for SELECTOR in "${SELECTOR_ARRAY[@]}"; do
      BYTES4_SELECTORS+=("0x${SELECTOR}")
  done

  # return the selectors array
  echo "${BYTES4_SELECTORS[@]}"
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
  local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")"

  local ZERO_ADDRESS=0x0000000000000000000000000000000000000000

  # go through list of facet selectors and find out which of those is known by the diamond
  for SELECTOR in $FUNCTION_SELECTORS
  do
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
      cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$PRIVATE_KEY" --rpc-url "${!RPC}" --legacy
    else
      # do not print output to console
      cast send "$DIAMOND_ADDRESS" "$ENCODED_ARGS" --private-key "$PRIVATE_KEY" --rpc-url "${!RPC}" --legacy >/dev/null 2>&1
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
    echo "[error] failed to remove $FACET_NAME from $DIAMOND_ADDRESS on network $NETWORK"
    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  if [[ "$DEBUG" == *"true"* ]]; then
    echo "[info] successfully removed $FACET_NAME from $DIAMOND_ADDRESS on network $NETWORK"
  fi
}
function checkRequiredVariablesInDotEnv() {
  # read function arguments into variables
  local NETWORK=$1

  local PRIVATE_KEY="$PRIVATE_KEY"
  local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")"
  local RPC_URL="${!RPC}"
  local BLOCKEXPLORER_API="$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")""_ETHERSCAN_API_KEY"
  local BLOCKEXPLORER_API_KEY="${!BLOCKEXPLORER_API}"

  if [[ -z "$PRIVATE_KEY" || -z "$RPC_URL" || -z "$BLOCKEXPLORER_API_KEY" ]]; then
    # throw error if any of the essential keys is missing
    echo "[error] your .env file is missing essential entries for this network (required are: PRIVATE_KEY, $RPC and $BLOCKEXPLORER_API)"
    return 1
  fi

  # all good - continue
  return 0
}
function checkIfFileExists(){
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

# >>>>> Manipulation of target state JSON file
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
      if [[ "$DEBUG" == *"true"* ]]; then
        echo "[warning]: target state file already contains an entry for NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, and CONTRACT_NAME:$CONTRACT_NAME."
      fi
      # exit script
      return 1
    else
      if [[ "$DEBUG" == *"true"* ]]; then
        echo "[warning]: target state file already contains an entry for NETWORK:$NETWORK, ENVIRONMENT:$ENVIRONMENT, DIAMOND_NAME:$DIAMOND_NAME, and CONTRACT_NAME:$CONTRACT_NAME. Updating version."
      fi
    fi
  fi

  # add or update target state file
  jq ".\"${NETWORK}\" = (.\"${NETWORK}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" = \"${VERSION}\"" $TARGET_STATE_PATH > temp.json && mv temp.json $TARGET_STATE_PATH
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
    jq ".\"${NETWORK}\" = (.\"${NETWORK}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" = (.\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\" // {}) | .\"${NETWORK}\".\"${ENVIRONMENT}\".\"${DIAMOND_NAME}\".\"${CONTRACT_NAME}\" = \"${VERSION}\"" $TARGET_STATE_PATH > temp.json && mv temp.json $TARGET_STATE_PATH
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
  for NETWORK in $NETWORKS
  do
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
  for NETWORK in $NETWORKS
  do
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
    echo "[error] function addNewNetworkWithAllIncludedContractsInLatestVersions called with invalid parameters: NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, DIAMOND_NAME=$DIAMOND_NAME"
    return 1
  fi

  # get all facet contracts
  local FACET_CONTRACTS=$(getIncludedAndSortedFacetContractsArray)

  # get all periphery contracts
  local PERIPHERY_CONTRACTS=$(getIncludedPeripheryContractsArray)

  # merge all contracts into one array
  local ALL_CONTRACTS=("$DIAMOND_NAME" "${FACET_CONTRACTS[@]}" "${PERIPHERY_CONTRACTS[@]}")

  # go through all contracts
  for CONTRACT in ${ALL_CONTRACTS[*]}
  do
      # get current contract version
      CURRENT_VERSION=$(getCurrentContractVersion "$CONTRACT")

      # add to target state json
      addContractVersionToTargetState "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_NAME" "$CURRENT_VERSION" true
      if [ $? -ne 0 ]
      then
        echo "[error] could not add contract version to target state for NETWORK=$NETWORK, ENVIRONMENT=$ENVIRONMENT, CONTRACT=$CONTRACT, DIAMOND_NAME=$DIAMOND_NAME, VERSION=$CURRENT_VERSION"
      fi
  done
}
# <<<<<< Manipulation of target state JSON file

# >>>>> read from blockchain

function getContractAddressFromSalt() {
  # read function arguments into variables
  local SALT=$1
  local NETWORK=$2
  local CONTRACT_NAME=$3

  # get RPC URL
  local RPC_URL="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")"

  # get deployer address
  local DEPLOYER_ADDRESS=$(getDeployerAddress)


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
    # prepare web3 code to be executed
    jsCode="const Web3 = require('web3');
      const web3 = new Web3();
      const deployerAddress = (web3.eth.accounts.privateKeyToAccount('$PRIVATE_KEY')).address
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

  # get RPC URL
  RPC_URL=$(getRPCUrl "$NETWORK")

  # get deployer address
  ADDRESS=$(getDeployerAddress)

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

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function doesDiamondHaveCoreFacetsRegistered"
    echo "[debug] DIAMOND_ADDRESS=$DIAMOND_ADDRESS"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
    echo ""
  fi

  # get file with deployment addresses
  DEPLOYMENTS_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  # get RPC URL for given network
  RPC_URL=$(getRPCUrl "$NETWORK")

  # get list of all core facet contracts from config
  IFS=',' read -ra FACETS_NAMES <<< "$CORE_FACETS"

  # get a list of all facets that the diamond knows
  local KNOWN_FACET_ADDRESSES=$(cast call "$DIAMOND_ADDRESS" "facets() returns ((address,bytes4[])[])" --rpc-url "$RPC_URL") 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "[debug] not all core facets are registered in the diamond"
    return 1
  fi

  # extract the IDiamondLoupe.Facet tuples
  tuples=($(echo "${KNOWN_FACET_ADDRESSES:1:${#KNOWN_FACET_ADDRESSES}-2}" | sed 's/),(/) /g' | sed 's/[()]//g'))

  # extract the addresses from the tuples into an array
  ADDRESSES=()
  for tpl in "${tuples[@]}"; do
    tpl="${tpl// /}" # remove spaces
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
      if [[ "$DEBUG" == *"true"* ]]; then
          echo "[debug] not all core facets are registered in the diamond"
      fi

      # not included, return error code
      return 1
    fi
  done
  return 0
}
function getFacetFunctionSelectorsFromDiamond() {
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
    echo "[error] no address found for $FACET_NAME in $FILE_PATH"
    return 1
  fi

  # get RPC URL
  local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")"

  # get a list of all facet addresses that are registered with the diamond
  local DIAMOND_FILE_PATH="deployments/$NETWORK.diamond.${FILE_SUFFIX}json"

  # search in DIAMOND_FILE_PATH for the given address
  if jq -e ".facets | index(\"$FACET_ADDRESS\")" "$DIAMOND_FILE_PATH" >/dev/null; then
    # get function selectors from diamond (function facetFunctionSelectors)
    local ATTEMPTS=1
    while [[ -z "$FUNCTION_SELECTORS" && $ATTEMPTS -le $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION ]]; do
      # get address of facet in diamond
      local FUNCTION_SELECTORS=$(cast call "$DIAMOND_ADDRESS" "facetFunctionSelectors(address) returns (bytes4[])" "$FACET_ADDRESS" --rpc-url "${!RPC}")
      ((ATTEMPTS++))
      sleep 1
    done

    if [[ "$ATTEMPTS" -gt "$MAX_ATTEMPTS_PER_SCRIPT_EXECUTION" ]]; then
      echo "[error] could not get facet address after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts, exiting."
      return 1
    fi
  else
    echo "[error] $FACET_NAME with address $FACET_ADDRESS is not known by diamond $DIAMOND_ADDRESS on network $NETWORK in $ENVIRONMENT environment. Please check why you tried to remove this facet from the diamond."
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
    local RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")"

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
      echo "[error] could not get facet address after $MAX_ATTEMPTS_PER_SCRIPT_EXECUTION attempts, exiting."
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

  # get correct node URL for given NETWORK
  NODE_URL_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<$NETWORK)"
  NODE_URL=${!NODE_URL_KEY}

  # logging for debug purposes
#  if [[ "$DEBUG" == *"true"* ]]; then
#    echo ""
#    echo "[debug] in function doesAddressContainBytecode"
#    echo "[debug] NETWORK=$NETWORK"
#    echo "[debug] ADDRESS=$ADDRESS"
#  fi

  # check if NODE_URL is available
  if [ -z "$NODE_URL" ]; then
      echo "[error]: no node url found for NETWORK $NETWORK. Please update your .env FILE and make sure it has a value for the following key: $NODE_URL_KEY"
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
  if [[ $contract_code == "0x" ]]; then
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
# <<<<<< read from blockchain

function getRPCUrl(){
  # read function arguments into variables
  local NETWORK=$1

  # get RPC KEY
  RPC_KEY="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")"

  # return RPC URL
  echo "${!RPC_KEY}"
}
function playNotificationSound() {
  if [[ "NOTIFICATION_SOUNDS" == *"true"* ]]; then
    afplay ./scripts/deploy/notification.mp3
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
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function deployAndAddContractToDiamond"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] CONTRACT=$CONTRACT"
    echo "[debug] DIAMOND_CONTRACT_NAME=$DIAMOND_CONTRACT_NAME"
    echo "[debug] VERSION=$VERSION"
    echo ""
  fi

  # check which type of contract we are deploying
  if [[ "$CONTRACT" == *"Facet"* ]]; then
    # deploying a facet
    deployFacetAndAddToDiamond "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_CONTRACT_NAME" "$VERSION"
  elif [[ "$CONTRACT" == *"LiFiDiamond"* ]]; then
    # deploying a diamond
    deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" false
  else
    # deploy periphery contract
    deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" false

    # update periphery registry in diamond
    updatePeriphery "$NETWORK" "$ENVIRONMENT" "$DIAMOND_CONTRACT_NAME" false false "$CONTRACT"
  fi
}


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
function test_findContractInLogFile() {
  findContractInLogFile "DiamondCutFacet" "optimism" "production" "1.0.0"
  match=($(findContractInLogFile "DiamondCutFacet" "optimism" "production" "1.0.0"))

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
function test_userDialogSelectDiamondType() {
  echo ""
  echo "Please select which type of diamond contract to deploy:"
  echo "should return 'LiFiDiamondImmutable': $(userDialogSelectDiamondType)"
}
function test_getFunctionSelectorsFromContractABI()  {
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
function test_checkIfFileExists(){
  echo "should be true: $(checkIfFileExists "./script/DeployCelerIMFacet.s.sol")"
  echo "should be false: $(checkIfFileExists "./script/NoScript.s.sol")"
}
function test_tmp(){
  logContractDeploymentInfo2 "DiamondCutFacet" "optimism" "<TIMESTAMP>" "1.0.0" "50000" "<args>" "production" "0x1234"
  logContractDeploymentInfo2 "DiamondCutFacet" "bsc" "<TIMESTAMP>" "1.0.0" "50000" "<args>" "production" "0x1234"

}
function test_getFacetAddressFromDiamond(){
  getFacetAddressFromDiamond "arbitrum" "0x9b11bc9FAc17c058CAB6286b0c785bE6a65492EF" "0xc5ae0fe6"
}

#test_getFacetAddressFromDiamond


