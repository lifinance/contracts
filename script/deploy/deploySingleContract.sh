#!/bin/bash

# deploys a single contract
# should be called like this:
# $(deploySingleContract "Executor" "BSC" "staging" "1.0.0" true false)
deploySingleContract() {
  # load config & helper functions
  source script/config.sh
  source script/helperFunctions.sh
  source script/deploy/resources/contractSpecificReminders.sh
  source script/deploy/deployAllLDAContracts.sh

  # read function arguments into variables
  local CONTRACT="$1"
  local NETWORK="$2"
  local ENVIRONMENT="$3"
  local VERSION="$4"
  local EXIT_ON_ERROR="$5"
  # load env variables
  source .env

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

  FILE_EXTENSION=".s.sol"

  # Determine deployment script directory based on network type and contract type
  # We need to support 4 combinations:
  # 1. Regular + Non-zkEVM = script/deploy/facets/
  # 2. Regular + zkEVM = script/deploy/zksync/
  # 3. LDA + Non-zkEVM = script/deploy/facets/LDA/
  # 4. LDA + zkEVM = script/deploy/zksync/LDA/

  # Helper function to check if contract is LDA-related
  isLDAContract() {
    local contract_name="$1"
    # Check if contract name contains LDA-related patterns or is in LDA facets list
    if [[ "$contract_name" == "LiFiDEXAggregatorDiamond" ]] || 
       [[ "$contract_name" == *"LDA"* ]] ||
       [[ -f "script/deploy/facets/LDA/Deploy${contract_name}.s.sol" ]]; then
      return 0  # true
    else
      return 1  # false
    fi
  }
  
  if isZkEvmNetwork "$NETWORK"; then
    if isLDAContract "$CONTRACT"; then
      DEPLOY_SCRIPT_DIRECTORY="script/deploy/zksync/LDA/"
    else
      DEPLOY_SCRIPT_DIRECTORY="script/deploy/zksync/"
    fi
    FILE_EXTENSION=".zksync.s.sol"
  else
    if isLDAContract "$CONTRACT"; then
      DEPLOY_SCRIPT_DIRECTORY="script/deploy/facets/LDA/"
    else
      DEPLOY_SCRIPT_DIRECTORY="script/deploy/facets/"
    fi
  fi

  if [[ -z "$CONTRACT" ]]; then
    # select which contract should be deployed
    SCRIPT=$(ls -1 "$DEPLOY_SCRIPT_DIRECTORY" | sed -e "s/${FILE_EXTENSION}//" | grep 'Deploy' | gum filter --placeholder "Deploy Script")
    local CONTRACT=$(echo "$SCRIPT" | sed -e 's/Deploy//')
  else
    # the to-be-deployed contract was already selected prior to calling this script
    SCRIPT="Deploy"$CONTRACT
  fi

  # define the full path to the deploy script
  FULL_SCRIPT_PATH="${DEPLOY_SCRIPT_DIRECTORY}${SCRIPT}${FILE_EXTENSION}"

  # Display contract-specific information, if existing
  if grep -q "^$CONTRACT=" "$CONTRACT_REMINDERS"; then
    echo -e "\n\n"
    printf '\033[31m%s\031\n' "--------------------------------------- !!!!!!!! ATTENTION !!!!!!!! ---------------------------------------"
    warning "Please read the following information carefully: "
    warning "${!CONTRACT}"
    printf '\033[31m%s\031\n' "-----------------------------------------------------------------------------------------------------------"
    echo -e "\n\n"
  fi

  # Special case: LiFiDEXAggregatorDiamond is treated as a single external contract
  # that triggers the full LDA deployment process
  if [[ "$CONTRACT" == "LiFiDEXAggregatorDiamond" ]]; then
    echo "[info] LiFiDEXAggregatorDiamond detected - deploying full LDA diamond with all contracts"
    echo "[info] Calling deployAllLDAContracts script..."
    
    # Call the full LDA deployment script
    deployAllLDAContracts "$NETWORK" "$ENVIRONMENT"
    
    # Check if deployment was successful
    local LDA_DEPLOYMENT_RESULT=$?
    if [[ $LDA_DEPLOYMENT_RESULT -eq 0 ]]; then
      echo "[info] LiFiDEXAggregatorDiamond (full LDA deployment) completed successfully"
      return 0
    else
      error "LiFiDEXAggregatorDiamond (full LDA deployment) failed"
      if [[ -z "$EXIT_ON_ERROR" || "$EXIT_ON_ERROR" == "false" ]]; then
        return 1
      else
        exit 1
      fi
    fi
  fi

  # check if deploy script exists
  if ! checkIfFileExists "$FULL_SCRIPT_PATH" >/dev/null; then
    error "could not find deploy script for $CONTRACT in this path: $FULL_SCRIPT_PATH". Aborting deployment.
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  # get current contract version
  local VERSION=$(getCurrentContractVersion "$CONTRACT")

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  if [[ -z "$GAS_ESTIMATE_MULTIPLIER" ]]; then
    GAS_ESTIMATE_MULTIPLIER=130 # this is foundry's default value
  fi

  # logging for debug purposes
  echo ""
  echoDebug "in function deploySingleContract"
  echoDebug "CONTRACT=$CONTRACT"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "SCRIPT=$SCRIPT"
  echoDebug "FULL_SCRIPT_PATH=$FULL_SCRIPT_PATH"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "VERSION=$VERSION"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echoDebug "DIAMOND_TYPE=$DIAMOND_TYPE"
  echoDebug "GAS_ESTIMATE_MULTIPLIER=$GAS_ESTIMATE_MULTIPLIER (default value: 130, set in .env for example to 200 for doubling Foundry's estimate)"
  echo ""

  # the following is only applicable for networks where we use CREATE3 (= non-zkEVM)
  if ! isZkEvmNetwork "$NETWORK"; then
    # prepare bytecode
    BYTECODE=$(getBytecodeFromArtifact "$CONTRACT")

    # get CREATE3_FACTORY_ADDRESS
    CREATE3_FACTORY_ADDRESS=$(getCreate3FactoryAddress "$NETWORK")
    checkFailure $? "retrieve create3Factory address from networks.json"

    if [[ $CONTRACT == "LiFiDiamondImmutable" ]]; then
      # adds a string to the end of the bytecode to alter the salt but always produce deterministic results based on bytecode
      BYTECODE="$BYTECODE""ffffffffffffffffffffffffffffffffffffff"
    fi

    # check if .env file contains a value "SALT" and if this has correct number of digits (must be even)
    if [[ ! -z "$SALT" ]]; then
      if [ $((${#SALT} % 2)) != 0 ]; then
        error "your SALT environment variable (in .env file) has a value with odd digits (must be even digits) - please adjust value and run script again"
        exit 1
      fi
    fi

    # add custom salt from .env file (allows to re-deploy contracts with same bytecode)
    local SALT_INPUT="$BYTECODE""$SALT"

    # create salt that is used to deploy contract
    local DEPLOYSALT=$(cast keccak "$SALT_INPUT")

    # get predicted contract address based on salt (or special case for LiFiDiamond)
    if [[ $CONTRACT == "LiFiDiamond" && $DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS == "true" ]]; then
      CONTRACT_ADDRESS="0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"
    else
      CONTRACT_ADDRESS=$(getContractAddressFromSalt "$DEPLOYSALT" "$NETWORK" "$CONTRACT" "$ENVIRONMENT")
    fi

    # check if address already contains code (=> are we deploying or re-running the script again?)
    NEW_DEPLOYMENT=$(doesAddressContainBytecode "$NETWORK" "$CONTRACT_ADDRESS")

    # check if all required data (e.g. config data / contract addresses) is available
    checkDeployRequirements "$NETWORK" "$ENVIRONMENT" "$CONTRACT"

    # do not continue if data required for deployment is missing
    if [ $? -ne 0 ]; then
      if [[ -z "$EXIT_ON_ERROR" || $EXIT_ON_ERROR == "false" ]]; then
        return 1
      else
        exit 1
      fi
    fi
  else
      # Check if a zksync contract has already been deployed for a specific
      # version otherwise it might fail since create2 will try to deploy to the
      # same address
      DEPLOYED=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" "$LOG_FILE_PATH")
      if [[ $? == 0 ]]; then
        gum style \
	        --foreground 220 --border-foreground 220 --border double \
	        --align center --width 50 --margin "1 2" --padding "2 4" \
	        'WARNING' "$CONTRACT v$VERSION is already deployed to $NETWORK" 'Deployment might fail'
        gum confirm "Deploy anyway?" || exit 0
      fi

      # Run zksync specific fork of forge
      FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync
  fi
  # execute script
  attempts=1

  while [ $attempts -le "$MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT" ]; do
    echo "[info] trying to deploy $CONTRACT now - attempt ${attempts} (max attempts: $MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT) "

    # ensure that gas price is below maximum threshold (for mainnet only)
    doNotContinueUnlessGasIsBelowThreshold "$NETWORK"

    if isZkEvmNetwork "$NETWORK"; then
      # Deploy zksync scripts using the zksync specific fork of forge
      RAW_RETURN_DATA=$(FOUNDRY_PROFILE=zksync DEPLOYSALT=$DEPLOYSALT NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") ./foundry-zksync/forge script "$FULL_SCRIPT_PATH" -f "$NETWORK" -vvvvv --json --broadcast --skip-simulation --slow --zksync --gas-estimate-multiplier "$GAS_ESTIMATE_MULTIPLIER")
    else
      # try to execute call
      RAW_RETURN_DATA=$(DEPLOYSALT=$DEPLOYSALT CREATE3_FACTORY_ADDRESS=$CREATE3_FACTORY_ADDRESS NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT=$DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS=$DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") DIAMOND_TYPE=$DIAMOND_TYPE forge script "$FULL_SCRIPT_PATH" -f "$NETWORK" -vvvvv --json --broadcast --legacy --slow --gas-estimate-multiplier "$GAS_ESTIMATE_MULTIPLIER")
    fi

    RETURN_CODE=$?

    # print return data only if debug mode is activated
    echoDebug "RAW_RETURN_DATA: $RAW_RETURN_DATA"

    # check return data for error message (regardless of return code as this is not 100% reliable)
    if [[ $RAW_RETURN_DATA == *"\"logs\":[]"* && $RAW_RETURN_DATA == *"\"returns\":{}"* ]]; then
      # try to extract error message and throw error
      ERROR_MESSAGE=$(echo "$RAW_RETURN_DATA" | sed -n 's/.*0\\0\\0\\0\\0\(.*\)\\0\".*/\1/p')
      if [[ $ERROR_MESSAGE == "" ]]; then
        error "execution of deploy script failed. Could not extract error message. RAW_RETURN_DATA: $RAW_RETURN_DATA"
      else
        error "execution of deploy script failed with message: $ERROR_MESSAGE"
      fi

    # check the return code the last call
    elif [ $RETURN_CODE -eq 0 ]; then
      # extract deployed-to address from return data
        ADDRESS=$(extractDeployedAddressFromRawReturnData "$RAW_RETURN_DATA" "$NETWORK")
        if [[ $? -ne 0 ]]; then
          error "❌ Could not extract deployed address from raw return data"
          return 1
        elif [[ -n "$ADDRESS" ]]; then
          # address successfully extracted
          break
        fi
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all ATTEMPTS
  if [ $attempts -gt "$MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT" ]; then
    error "failed to deploy $CONTRACT to network $NETWORK in $ENVIRONMENT environment"

    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" || "$EXIT_ON_ERROR" == "false" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  # check if address is available, otherwise do not continue
  if [[ -z "$ADDRESS" || "$ADDRESS" == "null" ]]; then
    warning "failed to obtain address of newly deployed contract $CONTRACT. There may be an issue within the deploy script. Please check and try again"

    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" || "$EXIT_ON_ERROR" == "false" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  # extract constructor arguments from return data
  CONSTRUCTOR_ARGS=$(echo "$RAW_RETURN_DATA" | grep -o '{\"logs\":.*' | jq -r '.returns.constructorArgs.value // "0x"' 2>/dev/null)
  echo "[info] $CONTRACT deployed to $NETWORK at address $ADDRESS"

  # check if log entry exists for this file and if yes, if contract is verified already
  LOG_ENTRY=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION")
  LOG_ENTRY_RETURN_CODE=$?
  echoDebug "existing log entry, may have a different address in case of a redeployment (RETURN CODE: $LOG_ENTRY_RETURN_CODE): $LOG_ENTRY"

  if [[ "$LOG_ENTRY_RETURN_CODE" -eq 0 ]]; then
    VERIFIED_LOG=$(echo "$LOG_ENTRY" | jq -r ".VERIFIED")
    ADDRESS_LOG=$(echo "$LOG_ENTRY" | jq -r ".ADDRESS")
  fi

  # check if this was a redeployment (= if address does not match with what is already in log file)
  if [[ "$(echo "$ADDRESS" | tr '[:upper:]' '[:lower:]')" == "$(echo "$ADDRESS_LOG" | tr '[:upper:]' '[:lower:]')" ]]; then
    REDEPLOYMENT=false
  else
    REDEPLOYMENT=true
    # overwirte VERIFIED_LOG value since it was a redeployment, we dont care if the last contract was already verified or not
    VERIFIED_LOG=""
  fi

  # verify contract, if needed
  VERIFIED=false

  # prepare information for logfile entry
  TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
  OPTIMIZER=$(getOptimizerRuns)

  # Get compiler versions used for deployment
  SOLC_VERSION=$(getSolcVersion "$NETWORK")
  EVM_VERSION=$(getEvmVersion "$NETWORK")

  # Get zk-solc version for zkEvm networks
  if isZkEvmNetwork "$NETWORK"; then
    ZK_SOLC_VERSION=$(getZkSolcVersion "$NETWORK")
  else
    ZK_SOLC_VERSION=""
  fi

  # check if contract verification is enabled in config and contract not yet verified according to log file
  if [[ $VERIFY_CONTRACTS == "true" && ("$VERIFIED_LOG" == "false" || -z "$VERIFIED_LOG") ]]; then
    echo "[info] trying to verify contract $CONTRACT on $NETWORK with address $ADDRESS"
    if [[ $DEBUG == "true" ]]; then
      verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$CONSTRUCTOR_ARGS"
      if [ $? -eq 0 ]; then
        VERIFIED=true
      fi
    else
      verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$CONSTRUCTOR_ARGS" 2>/dev/null
      if [ $? -eq 0 ]; then
        VERIFIED=true
      fi
    fi
  fi

  # check if log entry was found
  if [[ "$LOG_ENTRY_RETURN_CODE" -eq 0 ]]; then
    echoDebug "Now checking if $CONTRACT was verified just now and update log, if so"

    # check if redeployment
    if [[ "$REDEPLOYMENT" == "false" ]]; then
      echoDebug "address of existing log entry matched with current deployed-to address"

      # check if contract was verified during this script execution
      if [[ $VERIFIED == "true" ]]; then
        echoDebug "contract was just verified. Updating VERIFIED flag in log entry now."

        # extract values from existing log entry
        ADDRESS=$(echo "$LOG_ENTRY" | jq -r ".ADDRESS")
        OPTIMIZER=$(echo "$LOG_ENTRY" | jq -r ".OPTIMIZER_RUNS")
        TIMESTAMP=$(echo "$LOG_ENTRY" | jq -r ".TIMESTAMP")
        CONSTRUCTOR_ARGS=$(echo "$LOG_ENTRY" | jq -r ".CONSTRUCTOR_ARGS")
        TIMESTAMP=$(echo "$LOG_ENTRY" | jq -r ".TIMESTAMP")

        # update VERIFIED info in log file
        logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS" "$VERIFIED" "$SALT" "$SOLC_VERSION" "$EVM_VERSION" "$ZK_SOLC_VERSION"
      else
        echoDebug "contract was not verified just now. No further action needed."
      fi
    else
      echoDebug "address of existing log entry does not match with current deployed-to address (=re-deployment)"

      # overwrite existing log entry with new deployment info
      logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS" "$VERIFIED" "$SALT" "$SOLC_VERSION" "$EVM_VERSION" "$ZK_SOLC_VERSION"
    fi
  else
    echoDebug "log entry does not exist. Log entry will be written now."

    # write to logfile
    logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS" "$VERIFIED" "$SALT" "$SOLC_VERSION" "$EVM_VERSION" "$ZK_SOLC_VERSION"
  fi

  # save contract in network-specific deployment files
  saveContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$FILE_SUFFIX"

  return 0
}
