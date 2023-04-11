#!/bin/bash

# deploys a single contract
# should be called like this:
# $(deploySingleContract "Executor" "BSC" "staging" "1.0.0" true)
deploySingleContract() {
  # load config & helper functions
  source scripts/deploy/deployConfig.sh
  source scripts/deploy/deployHelperFunctions.sh

  # read function arguments into variables
  CONTRACT="$1"
  NETWORK="$2"
  ENVIRONMENT="$3"
  VERSION="$4"
  EXIT_ON_ERROR="$5"

  # load env variables
  source .env

  # if no NETWORK was passed to this function, ask user to select it
  if [[ -z "$NETWORK" ]]; then
    NETWORK=$(getUserSelectedNetwork)

    # check the return code the last call
    if [ $? -ne 0 ]; then
      echo "$NETWORK" # will contain an error message
      exit 1
    fi
    # get deployer wallet balance
    BALANCE=$(getDeployerBalance "$NETWORK")

    echo "[info] selected network: $NETWORK"
    echo "[info] deployer wallet balance in this network: $BALANCE"
  fi

  # if no ENVIRONMENT was passed to this function, determine it
  if [[ -z "$ENVIRONMENT" ]]; then
    # determine environment (production/staging)
    ENVIRONMENT=$(determineEnvironment)
  fi

  if [[ -z "$CONTRACT" ]]; then
    # get user-selected deploy script and contract from list
    SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
    CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')
  else
    SCRIPT="Deploy"$CONTRACT
  fi

  # get current contract version
  local VERSION=$(getCurrentContractVersion "$CONTRACT")


  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # define name of deploy script

  # logging for debug purposes
  if [[ "$DEBUG" == *"true"* ]]; then
    echo ""
    echo "[debug] in function deploySingleContract"
    echo "[debug] CONTRACT=$CONTRACT"
    echo "[debug] NETWORK=$NETWORK"
    echo "[debug] SCRIPT=$SCRIPT"
    echo "[debug] ENVIRONMENT=$ENVIRONMENT"
    echo "[debug] VERSION=$VERSION"
    echo "[debug] FILE_SUFFIX=$FILE_SUFFIX"
    echo "[debug] SALT=$SALT"
    echo ""
  fi

  # prepare bytecode
  BYTECODE=$(forge inspect "$CONTRACT" bytecode)

  # write bytecode to bytecode storage file
  logBytecode "$CONTRACT" "$VERSION" "$BYTECODE"

  # if selected contract is "LiFiDiamondImmutable" then use an adjusted salt for deployment to prevent clashes due to same bytecode
  if [[ $CONTRACT = "LiFiDiamondImmutable" ]]; then
    # adds a string to the end of the bytecode to alter the salt but always produce deterministic results based on bytecode
    BYTECODE="$BYTECODE""ffffffffffffffffffffffffffffffffffffff"
  fi

  # check if .env file contains a value "SALT" and if this has correct number of digits (must be even)
  if [[ ! -z "$SALT" ]]; then
    if [ $(( ${#SALT} % 2 )) != 0 ]; then
      echo "[error] your SALT environment variable (in .env file) has a value with odd digits (must be even digits) - please adjust value and run script again"
      exit 1
    fi
  fi

  # add custom salt from .env file (allows to re-deploy contracts with same bytecode)
  local SALT_INPUT="$BYTECODE""$SALT"

  # create salt that is used to deploy contract
  local DEPLOYSALT=$(cast keccak "$SALT_INPUT")

  # get predicted contract address based on salt
  local CONTRACT_ADDRESS=$(getContractAddressFromSalt "$DEPLOYSALT" "$NETWORK" "$CONTRACT")

  # check if predicted address already contains bytecode
  if doesAddressContainBytecode "$NETWORK" "$CONTRACT_ADDRESS" > /dev/null; then
    echo "[info] contract $CONTRACT is already deployed to address $CONTRACT_ADDRESS. Change SALT in .env if you want to redeploy to fresh address"
    return 0
  fi

  # execute script
  attempts=1

  while [ $attempts -le "$MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT" ]; do
    echo ""
    echo "[info] trying to deploy $CONTRACT now - attempt ${attempts} (max attempts: $MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT) "
    # try to execute call
    RAW_RETURN_DATA=$(DEPLOYSALT=$DEPLOYSALT NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy)

    # check the return code the last call
    if [ $? -eq 0 ]; then
      # clean tx return data
      CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
      checkFailure $? "clean return data (original data: $RAW_RETURN_DATA)"

      # print return data only if debug mode is activated
      if [[ "$DEBUG" == *"true"* ]]; then
        echo $CLEAN__RETURN_DATA | jq 2>/dev/null
      fi

      # extract the "returns" field and its contents from the return data (+hide errors)
      RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2>/dev/null)

      # extract deployed-to address from return data
      ADDRESS=$(echo $RETURN_DATA | jq -r '.deployed.value')

      # check every ten seconds up until MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC if code is deployed
      local COUNT=0
      while [ $COUNT -lt "$MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC" ]
      do
        # check if bytecode is deployed at address
        if doesAddressContainBytecode "$NETWORK" "$ADDRESS" > /dev/null; then
          echo "[info] bytecode deployment at address $ADDRESS verified through block explorer"
          break 2 # exit both loops if the operation was successful
        fi
        # wait for 10 seconds to allow blockchain to sync
        if [[ "$DEBUG" == *"true"* ]]; then
          echo "[info] waiting 10 seconds for blockchain to sync bytecode (max wait time: $MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC seconcs)"
        fi
        sleep 10
        COUNT=$((COUNT+10))
      done

      if [ $COUNT -gt "$MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC" ]; then
        echo "[warning] contract deployment tx successful but doesAddressContainBytecode returned false. Please check if contract was actually deployed (NETWORK=$NETWORK, ADDRESS:$ADDRESS)"
      fi

    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  # check if call was executed successfully or used all ATTEMPTS
  if [ $attempts -gt "$MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT" ]; then
    echo "[error] failed to deploy $CONTRACT to network $NETWORK in $ENVIRONMENT environment"

    # end this script according to flag
    if [[ -z "$EXIT_ON_ERROR" ]]; then
      return 1
    else
      exit 1
    fi
  fi
  #echo $RAW_RETURN_DATA

  # extract constructor arguments from return data
  CONSTRUCTOR_ARGS=$(echo $RETURN_DATA | jq -r '.constructorArgs.value // "0x"')
  echo "[info] $CONTRACT deployed to $NETWORK at address $ADDRESS"

  # save contract in network-specific deployment files
  saveContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$FILE_SUFFIX"

  # prepare information for logfile entry
  TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
  OPTIMIZER=$(getOptimizerRuns)

  # verify contract
  if [[ $VERIFY_CONTRACTS == "true" ]]; then
    if [[ $DEBUG == "true" ]]; then
      verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$CONSTRUCTOR_ARGS"
    else
      verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$CONSTRUCTOR_ARGS" 2>/dev/null
    fi
  fi

  # write to logfile
  if [ $? -ne 0 ]; then
    # verification not successful
    logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS" false
  else
    # verification successful
    logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS" true
  fi
  return 0
}

