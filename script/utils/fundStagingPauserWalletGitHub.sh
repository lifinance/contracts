#!/bin/bash

# fundStagingPauserWalletGitHub.sh
#
# Tops up the staging PauserWallet on arbitrum, optimism, and base from the
# staging deployer/dev wallet so diamondEMERGENCYPauseStagingGitHub.sh can run
# on chains where the pauser EOA is empty.
#
# Pre-flights:
#   - skip network entirely if the pauser already holds >= $USD_SKIP_THRESHOLD
#     (enough native to send a pause tx); no sender check needed in that case
#   - sender (deployer/dev) balance on each remaining chain (must cover fund + reserve)
#   - on-chain pauserWallet() of each staging diamond matches the recipient
# If any pre-flight check fails, the script exits before sending any tx.
#
# Funding amount matches DEFAULT_FUND_AMOUNT in script/deploy/deployAllContracts.sh
# (Stage 9: Fund PauserWallet and DevWallet).

set -euo pipefail

# load required helpers and env
source script/helperFunctions.sh
source .env

# recipient: staging PauserWallet (address derived from PRIVATE_KEY_PAUSER_WALLET in CI)
PAUSER_WALLET_ADDRESS="0x439B9e7f4Aa5e2360C49a200F23F2edD385Bba17"

# 0.002 ETH (matches DEFAULT_FUND_AMOUNT in deployAllContracts.sh Stage 9)
FUND_AMOUNT_WEI=2000000000000000

# minimum native balance the sender must keep on top of the transfer to cover gas
GAS_RESERVE_WEI=500000000000000

ENVIRONMENT="staging"
NETWORKS=("arbitrum" "optimism" "base")

# skip a chain entirely if the pauser already holds >= this much native (in USD).
# all three networks use ETH as the gas token, so a single ETH/USD price suffices.
USD_SKIP_THRESHOLD=1

# RPC pacing - some staging/public endpoints throttle aggressively (~1 call per 3s).
# Same shape as diamondEMERGENCYPauseStagingGitHub.sh: bounded retries with fixed sleep.
MAX_ATTEMPTS=5
RETRY_SLEEP_SECONDS=3
RPC_CALL_DELAY_SECONDS=1   # gentle pacing between back-to-back cast reads

# retryRpc: Run an RPC-touching command up to $MAX_ATTEMPTS times with
# $RETRY_SLEEP_SECONDS between failures. Prints last stdout+stderr to stdout
# so callers can capture it; returns 0 on first success, 1 if all attempts fail.
# Usage: VAR=$(retryRpc "label" cast balance "$ADDR" --rpc-url "$RPC")
retryRpc() {
  local LABEL="$1"
  shift
  local ATTEMPT=1
  local OUT=""
  while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
    if OUT=$("$@" 2>&1); then
      printf "%s" "$OUT"
      return 0
    fi
    if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
      echo "[retry] $LABEL attempt $ATTEMPT failed, sleeping ${RETRY_SLEEP_SECONDS}s..." >&2
      sleep "$RETRY_SLEEP_SECONDS"
    fi
    ATTEMPT=$((ATTEMPT + 1))
  done
  printf "%s" "$OUT"
  return 1
}

echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> pre-flight checks"
echo "[info] recipient (pauser):  $PAUSER_WALLET_ADDRESS"
echo "[info] amount per network:  $FUND_AMOUNT_WEI wei (0.002 ETH)"
echo "[info] gas reserve per net: $GAS_RESERVE_WEI wei"
echo "[info] skip threshold:      \$$USD_SKIP_THRESHOLD (per-chain pauser USD balance)"
echo ""

# fetch ETH/USD spot price (CoinGecko, no auth required)
echo "[info] fetching ETH/USD price from CoinGecko..."
ETH_USD=$(curl -fsS "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd" | jq -r '.ethereum.usd')
if [[ -z "$ETH_USD" || "$ETH_USD" == "null" ]]; then
  error "Could not fetch ETH/USD price from CoinGecko"
  exit 1
fi
# convert $USD_SKIP_THRESHOLD into a wei threshold (integer)
WEI_SKIP_THRESHOLD=$(echo "scale=0; ($USD_SKIP_THRESHOLD * 10^18) / $ETH_USD" | bc)
echo "[info] ETH/USD = \$$ETH_USD  ->  skip threshold = $WEI_SKIP_THRESHOLD wei (~\$$USD_SKIP_THRESHOLD)"
echo ""

PREFLIGHT_OK=true

for NETWORK in "${NETWORKS[@]}"; do
  RPC_URL=$(getRPCUrl "$NETWORK")
  if [[ -z "$RPC_URL" ]]; then
    error "[network: $NETWORK] RPC URL not available"
    exit 1
  fi

  # check pauser balance first - if already >= $USD_SKIP_THRESHOLD, skip this chain entirely
  if ! PAUSER_BAL=$(retryRpc "[$NETWORK] cast balance pauser" cast balance "$PAUSER_WALLET_ADDRESS" --rpc-url "$RPC_URL"); then
    error "[network: $NETWORK] failed to read pauser balance after $MAX_ATTEMPTS attempts: $PAUSER_BAL"
    exit 1
  fi
  if [[ $(echo "$PAUSER_BAL >= $WEI_SKIP_THRESHOLD" | bc) -eq 1 ]]; then
    echo "[network: $NETWORK] pauser already holds $PAUSER_BAL wei (>= \$$USD_SKIP_THRESHOLD). Skipping - no sender check needed."
    echo ""
    sleep "$RPC_CALL_DELAY_SECONDS"
    continue
  fi

  PRIVATE_KEY_TO_USE=$(getPrivateKey "$NETWORK" "$ENVIRONMENT")
  if [[ -z "$PRIVATE_KEY_TO_USE" ]]; then
    error "[network: $NETWORK] could not resolve private key for $ENVIRONMENT environment"
    exit 1
  fi

  SENDER_ADDR=$(cast wallet address "$PRIVATE_KEY_TO_USE")

  sleep "$RPC_CALL_DELAY_SECONDS"
  if ! BALANCE=$(retryRpc "[$NETWORK] cast balance sender" cast balance "$SENDER_ADDR" --rpc-url "$RPC_URL"); then
    error "[network: $NETWORK] failed to read sender balance after $MAX_ATTEMPTS attempts: $BALANCE"
    exit 1
  fi

  REQUIRED=$((FUND_AMOUNT_WEI + GAS_RESERVE_WEI))

  # confirm the on-chain registered pauser on each staging diamond
  DIAMOND_ADDRESS=$(getValueFromJSONFile "./deployments/${NETWORK}.staging.json" "LiFiDiamond")
  if [[ -z "$DIAMOND_ADDRESS" || "$DIAMOND_ADDRESS" == "null" ]]; then
    error "[network: $NETWORK] LiFiDiamond not found in deployments/${NETWORK}.staging.json"
    exit 1
  fi
  sleep "$RPC_CALL_DELAY_SECONDS"
  if ! ONCHAIN_PAUSER=$(retryRpc "[$NETWORK] pauserWallet()" universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "pauserWallet() returns (address)"); then
    error "[network: $NETWORK] failed to read pauserWallet() after $MAX_ATTEMPTS attempts: $ONCHAIN_PAUSER"
    exit 1
  fi

  echo "[network: $NETWORK]"
  echo "  pauser balance:   $PAUSER_BAL wei (< \$$USD_SKIP_THRESHOLD - top-up needed)"
  echo "  sender:           $SENDER_ADDR"
  echo "  sender balance:   $BALANCE wei"
  echo "  required (>=):    $REQUIRED wei"
  echo "  diamond:          $DIAMOND_ADDRESS"
  echo "  on-chain pauser:  $ONCHAIN_PAUSER"

  if [[ "$(echo "$ONCHAIN_PAUSER" | tr '[:upper:]' '[:lower:]')" != "$(echo "$PAUSER_WALLET_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]]; then
    error "  on-chain pauser does NOT match expected $PAUSER_WALLET_ADDRESS - refusing to fund"
    PREFLIGHT_OK=false
  fi

  if [[ $(echo "$BALANCE < $REQUIRED" | bc) -eq 1 ]]; then
    error "  insufficient sender balance (have $BALANCE, need >= $REQUIRED)"
    PREFLIGHT_OK=false
  fi
  echo ""
done

if [[ "$PREFLIGHT_OK" != "true" ]]; then
  error "Pre-flight failed. No transactions sent. Top up the deployer/dev wallet or fix the diamond config and re-run."
  exit 1
fi

echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< pre-flight passed"
echo ""

# send transfers (sequentially - clearer logs and easier to abort mid-way)
for NETWORK in "${NETWORKS[@]}"; do
  echo ">>>>>>>>>>>>>>>>>>>>>> start network $NETWORK >>>>>>>>>>>>>>>>>>>>>>"
  RPC_URL=$(getRPCUrl "$NETWORK")

  if ! PAUSER_BAL_BEFORE=$(retryRpc "[$NETWORK] balance pauser (pre-send)" cast balance "$PAUSER_WALLET_ADDRESS" --rpc-url "$RPC_URL"); then
    error "[network: $NETWORK] failed to read pauser balance before send: $PAUSER_BAL_BEFORE"
    echo "<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<"
    echo ""
    continue
  fi
  echo "[network: $NETWORK] pauser balance before: $PAUSER_BAL_BEFORE wei"

  if [[ $(echo "$PAUSER_BAL_BEFORE >= $WEI_SKIP_THRESHOLD" | bc) -eq 1 ]]; then
    echo "[network: $NETWORK] pauser already holds >= \$$USD_SKIP_THRESHOLD ($PAUSER_BAL_BEFORE wei). Skipping send."
    echo "<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<"
    echo ""
    sleep "$RPC_CALL_DELAY_SECONDS"
    continue
  fi

  PRIVATE_KEY_TO_USE=$(getPrivateKey "$NETWORK" "$ENVIRONMENT")
  echo "[network: $NETWORK] sending $FUND_AMOUNT_WEI wei to $PAUSER_WALLET_ADDRESS"

  # retry the actual send (mirrors diamondEMERGENCYPauseStagingGitHub.sh:104-119)
  SEND_ATTEMPTS=1
  while [ $SEND_ATTEMPTS -le $MAX_ATTEMPTS ]; do
    echo "[network: $NETWORK] send attempt $SEND_ATTEMPTS/$MAX_ATTEMPTS"
    if universalCast "sendValue" "$NETWORK" "$ENVIRONMENT" "$PAUSER_WALLET_ADDRESS" "$FUND_AMOUNT_WEI" "$PRIVATE_KEY_TO_USE"; then
      break
    fi
    SEND_ATTEMPTS=$((SEND_ATTEMPTS + 1))
    if [ $SEND_ATTEMPTS -le $MAX_ATTEMPTS ]; then
      echo "[network: $NETWORK] send failed, sleeping ${RETRY_SLEEP_SECONDS}s before retry..."
      sleep "$RETRY_SLEEP_SECONDS"
    fi
  done
  if [ $SEND_ATTEMPTS -gt "$MAX_ATTEMPTS" ]; then
    error "[network: $NETWORK] failed to fund pauser after $MAX_ATTEMPTS attempts"
    echo "<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<"
    echo ""
    continue
  fi

  # post-send verification: read pauser balance with retry so a transient RPC
  # hiccup doesn't make a successful send look like a failure
  sleep "$RPC_CALL_DELAY_SECONDS"
  if ! PAUSER_BAL_AFTER=$(retryRpc "[$NETWORK] balance pauser (post-send)" cast balance "$PAUSER_WALLET_ADDRESS" --rpc-url "$RPC_URL"); then
    warning "[network: $NETWORK] post-send balance read failed (tx may still have landed): $PAUSER_BAL_AFTER"
  else
    echo "[network: $NETWORK] pauser balance after:  $PAUSER_BAL_AFTER wei"
  fi
  echo "<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<"
  echo ""
done

echo "[success] All transfers complete."
