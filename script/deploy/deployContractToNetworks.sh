#!/bin/bash

# deployContractToNetworks.sh
#
# Non-interactive equivalent of scriptMaster.sh use case 1 ("Deploy one specific
# contract to one network"), repeated over multiple networks in one invocation.
# Deploys the contract and (by default) registers it in the diamond:
#   - facets:    deploy + Update<Facet> script (Safe proposal in production)
#   - periphery: deploy + diamondUpdatePeriphery
#
# Note: no `set -euo pipefail` on purpose - the sourced deploy framework
# (helperFunctions.sh, deploySingleContract.sh, ...) relies on `$?` checks and
# retry loops that strict mode would abort (same as scriptMaster.sh).

function printUsage() {
  cat <<'EOF'
Usage: ./script/deploy/deployContractToNetworks.sh CONTRACT NETWORK [NETWORK...] [OPTIONS]

Deploys CONTRACT to each NETWORK and registers it in the diamond.
Same flow as scriptMaster.sh use case 1, without interactive prompts.

Arguments:
  CONTRACT             contract name (e.g. MayanFacet, ReceiverChainflip)
  NETWORK              one or more network names from config/networks.json

Options:
  --production         deploy to production (also requires PRODUCTION=true in .env)
  --diamond NAME       diamond to update: LiFiDiamond (default) or LiFiDiamondImmutable
  --no-diamond-update  deploy only, do not register in any diamond
  -h, --help           show this help

Examples:
  ./script/deploy/deployContractToNetworks.sh MayanFacet arbitrum base optimism
  ./script/deploy/deployContractToNetworks.sh RelayFacet polygon --production
EOF
}

function deployContractToNetworks() {
  trap 'cleanupBackgroundJobs' SIGINT

  local CONTRACT=""
  local DIAMOND_CONTRACT_NAME="LiFiDiamond"
  local UPDATE_DIAMOND=true
  local PRODUCTION_FLAG=false
  local NETWORKS=()

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
    --diamond)
      if [[ -z "${2:-}" || "${2:-}" == -* ]]; then
        error "--diamond requires a value (LiFiDiamond or LiFiDiamondImmutable)"
        exit 1
      fi
      DIAMOND_CONTRACT_NAME="$2"
      shift 2
      ;;
    --no-diamond-update)
      UPDATE_DIAMOND=false
      shift
      ;;
    -*)
      error "unknown option: $1"
      printUsage
      exit 1
      ;;
    *)
      if [[ -z "$CONTRACT" ]]; then
        CONTRACT="$1"
      else
        NETWORKS+=("$1")
      fi
      shift
      ;;
    esac
  done

  if [[ -z "$CONTRACT" ]]; then
    error "missing CONTRACT argument"
    printUsage
    exit 1
  fi
  if [[ ${#NETWORKS[@]} -eq 0 ]]; then
    error "missing NETWORK argument(s)"
    printUsage
    exit 1
  fi
  if [[ "$DIAMOND_CONTRACT_NAME" != "LiFiDiamond" && "$DIAMOND_CONTRACT_NAME" != "LiFiDiamondImmutable" ]]; then
    error "invalid --diamond value: '$DIAMOND_CONTRACT_NAME' (must be LiFiDiamond or LiFiDiamondImmutable)"
    exit 1
  fi

  # resolve environment: .env PRODUCTION and --production must agree, replacing
  # scriptMaster's interactive "last chance" prompt with a double opt-in
  local ENVIRONMENT
  if [[ "$PRODUCTION_FLAG" == "true" ]]; then
    if [[ "$PRODUCTION" != "true" ]]; then
      error "--production requires PRODUCTION=true in .env"
      exit 1
    fi
    ENVIRONMENT="production"
  else
    if [[ "$PRODUCTION" == "true" ]]; then
      error "PRODUCTION=true is set in .env but --production was not passed - pass --production to deploy to production or set PRODUCTION=false for staging"
      exit 1
    fi
    ENVIRONMENT="staging"
  fi

  if [[ "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" == "true" ]]; then
    warning "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND is set to true (send directly to diamond; use only for new production networks before ownership transfer)."
  fi

  # validate all networks against networks.json before deploying anything
  checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
  local NETWORK
  for NETWORK in "${NETWORKS[@]}"; do
    if ! jq -e --arg NETWORK "$NETWORK" 'has($NETWORK)' "$NETWORKS_JSON_FILE_PATH" >/dev/null; then
      error "unknown network '$NETWORK' (not found in $NETWORKS_JSON_FILE_PATH)"
      exit 1
    fi
  done

  # validate contract name + resolve current version
  local VERSION
  VERSION=$(getCurrentContractVersion "$CONTRACT") || {
    error "could not determine version of contract '$CONTRACT' - check the contract name"
    exit 1
  }

  if [[ "$COMPILE_ON_STARTUP" == "true" ]]; then
    echo "[info] compiling contracts"
    forge build
  fi

  echo ""
  echo "[info] deploying $CONTRACT v$VERSION to ${#NETWORKS[@]} network(s) in $ENVIRONMENT environment: ${NETWORKS[*]}"
  echo "[info] deployer address: $(getDeployerAddress "" "$ENVIRONMENT")"

  local FAILED_NETWORKS=()
  local SUCCEEDED_NETWORKS=()
  local BALANCE

  for NETWORK in "${NETWORKS[@]}"; do
    echo ""
    echo "[info] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>> now deploying $CONTRACT to $NETWORK..."

    if ! checkRequiredVariablesInDotEnv "$NETWORK"; then
      warning "missing required .env variables for $NETWORK - skipping this network"
      FAILED_NETWORKS+=("$NETWORK")
      continue
    fi

    BALANCE=$(getDeployerBalance "$NETWORK" "$ENVIRONMENT")
    echo "[info] deployer wallet balance on $NETWORK: $BALANCE"

    local DEPLOY_RC
    if [[ "$UPDATE_DIAMOND" == "true" ]]; then
      deployAndAddContractToDiamond "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$DIAMOND_CONTRACT_NAME" "$VERSION"
      DEPLOY_RC=$?
    else
      deploySingleContract "$CONTRACT" "$NETWORK" "$ENVIRONMENT" "$VERSION" false
      DEPLOY_RC=$?
    fi

    if [[ $DEPLOY_RC -eq 0 ]]; then
      SUCCEEDED_NETWORKS+=("$NETWORK")
      echo "[info] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< network $NETWORK done"
    else
      FAILED_NETWORKS+=("$NETWORK")
      warning "<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< network $NETWORK FAILED"
    fi
  done

  echo ""
  echo "[info] ==================== SUMMARY ===================="
  echo "[info] contract:    $CONTRACT v$VERSION"
  echo "[info] environment: $ENVIRONMENT"
  local DEPLOYED_ADDRESS
  for NETWORK in "${SUCCEEDED_NETWORKS[@]:-}"; do
    if [[ -n "$NETWORK" ]]; then
      DEPLOYED_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "$ENVIRONMENT" "$CONTRACT") || DEPLOYED_ADDRESS="address not found in deployment log"
      success "$NETWORK: OK ($DEPLOYED_ADDRESS)"
    fi
  done
  for NETWORK in "${FAILED_NETWORKS[@]:-}"; do
    [[ -n "$NETWORK" ]] && error "$NETWORK: FAILED"
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
  [ -f "$TASK_SCRIPT" ] && source "$TASK_SCRIPT"
done

deployContractToNetworks "$@"
