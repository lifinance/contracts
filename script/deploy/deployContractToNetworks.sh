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
# Runs as a backgrounded job, so it writes "OK"/"FAILED" to RESULT_FILE instead of a
# parent-shell array - a background subshell cannot write those back (see
# [CONV:PARALLEL-WORK]). Each worker runs in its own subshell, so the deploy
# framework's non-local globals (NETWORK, CONTRACT, VERSION, ...) stay isolated per
# network; WORKER_-prefixed locals are never touched by the framework.
#
# Usage: deployToNetworkWorker NETWORK ENVIRONMENT CONTRACT VERSION RESULT_DIR
#   NETWORK      - target network name
#   ENVIRONMENT  - "production" or "staging"
#   CONTRACT     - contract name to deploy
#   VERSION      - resolved contract version
#   RESULT_DIR   - directory to write the per-network result file into
#
# Returns: 0 on success, 1 on failure (outcome is also written to RESULT_DIR/NETWORK)
function deployToNetworkWorker() {
  local WORKER_NETWORK="$1"
  local WORKER_ENVIRONMENT="$2"
  local WORKER_CONTRACT="$3"
  local WORKER_VERSION="$4"
  local WORKER_RESULT_FILE="$5/$1"

  echo ""
  echo "[info] [$WORKER_NETWORK] >>>> now deploying $WORKER_CONTRACT..."

  if ! checkRequiredVariablesInDotEnv "$WORKER_NETWORK"; then
    warning "[$WORKER_NETWORK] missing required .env variables - skipping this network"
    echo "FAILED" >"$WORKER_RESULT_FILE"
    return 1
  fi

  echo "[info] [$WORKER_NETWORK] deployer wallet balance: $(getDeployerBalance "$WORKER_NETWORK" "$WORKER_ENVIRONMENT")"

  deployAndAddContractToDiamond "$WORKER_NETWORK" "$WORKER_ENVIRONMENT" "$WORKER_CONTRACT" "LiFiDiamond" "$WORKER_VERSION"
  local WORKER_RC=$?

  if [[ $WORKER_RC -eq 0 ]]; then
    echo "OK" >"$WORKER_RESULT_FILE"
    success "[$WORKER_NETWORK] <<<< done"
    return 0
  else
    echo "FAILED" >"$WORKER_RESULT_FILE"
    warning "[$WORKER_NETWORK] <<<< FAILED"
    return 1
  fi
}

function deployContractToNetworks() {
  # SIGTERM covers CI cancellation; SIGINT covers a local Ctrl-C. Both kill the
  # backgrounded workers via cleanupBackgroundJobs rather than orphaning them.
  trap 'cleanupBackgroundJobs' SIGINT SIGTERM

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
  local -A SEEN_NETWORKS=()
  local DEDUPED_NETWORKS=()
  for TARGET_NETWORK in "${TARGET_NETWORKS[@]}"; do
    if [[ -n "${SEEN_NETWORKS[$TARGET_NETWORK]:-}" ]]; then
      warning "duplicate network '$TARGET_NETWORK' in arguments - ignoring the repeat"
      continue
    fi
    SEEN_NETWORKS[$TARGET_NETWORK]=1
    DEDUPED_NETWORKS+=("$TARGET_NETWORK")
  done
  TARGET_NETWORKS=("${DEDUPED_NETWORKS[@]}")

  # validate contract name + resolve current version
  local TARGET_VERSION
  TARGET_VERSION=$(getCurrentContractVersion "$TARGET_CONTRACT") || {
    error "could not determine version of contract '$TARGET_CONTRACT' - check the contract name"
    exit 1
  }

  # Compile once up front, unconditionally: the parallel workers below each run
  # `forge script`, which would otherwise trigger concurrent compilation on a cold
  # cache and race. Building here guarantees every worker starts against a warm,
  # consistent artifact cache (COMPILE_ON_STARTUP is not honored - the pre-build is
  # mandatory for parallel safety, not opt-in).
  echo "[info] compiling contracts before parallel deployment"
  if ! forge build; then
    error "forge build failed - aborting before any deployment"
    exit 1
  fi

  echo ""
  echo "[info] deploying $TARGET_CONTRACT v$TARGET_VERSION to ${#TARGET_NETWORKS[@]} network(s) in $TARGET_ENVIRONMENT environment: ${TARGET_NETWORKS[*]}"
  echo "[info] deployer address: $(getDeployerAddress "" "$TARGET_ENVIRONMENT")"

  # Must be a positive integer: unset/empty or a non-numeric value breaks the `-ge`
  # arithmetic in the throttle gate, and 0 makes it spin forever (job count is always >= 0).
  if [[ ! "${MAX_CONCURRENT_JOBS:-}" =~ ^[1-9][0-9]*$ ]]; then
    error "MAX_CONCURRENT_JOBS must be a positive integer (check your .env) - got '${MAX_CONCURRENT_JOBS:-}'"
    exit 1
  fi

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
    deployToNetworkWorker "$TARGET_NETWORK" "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT" "$TARGET_VERSION" "$RESULT_DIR" &
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
