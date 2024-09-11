#!/bin/bash
#

# load env variables
source .env

# load script
source script/helperFunctions.sh


function test_tmp() {

  CONTRACT="LiFiDEXAggregator"
  NETWORK="immutablezkevm"
  ADDRESS=""
  ENVIRONMENT="production"
  VERSION="2.0.0"
  DIAMOND_CONTRACT_NAME="LiFiDiamondImmutable"
  ARGS="0x"
  RPC_URL=$(getRPCUrl "$NETWORK" "$ENVIRONMENT")
  #  ADDRESS=$(getContractOwner "$NETWORK" "$ENVIRONMENT" "ERC20Proxy");
  #  if [[ "$ADDRESS" != "$ZERO_ADDRESS" ]]; then
  #    error "ERC20Proxy ownership was not transferred to address(0)"
  #    exit 1
  #  fi
  #getPeripheryAddressFromDiamond "$NETWORK" "0x9b11bc9FAc17c058CAB6286b0c785bE6a65492EF" "RelayerCelerIM"
  # verifyContract "$NETWORK" "$CONTRACT" "$ADDRESS" "$ARGS"

  # forge verify-contract "$ADDRESS" "$CONTRACT" --chain-id 13371 --verifier blockscout --verifier-url https://explorer.immutable.com/api --skip-is-verified-check
  # forge verify-contract 0x8CDDE82cFB4555D6ca21B5b28F97630265DA94c4 Counter --verifier oklink --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER  --api-key $OKLINK_API_KEY


  # transferContractOwnership "$PRIVATE_KEY_PRODUCTION" "$PRIVATE_KEY" "$ADDRESS" "$NETWORK"
  # RESPONSE=$(cast call "$ADDRESS" "owner()" --rpc-url $(getRPCUrl "$NETWORK"))
  # echo "RESPONSE: $RESPONSE"
  # ADDRESS_NEW_OWNER=0xa89a87986e8ee1Ac8fDaCc5Ac91627010Ec9f772
  # cast call "$ADDRESS" "pendingOwner()" --rpc-url $(getRPCUrl "$NETWORK")
  # cast call "$ADDRESS" "facets() returns ((address,bytes4[])[] )" --rpc-url $(getRPCUrl "$NETWORK")
  # RESPONSE=$(cast send "$ADDRESS" "transferOwnership(address)" "$ADDRESS_NEW_OWNER" --private-key $PRIVATE_KEY_PRODUCTION --rpc-url "$RPC_URL")
  # echo "RESPONSE: $RESPONSE"

  # RESULT=$(yarn add-safe-owners --network immutablezkevm --rpc-url "$(getRPCUrl "$NETWORK" "$ENVIRONMENT")" --privateKey "$PRIVATE_KEY_PRODUCTION" --owners "0xb78FbE12d9C09d98ce7271Fa089c2fe437B7B4D5,0x65f6F29D3eb871254d71A79CC4F74dB3AAF3b86e,0x24767E3A1cb07ee500BA9A5621F2B608440Ca270,0x81Dbb716aA13869323974A1766120D0854188e3e,0x11F1022cA6AdEF6400e5677528a80d49a069C00c,0x498E8fF83B503aDe5e905719D27b2f11B605b45A")

  # RESPONSE=$(yarn add-safe-owners --network taiko --rpc-url $(getRPCUrl $NETWORK $ENVIRONMENT) --privateKey $PRIVATE_KEY_PRODUCTION --owners "0xb78FbE12d9C09d98ce7271Fa089c2fe437B7B4D5,0x65f6F29D3eb871254d71A79CC4F74dB3AAF3b86e,0x24767E3A1cb07ee500BA9A5621F2B608440Ca270,0x81Dbb716aA13869323974A1766120D0854188e3e,0x11F1022cA6AdEF6400e5677528a80d49a069C00c,0x498E8fF83B503aDe5e905719D27b2f11B605b45A")
  # echo "RESPONSE: $RESPONSE"
}
test_tmp
