#!/bin/bash

# deploys a single contract
# should be called like this:
# $(deploySingleContract "Executor" "BSC" "staging" "1.0.0" true)
deploySingleContract() {
  # load config & helper functions
  source scripts/config.sh
  source scripts/deploy/resources/deployHelperFunctions.sh
  source scripts/deploy/resources/contractSpecificReminders.sh

  # read function arguments into variables
  CONTRACT="$1"
  NETWORK="$2"
  ENVIRONMENT="$3"
  VERSION="$4"
  EXIT_ON_ERROR="$5"

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

  if [[ -z "$CONTRACT" ]]; then
    # get user-selected deploy script and contract from list
    SCRIPT=$(ls -1 "$DEPLOY_SCRIPT_DIRECTORY" | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
    CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')
  else
    SCRIPT="Deploy"$CONTRACT
  fi

  # Display contract-specific information, if existing
  if grep -q "^$CONTRACT=" "$CONTRACT_REMINDERS"; then
    echo ""
    warning "Please read the following information carefully: "
    warning "${!CONTRACT}"
    echo ""
  fi

  # check if deploy script exists
  local FULL_SCRIPT_PATH=""$DEPLOY_SCRIPT_DIRECTORY""$SCRIPT"".s.sol""
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

  # logging for debug purposes
  echo ""
  echoDebug "in function deploySingleContract"
  echoDebug "CONTRACT=$CONTRACT"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "SCRIPT=$SCRIPT"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "VERSION=$VERSION"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echo ""

  # prepare bytecode
  BYTECODE=$(forge inspect "$CONTRACT" bytecode)

  # write bytecode to bytecode storage file
  logBytecode "$CONTRACT" "$VERSION" "$BYTECODE"

  # if selected contract is "LiFiDiamondImmutable" then use an adjusted salt for deployment to prevent clashes due to same bytecode
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

  # check if all required data (e.g. config data / contract addresses) is available
  checkDeployRequirements "$NETWORK" "$ENVIRONMENT" "$CONTRACT"

  # do not continue if data required for deployment is missing
  if [ $? -ne 0 ]; then
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi


  # execute script
  attempts=1

  while [ $attempts -le "$MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT" ]; do
    echo "[info] trying to deploy $CONTRACT now - attempt ${attempts} (max attempts: $MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT) "

    # ensure that gas price is below maximum threshold (for mainnet only)
    doNotContinueUnlessGasIsBelowThreshold "$NETWORK"

    # try to execute call
    RAW_RETURN_DATA=$(DEPLOYSALT=$DEPLOYSALT NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT=$DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS=$DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") forge script "$FULL_SCRIPT_PATH" -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy)
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
      # clean tx return data
      CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
      checkFailure $? "clean return data (original data: $RAW_RETURN_DATA)"

      # extract the "returns" field and its contents from the return data (+hide errors)
      RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2>/dev/null)

      # extract deployed-to address from return data
      ADDRESS=$(echo $RETURN_DATA | jq -r '.deployed.value')

      # check every ten seconds up until MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC if code is deployed
      local COUNT=0
      while [ $COUNT -lt "$MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC" ]; do
        # check if bytecode is deployed at address
        if doesAddressContainBytecode "$NETWORK" "$ADDRESS" >/dev/null; then
          echo "[info] bytecode deployment at address $ADDRESS verified through block explorer"
          break 2 # exit both loops if the operation was successful
        fi
        # wait for 10 seconds to allow blockchain to sync
        echoDebug "waiting 10 seconds for blockchain to sync bytecode (max wait time: $MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC seconds)"
        sleep 10

        COUNT=$((COUNT + 10))
      done

      if [ $COUNT -gt "$MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC" ]; then
        warning "contract deployment tx successful but doesAddressContainBytecode returned false. Please check if contract was actually deployed (NETWORK=$NETWORK, ADDRESS:$ADDRESS)"
      fi

    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all ATTEMPTS
  if [ $attempts -gt "$MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT" ]; then
    error "failed to deploy $CONTRACT to network $NETWORK in $ENVIRONMENT environment"

    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  # check if address is available, otherwise do not continue
  if [[ -z "$ADDRESS" || "$ADDRESS" == "null" ]]; then
    warning "failed to obtain address of newly deployed contract $CONTRACT. There may be an issue within the deploy script. Please check and try again"

    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi

  # extract constructor arguments from return data
  CONSTRUCTOR_ARGS=$(echo $RETURN_DATA | jq -r '.constructorArgs.value // "0x"')
  echo "[info] $CONTRACT deployed to $NETWORK at address $ADDRESS"

  # check if log entry exists for this file
  LOG_ENTRY=$(findContractInMasterLog "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION")
  LOG_ENTRY_RETURN_CODE=$?
  VERIFIED_LOG=$(echo "$LOG_ENTRY" | jq -r ".VERIFIED")

  # verify contract, if needed
  VERIFIED=false

  # check if contract verification is enabled in config and contract not yet verified according to log file
  if [[ $VERIFY_CONTRACTS == "true" && "$VERIFIED_LOG" != "true" ]]; then
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
  if [ "$LOG_ENTRY_RETURN_CODE" -eq 0 ]; then
    echoDebug "log entry already exists:"
    echoDebug "$LOG_ENTRY"
    echoDebug "Now checking if contract was verified just now and update log, if so"

    # check if contract was verified during this script execution
    if [[ $VERIFIED == "true" ]]; then
      echoDebug "contract was just verified. Updating VERIFIED flag in log entry now."

      # extract values from existing log entry
      ADDRESS=$(echo "$LOG_ENTRY" | jq -r ".ADDRESS")
      OPTIMIZER_RUNS=$(echo "$LOG_ENTRY" | jq -r ".OPTIMIZER_RUNS")
      TIMESTAMP=$(echo "$LOG_ENTRY" | jq -r ".TIMESTAMP")
      CONSTRUCTOR_ARGS=$(echo "$LOG_ENTRY" | jq -r ".CONSTRUCTOR_ARGS")
      TIMESTAMP=$(echo "$LOG_ENTRY" | jq -r ".TIMESTAMP")

      # update VERIFIED info in log file
      logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER_RUNS" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS" $VERIFIED
    else
      echoDebug "contract was not verified just now. No further action needed."
    fi

    # end script here
    return 0
  else
    echoDebug "log entry does not exist yet and will be written now"

    # prepare information for logfile entry
    TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
    OPTIMIZER=$(getOptimizerRuns)

    # write to logfile
    logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS" $VERIFIED
  fi

  # save contract in network-specific deployment files
  saveContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$FILE_SUFFIX"

  return 0
}
