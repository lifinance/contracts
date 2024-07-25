#!/bin/bash

#TODO:
# - who can execute this script?
# - who has access to the PauserWallet privKey (or should it be the tester wallet so every employee can pause our contract)?
# - replace pauserWallet address in global config
# - how can we make sure that the user log info is being sent to Discord (webhook URL must be in config.sh which most people wont have set up)

function main {
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> running script diamondEMERGENCYPause now...."


  # load config & helper functions
  source ./script/helperFunctions.sh

  # read function arguments into variables
  local NETWORK="$1"
  local DIAMOND_CONTRACT_NAME="$3"
  local EXIT_ON_ERROR="$4"
  local ENVIRONMENT="production" # this script is only meant to be used on PROD diamond

    # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")



  echo "TEST_SECRET: $TEST_SECRET"
  echo "DIAMOND_CONTRACT_NAME: $DIAMOND_CONTRACT_NAME"
  echo "EXIT_ON_ERROR: $EXIT_ON_ERROR"
  echo "ENVIRONMENT: $ENVIRONMENT"
  echo "FILE_SUFFIX: $FILE_SUFFIX"
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "mainnet" "production" "LiFiDiamond")

  echo "DIAMOND_ADDRESS: $DIAMOND_ADDRESS"

  if [[ "$PRIVATE_KEY_PAUSER_WALLET" == "TEST_SECRET_VALUE" ]]; then
    echo "TEST_SECRET_VALUE found"
  else
    PAUSER_WALLET_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  fi

  echo "trying to print pauser wallet key now"
  echo "PRIVATE_KEY_PAUSER_WALLET: $PRIVATE_KEY_PAUSER_WALLET"
  PAUSER_WALLET_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  echo "PAUSER_WALLET_ADDRESS: $PAUSER_WALLET_ADDRESS"


}

main "$@"

