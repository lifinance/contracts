#!/bin/bash
source .env

if [[ -z "$PRODUCTION" ]]; then
	FILE_SUFFIX="staging."
fi

NETWORK=$(cat ./networks | gum filter --placeholder "Network")

DIAMOND=$(jq -r '.LiFiDiamond' "./deployments/${NETWORK}.${FILE_SUFFIX}json")
CFG_SIGS=($(jq -r '.[] | @sh' "./config/sigs.json" | tr -d \' | tr '[:upper:]' '[:lower:]' ))

RPC="ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<< "$NETWORK")"


echo 'Updating Sigs'
for d in "${CFG_SIGS[@]}"; do
  PARAMS+="${d},"
done
cast send $DIAMOND "batchSetFunctionApprovalBySignature(bytes4[],bool)" "[${PARAMS::-1}]" true --rpc-url ${!RPC} --private-key ${PRIVATE_KEY} --legacy 
