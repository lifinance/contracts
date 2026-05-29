#!/bin/bash

# this script is designed to be called by the "Verify Emergency Pause Readiness (Staging)"
# Github action. It is the STAGING, read-only counterpart to verifyEmergencyPauseReadinessGitHub.sh.
#
# Staging differs from production in two ways that shape this check:
#   - config/global.json has NO staging pauser entry, so there is no offline secret<->config layer.
#   - staging diamonds are not Safe/timelock-governed, so there is no governance layer.
# It therefore runs a single check per target network: the staging diamond's on-chain
# pauserWallet() equals the address derived from PRIVATE_KEY_PAUSER_WALLET_STAGING.
#
# Scope: the staging diamonds we actively care about — bsc, base, optimism, arbitrum.
# Performs NO transactions (no pause / unpause / send). A non-zero exit means the staging
# pause would not work with the configured staging key and must be investigated.


# load helper functions (also sources script/universalCast.sh)
source ./script/helperFunctions.sh

# Staging diamonds to verify (staging deployments on their respective mainnet chains).
STAGING_NETWORKS=(bsc base optimism arbitrum)

# ---------------------------------------------------------------------------------------
# INTENTIONAL DUPLICATION (temporary) — see verifyEmergencyPauseReadinessGitHub.sh and
# script/utils/diamondEMERGENCYPauseGitHub.sh.
# rpcCallWithRetry + the RPC pacing constants are duplicated rather than shared, to avoid
# touching the security-critical pause script. CONSOLIDATION PLAN: when that script is next
# modified, extract rpcCallWithRetry into a shared sourceable helper and have all three
# scripts use it. Keep the copies in sync until then.
# ---------------------------------------------------------------------------------------
RPC_MAX_ATTEMPTS=5
RPC_RETRY_SLEEP_SECONDS=3
RPC_CALL_DELAY_SECONDS=1

# rpcCallWithRetry: Run an RPC-touching command up to $RPC_MAX_ATTEMPTS times with
# $RPC_RETRY_SLEEP_SECONDS between failures. Captures stdout cleanly so callers get clean
# values back, while stderr is preserved and surfaced in retry logs / the final message.
# Returns 0 on first success, 1 if exhausted.
# Usage: VAR=$(rpcCallWithRetry "label" cast balance "$ADDR" --rpc-url "$RPC")
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

# verifyStagingPauserOnNetwork: read the staging diamond's pauserWallet() and assert it equals
# the staging pauser address derived from the secret. Read-only.
#
# Usage: verifyStagingPauserOnNetwork NETWORK EXPECTED_PAUSER_ADDRESS
# Returns: 0 on match; 1 on missing diamond / missing EmergencyPauseFacet / RPC exhausted / mismatch.
function verifyStagingPauserOnNetwork() {
  local NETWORK="$1"
  local EXPECTED_PAUSER="$2"

  local DIAMOND_ADDRESS
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "staging" "LiFiDiamond")
  if [[ $? -ne 0 || -z "$DIAMOND_ADDRESS" ]]; then
    error "[network: $NETWORK] could not find STAGING LiFiDiamond in deploy log."
    return 1
  fi

  sleep "$RPC_CALL_DELAY_SECONDS"
  local DIAMOND_PAUSER_WALLET
  if ! DIAMOND_PAUSER_WALLET=$(rpcCallWithRetry "[$NETWORK] staging pauserWallet()" universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "pauserWallet() returns (address)"); then
    error "[network: $NETWORK] failed to read staging pauserWallet() after $RPC_MAX_ATTEMPTS attempts (missing EmergencyPauseFacet or RPC error): $DIAMOND_PAUSER_WALLET"
    return 1
  fi

  if [[ "$(echo "$DIAMOND_PAUSER_WALLET" | tr '[:upper:]' '[:lower:]')" != "$(echo "$EXPECTED_PAUSER" | tr '[:upper:]' '[:lower:]')" ]]; then
    error "[network: $NETWORK] staging on-chain pauserWallet ($DIAMOND_PAUSER_WALLET) does not match the staging key ($EXPECTED_PAUSER)"
    return 1
  fi
  success "[network: $NETWORK] staging on-chain pauserWallet matches the staging key"
  return 0
}

function main {
  if [[ -z "$PRIVATE_KEY_PAUSER_WALLET_STAGING" ]]; then
    error "PRIVATE_KEY_PAUSER_WALLET_STAGING is empty or not set. Cannot verify staging pause readiness."
    return 1
  fi

  # derive the staging pauser address from the staging secret (never echoed; cast has no
  # env/stdin path for a raw key; GitHub masks the secret in logs)
  local PRIV_KEY_ADDRESS
  PRIV_KEY_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET_STAGING")
  echo "Address derived from PRIVATE_KEY_PAUSER_WALLET_STAGING: $PRIV_KEY_ADDRESS"

  echo "Verifying staging pauserWallet across: ${STAGING_NETWORKS[*]} (parallel; log may interleave)..."

  # Launch checks in parallel and aggregate without short-circuiting (same pattern as the prod script).
  local -a PIDS=()
  for NETWORK in "${STAGING_NETWORKS[@]}"; do
    verifyStagingPauserOnNetwork "$NETWORK" "$PRIV_KEY_ADDRESS" &
    PIDS+=("$!")
  done
  local RETURN=0
  for PID in "${PIDS[@]}"; do
    wait "$PID" || RETURN=1
  done

  echo "-------------------------------------------------------------------------------------"
  if [[ "$RETURN" -ne 0 ]]; then
    error "Staging emergency pause readiness check FAILED for one or more networks (see logs above)."
  else
    success "Staging emergency pause readiness check passed for: ${STAGING_NETWORKS[*]}"
  fi
  return "$RETURN"
}

# call main function with all parameters the script was called with
main "$@"
