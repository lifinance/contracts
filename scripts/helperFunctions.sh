#!/bin/bash

log_file="deployments/deployments_log_file.json"

# DONE
function log_contract_info {
  # read function arguments into variables
  contract="$1"
  network="$2"
  date="$3"
  version="$4"
  optimizer_runs="$5"
  constr_args="$6"
  environment="$7"
  address="$8"

  # Check if log file exists, if not create it
  if [ ! -f "$log_file" ]; then
    echo "{}" > "$log_file"
  fi

  # Check if log file already contains entry with same contract, network, environment and version
  checkIfJSONContainsEntry $contract $network $environment $version
  if [ $? -eq 1 ]; then
      echo "[warning]: deployment log file contained already an entry for (contract: $contract, network: $network, environment: $environment, version: $version). This is unexpected behaviour since an existing contract should not have been re-deployed. A new entry was added to the log file. "
  fi

  # Append new JSON object to log file
  jq -r --arg contract "$contract" \
      --arg network "$network" \
      --arg environment "$environment" \
      --arg version "$version" \
      --arg address "$address" \
      --arg optimizer_runs "$optimizer_runs" \
      --arg date "$date" \
      --arg constr_args "$constr_args" \
      '.[$contract][$network][$environment][$version] += [{ address: $address, optimizer_runs: $optimizer_runs, date: $date, constr_args: $constr_args  }]' \
      "$log_file" > tmpfile && mv tmpfile "$log_file"
}
function checkIfJSONContainsEntry {
  CONTRACT=$1
  NETWORK=$2
  ENVIRONMENT=$3
  VERSION=$4

  # Check if the entry already exists
  if jq -e --arg contract "$CONTRACT" \
         --arg network "$NETWORK" \
         --arg environment "$ENVIRONMENT" \
         --arg version "$VERSION" \
         '.[$contract][$network][$environment][$version] != null' \
         "$log_file" > /dev/null; then
      return 1
  else
      return 0
  fi
}

# WIP
function


# TMP - remove after testing
function testing() {

  log_contract_info "ContractName" "BSC" "<date>" "1.0.0" "10000" "<args>" "staging" "0x1234"
  log_contract_info "ContractName" "BSC" "<date>" "1.0.1" "10000" "<args>" "staging" "0x4321"

  log_contract_info "ContractName" "ETH" "<date>" "1.0.0" "10000" "<args>" "staging" "0x1234"
  log_contract_info "ContractName" "ETH" "<date>" "1.0.1" "10000" "<args>" "staging" "0x4321"

  log_contract_info "ContractName" "BSC" "<date>" "1.0.0" "10000" "<args>" "production" "0x5555"
  log_contract_info "ContractName" "BSC" "<date>" "1.0.1" "10000" "<args>" "production" "0x6666"

  log_contract_info "ContractName" "ETH" "<date>" "1.0.0" "10000" "<args>" "production" "0x5555"
  log_contract_info "ContractName" "ETH" "<date>" "1.0.1" "10000" "<args>" "production" "0x6666"

  log_contract_info "ContractName2" "BSC" "<date>" "1.0.0" "10000" "<args>" "staging" "0x1234"
  log_contract_info "ContractName2" "BSC" "<date>" "1.0.1" "10000" "<args>" "staging" "0x4321"

  log_contract_info "ContractName2" "ETH" "<date>" "1.0.0" "10000" "<args>" "staging" "0x1234"
  log_contract_info "ContractName2" "ETH" "<date>" "1.0.1" "10000" "<args>" "staging" "0x4321"

}

function testing2() {
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


testing
