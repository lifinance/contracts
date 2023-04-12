#!/bin/bash

# the maximum time in seconds that the script will wait for blockchain to sync contract deployment
# we use this as double check to make sure that a contract was actually deployed
MAX_WAITING_TIME_FOR_BLOCKCHAIN_SYNC=60

# the maximum number of attempts to deploy a single contract
MAX_ATTEMPTS_PER_CONTRACT_DEPLOYMENT=20

# the maximum number of attempts to verify contract
MAX_ATTEMPTS_PER_CONTRACT_VERIFICATION=20

# the maximum number of attempts to execute a script (e.g. diamondUpdate)
MAX_ATTEMPTS_PER_SCRIPT_EXECUTION=20

# the root directory of all contract src files
CONTRACT_DIRECTORY="src/"

# the directory of all deploy and update scripts
DEPLOY_SCRIPT_DIRECTORY="script/"

# the path of the JSON file that contains the target state
TARGET_STATE_PATH="scripts/deploy/_targetState.json"

# the path of the JSON file that contains the deployment log file
LOG_FILE_PATH="deployments/_deployments_log_file.json"

# the path of the JSON file that contains the bytecode storage file
BYTECODE_STORAGE_PATH="deployments/_bytecode_storage.json"

# any networks listed here will be excluded from actions that are applied to "all networks"
# exclude all test networks:       EXCLUDE_NETWORKS="bsctest,goerli,sepolia,mumbai,consensys-zkevm-testnet"
# exclude all production networks: EXCLUDE_NETWORKS="mainnet,polygon,bsc,gnosis,fantom,okx,avalanche,arbitrum,optimism,moonriver,moonbeam,celo,fuse,cronos,velas,harmony,evmos,aurora,boba,nova"
EXCLUDE_NETWORKS=""

# will output more detailed information for debugging purposes
DEBUG=false

# defines if newly deployed contracts should be verified or not
VERIFY_CONTRACTS=false

# contract verification will be deactivated for any network listed here
DO_NOT_VERIFY_IN_THESE_NETWORKS=""

# the path to the file that contains a list of all networks
NETWORKS_FILE_PATH="./networks"

# script will use all periphery contracts by default, unless excluded here (must match exact filename without .sol, comma-separated without space)
EXCLUDE_PERIPHERY_CONTRACTS=""

# scripts will use all facet contracts by default, unless excluded here (must match exact filename without .sol, comma-separated without space)
EXCLUDE_FACET_CONTRACTS=""

# contains a list of all facets that are considered core facets (and will be deployed to every network)
CORE_FACETS="DiamondCutFacet,DiamondLoupeFacet,OwnershipFacet,DexManagerFacet,AccessManagerFacet,WithdrawFacet,PeripheryRegistryFacet"
