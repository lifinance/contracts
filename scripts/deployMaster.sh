#!/bin/bash

deploy() {
  # load env variables
  source .env

  # load deploy scripts
  #source scripts/deploySingle.sh

  # check if env variable "PRODUCTION" is true, otherwise deploy as staging
  if [[ -z "$PRODUCTION" ]]; then
    FILE_SUFFIX="staging."
  fi

  # get user-selected network from list
  NETWORK=$(cat ./networks | gum filter --placeholder "Network")
  echo "Selected network: $NETWORK"

  # ask user to deploy all contracts for this network or just a specific contract
  echo "(Re-)Deploy all contracts in this network or just a specific one?"
  SELECTION=$(gum choose "1) Deploy all" "2) Deploy specific")


  if [[ "$SELECTION" == *"all"* ]]; then
      echo "Deploy all"

      # read _targetState.json

      # go through each contract

        # check to-be-deployed version

        # check if contract deployed and if yes, in which version

          # get address from deployment JSON

          # check logfile to see which version was deployed to this address

        # if necessary, (re-)deploy contract

        # if deployed, write deployment info to logfile
  else
      echo "Deploy specific"
  fi





  echo "Press button to continue..."
  read



  # get user-selected deploy script and contract from list
  SCRIPT=$(ls -1 script | sed -e 's/\.s.sol$//' | grep 'Deploy' | gum filter --placeholder "Deploy Script")
  CONTRACT=$(echo $SCRIPT | sed -e 's/Deploy//')



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



  # display the name of selected script and network


  # execute script
  attempts=1 # initialize attempts to 0

  while [ $attempts -lt 11 ]; do
    echo "Trying to deploy $CONTRACTADJ now - attempt ${attempts}"
    # try to execute call
    RAW_RETURN_DATA=$(DEPLOYSALT=$DEPLOYSALT NETWORK=$NETWORK FILE_SUFFIX=$FILE_SUFFIX forge script script/$SCRIPT.s.sol -f $NETWORK -vvvv --json --silent --broadcast --skip-simulation --legacy)

    # check the return code the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    attempts=$((attempts + 1)) # increment attempts
    sleep 1                    # wait for 1 second before trying the operation again
  done

  if [ $attempts -eq 11 ]; then
    echo "Failed to deploy $CONTRACTADJ"
    exit 1
  fi
  echo $RAW_RETURN_DATA
  # clean tx return data
  CLEAN_RETURN_DATA=$(echo $RAW_RETURN_DATA | sed 's/^.*{\"logs/{\"logs/')
  echo $CLEAN__RETURN_DATA | jq 2>/dev/null
  checkFailure

  # extract the "returns" field and its contents from the return data (+hide errors)
  RETURN_DATA=$(echo $CLEAN_RETURN_DATA | jq -r '.returns' 2>/dev/null)

  # extract deployed-to address from return data
  deployed=$(echo $RETURN_DATA | jq -r '.deployed.value')
  # extract constructor arguments from return data
  args=$(echo $RETURN_DATA | jq -r '.constructorArgs.value // "0x"')
  echo "$CONTRACT deployed on $NETWORK at address $deployed"

  saveContract $NETWORK $CONTRACTADJ $deployed
  verifyContract $NETWORK $CONTRACTADJ $deployed $args
}

saveContract() {
  source .env

  if [[ -z "$PRODUCTION" ]]; then
    FILE_SUFFIX="staging."
  fi

  NETWORK=$1
  CONTRACT=$2
  ADDRESS=$3

  ADDRESSES_FILE="./deployments/${NETWORK}.${FILE_SUFFIX}json"

  # create an empty json if it does not exist
  if [[ ! -e $ADDRESSES_FILE ]]; then
    echo "{}" >"$ADDRESSES_FILE"
  fi
  result=$(cat "$ADDRESSES_FILE" | jq -r ". + {\"$CONTRACT\": \"$ADDRESS\"}" || cat "$ADDRESSES_FILE")
  printf %s "$result" >"$ADDRESSES_FILE"
}

verifyContract() {
  source .env

  NETWORK=$1
  CONTRACT=$2
  ADDRESS=$3
  echo "ADDRESS in verify: $ADDRESS"
  ARGS=$4
  API_KEY="$(tr '[:lower:]' '[:upper:]' <<<$NETWORK)_ETHERSCAN_API_KEY"
  if [ "$ARGS" = "0x" ]; then
    forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT -e "${!API_KEY}"
  else
    forge verify-contract --watch --chain $NETWORK $ADDRESS $CONTRACT --constructor-args $ARGS -e "${!API_KEY}"
  fi
}

checkFailure() {
  if [[ $? -ne 0 ]]; then
    echo "Failed to deploy $CONTRACT"
    exit 1
  fi
}

deploy
