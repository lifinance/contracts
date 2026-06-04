#!/bin/bash

# this script is designed to be called by a Github action ("Verify Emergency Pause Readiness")
# it is the READ-ONLY companion to diamondEMERGENCYPauseGitHub.sh: it verifies that the
# emergency pause CAN fire on every production diamond, WITHOUT firing it.
#
# Checks:
#   Secret check (offline, fail-fast): the address derived from PRIVATE_KEY_PAUSER_WALLET matches
#                      the configured pauser in config/global.json (EVM hex + Tron base58).
#   Pauser check (on-chain, per production LiFiDiamond): the registered pauserWallet() equals
#                      that derived address, read via the real `universalCast "call"`.
#   Governance check (on-chain, per Safe/timelock-governed diamond — the UNPAUSE path): the
#                      LiFiTimelockController's diamond() points at the production diamond,
#                      and the Safe holds TIMELOCK_ADMIN_ROLE. Skipped on testnets/Tron.
#
# It performs NO transactions (no pause / unpause / send). A non-zero exit means the
# emergency pause/unpause would not work as configured and must be investigated.


# load helper functions (also sources script/universalCast.sh)
source ./script/helperFunctions.sh

# ---------------------------------------------------------------------------------------
# INTENTIONAL DUPLICATION (temporary) — keep in sync with diamondEMERGENCYPauseGitHub.sh
# ---------------------------------------------------------------------------------------
# rpcCallWithRetry + the RPC pacing constants below, and the per-network read+compare in
# verifyPauserOnNetwork(), are duplicated near-verbatim from
# script/utils/diamondEMERGENCYPauseGitHub.sh.
#
# Why duplicated and not shared: that script is security-critical (it sends the real
# pauseDiamond() transaction). We deliberately did NOT refactor it as a side effect of
# adding this read-only check, to avoid any risk to the live pause path.
#
# CONSOLIDATION PLAN: the next time diamondEMERGENCYPauseGitHub.sh is modified, extract
# rpcCallWithRetry + the pauser comparison into a shared sourceable helper (e.g.
# script/utils/emergencyPauseShared.sh) and have BOTH scripts source it. Until then,
# any change here must be mirrored there (and vice-versa).
# ---------------------------------------------------------------------------------------

# RPC pacing for read calls. RPCs can throttle reads under load (paid tiers included),
# so we pace and retry transient failures before failing hard.
RPC_MAX_ATTEMPTS=5
RPC_RETRY_SLEEP_SECONDS=3
RPC_CALL_DELAY_SECONDS=1

# The role gating LiFiTimelockController.unpauseDiamond(). Derived at runtime via
# keccak256("TIMELOCK_ADMIN_ROLE") so it reads as a role hash rather than a magic 32-byte
# literal (which also trips secret scanners as a false-positive "private key").
TIMELOCK_ADMIN_ROLE="$(cast keccak "TIMELOCK_ADMIN_ROLE")"

# rpcCallWithRetry: Run an RPC-touching command up to $RPC_MAX_ATTEMPTS times with
# $RPC_RETRY_SLEEP_SECONDS between failures. Captures stdout cleanly so callers
# get clean values back (no stderr mixed in), while stderr is preserved in a
# temp file and surfaced in retry logs / the final failure message. Returns 0
# on first success, 1 if exhausted.
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
  # On exhaustion, surface diagnostic context to the caller. Prefer stderr
  # (cleaner), but fall back to stdout when stderr was empty - some wrapped
  # helpers (e.g. universalCall) merge cast's stderr into stdout via 2>&1
  # internally, so the revert reason / RPC error ends up in OUT, not ERR_FILE.
  local LAST_ERR
  LAST_ERR=$(< "$ERR_FILE")
  rm -f "$ERR_FILE"
  printf "%s" "${LAST_ERR:-$OUT}"
  return 1
}

# evmToTronBase58: encode a 20-byte EVM hex address as a Tron base58check (T...) address.
# Tron payload = 0x41 || 20-byte address; checksum = first 4 bytes of sha256(sha256(payload)).
# Uses only coreutils / openssl / bc (no npm/TS dependency). A 0x41-prefixed payload has no
# leading zero bytes, so no leading-'1' padding is needed. Used by the offline secret check
# to compare the derived key against config tronWallets.pauserWallet.
#
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

# verifyPauserOnNetwork: pauser check — read the on-chain pauserWallet() of a network's
# production LiFiDiamond and assert it equals the derived pauser address. Read-only.
# Mirrors diamondEMERGENCYPauseGitHub.sh's comparison exactly (lowercase string compare),
# which also handles Tron's address form the same proven way the live pause does.
#
# Usage: verifyPauserOnNetwork NETWORK EXPECTED_PAUSER_ADDRESS
# Returns: 0 on match; 1 on missing diamond / missing EmergencyPauseFacet (call reverts) /
#          RPC exhausted / address mismatch.
function verifyPauserOnNetwork() {
  local NETWORK="$1"
  local EXPECTED_PAUSER="$2"

  # skip any non-prod networks (mirrors diamondEMERGENCYPauseGitHub.sh exactly so this
  # check covers precisely the networks the real pause acts on)
  case "$NETWORK" in
    "bsc-testnet" | "localanvil" | "sepolia" | "mumbai" | "lineatest")
      echo "skipping $NETWORK (Testnet)"
      return 0
      ;;
  esac

  # A network with no production LiFiDiamond is simply not in scope ("verify every
  # production diamond" — there isn't one here), so skip with a visible notice rather
  # than failing. networks.json lists more networks (e.g. tronshasta) than have a prod
  # deployment; treating "not deployed" as a failure would be a permanent false alarm.
  local DIAMOND_ADDRESS
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond")
  if [[ $? -ne 0 || -z "$DIAMOND_ADDRESS" ]]; then
    echo "skipping $NETWORK (no production LiFiDiamond in deploy log)"
    return 0
  fi

  # read on-chain registered pauser (retry transient RPC throttling, then fail hard).
  # A missing EmergencyPauseFacet makes pauserWallet() revert, which exhausts retries
  # and is reported as a failure - per design, every prod diamond must have the facet.
  sleep "$RPC_CALL_DELAY_SECONDS"
  local DIAMOND_PAUSER_WALLET
  if ! DIAMOND_PAUSER_WALLET=$(rpcCallWithRetry "[$NETWORK] pauserWallet()" universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "pauserWallet() returns (address)"); then
    error "[network: $NETWORK] failed to read pauserWallet() after $RPC_MAX_ATTEMPTS attempts (missing EmergencyPauseFacet or RPC error): $DIAMOND_PAUSER_WALLET"
    return 1
  fi

  # Compare on-chain pauser to the expected (derived) address. The two networks return
  # different address forms, so normalize before comparing:
  #   - Tron: `troncast call ... returns(address)` yields a base58 (T...) address, while
  #     EXPECTED_PAUSER is EVM hex. Encode the expected address to base58 and compare
  #     case-SENSITIVELY (base58 distinguishes case).
  #   - EVM: both are 0x hex; compare case-insensitively (EIP-55 casing is cosmetic).
  if isTronNetwork "$NETWORK"; then
    local EXPECTED_TRON
    EXPECTED_TRON=$(evmToTronBase58 "$EXPECTED_PAUSER")
    if [[ "$DIAMOND_PAUSER_WALLET" != "$EXPECTED_TRON" ]]; then
      error "[network: $NETWORK] on-chain pauserWallet ($DIAMOND_PAUSER_WALLET) does not match the configured pauser key ($EXPECTED_TRON)"
      return 1
    fi
  else
    if [[ "$(echo "$DIAMOND_PAUSER_WALLET" | tr '[:upper:]' '[:lower:]')" != "$(echo "$EXPECTED_PAUSER" | tr '[:upper:]' '[:lower:]')" ]]; then
      error "[network: $NETWORK] on-chain pauserWallet ($DIAMOND_PAUSER_WALLET) does not match the configured pauser key ($EXPECTED_PAUSER)"
      return 1
    fi
  fi
  success "[network: $NETWORK] on-chain pauserWallet matches the configured key"
  return 0
}

# verifyGovernanceOnNetwork: governance check — verify the UNPAUSE path's governance wiring:
#   (1) LiFiTimelockController.diamond() points at the deploy-log production LiFiDiamond, and
#   (2) the Safe holds TIMELOCK_ADMIN_ROLE (so it can drive unpauseDiamond()).
# Read-only. Applies only to mainnet (non-testnet, non-Tron) networks that have a deployed
# timelock AND a configured Safe; everything else is skipped with a notice. Returns 0 on
# pass/skip, 1 on a real mismatch / missing role / RPC exhausted.
#
# Usage: verifyGovernanceOnNetwork NETWORK
function verifyGovernanceOnNetwork() {
  local NETWORK="$1"

  # Testnets are EOA-owned (no Safe/timelock); Tron's governance model differs. Skip both.
  if isTestnetNetwork "$NETWORK" || isTronNetwork "$NETWORK"; then
    echo "skipping $NETWORK governance checks (testnet or Tron - no Safe/timelock)"
    return 0
  fi

  local TIMELOCK_ADDRESS
  TIMELOCK_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiTimelockController")
  if [[ $? -ne 0 || -z "$TIMELOCK_ADDRESS" ]]; then
    echo "skipping $NETWORK governance checks (no LiFiTimelockController in deploy log)"
    return 0
  fi

  local SAFE_ADDRESS
  SAFE_ADDRESS=$(jq -r --arg n "$NETWORK" '.[$n].safeAddress // empty' config/networks.json)
  if [[ -z "$SAFE_ADDRESS" ]]; then
    echo "skipping $NETWORK governance checks (no safeAddress in networks.json)"
    return 0
  fi

  local DIAMOND_ADDRESS
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond")
  if [[ $? -ne 0 || -z "$DIAMOND_ADDRESS" ]]; then
    error "[network: $NETWORK] governance: production LiFiDiamond not found in deploy log."
    return 1
  fi

  local RC=0

  # (1) timelock.diamond() must point at the production diamond
  sleep "$RPC_CALL_DELAY_SECONDS"
  local TIMELOCK_DIAMOND
  if ! TIMELOCK_DIAMOND=$(rpcCallWithRetry "[$NETWORK] timelock.diamond()" universalCast "call" "$NETWORK" "$TIMELOCK_ADDRESS" "diamond() returns (address)"); then
    error "[network: $NETWORK] governance: failed to read LiFiTimelockController.diamond() after $RPC_MAX_ATTEMPTS attempts: $TIMELOCK_DIAMOND"
    RC=1
  elif [[ "$(echo "$TIMELOCK_DIAMOND" | tr '[:upper:]' '[:lower:]')" != "$(echo "$DIAMOND_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]]; then
    error "[network: $NETWORK] governance: timelock.diamond() ($TIMELOCK_DIAMOND) does not match deploy-log LiFiDiamond ($DIAMOND_ADDRESS)"
    RC=1
  else
    success "[network: $NETWORK] governance: timelock.diamond() matches the production diamond"
  fi

  # (2) Safe must hold TIMELOCK_ADMIN_ROLE (so it can drive unpauseDiamond())
  sleep "$RPC_CALL_DELAY_SECONDS"
  local HAS_ROLE
  if ! HAS_ROLE=$(rpcCallWithRetry "[$NETWORK] timelock.hasRole(admin,safe)" universalCast "call" "$NETWORK" "$TIMELOCK_ADDRESS" "hasRole(bytes32,address) returns (bool)" "$TIMELOCK_ADMIN_ROLE" "$SAFE_ADDRESS"); then
    error "[network: $NETWORK] governance: failed to read hasRole(TIMELOCK_ADMIN_ROLE, safe) after $RPC_MAX_ATTEMPTS attempts: $HAS_ROLE"
    RC=1
  elif [[ "$HAS_ROLE" != "true" ]]; then
    error "[network: $NETWORK] governance: Safe ($SAFE_ADDRESS) does NOT hold TIMELOCK_ADMIN_ROLE on the timelock (hasRole=$HAS_ROLE)"
    RC=1
  else
    success "[network: $NETWORK] governance: Safe holds TIMELOCK_ADMIN_ROLE"
  fi

  return $RC
}

# verifyNetwork: run both on-chain per-network checks for one network (the pauser check +
# the governance check). Runs both even if the first fails, so a network reports all problems.
# The exit code BIT-ENCODES which check failed so main() can aggregate the two checks
# separately (for the per-check status report) from each background job's `wait` status:
#   bit 0 (1) = pauser check failed,  bit 1 (2) = governance check failed.
#
# Usage: verifyNetwork NETWORK EXPECTED_PAUSER_ADDRESS
# Returns: 0 (both ok) | 1 (pauser failed) | 2 (governance failed) | 3 (both failed).
function verifyNetwork() {
  local NETWORK="$1"
  local EXPECTED_PAUSER="$2"
  local RC=0
  verifyPauserOnNetwork "$NETWORK" "$EXPECTED_PAUSER" || RC=$((RC | 1))
  verifyGovernanceOnNetwork "$NETWORK" || RC=$((RC | 2))
  return $RC
}

# emitCheckStatus: when running inside GitHub Actions, publish each check's result as a step
# output (secret / pauser / governance, each one of pass | fail | skipped) so the workflow can
# render an accurate per-check Slack status. No-op locally (GITHUB_OUTPUT unset). OUTPUT ONLY —
# never affects which checks run or the exit code.
#
# Usage: emitCheckStatus SECRET_STATUS PAUSER_STATUS GOVERNANCE_STATUS
function emitCheckStatus() {
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  {
    echo "secret=$1"
    echo "pauser=$2"
    echo "governance=$3"
  } >>"$GITHUB_OUTPUT"
}

function main {
  # Per-check results for the workflow's per-check Slack status. The secret check fail-fasts (we do
  # not hit chains with a wrong key), so on a secret-check failure the on-chain checks stay
  # "skipped". emitCheckStatus publishes these as step outputs in CI; it is output-only and never
  # changes the exit code below.
  local SECRET_STATUS="fail" PAUSER_STATUS="skipped" GOVERNANCE_STATUS="skipped"

  if [[ -z "$PRIVATE_KEY_PAUSER_WALLET" ]]; then
    error "PRIVATE_KEY_PAUSER_WALLET is empty or not set. Cannot verify emergency pause readiness."
    emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$GOVERNANCE_STATUS"
    return 1
  fi

  # derive the pauser address from the secret (mirrors diamondEMERGENCYPauseGitHub.sh:303;
  # the key is passed as an argument because cast has no env/stdin path for a raw key, is
  # never echoed, and GitHub masks the secret in logs)
  local PRIV_KEY_ADDRESS
  PRIV_KEY_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  echo "Address derived from PRIVATE_KEY_PAUSER_WALLET: $PRIV_KEY_ADDRESS"

  ##### Secret check: offline secret <-> config (fail fast - no point hitting chains if the key is wrong)
  local EXPECTED_EVM EXPECTED_TRON
  EXPECTED_EVM=$(jq -r '.pauserWallet // empty' config/global.json)
  EXPECTED_TRON=$(jq -r '.tronWallets.pauserWallet // empty' config/global.json)
  if [[ -z "$EXPECTED_EVM" || -z "$EXPECTED_TRON" ]]; then
    error "pauserWallet / tronWallets.pauserWallet missing or null in config/global.json."
    emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$GOVERNANCE_STATUS"
    return 1
  fi
  if [[ "$(echo "$PRIV_KEY_ADDRESS" | tr '[:upper:]' '[:lower:]')" != "$(echo "$EXPECTED_EVM" | tr '[:upper:]' '[:lower:]')" ]]; then
    error "secret-derived address ($PRIV_KEY_ADDRESS) does not match config pauserWallet ($EXPECTED_EVM)."
    emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$GOVERNANCE_STATUS"
    return 1
  fi
  local DERIVED_TRON
  DERIVED_TRON=$(evmToTronBase58 "$PRIV_KEY_ADDRESS")
  if [[ "$DERIVED_TRON" != "$EXPECTED_TRON" ]]; then
    error "secret-derived Tron address ($DERIVED_TRON) does not match config tronWallets.pauserWallet ($EXPECTED_TRON)."
    emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$GOVERNANCE_STATUS"
    return 1
  fi
  SECRET_STATUS="pass"
  success "Secret check OK: the GitHub secret matches the configured pauser (EVM + Tron)."

  ##### On-chain checks: pauserWallet() + governance, per production diamond
  local NETWORKS=()
  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
  while IFS= read -r NETWORK; do
    NETWORKS+=("$NETWORK")
  done < <(jq -r 'keys[]' "$NETWORKS_JSON_FILE_PATH")

  echo "Verifying on-chain pauserWallet + governance across ${#NETWORKS[@]} networks (parallel; log may appear interleaved)..."

  # Launch verifyNetwork in parallel and capture PIDs explicitly (same pattern and rationale as
  # diamondEMERGENCYPauseGitHub.sh:309-319). A failure on one diamond does NOT abort the others;
  # aggregation happens after every job finishes and does not short-circuit. Each job's bit-encoded
  # exit code (see verifyNetwork) lets us tell pauser-check failures from governance-check failures.
  local -a PIDS=()
  for NETWORK in "${NETWORKS[@]}"; do
    verifyNetwork "$NETWORK" "$PRIV_KEY_ADDRESS" &
    PIDS+=("$!")
  done
  local PAUSER_FAILED=0 GOVERNANCE_FAILED=0 PID_RC
  for PID in "${PIDS[@]}"; do
    wait "$PID"
    PID_RC=$?
    ((PID_RC & 1)) && PAUSER_FAILED=1
    ((PID_RC & 2)) && GOVERNANCE_FAILED=1
  done
  [[ "$PAUSER_FAILED" -eq 0 ]] && PAUSER_STATUS="pass" || PAUSER_STATUS="fail"
  [[ "$GOVERNANCE_FAILED" -eq 0 ]] && GOVERNANCE_STATUS="pass" || GOVERNANCE_STATUS="fail"

  local RETURN=0
  [[ "$PAUSER_FAILED" -eq 1 || "$GOVERNANCE_FAILED" -eq 1 ]] && RETURN=1

  emitCheckStatus "$SECRET_STATUS" "$PAUSER_STATUS" "$GOVERNANCE_STATUS"

  echo "-------------------------------------------------------------------------------------"
  if [[ "$RETURN" -ne 0 ]]; then
    error "Emergency pause readiness check FAILED for one or more networks (see logs above)."
  else
    success "Emergency pause readiness check passed: secret valid and every production diamond agrees."
  fi
  return "$RETURN"
}

# call main function with all parameters the script was called with
main "$@"
