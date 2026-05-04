#!/bin/bash

# deploys a CREATE3Factory
# stores the deployed-to address in networks.json
deployAndStoreCREATE3Factory() {
  # load helper functions
  source script/helperFunctions.sh

  # make sure script was called with sufficient parameters
  if [ "$#" -lt 2 ]; then
    error "Usage: deployAndStoreCREATE3Factory <NETWORK> <ENVIRONMENT>"
    return 1
  fi

  echo ""
  echo ""
  echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> deploying CREATE3Factory now...."


  # read function arguments into variables
  local NETWORK="$1"
  local ENVIRONMENT="$2"

  # load env variables
  source .env

  # get file suffix based on value in variable ENVIRONMENT
  local FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  # logging for debug purposes
  echo ""
  echoDebug "in function deployAndStoreCREATE3Factory"
  echoDebug "NETWORK=$NETWORK"
  echoDebug "ENVIRONMENT=$ENVIRONMENT"
  echoDebug "FILE_SUFFIX=$FILE_SUFFIX"
  echo ""

  # deploy CREATE3Factory
  echo "Trying to deploy CREATE3Factory now"
  echo ""

  [[ -z "$GAS_ESTIMATE_MULTIPLIER" ]] && GAS_ESTIMATE_MULTIPLIER=200
  SKIP_SIMULATION_FLAG=$(getSkipSimulationFlag)

  FACTORY_ADDRESS=""
  PRIVATE_KEY=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") || {
    error "Failed to load PRIVATE_KEY for network $NETWORK (environment: $ENVIRONMENT)"
    return 1
  }

  # 1) Try forge script (works for chains in Foundry's alloy-chains list)
  if executeAndParse \
    "PRIVATE_KEY=\"$PRIVATE_KEY\" forge script script/deploy/facets/DeployCREATE3Factory.s.sol --fork-url \"$NETWORK\" --json --broadcast --legacy --slow $SKIP_SIMULATION_FLAG --gas-estimate-multiplier \"$GAS_ESTIMATE_MULTIPLIER\"" \
    "true" \
    "" \
    "return"; then
    FACTORY_ADDRESS=$(extractDeployedAddressFromRawReturnData "${RAW_RETURN_DATA:-}" "$NETWORK")
  fi

  # 2) Fallback when chain is not in Foundry's alloy-chains: deploy same bytecode as the Solidity
  #    script (from forge build) via cast send --create, so the .s.sol script remains the single source of truth.
  if [[ -z "$FACTORY_ADDRESS" || "$FACTORY_ADDRESS" == "null" ]]; then
    if [[ "${STDERR_CONTENT:-}" == *"Chain"* && "${STDERR_CONTENT:-}" == *"not supported"* ]]; then
      echo "[info] Chain not in Foundry list; deploying via cast send --create"
      local RPC_URL
      RPC_URL=$(getRPCUrl "$NETWORK") || return 1
      if ! forge build --contracts lib/create3-factory/src/CREATE3Factory.sol --silent; then
        error "CREATE3Factory build failed; fix the build before deploying."
        return 1
      fi
      local ARTIFACT="out/CREATE3Factory.sol/CREATE3Factory.json"
      [[ ! -f "$ARTIFACT" ]] && ARTIFACT="out/lib/create3-factory/src/CREATE3Factory.sol/CREATE3Factory.json"
      if [[ ! -f "$ARTIFACT" ]]; then
        error "CREATE3Factory artifact not found. Run: forge build"
        return 1
      fi
      local BYTECODE
      BYTECODE=$(jq -r '.bytecode.object // empty' "$ARTIFACT")
      if [[ -z "$BYTECODE" || "$BYTECODE" == "null" ]]; then
        error "Could not read bytecode from $ARTIFACT"
        return 1
      fi
      local TX_OUTPUT
      TX_OUTPUT=$(cast send --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" --legacy --create "$BYTECODE" --json 2>&1) || {
        error "cast send failed: $TX_OUTPUT"
        return 1
      }
      # cast may print log lines before the JSON; use last line or first {...} for jq
      local TX_JSON
      TX_JSON=$(echo "$TX_OUTPUT" | grep -E '^\s*\{' | head -1)
      [[ -z "$TX_JSON" ]] && TX_JSON=$(echo "$TX_OUTPUT" | tail -1)
      local TX_HASH
      TX_HASH=$(echo "$TX_JSON" | jq -r '.transactionHash // empty' 2>/dev/null)
      [[ -z "$TX_HASH" ]] && TX_HASH=$(echo "$TX_OUTPUT" | grep -oE '0x[a-fA-F0-9]{64}' | head -1)
      if [[ -z "$TX_HASH" ]]; then
        error "Could not get tx hash from cast send"
        return 1
      fi
      local RECEIPT_OUTPUT
      RECEIPT_OUTPUT=$(cast receipt "$TX_HASH" --rpc-url "$RPC_URL" --json 2>/dev/null)
      local RECEIPT_JSON
      RECEIPT_JSON=$(echo "$RECEIPT_OUTPUT" | grep -E '^\s*\{' | head -1)
      [[ -z "$RECEIPT_JSON" ]] && RECEIPT_JSON=$(echo "$RECEIPT_OUTPUT" | tail -1)
      FACTORY_ADDRESS=$(echo "$RECEIPT_JSON" | jq -r '.contractAddress // empty' 2>/dev/null)
    fi
  fi

  if [[ -z "$FACTORY_ADDRESS" || "$FACTORY_ADDRESS" == "null" ]]; then
    if [[ -n "${STDERR_CONTENT:-}" ]]; then
      error "❌ Deployment failed on $NETWORK. Last stderr: ${STDERR_CONTENT:0:500}"
    else
      error "Failed to obtain CREATE3Factory address on $NETWORK ($ENVIRONMENT)"
    fi
    return 1
  fi

  echo "✅ Successfully deployed to address $FACTORY_ADDRESS"

  # check if network exists in networks.json
  if ! jq -e --arg net "$NETWORK" '.[$net]' "$NETWORKS_JSON_FILE_PATH" >/dev/null; then
    error "Network \"$NETWORK\" does not exist in networks.json"
    return 1
  fi

  # update create3Factory field in networks.json
  tmpfile=$(mktemp)
  if ! jq --arg net "$NETWORK" --arg addr "$FACTORY_ADDRESS" \
    '(.[$net].create3Factory) = $addr' "$NETWORKS_JSON_FILE_PATH" > "$tmpfile"; then
    error "Failed to update networks.json"
    rm -f "$tmpfile"
    return 1
  fi

  mv "$tmpfile" "$NETWORKS_JSON_FILE_PATH"
  echo "Stored CREATE3Factory address ($FACTORY_ADDRESS) in networks.json for network \"$NETWORK\""

  # verify CREATE3Factory
  # verifyContract "$NETWORK" "CREATE3Factory" "$FACTORY_ADDRESS" "0x"

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< CREATE3Factory deployed (please check for warnings)"
  echo ""
  return 0
}
