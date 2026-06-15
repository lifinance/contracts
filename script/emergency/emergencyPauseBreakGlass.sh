#!/bin/bash

# emergencyPauseBreakGlass.sh
#
# FROZEN, SELF-CONTAINED emergency-pause "break glass" script. This is the single source of
# truth for how we pause production (and staging) LiFiDiamonds from the registered PauserWallet
# EOA. It is the script the GitHub emergency-pause workflows run, and the one the interactive
# CLI tool (script/tasks/diamondEMERGENCYPause.sh) delegates its "pause entirely" action to.
#
# >>> ISOLATION CONTRACT — READ BEFORE EDITING <<<
# This file MUST stay independent of the shared scripting library. It deliberately does NOT
# `source` script/helperFunctions.sh or script/universalCast.sh, and MUST NOT call any of
# universalCast / universalSend / universalSendRaw / universalCall / universalCode /
# sendOrPropose. The emergency pause is incident-critical; coupling it to that churny routing
# layer is exactly what caused the EXSC-367 Safe-proposal regression. A CI guard
# (emergencyPauseGuard.yml) fails the build if this isolation is violated, and changes here
# require Information Security Manager approval (protectSecurityRelevantCode.yml).
# "Frozen code, live data": the dispatch logic is frozen, but the network list and diamond
# addresses are read live from config/networks.json + deployments/* so newly-added prod EVM
# diamonds are covered automatically. See script/emergency/README.md.
#
# Pausing is sent DIRECTLY from the PauserWallet EOA (cast send on EVM, troncast send on Tron) —
# never proposed to a Safe. The pauser is authorized on-chain via EmergencyPauseFacet
# (OnlyPauserWalletOrOwner), so pauseDiamond() is a normal EOA tx.
#
# Usage:
#   PRIVATE_KEY_PAUSER_WALLET=<hex key> [ENVIRONMENT=production|staging] [NETWORK=<name>|all] \
#     bash script/emergency/emergencyPauseBreakGlass.sh
#
# Env / args:
#   PRIVATE_KEY_PAUSER_WALLET - required; pauser key (with or without 0x; normalized internally)
#   ENVIRONMENT               - production (default) or staging; picks deploy-log + network set
#   NETWORK                   - optional; a single network name to restrict to, or "all" (default)
#   ETH_NODE_URI_<NETWORK>    - EVM RPC endpoints (injected by the workflow's MongoDB fetch step,
#                               or present in .env for local/CLI use)
#
# Returns: 0 if every targeted diamond ended up paused, 1 if any network failed.

# --------------------------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------------------------

# selector for the DiamondIsPaused() custom error (owner() reverts with this once paused)
DIAMOND_IS_PAUSED_SELECTOR="0x0149422e"

# max attempts for the pause send transaction
MAX_ATTEMPTS=10

# RPC pacing for read calls. RPCs throttle reads under incident-response load, so we pace and
# retry transient failures. Send retries use MAX_ATTEMPTS (intentionally larger).
RPC_MAX_ATTEMPTS=5
RPC_RETRY_SLEEP_SECONDS=3
RPC_CALL_DELAY_SECONDS=1

# gas buffer for EVM sends (keeps gas price above base fee on L2s); mirrors the shared default.
GAS_ESTIMATE_MULTIPLIER="${GAS_ESTIMATE_MULTIPLIER:-100}"

# staging network subset (mirrors the original staging workflow)
STAGING_NETWORKS=("bsc" "arbitrum" "optimism" "base")

# live data files (read-only)
NETWORKS_JSON_FILE_PATH="config/networks.json"

# resolved at runtime in main()
ENVIRONMENT="${ENVIRONMENT:-production}"
NETWORK="${NETWORK:-all}"

# --------------------------------------------------------------------------------------------
# Vendored logging (no external dependency)
# --------------------------------------------------------------------------------------------

function bgError() { printf '\033[31m[error] %s\033[0m\n' "$1"; }
function bgWarning() { printf '\033[33m[warning] %s\033[0m\n' "$1"; }
function bgSuccess() { printf '\033[0;32m[success] %s\033[0m\n' "$1"; }

# --------------------------------------------------------------------------------------------
# Vendored helpers (frozen copies of the relevant shared-library logic)
# --------------------------------------------------------------------------------------------

# bgIsTron: true (0) for Tron networks. Frozen copy of isTronNetwork.
function bgIsTron() {
  [[ "$1" == "tron" || "$1" == "tronshasta" ]]
}

# bgTronEnv: troncast --env value for a Tron network. Frozen copy of getTronEnv.
function bgTronEnv() {
  case "$1" in
    tron) echo "mainnet" ;;
    tronshasta) echo "testnet" ;;
  esac
}

# bgRpcEnvVarName: the ETH_NODE_URI_* env var name for an EVM network. Frozen copy of
# getRPCEnvVarName.
function bgRpcEnvVarName() {
  echo "ETH_NODE_URI_$(tr '[:lower:]' '[:upper:]' <<<"$1" | tr '-' '_')"
}

# bgCastSendAsync: read castSendAsync for a network from networks.json (some L2s return receipts
# cast cannot deserialize). Frozen copy of getCastSendAsync.
function bgCastSendAsync() {
  local NETWORK="$1"
  local VAL
  VAL=$(jq -r --arg network "$NETWORK" '.[$network].castSendAsync // false' "$NETWORKS_JSON_FILE_PATH" 2>/dev/null)
  [[ "$VAL" == "true" ]] && echo "true" || echo "false"
}

# evmToTronBase58: convert a 0x EVM address to its Tron base58check form. Frozen copy of the
# helper in verifyEmergencyPauseReadinessGitHub.sh. Used to compare the pauser key's Tron
# address against the on-chain pauserWallet() on Tron.
# Usage: TRON_ADDR=$(evmToTronBase58 "0xd387...")
function evmToTronBase58() {
  local ADDR_HEX="${1#0x}"
  ADDR_HEX="$(echo "$ADDR_HEX" | tr 'A-F' 'a-f')"
  local PAYLOAD_HEX="41${ADDR_HEX}"
  local CHECKSUM_HEX
  CHECKSUM_HEX="$(printf '%s' "$PAYLOAD_HEX" | xxd -r -p \
    | openssl dgst -sha256 -binary | openssl dgst -sha256 -binary \
    | xxd -p | tr -d '\n' | cut -c1-8)"
  local ALPHABET="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
  local DEC
  DEC="$(echo "ibase=16; $(echo "${PAYLOAD_HEX}${CHECKSUM_HEX}" | tr 'a-f' 'A-F')" | bc)"
  local OUT=""
  local REM
  while [[ "$DEC" != "0" ]]; do
    REM="$(echo "$DEC % 58" | bc)"
    OUT="${ALPHABET:$REM:1}${OUT}"
    DEC="$(echo "$DEC / 58" | bc)"
  done
  printf "%s" "$OUT"
}

# normalizePrivateKey: canonicalize + validate a hex private key (accept with/without 0x, trim
# whitespace, lowercase, 64-hex). Fails loud and early. Frozen copy of the shared helper
# (EXSC-507). Prints normalized key on stdout / returns 0; prints nothing / returns 1 on bad
# input (error logged to stderr so $(...) capture stays clean).
function normalizePrivateKey() {
  local RAW="$1"
  local VAR_NAME="${2:-private key}"
  RAW="${RAW#"${RAW%%[![:space:]]*}"}"
  RAW="${RAW%"${RAW##*[![:space:]]}"}"
  if [[ -z "$RAW" ]]; then
    bgError "$VAR_NAME is empty or not set. Cannot continue." >&2
    return 1
  fi
  local HEX="${RAW#0x}"
  HEX="${HEX#0X}"
  HEX=$(echo "$HEX" | tr '[:upper:]' '[:lower:]')
  if ! [[ "$HEX" =~ ^[0-9a-f]{64}$ ]]; then
    bgError "$VAR_NAME is not a valid 32-byte hex private key (expected 64 hex chars, with or without a 0x prefix). Cannot continue." >&2
    return 1
  fi
  printf '0x%s' "$HEX"
  return 0
}

# bgDiamondAddress: read the LiFiDiamond address for a network from the deploy logs, respecting
# ENVIRONMENT (production => deployments/<net>.json, staging => deployments/<net>.staging.json).
function bgDiamondAddress() {
  local NETWORK="$1"
  local FILE="deployments/${NETWORK}.json"
  [[ "$ENVIRONMENT" == "staging" ]] && FILE="deployments/${NETWORK}.staging.json"
  [[ -f "$FILE" ]] || return 1
  local ADDR
  ADDR=$(jq -r '.LiFiDiamond // empty' "$FILE" 2>/dev/null)
  [[ -n "$ADDR" ]] || return 1
  printf '%s' "$ADDR"
}

# rpcCallWithRetry: run an RPC-touching command up to $RPC_MAX_ATTEMPTS times. Captures stdout
# cleanly; preserves stderr for retry logs / final error. Frozen copy of the shared helper.
# Usage: VAR=$(rpcCallWithRetry "label" cmd args...)
function rpcCallWithRetry() {
  local LABEL="$1"
  shift
  local ATTEMPT=1
  local OUT=""
  local ERR_FILE
  ERR_FILE=$(mktemp)
  while [ "$ATTEMPT" -le "$RPC_MAX_ATTEMPTS" ]; do
    if OUT=$("$@" 2>"$ERR_FILE"); then
      rm -f "$ERR_FILE"
      printf "%s" "$OUT"
      return 0
    fi
    if [ "$ATTEMPT" -lt "$RPC_MAX_ATTEMPTS" ]; then
      echo "[retry] $LABEL attempt $ATTEMPT failed ($(< "$ERR_FILE")), sleeping ${RPC_RETRY_SLEEP_SECONDS}s..." >&2
      sleep "$RPC_RETRY_SLEEP_SECONDS"
    fi
    ATTEMPT=$((ATTEMPT + 1))
  done
  local LAST_ERR
  LAST_ERR=$(< "$ERR_FILE")
  rm -f "$ERR_FILE"
  printf "%s" "${LAST_ERR:-$OUT}"
  return 1
}

# --------------------------------------------------------------------------------------------
# Contract interaction (frozen copies of the relevant universalCast branches)
# --------------------------------------------------------------------------------------------

# bgOwnerCall: read owner() for pause-state detection (EVM via cast, Tron via troncast). stderr
# is merged into stdout so the DiamondIsPaused revert reason is inspectable by the caller.
function bgOwnerCall() {
  local NETWORK="$1"
  local DIAMOND="$2"
  local RPC_URL="$3"
  if bgIsTron "$NETWORK"; then
    CONSOLA_LEVEL=3 bun troncast call "$DIAMOND" "owner() returns (address)" --env "$(bgTronEnv "$NETWORK")" 2>&1
  else
    cast call "$DIAMOND" "owner() returns (address)" --rpc-url "$RPC_URL" 2>&1
  fi
}

# bgPauserWalletCall: read pauserWallet() (EVM via cast, Tron via troncast).
function bgPauserWalletCall() {
  local NETWORK="$1"
  local DIAMOND="$2"
  local RPC_URL="$3"
  if bgIsTron "$NETWORK"; then
    CONSOLA_LEVEL=3 bun troncast call "$DIAMOND" "pauserWallet() returns (address)" --env "$(bgTronEnv "$NETWORK")"
  else
    cast call "$DIAMOND" "pauserWallet() returns (address)" --rpc-url "$RPC_URL"
  fi
}

# bgSendPause: dispatch pauseDiamond() DIRECTLY from the pauser EOA. EVM mirrors
# universalSendRaw's EVM branch (gas buffer + async handling); Tron mirrors its troncast branch.
function bgSendPause() {
  local NETWORK="$1"
  local DIAMOND="$2"
  local CALLDATA="$3"
  local KEY="$4"
  local RPC_URL="$5"

  if bgIsTron "$NETWORK"; then
    bun troncast send "$DIAMOND" "" --calldata "$CALLDATA" --env "$(bgTronEnv "$NETWORK")" --private-key "$KEY" --confirm
    return $?
  fi

  local USE_ASYNC
  USE_ASYNC=$(bgCastSendAsync "$NETWORK")

  local CAST_EXTRA=()
  if [[ "$USE_ASYNC" == "true" ]]; then
    CAST_EXTRA+=(--async)
  else
    CAST_EXTRA+=(--confirmations 1)
  fi

  # Buffer the gas price above base fee (helps on L2s). If the gas-price read fails or returns 0,
  # OMIT --gas-price and let cast auto-estimate — never send an unusable 1-wei tx, which would
  # burn every retry during an incident.
  local GAS_PRICE
  GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL" 2>/dev/null || echo "0")
  if [[ "$GAS_PRICE" =~ ^[0-9]+$ && "$GAS_PRICE" -gt 0 ]]; then
    local GAS_PRICE_BUF=$((GAS_PRICE * GAS_ESTIMATE_MULTIPLIER / 100))
    [[ "$GAS_PRICE_BUF" -lt 1 ]] && GAS_PRICE_BUF=1
    CAST_EXTRA+=(--gas-price "$GAS_PRICE_BUF")
  else
    bgWarning "[network: $NETWORK] gas-price unavailable; letting cast auto-estimate"
  fi

  cast send "$DIAMOND" "$CALLDATA" \
    --rpc-url "$RPC_URL" \
    --private-key "$KEY" \
    --legacy \
    "${CAST_EXTRA[@]}"
  local CAST_EXIT=$?
  if [[ $CAST_EXIT -eq 0 && "$USE_ASYNC" == "true" ]]; then
    sleep 3
  fi
  return $CAST_EXIT
}

# --------------------------------------------------------------------------------------------
# Per-network pause
# --------------------------------------------------------------------------------------------

function handleNetwork() {
  echo ""
  echo ">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start network $1 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>"
  local NETWORK=$1
  local PAUSER_PRIVATE_KEY=$2
  local IS_TRON="false"
  bgIsTron "$NETWORK" && IS_TRON="true"

  # pauser address from the key (EVM hex; Tron base58 derived from it)
  local PRIV_KEY_ADDRESS PRIV_KEY_ADDRESS_EVM
  PRIV_KEY_ADDRESS_EVM=$(cast wallet address "$PAUSER_PRIVATE_KEY")
  if [[ "$IS_TRON" == "true" ]]; then
    PRIV_KEY_ADDRESS=$(evmToTronBase58 "$PRIV_KEY_ADDRESS_EVM")
  else
    PRIV_KEY_ADDRESS="$PRIV_KEY_ADDRESS_EVM"
  fi

  # resolve EVM RPC (Tron uses troncast --env, no RPC URL needed)
  local RPC_URL=""
  if [[ "$IS_TRON" != "true" ]]; then
    local RPC_KEY
    RPC_KEY=$(bgRpcEnvVarName "$NETWORK")
    eval "RPC_URL=\$$RPC_KEY"
    if [[ -z "$RPC_URL" ]]; then
      bgError "[network: $NETWORK] could not find RPC_URL (env key: $RPC_KEY). Cannot continue."
      echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
      return 1
    fi
    echo "[network: $NETWORK] RPC URL found"
  fi

  # diamond address from deploy logs (live data)
  local DIAMOND_ADDRESS
  if ! DIAMOND_ADDRESS=$(bgDiamondAddress "$NETWORK"); then
    bgError "[network: $NETWORK] could not find LiFiDiamond in $ENVIRONMENT deploy log. Cannot continue for this network."
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi
  echo "[network: $NETWORK] diamond address: $DIAMOND_ADDRESS"

  # already-paused check (retry on unclear responses — transient RPC/throttle)
  local PRE_PAUSE_RESPONSE=""
  local ATTEMPT=1
  while [ "$ATTEMPT" -le "$RPC_MAX_ATTEMPTS" ]; do
    PRE_PAUSE_RESPONSE=$(bgOwnerCall "$NETWORK" "$DIAMOND_ADDRESS" "$RPC_URL")
    if [[ "$PRE_PAUSE_RESPONSE" =~ ^0x[0-9a-fA-F]{40}$ ]] \
      || [[ "$PRE_PAUSE_RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* ]] \
      || [[ "$PRE_PAUSE_RESPONSE" == *"DiamondIsPaused"* ]] \
      || { [[ "$IS_TRON" == "true" ]] && [[ "$PRE_PAUSE_RESPONSE" == T* ]]; }; then
      break
    fi
    if [ "$ATTEMPT" -lt "$RPC_MAX_ATTEMPTS" ]; then
      echo "[network: $NETWORK] pre-pause owner() unclear (attempt $ATTEMPT/$RPC_MAX_ATTEMPTS), retrying in ${RPC_RETRY_SLEEP_SECONDS}s..."
      sleep "$RPC_RETRY_SLEEP_SECONDS"
    fi
    ATTEMPT=$((ATTEMPT + 1))
  done
  if [[ "$PRE_PAUSE_RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* || "$PRE_PAUSE_RESPONSE" == *"DiamondIsPaused"* ]]; then
    bgSuccess "[network: $NETWORK] The diamond is already paused."
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 0
  elif [[ "$PRE_PAUSE_RESPONSE" =~ ^0x[0-9a-fA-F]{40}$ ]] || { [[ "$IS_TRON" == "true" ]] && [[ "$PRE_PAUSE_RESPONSE" == T* ]]; }; then
    echo "[network: $NETWORK] The diamond is not yet paused. Proceeding..."
  else
    # Fail closed: pause state undetermined after retries — do NOT pause blindly.
    bgError "[network: $NETWORK] RPC/network error while checking pause state after $RPC_MAX_ATTEMPTS attempts: $PRE_PAUSE_RESPONSE"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi

  # balance check (EVM only — troncast has no balance command; Tron funding is verified by the
  # final pause check succeeding)
  if [[ "$IS_TRON" != "true" ]]; then
    sleep "$RPC_CALL_DELAY_SECONDS"
    local BALANCE_PAUSER_WALLET
    if ! BALANCE_PAUSER_WALLET=$(rpcCallWithRetry "[$NETWORK] cast balance pauser" cast balance "$PRIV_KEY_ADDRESS_EVM" --rpc-url "$RPC_URL"); then
      bgError "[network: $NETWORK] failed to read PauserWallet balance after $RPC_MAX_ATTEMPTS attempts: $BALANCE_PAUSER_WALLET"
      echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
      return 1
    fi
    if ! [[ "$BALANCE_PAUSER_WALLET" =~ ^[0-9]+$ ]]; then
      bgError "[network: $NETWORK] PauserWallet balance unparseable: $BALANCE_PAUSER_WALLET. Cannot continue"
      echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
      return 1
    fi
    # bash 64-bit arithmetic overflows above ~9.2 ETH in wei; bc handles arbitrary precision.
    if [[ $(echo "$BALANCE_PAUSER_WALLET <= 0" | bc) -eq 1 ]]; then
      bgError "[network: $NETWORK] PauserWallet has no balance. Cannot continue"
      echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
      return 1
    fi
    echo "[network: $NETWORK] balance pauser wallet: $BALANCE_PAUSER_WALLET"
  fi

  # on-chain registered pauser must match our key
  sleep "$RPC_CALL_DELAY_SECONDS"
  local DIAMOND_PAUSER_WALLET
  if ! DIAMOND_PAUSER_WALLET=$(rpcCallWithRetry "[$NETWORK] pauserWallet()" bgPauserWalletCall "$NETWORK" "$DIAMOND_ADDRESS" "$RPC_URL"); then
    bgError "[network: $NETWORK] failed to read pauserWallet() after $RPC_MAX_ATTEMPTS attempts: $DIAMOND_PAUSER_WALLET"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi
  # EVM: 0x-hex casing is cosmetic, compare lowercased. Tron: base58 is case-SENSITIVE, compare
  # the exact trimmed value (troncast output is clean under CONSOLA_LEVEL=3; a substring match
  # could false-positive on wrapped/error output).
  local MATCH="false"
  if [[ "$IS_TRON" == "true" ]]; then
    local TRIMMED_PAUSER
    TRIMMED_PAUSER=$(echo "$DIAMOND_PAUSER_WALLET" | tr -d '[:space:]')
    [[ "$TRIMMED_PAUSER" == "$PRIV_KEY_ADDRESS" ]] && MATCH="true"
  else
    [[ "$(echo "$DIAMOND_PAUSER_WALLET" | tr '[:upper:]' '[:lower:]')" == "$(echo "$PRIV_KEY_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]] && MATCH="true"
  fi
  if [[ "$MATCH" != "true" ]]; then
    bgError "[network: $NETWORK] the key in PRIVATE_KEY_PAUSER_WALLET (address: $PRIV_KEY_ADDRESS) does not match the registered PauserWallet ($DIAMOND_PAUSER_WALLET)"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi
  echo "[network: $NETWORK] registered pauser wallet matches stored key (= ready to execute)"

  # Pre-build pauseDiamond() calldata; dispatch DIRECTLY from the pauser EOA.
  local PAUSE_CALLDATA
  PAUSE_CALLDATA=$(cast calldata "pauseDiamond()")

  local SEND_ATTEMPTS=1
  while [ $SEND_ATTEMPTS -le $MAX_ATTEMPTS ]; do
    echo ""
    echo "[network: $NETWORK] pausing diamond $DIAMOND_ADDRESS now from PauserWallet: $PRIV_KEY_ADDRESS (attempt: $SEND_ATTEMPTS)"
    echo ""
    bgSendPause "$NETWORK" "$DIAMOND_ADDRESS" "$PAUSE_CALLDATA" "$PAUSER_PRIVATE_KEY" "$RPC_URL"
    [ $? -eq 0 ] && break
    SEND_ATTEMPTS=$((SEND_ATTEMPTS + 1))
    sleep "$RPC_RETRY_SLEEP_SECONDS"
  done
  if [ $SEND_ATTEMPTS -gt "$MAX_ATTEMPTS" ]; then
    bgWarning "[network: $NETWORK] all $MAX_ATTEMPTS pause-send attempts failed - verifying on-chain state before declaring failure"
  fi

  # Final pause check: owner() must revert with DiamondIsPaused. This is the canonical truth
  # source (another caller may have paused it; read-after-write lag is cushioned by retries).
  local FINAL_ATTEMPT=1
  local FINAL_RESPONSE=""
  sleep "$RPC_CALL_DELAY_SECONDS"
  while [ "$FINAL_ATTEMPT" -le "$RPC_MAX_ATTEMPTS" ]; do
    FINAL_RESPONSE=$(bgOwnerCall "$NETWORK" "$DIAMOND_ADDRESS" "$RPC_URL")
    if [[ "$FINAL_RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* || "$FINAL_RESPONSE" == *"DiamondIsPaused"* ]]; then
      bgSuccess "[network: $NETWORK] diamond ($DIAMOND_ADDRESS) successfully paused"
      echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
      return 0
    fi
    if [ "$FINAL_ATTEMPT" -lt "$RPC_MAX_ATTEMPTS" ]; then
      echo "[network: $NETWORK] final pause check unclear (attempt $FINAL_ATTEMPT/$RPC_MAX_ATTEMPTS), retrying in ${RPC_RETRY_SLEEP_SECONDS}s..."
      sleep "$RPC_RETRY_SLEEP_SECONDS"
    fi
    FINAL_ATTEMPT=$((FINAL_ATTEMPT + 1))
  done

  bgError "[network: $NETWORK] final pause check failed after $RPC_MAX_ATTEMPTS attempts - please check diamond ($DIAMOND_ADDRESS) manually (last response: $FINAL_RESPONSE)"
  echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
  return 1
}

function printStatus() {
  local NETWORK="$1"
  local RPC_URL=""
  if ! bgIsTron "$NETWORK"; then
    local RPC_KEY
    RPC_KEY=$(bgRpcEnvVarName "$NETWORK")
    eval "RPC_URL=\$$RPC_KEY"
  fi
  local DIAMOND_ADDRESS
  if ! DIAMOND_ADDRESS=$(bgDiamondAddress "$NETWORK"); then
    bgError "[network: $NETWORK] no diamond in deploy log."
    return 0
  fi
  local RESPONSE
  RESPONSE=$(bgOwnerCall "$NETWORK" "$DIAMOND_ADDRESS" "$RPC_URL")
  if [[ "$RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* || "$RESPONSE" == *"DiamondIsPaused"* ]]; then
    bgSuccess "[network: $NETWORK] diamond paused."
  elif [[ "$RESPONSE" =~ ^0x[0-9a-fA-F]{40}$ ]] || [[ "$RESPONSE" == T* ]]; then
    bgError "[network: $NETWORK] diamond NOT paused."
  else
    bgError "[network: $NETWORK] RPC/network error while checking pause state: $RESPONSE"
  fi
}

# --------------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------------

# bgBuildNetworks: resolve the target network list from ENVIRONMENT + NETWORK, skipping testnets.
function bgBuildNetworks() {
  local -a CANDIDATES=()
  if [[ "$ENVIRONMENT" == "staging" ]]; then
    CANDIDATES=("${STAGING_NETWORKS[@]}")
  else
    while IFS= read -r n; do CANDIDATES+=("$n"); done < <(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH")
  fi

  local -a RESULT=()
  local n
  for n in "${CANDIDATES[@]}"; do
    # honor a single-network filter (used by the CLI delegation)
    if [[ "$NETWORK" != "all" && "$n" != "$NETWORK" ]]; then
      continue
    fi
    # skip testnets (read from live data, not a hardcoded list)
    local TYPE
    TYPE=$(jq -r --arg network "$n" '.[$network].type // empty' "$NETWORKS_JSON_FILE_PATH")
    if [[ "$TYPE" == "testnet" ]]; then
      echo "skipping $n (testnet)" >&2
      continue
    fi
    RESULT+=("$n")
  done
  printf '%s\n' "${RESULT[@]}"
}

function main() {
  echo "[info] >>> emergencyPauseBreakGlass starting (ENVIRONMENT=$ENVIRONMENT, NETWORK=$NETWORK)"

  if [[ ! -f "$NETWORKS_JSON_FILE_PATH" ]]; then
    bgError "networks file not found at $NETWORKS_JSON_FILE_PATH. Run from the repo root."
    return 1
  fi

  # Normalize + validate the pauser key once, up front (accept with/without 0x; fail loud on
  # empty/malformed) so a malformed secret fails here, not mid-pause on every network.
  PRIVATE_KEY_PAUSER_WALLET=$(normalizePrivateKey "$PRIVATE_KEY_PAUSER_WALLET" "PRIVATE_KEY_PAUSER_WALLET") || return 1

  local -a NETWORKS=()
  while IFS= read -r n; do [[ -n "$n" ]] && NETWORKS+=("$n"); done < <(bgBuildNetworks)
  if [[ ${#NETWORKS[@]} -eq 0 ]]; then
    bgError "no target networks resolved (ENVIRONMENT=$ENVIRONMENT, NETWORK=$NETWORK)."
    return 1
  fi
  echo "networks to pause: ${NETWORKS[*]}"

  local PRIV_KEY_ADDRESS
  PRIV_KEY_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  echo "Address PauserWallet (EVM): $PRIV_KEY_ADDRESS"
  exit 0
  echo "Networks run in parallel; the log may appear interleaved. Watch for colored start/end markers."

  # Launch per-network in parallel; track PIDs explicitly so no failure is swallowed.
  local -a PIDS=()
  local NETWORK
  for NETWORK in "${NETWORKS[@]}"; do
    handleNetwork "$NETWORK" "$PRIVATE_KEY_PAUSER_WALLET" &
    PIDS+=("$!")
  done
  local RETURN=0
  local PID
  for PID in "${PIDS[@]}"; do
    wait "$PID" || RETURN=1
  done

  echo "-------------------------------------------------------------------------------------"
  echo "--------------------------------ALL JOBS DONE----------------------------------------"
  echo "-------------------------------------------------------------------------------------"
  local -a STATUS_PIDS=()
  for NETWORK in "${NETWORKS[@]}"; do
    printStatus "$NETWORK" &
    STATUS_PIDS+=("$!")
  done
  for PID in "${STATUS_PIDS[@]}"; do
    wait "$PID" || true
  done

  echo "[info] <<< emergencyPauseBreakGlass completed"
  return "$RETURN"
}

# Run main only when executed directly, so tests can source this file and call individual
# functions (e.g. the Anvil dispatch test) without triggering a real pause.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
