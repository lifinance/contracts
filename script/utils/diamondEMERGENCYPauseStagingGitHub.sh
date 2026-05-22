#!/bin/bash

# this script is designed to be called by a Github action
# it pauses the main STAGING diamonds on the networks listed in STAGING_NETWORKS
# below. Mirrors `diamondEMERGENCYPauseGitHub.sh` (prod) by routing all cast-like
# operations through `universalCast` so the staging end-to-end test exercises
# the same helper code path that prod uses.
# for all other actions the diamondEMERGENCYPauseStaging.sh script should be called
# via scriptMaster.sh in local CLI for more flexibility


# load helper functions
source ./script/helperFunctions.sh

DIAMOND_IS_PAUSED_SELECTOR="0x0149422e"

# the number of attempts the script will max try to execute the pause transaction
MAX_ATTEMPTS=10

# RPC pacing for read calls. Send retries use MAX_ATTEMPTS above (intentionally
# larger). Some public RPCs throttle reads aggressively (~1 call per few seconds),
# so we pace and retry transient failures.
#
# Why staging-only (and not in diamondEMERGENCYPauseGitHub.sh): prod uses paid
# RPCs that don't throttle under normal load. If prod RPCs ever start throttling
# during incident-induced load spikes (exactly when this script runs), this
# pacing should be back-ported.
RPC_MAX_ATTEMPTS=5
RPC_RETRY_SLEEP_SECONDS=3
RPC_CALL_DELAY_SECONDS=1

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

# Staging workflow: 4 networks to validate universalCast routing across a representative set
STAGING_NETWORKS=("bsc" "arbitrum" "optimism" "base")

# Define function to handle each network operation
function handleNetwork() {
  echo ""
  echo ">>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> start network $1 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>"
  local NETWORK=$1
  # Renamed from `PRIVATE_KEY` to avoid shadowing the `.env` PRIVATE_KEY global
  # (per .agents/rules/300-bash.md "No local shadowing of .env globals").
  local PAUSER_PRIVATE_KEY=$2


  # skip any non-prod networks
  case "$NETWORK" in
    "bsc-testnet" | "localanvil" | "sepolia" | "mumbai" | "lineatest")
      echo "skipping $NETWORK (Testnet)"
      return 0
      ;;
  esac

  # convert the provided private key of the pauser wallet (from github) to an address
  PRIV_KEY_ADDRESS=$(cast wallet address "$PAUSER_PRIVATE_KEY")

  # get RPC URL for given network using helper function
  RPC_KEY=$(getRPCEnvVarName "$NETWORK")

  # Use eval to read the environment variable named like the RPC_KEY (our normal syntax like 'RPC_URL=${!RPC_URL}' doesnt work on Github)
  eval "RPC_URL=\$$RPC_KEY"

  # make sure RPC_URL is available
  if [[ -z "$RPC_URL" ]]; then
    error "[network: $NETWORK] could not find RPC_URL for this network in Github secrets (key: $RPC_KEY). Cannot continue."
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  else
    echo "[network: $NETWORK] RPC URL found"
  fi

  # get diamond address for this network
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "staging" "LiFiDiamond")
  if [[ $? -ne 0 ]]; then
    error "[network: $NETWORK] could not find diamond address in STAGING deploy log. Cannot continue for this network."
    return 1
  else
    echo "[network: $NETWORK] diamond address found in deploy log file: $DIAMOND_ADDRESS"
  fi

  # check if the diamond is already paused by calling owner() function and analyzing the response.
  # Retry if the response is neither a clean address nor a recognized pause selector, since that
  # indicates a transient RPC/rate-limit issue rather than an unambiguous answer.
  local PRE_PAUSE_RESPONSE=""
  local PRE_PAUSE_CHECK_ATTEMPT=1
  while [ "$PRE_PAUSE_CHECK_ATTEMPT" -le "$RPC_MAX_ATTEMPTS" ]; do
    PRE_PAUSE_RESPONSE=$(universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "owner() returns (address)" 2>&1)
    if [[ "$PRE_PAUSE_RESPONSE" =~ ^0x[0-9a-fA-F]{40}$ ]] \
      || [[ "$PRE_PAUSE_RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* ]] \
      || [[ "$PRE_PAUSE_RESPONSE" == *"DiamondIsPaused"* ]]; then
      break
    fi
    if [ "$PRE_PAUSE_CHECK_ATTEMPT" -lt "$RPC_MAX_ATTEMPTS" ]; then
      echo "[network: $NETWORK] pre-pause owner() returned unclear response (attempt $PRE_PAUSE_CHECK_ATTEMPT/$RPC_MAX_ATTEMPTS), retrying in ${RPC_RETRY_SLEEP_SECONDS}s..."
      sleep "$RPC_RETRY_SLEEP_SECONDS"
    fi
    PRE_PAUSE_CHECK_ATTEMPT=$((PRE_PAUSE_CHECK_ATTEMPT + 1))
  done
    # Check for errors in the response
  if [[ "$PRE_PAUSE_RESPONSE" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
      # Clean address response — diamond is not paused
      echo "[network: $NETWORK] The diamond is not yet paused. Proceeding..."
  elif [[ "$PRE_PAUSE_RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* || "$PRE_PAUSE_RESPONSE" == *"DiamondIsPaused"* ]]; then
      # If the response contains the pause selector or "DiamondIsPaused", the diamond is paused
      success "[network: $NETWORK] The diamond is already paused."
      echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
      return 0
  else
      # Fail closed: we couldn't determine pause state after $RPC_MAX_ATTEMPTS attempts.
      # Do NOT send pauseDiamond() blindly - abort this network and let the workflow report.
      error "[network: $NETWORK] RPC or network error while checking if diamond is paused after $RPC_MAX_ATTEMPTS attempts: $PRE_PAUSE_RESPONSE"
      echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
      return 1
  fi

  # ensure PauserWallet has positive balance (wrap in retry: balance reads can fail under throttling)
  sleep "$RPC_CALL_DELAY_SECONDS"
  if ! BALANCE_PAUSER_WALLET=$(rpcCallWithRetry "[$NETWORK] cast balance pauser" cast balance "$PRIV_KEY_ADDRESS" --rpc-url "$RPC_URL"); then
    error "[network: $NETWORK] failed to read PauserWallet balance after $RPC_MAX_ATTEMPTS attempts: $BALANCE_PAUSER_WALLET"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi
  # Validate the value is a clean non-negative decimal then compare via bc.
  # bash 64-bit arithmetic overflows above ~9.2 ETH in wei; bc handles arbitrary precision.
  if ! [[ "$BALANCE_PAUSER_WALLET" =~ ^[0-9]+$ ]]; then
    error "[network: $NETWORK] PauserWallet balance unparseable: $BALANCE_PAUSER_WALLET. Cannot continue"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi
  if [[ $(echo "$BALANCE_PAUSER_WALLET <= 0" | bc) -eq 1 ]]; then
    error "[network: $NETWORK] PauserWallet has no balance. Cannot continue"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  else
    echo "[network: $NETWORK] balance pauser wallet: $BALANCE_PAUSER_WALLET"
  fi

  # read on-chain registered pauser (wrap in retry: this is the call that historically
  # failed on chains where EmergencyPauseFacet wasn't yet deployed; with the facet now
  # in place, transient failures are RPC throttling rather than missing selectors)
  sleep "$RPC_CALL_DELAY_SECONDS"
  if ! DIAMOND_PAUSER_WALLET=$(rpcCallWithRetry "[$NETWORK] pauserWallet()" universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "pauserWallet() returns (address)"); then
    error "[network: $NETWORK] failed to read pauserWallet() after $RPC_MAX_ATTEMPTS attempts: $DIAMOND_PAUSER_WALLET"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  fi

  # compare addresses in lowercase format
  if [[ "$(echo "$DIAMOND_PAUSER_WALLET" | tr '[:upper:]' '[:lower:]')" != "$(echo "$PRIV_KEY_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]]; then
    error "[network: $NETWORK] The private key in PRIVATE_KEY_PAUSER_WALLET (address: $PRIV_KEY_ADDRESS) on Github does not match with the registered PauserWallet in the diamond ($DIAMOND_PAUSER_WALLET)"
    echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
    return 1
  else
    echo "[network: $NETWORK] registered pauser wallet matches with stored private key (= ready to execute)"
  fi

  # repeatedly try to pause the diamond until it's done (or attempts are exhausted)
  local ATTEMPTS=1
  while [ $ATTEMPTS -le $MAX_ATTEMPTS ]; do
    echo ""
    echo "[network: $NETWORK] pausing diamond $DIAMOND_ADDRESS now from PauserWallet: $PRIV_KEY_ADDRESS (attempt: $ATTEMPTS)"
    echo ""
    universalCast "send" "$NETWORK" "staging" "$DIAMOND_ADDRESS" "pauseDiamond()" "" "" "$PRIVATE_KEY_PAUSER_WALLET"

    # check the return code of the last call
    if [ $? -eq 0 ]; then
      break # exit the loop if the operation was successful
    fi

    ATTEMPTS=$((ATTEMPTS + 1))           # increment attempts
    sleep "$RPC_RETRY_SLEEP_SECONDS"      # back-off before next attempt
  done

  # If all our send attempts failed, do NOT short-circuit to failure - the
  # on-chain state below is the source of truth. Another caller (a parallel
  # pauser, a manual safe tx, an incident-response runbook) may have already
  # paused the diamond, in which case our sends would revert with
  # DiamondIsPaused, causing the loop above to exhaust even though the
  # diamond is correctly paused. Falling through to the final-pause check
  # lets the chain decide.
  if [ $ATTEMPTS -gt "$MAX_ATTEMPTS" ]; then
    warning "[network: $NETWORK] all $MAX_ATTEMPTS pause-send attempts failed - verifying on-chain state before declaring failure"
  fi

  # Final pause check: owner() must revert with DiamondIsPaused. universalCall
  # internally merges cast's stderr into stdout (universalCast.sh:51), so the
  # revert reason ends up in the captured stream and we inspect it for the
  # DiamondIsPaused selector. Relying on $? alone is brittle - some RPCs
  # return slightly stale state right after the pause tx is mined
  # (read-after-write lag), so cast may succeed and exit 0 even though the
  # diamond is in fact paused. Retries cushion that lag. This loop is the
  # canonical truth source for whether the diamond ended up paused
  # (regardless of who paused it).
  local FINAL_CHECK_ATTEMPT=1
  local FINAL_CHECK_RESPONSE=""
  sleep "$RPC_CALL_DELAY_SECONDS"
  while [ "$FINAL_CHECK_ATTEMPT" -le "$RPC_MAX_ATTEMPTS" ]; do
    FINAL_CHECK_RESPONSE=$(universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "owner() returns (address)" 2>&1)
    if [[ "$FINAL_CHECK_RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* || "$FINAL_CHECK_RESPONSE" == *"DiamondIsPaused"* ]]; then
      success "[network: $NETWORK] diamond ($DIAMOND_ADDRESS) successfully paused"
      echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
      return 0
    fi
    if [ "$FINAL_CHECK_ATTEMPT" -lt "$RPC_MAX_ATTEMPTS" ]; then
      echo "[network: $NETWORK] final pause check returned unclear response (attempt $FINAL_CHECK_ATTEMPT/$RPC_MAX_ATTEMPTS), retrying in ${RPC_RETRY_SLEEP_SECONDS}s..."
      sleep "$RPC_RETRY_SLEEP_SECONDS"
    fi
    FINAL_CHECK_ATTEMPT=$((FINAL_CHECK_ATTEMPT + 1))
  done

  error "[network: $NETWORK] final pause check failed after $RPC_MAX_ATTEMPTS attempts - please check the status of diamond ($DIAMOND_ADDRESS) manually (last response: $FINAL_CHECK_RESPONSE)"
  echo "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< end network $NETWORK <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<"
  return 1
}

function printStatus() {
  local NETWORK="$1"

  # skip any non-prod networks
  case "$NETWORK" in
    "bsc-testnet" | "localanvil" | "sepolia" | "mumbai" | "lineatest")
      echo "skipping $NETWORK (Testnet)"
      return 0
      ;;
  esac

  # get diamond address for this network
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "staging" "LiFiDiamond")

  # check if the diamond is paused by calling owner() function and analyzing the response.
  # Retry on unclear responses (transient RPC/throttling) so the summary doesn't misreport state.
  local STATUS_RESPONSE=""
  local STATUS_ATTEMPT=1
  while [ "$STATUS_ATTEMPT" -le "$RPC_MAX_ATTEMPTS" ]; do
    STATUS_RESPONSE=$(universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "owner() returns (address)" 2>&1)
    if [[ "$STATUS_RESPONSE" =~ ^0x[0-9a-fA-F]{40}$ ]] \
      || [[ "$STATUS_RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* ]] \
      || [[ "$STATUS_RESPONSE" == *"DiamondIsPaused"* ]]; then
      break
    fi
    if [ "$STATUS_ATTEMPT" -lt "$RPC_MAX_ATTEMPTS" ]; then
      sleep "$RPC_RETRY_SLEEP_SECONDS"
    fi
    STATUS_ATTEMPT=$((STATUS_ATTEMPT + 1))
  done
    # Check for errors in the response
  if [[ "$STATUS_RESPONSE" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
      # Clean address response — diamond is not paused
      error "[network: $NETWORK] diamond not paused."
  elif [[ "$STATUS_RESPONSE" == *"$DIAMOND_IS_PAUSED_SELECTOR"* || "$STATUS_RESPONSE" == *"DiamondIsPaused"* ]]; then
      # If the response contains the pause selector or "DiamondIsPaused", the diamond is paused
      success "[network: $NETWORK] diamond paused."
  else
      # Handle other RPC or network errors
      error "[network: $NETWORK] RPC or network error while checking if diamond is paused after $RPC_MAX_ATTEMPTS attempts: $STATUS_RESPONSE"
  fi
}

function main {
  # create array with networks for which the script should be executed (STAGING set)
  local NETWORKS=("${STAGING_NETWORKS[@]}")

  echo "networks found: ${NETWORKS[@]}"

  PRIV_KEY_ADDRESS=$(cast wallet address "$PRIVATE_KEY_PAUSER_WALLET")
  echo "Address PauserWallet: $PRIV_KEY_ADDRESS"
  echo "Networks will be executed in parallel, therefore the log might appear messy."
  echo "Watch out for red and green colored entries as they mark endpoints of each network thread"
  echo "A summary will be printed after all jobs/networks have been completed"

  # Launch handleNetwork in parallel and capture PIDs explicitly. We rely on
  # PIDs (not `jobs -p` after a no-arg `wait`) because the latter returns an
  # empty list once jobs have been reaped, which silently swallows per-network
  # failures. Each network's work happens in its own subshell so a failure on
  # one diamond does NOT abort the others - aggregation only happens after
  # every job has finished.
  local -a PIDS=()
  for NETWORK in "${NETWORKS[@]}"; do
      handleNetwork "$NETWORK" "$PRIVATE_KEY_PAUSER_WALLET" &
      PIDS+=("$!")
  done

  # Aggregate exit codes: if ANY network failed, surface that as the script's
  # exit code so the GitHub Actions workflow turns red. Aggregation does NOT
  # short-circuit - we wait for every job even after we've seen a failure.
  local RETURN=0
  for PID in "${PIDS[@]}"; do
    wait "$PID" || RETURN=1
  done

  echo "-------------------------------------------------------------------------------------"
  echo "--------------------------------ALL JOBS DONE----------------------------------------"
  echo "-------------------------------------------------------------------------------------"
  echo "[info] all jobs completed, now going through all networks again to print their status"
  # Run through all networks to print an easy-to-read summary. Wait on them
  # explicitly so the summary block is complete before main returns - without
  # this, the parent script can exit while printStatus children are still
  # writing, truncating the summary on-call uses to triage.
  local -a STATUS_PIDS=()
  for NETWORK in "${NETWORKS[@]}"; do
      printStatus "$NETWORK" &
      STATUS_PIDS+=("$!")
  done
  for PID in "${STATUS_PIDS[@]}"; do
    wait "$PID" || true
  done

  echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< script diamondEMERGENCYPauseStagingGitHub completed"
  return "$RETURN"
}

# call main function with all parameters the script was called with
main "$@"

