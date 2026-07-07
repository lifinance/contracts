#!/bin/bash

# syncWhitelistToNetworks.sh
#
# Non-interactive equivalent of scriptMaster.sh use case 5 with
# diamondSyncWhitelist selected, for an explicit list of networks.
# Syncs the granular contract/selector whitelist from config/whitelist.json
# onto each network's LiFiDiamond (Safe proposal in production, direct send
# in staging). After a production sync, diamondSyncWhitelist automatically
# syncs staging on the same networks as well.
#
# All networks are passed to diamondSyncWhitelist in one call, so the
# function's built-in parallelism (MAX_CONCURRENT_JOBS) and failure summary
# apply unchanged.
#
# Note: no `set -euo pipefail` on purpose - the sourced framework
# (helperFunctions.sh, diamondSyncWhitelist.sh) relies on `$?` checks and
# retry loops that strict mode would abort (same as scriptMaster.sh).

# unique name: this file is auto-sourced by scriptMaster.sh and
# deployContractToNetworks.sh alongside other scripts that define printUsage
function printSyncWhitelistUsage() {
  cat <<'EOF'
Usage: ./script/tasks/syncWhitelistToNetworks.sh NETWORK [NETWORK...] [OPTIONS]
       ./script/tasks/syncWhitelistToNetworks.sh --all [OPTIONS]

Syncs the whitelist (config/whitelist.json) onto each NETWORK's LiFiDiamond.
Same flow as scriptMaster.sh use case 5 > diamondSyncWhitelist.sh, without
interactive prompts. In production the changes are proposed to each chain's
Safe; in staging they are sent directly. A production run also syncs staging
on the same networks afterwards (built-in diamondSyncWhitelist behavior).

Arguments:
  NETWORK              one or more network names from config/networks.json

Options:
  --all                sync all (non-excluded) networks instead of an explicit list
  --production         sync production (also requires PRODUCTION=true in .env)
  -h, --help           show this help

Examples:
  ./script/tasks/syncWhitelistToNetworks.sh arbitrum base mainnet --production
  ./script/tasks/syncWhitelistToNetworks.sh polygon
  ./script/tasks/syncWhitelistToNetworks.sh --all --production
EOF
}

function syncWhitelistToNetworks() {
  # TARGET_-prefixed names are deliberate: the sourced framework assigns generic
  # names (NETWORK, ENVIRONMENT, NETWORKS, ...) without 'local', which would
  # clobber ours mid-run
  local PRODUCTION_FLAG=false
  local ALL_FLAG=false
  local TARGET_NETWORKS=()

  # scriptMaster's "Execute a script" use case calls tasks as <fn> "" <env>;
  # this wrapper is CLI-only and must not misparse that calling convention
  if [[ $# -ge 1 && -z "$1" ]]; then
    error "this task cannot be run via scriptMaster - run it directly: ./script/tasks/syncWhitelistToNetworks.sh NETWORK [NETWORK...] [--production]"
    exit 1
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
    -h | --help)
      printSyncWhitelistUsage
      exit 0
      ;;
    --production)
      PRODUCTION_FLAG=true
      shift
      ;;
    --all)
      ALL_FLAG=true
      shift
      ;;
    -*)
      error "unknown option: $1"
      printSyncWhitelistUsage
      exit 1
      ;;
    *)
      TARGET_NETWORKS+=("$1")
      shift
      ;;
    esac
  done

  if [[ "$ALL_FLAG" == "true" && ${#TARGET_NETWORKS[@]} -gt 0 ]]; then
    error "--all cannot be combined with an explicit network list"
    printSyncWhitelistUsage
    exit 1
  fi
  if [[ "$ALL_FLAG" != "true" && ${#TARGET_NETWORKS[@]} -eq 0 ]]; then
    error "missing NETWORK argument(s) (or use --all)"
    printSyncWhitelistUsage
    exit 1
  fi

  # ALLOW_TOKEN_CONTRACTS=true triggers an interactive gum confirmation inside
  # diamondSyncWhitelist, which would hang a non-interactive run
  if [[ "$ALLOW_TOKEN_CONTRACTS" == "true" ]]; then
    error "ALLOW_TOKEN_CONTRACTS=true requires an interactive confirmation - unset it or use scriptMaster.sh"
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
      error "PRODUCTION=true is set in .env but --production was not passed - pass --production to sync production or set PRODUCTION=false for staging"
      exit 1
    fi
    TARGET_ENVIRONMENT="staging"
  fi

  if [[ "$SEND_PROPOSALS_DIRECTLY_TO_DIAMOND" == "true" ]]; then
    warning "SEND_PROPOSALS_DIRECTLY_TO_DIAMOND is set to true (send directly to diamond; use only for new production networks before ownership transfer)."
  fi

  local NETWORK_ARG
  if [[ "$ALL_FLAG" == "true" ]]; then
    NETWORK_ARG="All (non-excluded) Networks"
  else
    # validate all networks against networks.json before syncing anything
    checkNetworksJsonFilePath || checkFailure $? "retrieve NETWORKS_JSON_FILE_PATH"
    local TARGET_NETWORK
    for TARGET_NETWORK in "${TARGET_NETWORKS[@]}"; do
      if ! jq -e --arg TARGET_NETWORK "$TARGET_NETWORK" 'has($TARGET_NETWORK)' "$NETWORKS_JSON_FILE_PATH" >/dev/null; then
        error "unknown network '$TARGET_NETWORK' (not found in $NETWORKS_JSON_FILE_PATH)"
        exit 1
      fi
      if ! checkRequiredVariablesInDotEnv "$TARGET_NETWORK"; then
        error "missing required .env variables for network '$TARGET_NETWORK'"
        exit 1
      fi
    done
    NETWORK_ARG="${TARGET_NETWORKS[*]}"
  fi

  echo ""
  echo "[info] syncing whitelist in $TARGET_ENVIRONMENT environment on: $NETWORK_ARG"

  diamondSyncWhitelist "$NETWORK_ARG" "$TARGET_ENVIRONMENT"
  local SYNC_RC=$?

  if [[ $SYNC_RC -ne 0 ]]; then
    error "whitelist sync finished with failures (see summary above)"
    exit 1
  fi
  exit 0
}

# Execute only when run directly. scriptMaster.sh and
# deployContractToNetworks.sh auto-source every script/tasks/*.sh - when
# sourced, this file must only define functions.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  # all framework paths are relative to the repo root
  if [[ ! -f "script/helperFunctions.sh" ]]; then
    echo "[error] this script must be run from the repository root (e.g. ./script/tasks/syncWhitelistToNetworks.sh ...)"
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
  source script/tasks/diamondSyncWhitelist.sh

  syncWhitelistToNetworks "$@"
fi
