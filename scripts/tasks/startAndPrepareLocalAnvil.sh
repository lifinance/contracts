#!/bin/bash

# load env variables
source .env

# load scripts
source scripts/config.sh
source scripts/deploy/resources/deployHelperFunctions.sh


function run() {

  startAndPrepareLocalAnvil &
  deployCreate3FactoryToAnvil


  echo "create3Factory Address = $ADDRESS"

}


function startAndPrepareLocalAnvil {
    # start network with given MNEMONIC (so we can use pre-determined private keys) and suppress output
    echo "[info] starting local anvil network"
    anvil -m "$MNEMONIC" &
    ANVIL_PROCESS_ID=$!
    sleep 2

    echo "ANVIL_PROCESS_ID: $ANVIL_PROCESS_ID"
#

#    # add CREATE3Factory repo as submodule
#    echo ""
#    echo ""
#    echo "[info] deploying create3Factory now"
#    ADDRESS=$(PRIVATE_KEY=$PRIVATE_KEY_ANVIL forge script lib/create3-factory/script/Deploy.s.sol --fork-url http://localhost:8545)
#    wait
#    echo "[info] deploying create3Factory done"
#
#    # deploy CREATE3Factory
#    # TODO: find out how to deploy contract to complete
#
#    echo "ADDRESS: $ADDRESS"
#
#    # update address of CREATE3Factory in env variable
#    export CREATE3_FACTORY_ADDRESS=$ADDRESS

#    kill $ANVIL_PROCESS_ID
}

run
