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

# launchDeployWave: Deploy CONTRACT to a set of networks concurrently and block
# until the whole wave finishes. All networks in a wave share one EVM-version
# profile (foundry.toml already pointed at it by the caller), so their `forge
# script` runs hit a warm, consistent artifact cache. Sequencing is by wave, not
# within it: the caller must not mutate foundry.toml again until this returns.
#
# Usage: launchDeployWave CONCURRENCY ENVIRONMENT CONTRACT VERSION RESULT_DIR NETWORK...
#   CONCURRENCY  - max networks to deploy at once (1 = sequential, e.g. zkEVM)
#   ENVIRONMENT  - "production" or "staging"
#   CONTRACT     - contract name to deploy
#   VERSION      - resolved contract version
#   RESULT_DIR   - directory each worker writes its per-network result file into
#   NETWORK...   - the networks that make up this wave
#
# Returns: 0 (per-network outcomes are read from RESULT_DIR by the caller)
function launchDeployWave() {
  local WAVE_CONCURRENCY="$1"
  local WAVE_ENVIRONMENT="$2"
  local WAVE_CONTRACT="$3"
  local WAVE_VERSION="$4"
  local WAVE_RESULT_DIR="$5"
  shift 5
  local WAVE_NETWORKS=("$@")
  local WAVE_NETWORK

  for WAVE_NETWORK in "${WAVE_NETWORKS[@]}"; do
    # throttle: wait for a free slot before launching the next network
    while [[ $(jobs | wc -l) -ge $WAVE_CONCURRENCY ]]; do
      sleep 1
    done
    # </dev/null makes the no-stdin guarantee explicit - the sourced framework must
    # never block on an interactive prompt inside a background worker; sed attributes
    # every line of framework output to its network, since concurrent workers'
    # otherwise-unprefixed logs interleave on the shared terminal
    deployToNetworkWorker "$WAVE_NETWORK" "$WAVE_ENVIRONMENT" "$WAVE_CONTRACT" "$WAVE_VERSION" "$WAVE_RESULT_DIR" </dev/null 2>&1 | sed "s/^/[$WAVE_NETWORK] /" &
  done

  # wait for every network in this wave before the caller repoints foundry.toml
  wait
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
  # The per-group builds below are mandatory for parallel-deploy safety (each wave
  # deploys against a warm, group-specific artifact cache), so COMPILE_ON_STARTUP
  # is not honored here as an opt-out.
  if [[ -n "$COMPILE_ON_STARTUP" && "$COMPILE_ON_STARTUP" != "true" ]]; then
    warning "COMPILE_ON_STARTUP=$COMPILE_ON_STARTUP is not honored by this script - the per-group pre-build is mandatory, not opt-in"
  fi

  # Split the target networks by the toolchain they must be built with: cancun
  # bytecode embeds opcodes (PUSH0/MCOPY/TLOAD) a london chain rejects, and zkEVM
  # needs a different compiler, so each group is built once and shipped its own
  # artifact (grouping + foundry.toml swap live in deployGroupingHelpers.sh).
  local GROUPS_JSON
  GROUPS_JSON=$(groupNetworksByExecutionGroup "${TARGET_NETWORKS[@]}") || {
    error "failed to group networks by EVM version"
    exit 1
  }

  local LONDON_NETWORKS=()
  local CANCUN_NETWORKS=()
  local ZKEVM_NETWORKS=()
  local INVALID_NETWORKS=()
  local GROUP_NETWORK
  while IFS= read -r GROUP_NETWORK; do
    [[ -n "$GROUP_NETWORK" ]] && LONDON_NETWORKS+=("$GROUP_NETWORK")
  done < <(echo "$GROUPS_JSON" | jq -r '.london[]')
  while IFS= read -r GROUP_NETWORK; do
    [[ -n "$GROUP_NETWORK" ]] && CANCUN_NETWORKS+=("$GROUP_NETWORK")
  done < <(echo "$GROUPS_JSON" | jq -r '.cancun[]')
  while IFS= read -r GROUP_NETWORK; do
    [[ -n "$GROUP_NETWORK" ]] && ZKEVM_NETWORKS+=("$GROUP_NETWORK")
  done < <(echo "$GROUPS_JSON" | jq -r '.zkevm[]')
  while IFS= read -r GROUP_NETWORK; do
    [[ -n "$GROUP_NETWORK" ]] && INVALID_NETWORKS+=("$GROUP_NETWORK")
  done < <(echo "$GROUPS_JSON" | jq -r '.invalid[]')

  if [[ ${#INVALID_NETWORKS[@]} -gt 0 ]]; then
    error "cannot resolve an EVM-version group for: ${INVALID_NETWORKS[*]} - check 'deployedWithEvmVersion'/'isZkEVM' in networks.json"
    exit 1
  fi

  echo ""
  echo "[info] deploying $TARGET_CONTRACT v$TARGET_VERSION to ${#TARGET_NETWORKS[@]} network(s) in $TARGET_ENVIRONMENT environment"
  echo "[info] deployer address: $(getDeployerAddress "" "$TARGET_ENVIRONMENT")"
  echo "[info] london (${#LONDON_NETWORKS[@]}): ${LONDON_NETWORKS[*]:-none}"
  echo "[info] cancun (${#CANCUN_NETWORKS[@]}): ${CANCUN_NETWORKS[*]:-none}"
  echo "[info] zkevm  (${#ZKEVM_NETWORKS[@]}): ${ZKEVM_NETWORKS[*]:-none}"
  echo "[info] up to $MAX_CONCURRENT_JOBS concurrent network(s) per EVM group; zkEVM runs sequentially"

  local FAILED_NETWORKS=()
  local SUCCEEDED_NETWORKS=()

  # Backgrounded workers cannot append to parent-shell arrays, so each writes its
  # outcome to "$RESULT_DIR/<network>"; the summary is derived after all waves
  # (see [CONV:PARALLEL-WORK]). Each network deploy is independent - per-chain
  # nonce space, per-network deployment-log files, per-chain Safe.
  local RESULT_DIR
  RESULT_DIR=$(mktemp -d)

  # Each EVM group temporarily rewrites foundry.toml (solc + evm_version) for its
  # build, so back it up now and restore on any exit - normal, error, or the
  # SIGINT/SIGTERM handler's `exit 1`, which also triggers this EXIT trap.
  backupFoundryToml || {
    error "failed to back up foundry.toml - aborting before any deployment"
    rm -rf "$RESULT_DIR"
    exit 1
  }
  trap 'restoreFoundryToml 2>/dev/null; rm -rf "$RESULT_DIR"' EXIT

  # London wave: solc 0.8.17 / evm_version london, deployed in parallel.
  if [[ ${#LONDON_NETWORKS[@]} -gt 0 ]]; then
    echo ""
    echo "[info] === london group: building, then deploying ${#LONDON_NETWORKS[@]} network(s) in parallel ==="
    if ! updateFoundryTomlForGroup "$GROUP_LONDON" true; then
      error "london group build failed - aborting before deploying any london network"
      exit 1
    fi
    launchDeployWave "$MAX_CONCURRENT_JOBS" "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT" "$TARGET_VERSION" "$RESULT_DIR" "${LONDON_NETWORKS[@]}"
  fi

  # Cancun wave: solc 0.8.29 / evm_version cancun, deployed in parallel.
  if [[ ${#CANCUN_NETWORKS[@]} -gt 0 ]]; then
    echo ""
    echo "[info] === cancun group: building, then deploying ${#CANCUN_NETWORKS[@]} network(s) in parallel ==="
    if ! updateFoundryTomlForGroup "$GROUP_CANCUN" true; then
      error "cancun group build failed - aborting before deploying any cancun network"
      exit 1
    fi
    launchDeployWave "$MAX_CONCURRENT_JOBS" "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT" "$TARGET_VERSION" "$RESULT_DIR" "${CANCUN_NETWORKS[@]}"
  fi

  # zkEVM wave: separate compiler plus a shared ./foundry-zksync install and zkout/
  # cache that cannot survive concurrent builds, so install+build once here and
  # deploy strictly sequentially (concurrency 1). The default-profile foundry.toml
  # state left by the EVM waves is irrelevant - zk uses [profile.zksync].
  if [[ ${#ZKEVM_NETWORKS[@]} -gt 0 ]]; then
    echo ""
    echo "[info] === zkevm group: installing foundry-zksync + building, then deploying ${#ZKEVM_NETWORKS[@]} network(s) sequentially ==="
    if ! install_foundry_zksync; then
      error "failed to install foundry-zksync - aborting before deploying any zkEVM network"
      exit 1
    fi
    if ! FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync --skip test; then
      error "zksync build failed - aborting before deploying any zkEVM network"
      exit 1
    fi
    launchDeployWave 1 "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT" "$TARGET_VERSION" "$RESULT_DIR" "${ZKEVM_NETWORKS[@]}"
  fi

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
# EVM-version grouping + foundry.toml management (groupNetworksByExecutionGroup,
# backup/restore/updateFoundryTomlForGroup, group constants)
# shellcheck disable=SC1091
source script/deploy/resources/deployGroupingHelpers.sh
# shellcheck disable=SC1091
source script/deploy/deploySingleContract.sh
# shellcheck disable=SC1091
source script/deploy/deployFacetAndAddToDiamond.sh
for TASK_SCRIPT in script/tasks/*.sh; do
  # shellcheck disable=SC1090
  [[ -f "$TASK_SCRIPT" ]] && source "$TASK_SCRIPT"
done

deployContractToNetworks "$@"
