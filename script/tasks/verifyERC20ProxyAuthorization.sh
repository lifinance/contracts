#!/bin/bash

verifyERC20ProxyAuthorization() {
	source .env
  source script/helperFunctions.sh

  local NETWORK=$1
  local ENVIRONMENT=$2

  local RPC_URL=$(getRPCUrl "$NETWORK") || checkFailure $? "get rpc url"

  local ERC20PROXY
  ERC20PROXY=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "ERC20Proxy")
  local EXECUTOR
  EXECUTOR=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "Executor")

  if [[ -z "$ERC20PROXY" || -z "$EXECUTOR" ]]; then
    error "Missing address (ERC20Proxy=$ERC20PROXY, Executor=$EXECUTOR)"
    exit 1
  fi

	echo ""
	echo "Verifying Executor authorization in ERC20Proxy on $NETWORK..."

  local IS_AUTHORIZED
  IS_AUTHORIZED=$(universalCast "call" "$NETWORK" "$ERC20PROXY" "authorizedCallers(address)(bool)" "$EXECUTOR")

  if [[ "$IS_AUTHORIZED" == "true" ]]; then
    echo "[info] Executor is already authorized in ERC20Proxy"
  else
    error "Executor is not authorized in ERC20Proxy (ERC20Proxy=$ERC20PROXY, Executor=$EXECUTOR)"
    error "New deployments (ERC20Proxy >= 1.2.0) pre-authorize Executor at deploy time via predicted CREATE3 address."
    error "For legacy deployments, refundWallet must call setAuthorizedCaller(executor, true) on ERC20Proxy."
    exit 1
  fi

	echo ""
}

# zkEVM-only follow-up to Stage 10.
#
# On zkEVM, CREATE2 addresses depend on constructor args, so the Executor address cannot be predicted
# before deploy and ERC20Proxy is deployed WITHOUT pre-authorization (executor = address(0)). The
# Executor therefore has to be authorized by the ERC20Proxy owner (refundWallet) after deploy. The
# deploy wallet does not hold that key, so this step cannot send the tx itself — instead it:
#   1. is idempotent: if the Executor is already authorized (re-run after the manual tx), it passes.
#   2. funds the owner with a little native gas for the single setAuthorizedCaller tx (optional prompt).
#   3. prints the exact command the owner must run, and warns that the chain is not fully functional
#      (Executor cannot pull tokens via the proxy) until that tx lands.
authorizeExecutorOnZkEvm() {
	source .env
  source script/helperFunctions.sh

  local NETWORK=$1
  local ENVIRONMENT=$2

  local ERC20PROXY
  ERC20PROXY=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "ERC20Proxy")
  local EXECUTOR
  EXECUTOR=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "Executor")

  if [[ -z "$ERC20PROXY" || -z "$EXECUTOR" ]]; then
    error "Missing address (ERC20Proxy=$ERC20PROXY, Executor=$EXECUTOR)"
    return 1
  fi

  echo ""
  echo "Verifying Executor authorization in ERC20Proxy on $NETWORK (zkEVM)..."

  local IS_AUTHORIZED
  IS_AUTHORIZED=$(universalCast "call" "$NETWORK" "$ERC20PROXY" "authorizedCallers(address)(bool)" "$EXECUTOR")

  if [[ "$IS_AUTHORIZED" == "true" ]]; then
    echo "[info] Executor is already authorized in ERC20Proxy"
    echo ""
    return 0
  fi

  # Resolve the actual owner on-chain (don't assume refundWallet) so the printed command is correct.
  local OWNER
  OWNER=$(universalCast "call" "$NETWORK" "$ERC20PROXY" "owner()(address)")

  echo ""
  gum style \
    --foreground 220 --border-foreground 220 --border double \
    --align left --width 78 --margin "1 2" --padding "1 2" \
    'ACTION REQUIRED (zkEVM): Executor is NOT yet authorized in ERC20Proxy.' \
    'zkEVM cannot pre-authorize at construction, so the owner must do it manually.' \
    "Owner:      $OWNER" \
    "ERC20Proxy: $ERC20PROXY" \
    "Executor:   $EXECUTOR" \
    '' \
    'Run from the owner key:' \
    "  cast send $ERC20PROXY \"setAuthorizedCaller(address,bool)\" $EXECUTOR true \\" \
    "    --rpc-url $NETWORK --private-key <OWNER_KEY>" \
    '' \
    'Until this lands, the Executor cannot pull tokens via the proxy and swaps' \
    'routed through the Executor on this chain WILL FAIL. Re-run stage 10 to verify.'

  # Optionally fund the owner with gas for that single tx (deploy wallet pays).
  local RPC_URL
  RPC_URL=$(getRPCUrl "$NETWORK") || { error "failed to obtain RPC URL for $NETWORK"; return 1; }
  local PRIVATE_KEY_TO_USE
  PRIVATE_KEY_TO_USE=$(getPrivateKey "$NETWORK" "$ENVIRONMENT") || { error "no private key for $NETWORK"; return 1; }

  local OWNER_BALANCE
  OWNER_BALANCE=$(cast balance "$OWNER" --rpc-url "$RPC_URL")
  echo "[info] Owner ($OWNER) native balance: $OWNER_BALANCE wei"

  local DEFAULT_FUND_AMOUNT=1000000000000000 # 0.001 native; one cheap state-setting tx
  local DO_FUND_OWNER=false

  # Only top up when the owner can't cover the tx. Compare with bc: wei balances routinely exceed
  # 2^63 and would overflow bash integer arithmetic. Without this gate, every NON_INTERACTIVE rerun
  # (e.g. before the manual authorization lands) would send another DEFAULT_FUND_AMOUNT.
  local OWNER_NEEDS_FUNDING=false
  if [[ -z "$OWNER_BALANCE" ]] || (( $(echo "$OWNER_BALANCE < $DEFAULT_FUND_AMOUNT" | bc -l) )); then
    OWNER_NEEDS_FUNDING=true
  fi

  if [[ "${NON_INTERACTIVE:-}" == "true" ]]; then
    if [[ "$OWNER_NEEDS_FUNDING" == "true" ]]; then
      echo "[info] NON_INTERACTIVE: owner balance below $DEFAULT_FUND_AMOUNT wei; auto-funding for the setAuthorizedCaller tx"
      DO_FUND_OWNER=true
    else
      echo "[info] NON_INTERACTIVE: owner already has sufficient native balance; skipping automatic funding"
    fi
  elif gum confirm "Fund owner with gas for the setAuthorizedCaller tx now?"; then
    DO_FUND_OWNER=true
  fi

  if [[ "$DO_FUND_OWNER" == "true" ]]; then
    local FUNDING_AMOUNT
    if [[ "${NON_INTERACTIVE:-}" == "true" ]]; then
      FUNDING_AMOUNT="$DEFAULT_FUND_AMOUNT"
    else
      echo "Enter wei to send to $OWNER (edit or press Enter to confirm default):"
      FUNDING_AMOUNT=$(gum input --value "$DEFAULT_FUND_AMOUNT" --placeholder "wei amount" --width 40)
    fi
    FUNDING_AMOUNT="${FUNDING_AMOUNT:-$DEFAULT_FUND_AMOUNT}"
    if ! [[ "$FUNDING_AMOUNT" =~ ^[0-9]+$ ]]; then
      error "Invalid funding amount. Please provide a valid wei amount (numeric value)."
      return 1
    fi
    echo "Funding owner $OWNER with $FUNDING_AMOUNT wei for the manual authorization tx"
    universalCast "sendValue" "$NETWORK" "$ENVIRONMENT" "$OWNER" "$FUNDING_AMOUNT" "$PRIVATE_KEY_TO_USE"
    checkFailure $? "fund owner $OWNER on $NETWORK"
  else
    echo "[info] Skipped funding $OWNER (it may already hold gas)."
  fi

  # Don't fail the deploy: the proxy/Executor are deployed correctly; authorization is a known manual
  # follow-up that this wallet cannot perform. The warning above makes the pending action explicit.
  echo ""
  return 0
}

