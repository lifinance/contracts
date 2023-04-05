#!/bin/bash

deploySingleContract() {
  # load config & helper functions
  source scripts/deploy/deployConfig.sh
  source scripts/deploy/deployHelperFunctions.sh

  # read function arguments into variables
  CONTRACT="$1"
  NETWORK="$2"
  SCRIPT="$3"
  ENVIRONMENT="$4"
  VERSION="$5"

  # load env variables
  source .env

  # get file suffix based on value in variable ENVIRONMENT
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

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
  fi

  # if selected contract is "LiFiDiamondImmutable" then use an adjusted salt for deployment to prevent clashes
  if [[ $CONTRACT = "LiFiDiamondImmutable" ]]; then
    # adjust contract name (remove "Immutable") since we are using our standard diamond contract
    CONTRACTADJ=$(echo "$CONTRACT"V1) # << this needs to be updated when releasing a new version
    # get contract bytecode
    BYTECODE=$(forge inspect $CONTRACTADJ bytecode)
    # adds a string to the end of the bytecode to alter the salt but always produce deterministic results based on bytecode
    BYTECODEADJ="$BYTECODE"ffffffffffffffffffffffffffffffffffffff$DEPLOYSALT
    # create salt with keccak(bytecode)
    DEPLOYSALT=$(cast keccak $BYTECODEADJ)
  else
    # in all other cases just create a salt just based on the contract bytecode
    CONTRACTADJ=$CONTRACT
    BYTECODE=$(forge inspect $CONTRACT bytecode)
    DEPLOYSALT=$(cast keccak $BYTECODE)
  fi

  # execute script
  attempts=1 # initialize attempts to 0

  while [ $attempts -le "$MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT" ]; do
    echo ""
    echo "[info] Trying to deploy $CONTRACTADJ now - attempt ${attempts} (max attempts: $MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT) "
    # try to execute call
    RAW_RETURN_DATA=$(DEPLOYSALT=$DEPLOYSALT NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy)

    # check the return code the last call
    if [ $? -eq 0 ]; then
      # clean tx return data
      CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
      echo $CLEAN__RETURN_DATA | jq 2>/dev/null
      checkFailure $? "clean return data (original data: $RAW_RETURN_DATA)"

      # extract the "returns" field and its contents from the return data (+hide errors)
      RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2>/dev/null)

      # extract deployed-to address from return data
      ADDRESS=$(echo $RETURN_DATA | jq -r '.deployed.value')

      # check if the deployed-to address contains bytecode (>> double-check deployment success)
      BYTECODE_FOUND=$(doesAddressContainBytecode "$NETWORK" "$ADDRESS")
      wait
      if [[ $BYTECODE_FOUND == "true" ]]; then
        break # exit the loop if the operation was successful
      fi
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq $MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT ]; then
    echo "[error] failed to deploy $CONTRACTADJ to network $NETWORK in $ENVIRONMENT environment"
    return 1
  fi
  #echo $RAW_RETURN_DATA

  # extract constructor arguments from return data
  CONSTRUCTOR_ARGS=$(echo $RETURN_DATA | jq -r '.constructorArgs.value // "0x"')
  echo "[info] $CONTRACT deployed to $NETWORK at address $ADDRESS"

  # save contract in network-specific deployment files
  # TODO: remove?????
  saveContract "$NETWORK" "$CONTRACTADJ" "$ADDRESS" "$FILE_SUFFIX"

  # write information about new contract to logfile
  TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
  OPTIMIZER=$(getOptimizerRuns)
  logContractDeploymentInfo "$CONTRACT" "$NETWORK" "$TIMESTAMP" "$VERSION" "$OPTIMIZER" "$CONSTRUCTOR_ARGS" "$ENVIRONMENT" "$ADDRESS"


  # verify contract
  if [[ $VERIFY_CONTRACTS == "true" ]]; then
    if [[ $DEBUG == "true" ]]; then
      verifyContract "$NETWORK" "$CONTRACTADJ" "$ADDRESS" "$CONSTRUCTOR_ARGS"
    else
      verifyContract "$NETWORK" "$CONTRACTADJ" "$ADDRESS" "$CONSTRUCTOR_ARGS" 2>/dev/null
    fi
  fi
}

