#!/bin/bash

# proposeContractToNetworks.sh
#
# Propose Safe registration for a contract whose address is already recorded in
# deployments/<NETWORK>.json — no CREATE3 / bytecode deploy. Covers deferred
# diamond cuts and recreate-after-delete. Facets use diamondUpdateFacet;
# periphery uses diamondUpdatePeriphery; diamond-called periphery also syncs
# the allowlist via syncWhitelistToNetworks.sh.
#
# Note: no `set -euo pipefail` on purpose — the sourced deploy framework relies
# on `$?` checks and retry loops that strict mode would abort.

# unique name: this file is auto-sourced by scriptMaster.sh /
# deployContractToNetworks.sh alongside other tasks that define printUsage
function printProposeContractUsage() {
  cat <<'EOF'
Usage: ./script/tasks/proposeContractToNetworks.sh CONTRACT NETWORK [NETWORK...] [OPTIONS]
       ./script/tasks/proposeContractToNetworks.sh CONTRACT --all-where-deployed [OPTIONS]

Propose Safe registration for CONTRACT using the address already in
deployments/<NETWORK>.json. Does not deploy bytecode. In production the
registration is proposed to each chain's Safe (timelock-wrapped); in staging
it is sent directly to the diamond.

Arguments:
  CONTRACT               contract name (e.g. MayanFacet, FeeCollector)
  NETWORK                one or more network names from config/networks.json

Options:
  --all-where-deployed   every network where deployments/<net>.json has CONTRACT
  --production           production (also requires PRODUCTION=true in .env)
  -h, --help             show this help

Examples:
  ./script/tasks/proposeContractToNetworks.sh MayanFacet mainnet arbitrum --production
  ./script/tasks/proposeContractToNetworks.sh MayanFacet --all-where-deployed --production
  ./script/tasks/proposeContractToNetworks.sh GasZipPeriphery arbitrum
EOF
}

# isFacetContractName: true when CONTRACT is registered via diamondCut (name contains Facet).
function isFacetContractName() {
  local CONTRACT_NAME="$1"
  [[ "$CONTRACT_NAME" == *"Facet"* ]]
}

# isDiamondCalledPeriphery: true when CONTRACT is listed under whitelistPeripheryFunctions.
function isDiamondCalledPeriphery() {
  local CONTRACT_NAME="$1"
  jq -e --arg N "$CONTRACT_NAME" '.whitelistPeripheryFunctions | has($N)' config/global.json >/dev/null 2>&1
}

# isAddressRegisteredOnDiamond: true when LOG_ADDRESS is already the live registration
# for CONTRACT on NETWORK's LiFiDiamond (facetAddresses membership or periphery registry).
function isAddressRegisteredOnDiamond() {
  local NETWORK="$1"
  local ENVIRONMENT="$2"
  local CONTRACT_NAME="$3"
  local LOG_ADDRESS="$4"

  local DIAMOND_ADDRESS
  DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "LiFiDiamond") || return 1

  local LOG_LOWER
  LOG_LOWER=$(echo "$LOG_ADDRESS" | tr '[:upper:]' '[:lower:]')

  if isFacetContractName "$CONTRACT_NAME"; then
    local FACET_LIST
    FACET_LIST=$(universalCast "call" "$NETWORK" "$DIAMOND_ADDRESS" "facetAddresses() returns (address[])" 2>/dev/null) || return 1
    echo "$FACET_LIST" | tr '[:upper:]' '[:lower:]' | grep -q "$LOG_LOWER"
    return $?
  fi

  local PERIPHERY_ADDRESS
  PERIPHERY_ADDRESS=$(getPeripheryAddressFromDiamond "$NETWORK" "$DIAMOND_ADDRESS" "$CONTRACT_NAME" 2>/dev/null) || return 1
  local PERIPHERY_LOWER
  PERIPHERY_LOWER=$(echo "$PERIPHERY_ADDRESS" | tr '[:upper:]' '[:lower:]')
  [[ "$PERIPHERY_LOWER" == "$LOG_LOWER" ]]
}

# writeProposeResult: record OK|SKIP|FAIL for NETWORK into RESULT_DIR (must exist).
function writeProposeResult() {
  local RESULT_DIR="$1"
  local NETWORK="$2"
  local OUTCOME="$3"
  local REASON="${4:-}"

  if [[ ! -d "$RESULT_DIR" ]]; then
    error "result directory missing while recording $OUTCOME for $NETWORK — parent cleaned up too early?"
    return 1
  fi
  if [[ -n "$REASON" ]]; then
    echo "${OUTCOME}:${REASON}" >"$RESULT_DIR/$NETWORK"
  else
    echo "$OUTCOME" >"$RESULT_DIR/$NETWORK"
  fi
}

# proposeToNetworkWorker: propose registration for CONTRACT on one NETWORK.
#
# Usage: proposeToNetworkWorker NETWORK ENVIRONMENT CONTRACT RESULT_DIR
function proposeToNetworkWorker() {
  local WORKER_NETWORK="$1"
  local WORKER_ENVIRONMENT="$2"
  local WORKER_CONTRACT="$3"
  local WORKER_RESULT_DIR="$4"

  echo ""
  echo "[info] >>>> proposing $WORKER_CONTRACT registration on $WORKER_NETWORK..."

  if ! checkRequiredVariablesInDotEnv "$WORKER_NETWORK"; then
    warning "missing required .env variables - failing this network"
    writeProposeResult "$WORKER_RESULT_DIR" "$WORKER_NETWORK" "FAIL" "missing-env"
    return 1
  fi

  local LOG_ADDRESS
  if ! LOG_ADDRESS=$(getContractAddressFromDeploymentLogs "$WORKER_NETWORK" "$WORKER_ENVIRONMENT" "$WORKER_CONTRACT"); then
    error "no $WORKER_CONTRACT address in deployments/${WORKER_NETWORK} log for $WORKER_ENVIRONMENT"
    writeProposeResult "$WORKER_RESULT_DIR" "$WORKER_NETWORK" "FAIL" "missing-log-address"
    return 1
  fi
  echo "[info] log address: $LOG_ADDRESS"

  local HAS_CODE
  HAS_CODE=$(doesAddressContainBytecode "$WORKER_NETWORK" "$LOG_ADDRESS" 2>/dev/null | tail -1)
  if [[ "$HAS_CODE" != "true" ]]; then
    error "no bytecode at $LOG_ADDRESS on $WORKER_NETWORK — deploy first"
    writeProposeResult "$WORKER_RESULT_DIR" "$WORKER_NETWORK" "FAIL" "no-bytecode"
    return 1
  fi

  if isAddressRegisteredOnDiamond "$WORKER_NETWORK" "$WORKER_ENVIRONMENT" "$WORKER_CONTRACT" "$LOG_ADDRESS"; then
    echo "[info] already registered on diamond at $LOG_ADDRESS — SKIP"
    writeProposeResult "$WORKER_RESULT_DIR" "$WORKER_NETWORK" "SKIP" "already-registered"
    success "<<<< skipped (already-registered)"
    return 0
  fi

  local PROPOSE_LOG
  PROPOSE_LOG=$(mktemp)
  local WORKER_RC=0

  if isFacetContractName "$WORKER_CONTRACT"; then
    diamondUpdateFacet "$WORKER_NETWORK" "$WORKER_ENVIRONMENT" "LiFiDiamond" "Update${WORKER_CONTRACT}" true >"$PROPOSE_LOG" 2>&1
    WORKER_RC=$?
  else
    diamondUpdatePeriphery "$WORKER_NETWORK" "$WORKER_ENVIRONMENT" "LiFiDiamond" false false "$WORKER_CONTRACT" >"$PROPOSE_LOG" 2>&1
    WORKER_RC=$?
  fi

  # Stream worker logs to the terminal (prefixed by the launcher's sed).
  cat "$PROPOSE_LOG"

  if grep -qiE 'Proposal already exists|Duplicate pending proposal' "$PROPOSE_LOG"; then
    rm -f "$PROPOSE_LOG"
    writeProposeResult "$WORKER_RESULT_DIR" "$WORKER_NETWORK" "SKIP" "duplicate-pending"
    success "<<<< skipped (duplicate-pending)"
    return 0
  fi

  if grep -qiE 'FacetCut is empty' "$PROPOSE_LOG"; then
    rm -f "$PROPOSE_LOG"
    writeProposeResult "$WORKER_RESULT_DIR" "$WORKER_NETWORK" "SKIP" "already-registered"
    success "<<<< skipped (empty cut / already-registered)"
    return 0
  fi

  rm -f "$PROPOSE_LOG"

  if [[ $WORKER_RC -eq 0 ]]; then
    writeProposeResult "$WORKER_RESULT_DIR" "$WORKER_NETWORK" "OK"
    success "<<<< done"
    return 0
  fi

  writeProposeResult "$WORKER_RESULT_DIR" "$WORKER_NETWORK" "FAIL" "propose-failed"
  warning "<<<< FAILED"
  return 1
}

function launchProposeWave() {
  local WAVE_CONCURRENCY="$1"
  local WAVE_ENVIRONMENT="$2"
  local WAVE_CONTRACT="$3"
  local WAVE_RESULT_DIR="$4"
  shift 4
  local WAVE_NETWORKS=("$@")
  local WAVE_NETWORK

  if [[ "$WAVE_CONCURRENCY" -eq 1 ]]; then
    for WAVE_NETWORK in "${WAVE_NETWORKS[@]}"; do
      proposeToNetworkWorker "$WAVE_NETWORK" "$WAVE_ENVIRONMENT" "$WAVE_CONTRACT" "$WAVE_RESULT_DIR" </dev/null
    done
    return 0
  fi

  for WAVE_NETWORK in "${WAVE_NETWORKS[@]}"; do
    while [[ $(jobs | wc -l) -ge $WAVE_CONCURRENCY ]]; do
      sleep 1
    done
    proposeToNetworkWorker "$WAVE_NETWORK" "$WAVE_ENVIRONMENT" "$WAVE_CONTRACT" "$WAVE_RESULT_DIR" </dev/null 2>&1 | sed "s/^/[$WAVE_NETWORK] /" &
  done
  wait
}

function resolveNetworksWhereDeployed() {
  local CONTRACT_NAME="$1"
  local ENVIRONMENT="$2"
  local FILE_SUFFIX
  FILE_SUFFIX=$(getFileSuffix "$ENVIRONMENT")

  local INCLUDED
  INCLUDED=$(getIncludedNetworksArray)

  local NETWORK
  local ADDR
  for NETWORK in $INCLUDED; do
    ADDR=$(jq -r --arg C "$CONTRACT_NAME" '.[$C] // empty' "./deployments/${NETWORK}.${FILE_SUFFIX}json" 2>/dev/null)
    if [[ -n "$ADDR" && "$ADDR" != "null" && "$ADDR" != "0x" ]]; then
      echo "$NETWORK"
    fi
  done
}

function proposeContractToNetworks() {
  local TARGET_CONTRACT=""
  local PRODUCTION_FLAG=false
  local ALL_WHERE_DEPLOYED=false
  local TARGET_NETWORKS=()

  if [[ $# -ge 1 && -z "$1" ]]; then
    error "this task cannot be run via scriptMaster - run it directly: ./script/tasks/proposeContractToNetworks.sh CONTRACT NETWORK... [--production]"
    exit 1
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
    -h | --help)
      printProposeContractUsage
      exit 0
      ;;
    --production)
      PRODUCTION_FLAG=true
      shift
      ;;
    --all-where-deployed)
      ALL_WHERE_DEPLOYED=true
      shift
      ;;
    -*)
      error "unknown option: $1"
      printProposeContractUsage
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
    printProposeContractUsage
    exit 1
  fi
  if [[ "$ALL_WHERE_DEPLOYED" == "true" && ${#TARGET_NETWORKS[@]} -gt 0 ]]; then
    error "--all-where-deployed cannot be combined with an explicit network list"
    printProposeContractUsage
    exit 1
  fi
  if [[ "$ALL_WHERE_DEPLOYED" != "true" && ${#TARGET_NETWORKS[@]} -eq 0 ]]; then
    error "missing NETWORK argument(s) (or use --all-where-deployed)"
    printProposeContractUsage
    exit 1
  fi

  local TARGET_ENVIRONMENT
  if [[ "$PRODUCTION_FLAG" == "true" ]]; then
    if [[ "$PRODUCTION" != "true" ]]; then
      error "--production requires PRODUCTION=true in .env"
      exit 1
    fi
    TARGET_ENVIRONMENT="production"
  else
    if [[ "$PRODUCTION" == "true" ]]; then
      error "PRODUCTION=true is set in .env but --production was not passed - pass --production to propose to production or set PRODUCTION=false for staging"
      exit 1
    fi
    TARGET_ENVIRONMENT="staging"
  fi

  if [[ "$TARGET_ENVIRONMENT" == "production" && "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" == "true" ]]; then
    error "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true would bypass the Safe — aborting propose-only run"
    exit 1
  fi

  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"

  if [[ "$ALL_WHERE_DEPLOYED" == "true" ]]; then
    while IFS= read -r NETWORK; do
      [[ -n "$NETWORK" ]] && TARGET_NETWORKS+=("$NETWORK")
    done < <(resolveNetworksWhereDeployed "$TARGET_CONTRACT" "$TARGET_ENVIRONMENT")
    if [[ ${#TARGET_NETWORKS[@]} -eq 0 ]]; then
      error "no networks found with $TARGET_CONTRACT in deployments logs ($TARGET_ENVIRONMENT)"
      exit 1
    fi
  fi

  local DEDUPED_NETWORKS=()
  local TARGET_NETWORK
  local KNOWN_NETWORK
  local IS_DUPLICATE
  for TARGET_NETWORK in "${TARGET_NETWORKS[@]}"; do
    IS_DUPLICATE=false
    for KNOWN_NETWORK in "${DEDUPED_NETWORKS[@]:-}"; do
      if [[ "$KNOWN_NETWORK" == "$TARGET_NETWORK" ]]; then
        IS_DUPLICATE=true
        break
      fi
    done
    if [[ "$IS_DUPLICATE" == "true" ]]; then
      warning "duplicate network '$TARGET_NETWORK' in arguments - ignoring the repeat"
      continue
    fi
    if ! jq -e --arg TARGET_NETWORK "$TARGET_NETWORK" 'has($TARGET_NETWORK)' "$NETWORKS_JSON_FILE_PATH" >/dev/null; then
      error "unknown network '$TARGET_NETWORK' (not found in $NETWORKS_JSON_FILE_PATH)"
      exit 1
    fi
    if isTronNetwork "$TARGET_NETWORK"; then
      if [[ "$ALL_WHERE_DEPLOYED" == "true" ]]; then
        warning "skipping Tron network '$TARGET_NETWORK' — use the Tron propose path instead"
        continue
      fi
      error "network '$TARGET_NETWORK' is Tron — use the Tron propose path instead"
      exit 1
    fi
    DEDUPED_NETWORKS+=("$TARGET_NETWORK")
  done
  if [[ ${#DEDUPED_NETWORKS[@]} -eq 0 ]]; then
    error "no eligible networks remain after filtering"
    exit 1
  fi
  TARGET_NETWORKS=("${DEDUPED_NETWORKS[@]}")

  local TARGET_VERSION
  TARGET_VERSION=$(getCurrentContractVersion "$TARGET_CONTRACT") || {
    error "could not determine version of contract '$TARGET_CONTRACT' - check the contract name"
    exit 1
  }

  MAX_CONCURRENT_JOBS="${MAX_CONCURRENT_JOBS:-10}"
  if [[ ! "$MAX_CONCURRENT_JOBS" =~ ^[1-9][0-9]*$ ]]; then
    error "MAX_CONCURRENT_JOBS must be a positive integer (check your .env) - got '$MAX_CONCURRENT_JOBS'"
    exit 1
  fi

  local NEEDS_WHITELIST=false
  if ! isFacetContractName "$TARGET_CONTRACT" && isDiamondCalledPeriphery "$TARGET_CONTRACT"; then
    NEEDS_WHITELIST=true
  fi

  local KIND="facet"
  isFacetContractName "$TARGET_CONTRACT" || KIND="periphery"

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
    error "cannot resolve an EVM-version group for: ${INVALID_NETWORKS[*]}"
    exit 1
  fi

  echo ""
  echo "[info] proposing $TARGET_CONTRACT v$TARGET_VERSION ($KIND) registration on ${#TARGET_NETWORKS[@]} network(s) in $TARGET_ENVIRONMENT"
  echo "[info] london (${#LONDON_NETWORKS[@]}): ${LONDON_NETWORKS[*]:-none}"
  echo "[info] cancun (${#CANCUN_NETWORKS[@]}): ${CANCUN_NETWORKS[*]:-none}"
  echo "[info] zkevm  (${#ZKEVM_NETWORKS[@]}): ${ZKEVM_NETWORKS[*]:-none}"
  [[ "$NEEDS_WHITELIST" == "true" ]] && echo "[info] diamond-called periphery — will sync allowlist on OK networks after registration"
  echo "[info] up to $MAX_CONCURRENT_JOBS concurrent network(s) per EVM group; zkEVM runs sequentially"

  local RESULT_DIR
  if ! RESULT_DIR=$(mktemp -d); then
    error "failed to create worker result directory - aborting"
    exit 1
  fi

  backupFoundryToml || {
    error "failed to back up foundry.toml - aborting"
    rm -rf "$RESULT_DIR"
    exit 1
  }
  # Do not delete RESULT_DIR in EXIT — summary reads it after waves; clean up explicitly.
  trap 'restoreFoundryToml 2>/dev/null' EXIT

  if [[ ${#LONDON_NETWORKS[@]} -gt 0 ]]; then
    echo ""
    echo "[info] === london group ==="
    if ! updateFoundryTomlForGroup "$GROUP_LONDON" true; then
      error "london group build failed"
      rm -rf "$RESULT_DIR"
      exit 1
    fi
    launchProposeWave "$MAX_CONCURRENT_JOBS" "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT" "$RESULT_DIR" "${LONDON_NETWORKS[@]}"
  fi

  if [[ ${#CANCUN_NETWORKS[@]} -gt 0 ]]; then
    echo ""
    echo "[info] === cancun group ==="
    if ! updateFoundryTomlForGroup "$GROUP_CANCUN" true; then
      error "cancun group build failed"
      rm -rf "$RESULT_DIR"
      exit 1
    fi
    launchProposeWave "$MAX_CONCURRENT_JOBS" "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT" "$RESULT_DIR" "${CANCUN_NETWORKS[@]}"
  fi

  if [[ ${#ZKEVM_NETWORKS[@]} -gt 0 ]]; then
    echo ""
    echo "[info] === zkevm group ==="
    if ! install_foundry_zksync; then
      error "failed to install foundry-zksync"
      rm -rf "$RESULT_DIR"
      exit 1
    fi
    if ! FOUNDRY_PROFILE=zksync ./foundry-zksync/forge build --zksync --skip test; then
      error "zksync build failed"
      rm -rf "$RESULT_DIR"
      exit 1
    fi
    launchProposeWave 1 "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT" "$RESULT_DIR" "${ZKEVM_NETWORKS[@]}"
  fi

  local FAILED_NETWORKS=()
  local SUCCEEDED_NETWORKS=()
  local SKIPPED_NETWORKS=()
  local OUTCOME
  for TARGET_NETWORK in "${TARGET_NETWORKS[@]}"; do
    OUTCOME=$(cat "$RESULT_DIR/$TARGET_NETWORK" 2>/dev/null || echo "FAIL:missing-result")
    case "$OUTCOME" in
    OK)
      SUCCEEDED_NETWORKS+=("$TARGET_NETWORK")
      ;;
    SKIP | SKIP:*)
      SKIPPED_NETWORKS+=("$TARGET_NETWORK ($OUTCOME)")
      ;;
    *)
      FAILED_NETWORKS+=("$TARGET_NETWORK ($OUTCOME)")
      ;;
    esac
  done

  echo ""
  echo "[info] ==================== SUMMARY ===================="
  echo "[info] contract:    $TARGET_CONTRACT v$TARGET_VERSION ($KIND)"
  echo "[info] environment: $TARGET_ENVIRONMENT"
  local DEPLOYED_ADDRESS
  for TARGET_NETWORK in "${SUCCEEDED_NETWORKS[@]:-}"; do
    if [[ -n "$TARGET_NETWORK" ]]; then
      DEPLOYED_ADDRESS=$(getContractAddressFromDeploymentLogs "$TARGET_NETWORK" "$TARGET_ENVIRONMENT" "$TARGET_CONTRACT") || DEPLOYED_ADDRESS="?"
      success "$TARGET_NETWORK: OK ($DEPLOYED_ADDRESS)"
    fi
  done
  for TARGET_NETWORK in "${SKIPPED_NETWORKS[@]:-}"; do
    [[ -n "$TARGET_NETWORK" ]] && warning "$TARGET_NETWORK: SKIP"
  done
  for TARGET_NETWORK in "${FAILED_NETWORKS[@]:-}"; do
    [[ -n "$TARGET_NETWORK" ]] && error "$TARGET_NETWORK: FAIL"
  done

  if [[ "$NEEDS_WHITELIST" == "true" && ${#SUCCEEDED_NETWORKS[@]} -gt 0 ]]; then
    echo ""
    echo "[info] syncing diamond-called periphery allowlist on OK networks..."
    local WL_ARGS=("${SUCCEEDED_NETWORKS[@]}")
    if [[ "$PRODUCTION_FLAG" == "true" ]]; then
      WL_ARGS+=(--production)
    fi
    if ! ./script/tasks/syncWhitelistToNetworks.sh "${WL_ARGS[@]}"; then
      error "allowlist sync finished with failures"
      rm -rf "$RESULT_DIR"
      exit 1
    fi
  fi

  rm -rf "$RESULT_DIR"
  trap - EXIT
  restoreFoundryToml 2>/dev/null

  if [[ ${#FAILED_NETWORKS[@]} -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ ! -f "script/helperFunctions.sh" ]]; then
    echo "[error] this script must be run from the repository root (e.g. ./script/tasks/proposeContractToNetworks.sh ...)"
    exit 1
  fi

  if [[ ! -f ".env" ]]; then
    echo "[error] .env file not found in repository root - copy .env.example to .env and configure it"
    exit 1
  fi

  # shellcheck disable=SC1091
  source .env
  # shellcheck disable=SC1091
  source script/helperFunctions.sh
  # shellcheck disable=SC1091
  source script/deploy/resources/deployGroupingHelpers.sh
  # shellcheck disable=SC1091
  source script/tasks/diamondUpdateFacet.sh
  # shellcheck disable=SC1091
  source script/tasks/diamondUpdatePeriphery.sh

  proposeContractToNetworks "$@"
fi
