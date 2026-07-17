#!/bin/bash

# deployContractToNetworks.sh
#
# Non-interactive equivalent of scriptMaster.sh use case 1 ("Deploy one specific
# contract to one network"), repeated over multiple networks in one invocation.
# Deploys the contract and registers it in the LiFiDiamond:
#   - facets:    deploy + Update<Facet> script (Safe proposal in production)
#   - periphery: deploy + diamondUpdatePeriphery
#
# Note: no `set -euo pipefail` on purpose - the sourced deploy framework
# (helperFunctions.sh, deploySingleContract.sh, ...) relies on `$?` checks and
# retry loops that strict mode would abort (same as scriptMaster.sh).

function printUsage() {
  cat <<'EOF'
Usage: ./script/deploy/deployContractToNetworks.sh CONTRACT NETWORK [NETWORK...] [OPTIONS]

Deploys CONTRACT to each NETWORK and registers it in the LiFiDiamond.
Same flow as scriptMaster.sh use case 1, without interactive prompts.

Arguments:
  CONTRACT             contract name (e.g. MayanFacet, ReceiverChainflip)
  NETWORK              one or more network names from config/networks.json

Options:
  --production         deploy to production (also requires PRODUCTION=true in .env)
  -h, --help           show this help

Examples:
  ./script/deploy/deployContractToNetworks.sh MayanFacet arbitrum base optimism
  ./script/deploy/deployContractToNetworks.sh RelayFacet polygon --production
EOF
}

# deployToNetworkWorker: Deploy CONTRACT to a single NETWORK and record the outcome.
# Runs as a backgrounded job, so it writes "OK" to RESULT_FILE on success instead of a
# parent-shell array - a background subshell cannot write those back (see
# [CONV:PARALLEL-WORK]). A missing result file means failure, which also covers a
# worker killed mid-deploy. Each worker runs in its own subshell, so the deploy
# framework's non-local globals (NETWORK, CONTRACT, VERSION, ...) stay isolated per
# network; WORKER_-prefixed locals are never touched by the framework. The launcher
# prefixes every line of worker output with "[NETWORK] ", so messages here carry no
# network prefix of their own.
#
# Usage: deployToNetworkWorker NETWORK ENVIRONMENT CONTRACT VERSION RESULT_DIR
#   NETWORK      - target network name
#   ENVIRONMENT  - "production" or "staging"
#   CONTRACT     - contract name to deploy
#   VERSION      - resolved contract version
#   RESULT_DIR   - directory to write the per-network result file into
#
# Returns: 0 on success, 1 on failure (success is also written to RESULT_DIR/NETWORK)
function deployToNetworkWorker() {
  local WORKER_NETWORK="$1"
  local WORKER_ENVIRONMENT="$2"
  local WORKER_CONTRACT="$3"
  local WORKER_VERSION="$4"
  local WORKER_RESULT_FILE="$5/$1"

  echo ""
  echo "[info] >>>> now deploying $WORKER_CONTRACT..."

  if ! checkRequiredVariablesInDotEnv "$WORKER_NETWORK"; then
    warning "missing required .env variables - skipping this network"
    return 1
  fi

  echo "[info] deployer wallet balance: $(getDeployerBalance "$WORKER_NETWORK" "$WORKER_ENVIRONMENT")"

  deployAndAddContractToDiamond "$WORKER_NETWORK" "$WORKER_ENVIRONMENT" "$WORKER_CONTRACT" "LiFiDiamond" "$WORKER_VERSION"
  local WORKER_RC=$?

  if [[ $WORKER_RC -eq 0 ]]; then
    echo "OK" >"$WORKER_RESULT_FILE"
    success "<<<< done"
    return 0
  else
    warning "<<<< FAILED"
    return 1
  fi
}

# killProcessTree: Terminate PID and all of its descendants, deepest first.
# The root is SIGSTOPped before the sweep so it cannot spawn new children while its
# subtree is being killed; the pending SIGTERM is delivered by the final SIGCONT.
#
# Usage: killProcessTree PID
#   PID - root process id of the tree to terminate
#
# Returns: 0 (best-effort; already-gone processes are ignored)
# shellcheck disable=SC2329  # invoked indirectly (recursion + trap handler)
function killProcessTree() {
  local ROOT_PID="$1"
  local CHILD_PID
  kill -STOP "$ROOT_PID" 2>/dev/null
  for CHILD_PID in $(pgrep -P "$ROOT_PID" 2>/dev/null); do
    killProcessTree "$CHILD_PID"
  done
  kill -TERM "$ROOT_PID" 2>/dev/null
  kill -CONT "$ROOT_PID" 2>/dev/null
}

# abortInFlightDeployments: SIGINT/SIGTERM handler. cleanupBackgroundJobs' flat
# `pkill -P $$` would only reach the worker subshells and orphan their forge/bun
# grandchildren, which would keep broadcasting transactions (unrecorded in the
# deployment logs, since their worker is dead) after the reported abort - so each
# child's whole process tree is killed instead.
#
# Usage: abortInFlightDeployments (trap handler, no arguments)
#
# Returns: does not return - exits 1
# shellcheck disable=SC2329  # invoked indirectly via the SIGINT/SIGTERM trap
function abortInFlightDeployments() {
  trap - SIGINT SIGTERM
  echo ""
  echo "[info] abort requested - killing all in-flight deployments..."
  local CHILD_PID
  for CHILD_PID in $(pgrep -P $$ 2>/dev/null); do
    killProcessTree "$CHILD_PID"
  done
  echo "[info] all in-flight deployments killed. Script execution aborted."
  exit 1
}

function deployContractToNetworks() {
  # SIGTERM covers CI cancellation; SIGINT covers a local Ctrl-C. Both kill the
  # backgrounded workers including their forge/bun child processes rather than
  # orphaning them mid-broadcast.
  trap 'abortInFlightDeployments' SIGINT SIGTERM

  # TARGET_-prefixed names are deliberate: the sourced framework assigns generic
  # names (CONTRACT, NETWORK, VERSION, ...) without 'local', which would clobber ours mid-run
  local TARGET_CONTRACT=""
  local PRODUCTION_FLAG=false
  local TARGET_NETWORKS=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
    -h | --help)
      printUsage
      exit 0
      ;;
    --production)
      PRODUCTION_FLAG=true
      shift
      ;;
    -*)
      error "unknown option: $1"
      printUsage
      exit 1
      ;;
    *)
      if [[ -z "$TARGET_CONTRACT" ]]; then
        TARGET_CONTRACT="$1"
      else
        TARGET_NETWORKS+=("$1")
      fi
      shift
      ;;
    esac
  done

  if [[ -z "$TARGET_CONTRACT" ]]; then
    error "missing CONTRACT argument"
    printUsage
    exit 1
  fi
  if [[ ${#TARGET_NETWORKS[@]} -eq 0 ]]; then
    error "missing NETWORK argument(s)"
    printUsage
    exit 1
  fi
  # resolve environment: .env PRODUCTION and --production must agree, replacing
  # scriptMaster's interactive "last chance" prompt with a double opt-in
  local TARGET_ENVIRONMENT
  if [[ "$PRODUCTION_FLAG" == "true" ]]; then
    if [[ "$PRODUCTION" != "true" ]]; then
      error "--production requires PRODUCTION=true in .env"
      exit 1
    fi
    TARGET_ENVIRONMENT="production"
  else
    if [[ "$PRODUCTION" == "true" ]]; then
      error "PRODUCTION=true is set in .env but --production was not passed - pass --production to deploy to production or set PRODUCTION=false for staging"
      exit 1
    fi
    TARGET_ENVIRONMENT="staging"
  fi

  if [[ "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" == "true" ]]; then
    warning "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND is set to true (send directly to diamond; use only for new production networks before ownership transfer)."
  fi

  # validate all networks against networks.json before deploying anything
  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
  local TARGET_NETWORK
  for TARGET_NETWORK in "${TARGET_NETWORKS[@]}"; do
    if ! jq -e --arg TARGET_NETWORK "$TARGET_NETWORK" 'has($TARGET_NETWORK)' "$NETWORKS_JSON_FILE_PATH" >/dev/null; then
      error "unknown network '$TARGET_NETWORK' (not found in $NETWORKS_JSON_FILE_PATH)"
      exit 1
    fi
  done

  # De-duplicate the target list. Sequential runs tolerated repeats (deploy twice,
  # idempotently); parallel workers cannot - two workers on the same chain race on
  # its nonce and clobber the same deployment-log and result file.
  # Nested loop instead of an associative array: macOS /bin/bash is 3.2, where
  # `local -A` fails and the indexed-array fallback silently drops every network
  # after the first (all string subscripts arithmetically evaluate to index 0).
  local DEDUPED_NETWORKS=()
  local KNOWN_NETWORK
  local IS_DUPLICATE
  for TARGET_NETWORK in "${TARGET_NETWORKS[@]}"; do
    IS_DUPLICATE=false
    for KNOWN_NETWORK in "${DEDUPED_NETWORKS[@]}"; do
      if [[ "$KNOWN_NETWORK" == "$TARGET_NETWORK" ]]; then
        IS_DUPLICATE=true
        break
      fi
    done
    if [[ "$IS_DUPLICATE" == "true" ]]; then
      warning "duplicate network '$TARGET_NETWORK' in arguments - ignoring the repeat"
      continue
    fi
    DEDUPED_NETWORKS+=("$TARGET_NETWORK")
  done
  TARGET_NETWORKS=("${DEDUPED_NETWORKS[@]}")

  # validate contract name + resolve current version
  local TARGET_VERSION
  TARGET_VERSION=$(getCurrentContractVersion "$TARGET_CONTRACT") || {
    error "could not determine version of contract '$TARGET_CONTRACT' - check the contract name"
    exit 1
  }

  # Throttle knob for the parallel workers below, defaulted like its other consumers
  # (helperFunctions.sh). Must be a positive integer: a non-numeric value breaks the
  # `-ge` arithmetic in the throttle gate, and 0 makes it spin forever (job count is
  # always >= 0). Validated here, before the expensive build.
  MAX_CONCURRENT_JOBS="${MAX_CONCURRENT_JOBS:-10}"
  if [[ ! "$MAX_CONCURRENT_JOBS" =~ ^[1-9][0-9]*$ ]]; then
    error "MAX_CONCURRENT_JOBS must be a positive integer (check your .env) - got '$MAX_CONCURRENT_JOBS'"
    exit 1
  fi

  # Compile once up front, unconditionally: the parallel workers below each run
  # `forge script`, which would otherwise trigger concurrent compilation on a cold
  # cache and race. Building here guarantees every worker starts against a warm,
  # consistent artifact cache.
  if [[ -n "$COMPILE_ON_STARTUP" && "$COMPILE_ON_STARTUP" != "true" ]]; then
    warning "COMPILE_ON_STARTUP=$COMPILE_ON_STARTUP is not honored by this script - the pre-build is mandatory for parallel deploy safety, not opt-in"
  fi
  echo "[info] compiling contracts before parallel deployment"
  if ! forge build; then
    error "forge build failed - aborting before any deployment"
    exit 1
  fi

  # The vanilla pre-build does not cover zkEVM targets: their workers compile via
  # `FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync` after installing
  # the pinned foundry-zksync toolchain (deploySingleContract.sh). Pre-warm both here
  # so concurrent zk workers do not race on the shared ./foundry-zksync install and a
  # cold zksync artifact cache.
  local HAS_ZKEVM_TARGET=false
  for TARGET_NETWORK in "${TARGET_NETWORKS[@]}"; do
    if isZkEvmNetwork "$TARGET_NETWORK"; then
      HAS_ZKEVM_TARGET=true
      break
    fi
  done
  if [[ "$HAS_ZKEVM_TARGET" == "true" ]]; then
    echo "[info] zkEVM target detected - installing foundry-zksync and building zksync artifacts before parallel deployment"
    if ! install_foundry_zksync; then
      error "failed to install foundry-zksync - aborting before any deployment"
      exit 1
    fi
    if ! FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync --skip test; then
      error "zksync build failed - aborting before any deployment"
      exit 1
    fi
  fi

  echo ""
  echo "[info] deploying $TARGET_CONTRACT v$TARGET_VERSION to ${#TARGET_NETWORKS[@]} network(s) in $TARGET_ENVIRONMENT environment: ${TARGET_NETWORKS[*]}"
  echo "[info] deployer address: $(getDeployerAddress "" "$TARGET_ENVIRONMENT")"

  local FAILED_NETWORKS=()
  local SUCCEEDED_NETWORKS=()

  # Backgrounded workers cannot append to parent-shell arrays, so each writes its
  # outcome to "$RESULT_DIR/<network>"; the summary is derived after `wait`
  # (see [CONV:PARALLEL-WORK]). Each network deploy is independent - per-chain
  # nonce space, per-network deployment-log files, per-chain Safe - so they run
  # concurrently, throttled to MAX_CONCURRENT_JOBS.
  local RESULT_DIR
  RESULT_DIR=$(mktemp -d)
  # clean the temp dir on any exit (normal, error, or signal) without altering the
  # exit code; the SIGINT/SIGTERM trap above still handles killing the workers
  trap 'rm -rf "$RESULT_DIR"' EXIT

  echo "[info] deploying with up to $MAX_CONCURRENT_JOBS concurrent network(s)"

  for TARGET_NETWORK in "${TARGET_NETWORKS[@]}"; do
    # throttle: wait for a free slot before launching the next network
    while [[ $(jobs | wc -l) -ge $MAX_CONCURRENT_JOBS ]]; do
      sleep 1
    done
    # </dev/null makes the no-stdin guarantee explicit - the sourced framework must
    # never block on an interactive prompt inside a background worker; sed attributes
    # every line of framework output to its network, since concurrent workers'
    # otherwise-unprefixed logs interleave on the shared terminal
    deployToNetworkWorker "$TARGET_NETWORK" "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT" "$TARGET_VERSION" "$RESULT_DIR" </dev/null 2>&1 | sed "s/^/[$TARGET_NETWORK] /" &
  done

  # wait for all in-flight network deployments to finish
  wait

  # derive per-network outcome from the result files the workers wrote
  for TARGET_NETWORK in "${TARGET_NETWORKS[@]}"; do
    if [[ "$(cat "$RESULT_DIR/$TARGET_NETWORK" 2>/dev/null)" == "OK" ]]; then
      SUCCEEDED_NETWORKS+=("$TARGET_NETWORK")
    else
      FAILED_NETWORKS+=("$TARGET_NETWORK")
    fi
  done

  echo ""
  echo "[info] ==================== SUMMARY ===================="
  echo "[info] contract:    $TARGET_CONTRACT v$TARGET_VERSION"
  echo "[info] environment: $TARGET_ENVIRONMENT"
  local DEPLOYED_ADDRESS
  for TARGET_NETWORK in "${SUCCEEDED_NETWORKS[@]:-}"; do
    if [[ -n "$TARGET_NETWORK" ]]; then
      DEPLOYED_ADDRESS=$(getContractAddressFromDeploymentLogs "$TARGET_NETWORK" "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT") || DEPLOYED_ADDRESS="address not found in deployment log"
      success "$TARGET_NETWORK: OK ($DEPLOYED_ADDRESS)"
    fi
  done
  for TARGET_NETWORK in "${FAILED_NETWORKS[@]:-}"; do
    [[ -n "$TARGET_NETWORK" ]] && error "$TARGET_NETWORK: FAILED"
  done
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "[info] PLEASE CHECK THE LOG CAREFULLY FOR WARNINGS AND ERRORS"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"

  if [[ ${#FAILED_NETWORKS[@]} -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

# all framework paths are relative to the repo root
if [[ ! -f "script/helperFunctions.sh" ]]; then
  echo "[error] this script must be run from the repository root (e.g. ./script/deploy/deployContractToNetworks.sh ...)"
  exit 1
fi

if [[ ! -f ".env" ]]; then
  echo "[error] .env file not found in repository root - copy .env.example to .env and configure it"
  exit 1
fi

# load env + deploy framework (same set as scriptMaster.sh)
# shellcheck disable=SC1091
source .env
# shellcheck disable=SC1091
source script/helperFunctions.sh
# shellcheck disable=SC1091
source script/deploy/deploySingleContract.sh
# shellcheck disable=SC1091
source script/deploy/deployFacetAndAddToDiamond.sh
for TASK_SCRIPT in script/tasks/*.sh; do
  # shellcheck disable=SC1090
  [[ -f "$TASK_SCRIPT" ]] && source "$TASK_SCRIPT"
done

deployContractToNetworks "$@"
