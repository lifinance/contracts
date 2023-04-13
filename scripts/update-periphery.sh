#!/bin/bash
source .env


function updatePeriphery() {

  if [[ -z "$PRODUCTION" ]]; then
    FILE_SUFFIX=".staging"
  fi

  NETWORK=$(cat ./networks | gum filter --placeholder "Network")
  CONTRACTS=$(gum choose --no-limit erc20Proxy axelarExecutor executor receiver feeCollector serviceFeeCollector relayerCelerIM)

  ADDRS="deployments/$NETWORK$FILE_SUFFIX.json"

  DIAMOND=$(jq -r '.LiFiDiamond' $ADDRS)
  ERC20PROXY=$(jq -r '.ERC20Proxy // "0x"' $ADDRS)
  AXELAREXECUTOR=$(jq -r '.AxelarExecutor // "0x"' $ADDRS)
  EXECUTOR=$(jq -r '.Executor // "0x"' $ADDRS)
  RECEIVER=$(jq -r '.Receiver // "0x"' $ADDRS)
  FEECOLLECTOR=$(jq -r '.FeeCollector // "0x"' $ADDRS)
  SERVICEFEECOLLECTOR=$(jq -r '.ServiceFeeCollector // "0x"' $ADDRS)
  RELAYERCELERIM=$(jq -r '.RelayerCelerIM // "0x"' $ADDRS)

  echo "Diamond: $DIAMOND"

  if [[ "$ERC20PROXY" != "0x"  && " ${CONTRACTS[*]} " =~ "erc20Proxy" ]]; then
    echo "Updating ERC20Proxy $ERC20PROXY"
    register $NETWORK $DIAMOND 'ERC20Proxy' $ERC20PROXY
  fi

  if [[ "$AXELAREXECUTOR" != "0x" && " ${CONTRACTS[*]}" =~ "axelarExecutor" ]]; then
    echo "Updating AxelarExecutor $AXELAREXECUTOR"
    register $NETWORK $DIAMOND 'AxelarExecutor' $AXELAREXECUTOR
  fi

  if [[ "$EXECUTOR" != "0x" && " ${CONTRACTS[*]}" =~ "executor" ]]; then
    echo "Updating Executor $EXECUTOR"
    register $NETWORK $DIAMOND 'Executor' $EXECUTOR
  fi

  if [[ "$RECEIVER" != "0x" && " ${CONTRACTS[*]}" =~ "receiver" ]]; then
    echo "Updating Receiver $RECEIVER"
    register $NETWORK $DIAMOND 'Receiver' $RECEIVER
  fi

  if [[ "$FEECOLLECTOR" != "0x" && " ${CONTRACTS[*]}" =~ "feeCollector" ]]; then
    echo "Updating FeeCollector $FEECOLLECTOR"
    register $NETWORK $DIAMOND 'FeeCollector' $FEECOLLECTOR
  fi

  if [[ "$SERVICEFEECOLLECTOR" != "0x" && " ${CONTRACTS[*]}" =~ "serviceFeeCollector" ]]; then
    echo "Updating ServiceFeeCollector $SERVICEFEECOLLECTOR"
    register $NETWORK $DIAMOND 'ServiceFeeCollector' $SERVICEFEECOLLECTOR
  fi


  if [[ "$RELAYERCELERIM" != "0x" && " ${CONTRACTS[*]}" =~ "relayerCelerIM" ]]; then
    echo "Updating RelayerCelerIM $RELAYERCELERIM"
    register $NETWORK $DIAMOND 'RelayerCelerIM' $RELAYERCELERIM
  fi
}

register() {
	NETWORK=$(tr '[:lower:]-' '[:upper:]_' <<< $1)
  DIAMOND=$2
  NAME=$3
  ADDR=$4
  RPC="ETH_NODE_URI_$NETWORK"

  cast send $DIAMOND 'registerPeripheryContract(string,address)' "$NAME" "$ADDR" --private-key $PRIVATE_KEY --rpc-url "${!RPC}" --legacy
}

updatePeriphery
