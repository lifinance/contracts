#!/bin/bash
source .env

if [[ -z "$PRODUCTION" ]]; then
	FILE_SUFFIX="staging."
fi

NETWORK=$(cat ./networks | gum filter --placeholder "Network")

DIAMOND=$(jq -r '.LiFiDiamond' "./deployments/${NETWORK}.${FILE_SUFFIX}json")
echo "Diamond address: $DIAMOND"
CFG_DEXS=($(jq --arg n "$NETWORK" -r '.[$n] | @sh' "./config/dexs.json" | tr -d \' | tr '[:upper:]' '[:lower:]'))

RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")"

RESULT=$(cast call "$DIAMOND" "approvedDexs() returns (address[])" --rpc-url "${!RPC}")
DEXS=($(echo ${RESULT:1:${#RESULT}-1} | tr ',' '\n' | tr '[:upper:]' '[:lower:]'))

NEW_DEXS=()
for dex in "${CFG_DEXS[@]}"; do
  if [[ ! " ${DEXS[*]} " =~ " ${dex} " ]]; then
    NEW_DEXS+=($dex)
  fi
done

if [[ ! ${#NEW_DEXS[@]} -eq 0 ]]; then
  echo 'Adding missing DEXs'
  for d in "${NEW_DEXS[@]}"; do
    PARAMS+="${d},"
  done
  cast send $DIAMOND "batchAddDex(address[])" "[${PARAMS::${#PARAMS}-1}]" --rpc-url ${!RPC} --private-key ${PRIVATE_KEY} --legacy
else
  echo 'No new DEXs to add'
fi
