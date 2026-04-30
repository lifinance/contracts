#!/bin/bash
#
# Deploy smoke test driver.
#
# Runs the full deployAllContracts pipeline against a local anvil chain so
# CI can catch regressions in the deploy script (missing sources, broken
# forge scripts, config drift) before they hit a real network. Designed to
# be invoked unattended from a workflow:
#
#   1. anvil --mnemonic "$MNEMONIC" --silent &
#   2. bash script/deploy/_smokeDeploy.sh
#   3. bun script/deploy/healthCheck.ts --network localanvil --environment staging
#
# Two workarounds make deployAllContracts runnable without a human:
#   - gum is stubbed so the start-stage prompt auto-picks "1)" and the script
#     runs every stage from the top.
#   - The pauser wallet is pre-funded so stage 9 skips its `read` prompt for
#     a funding amount.
#
# Requirements: anvil, cast, jq, bun, gum on PATH; a Mongo instance reachable
# at MONGODB_URI; node_modules populated via `bun install --frozen-lockfile`.

set -euo pipefail

NETWORK=localanvil
ENVIRONMENT=staging
RPC_URL=http://localhost:8545

# Load .env so PRIVATE_KEY_ANVIL, MNEMONIC, MONGODB_URI, etc. are available
# even when the caller didn't pre-source. deployAllContracts.sh re-sources
# .env on entry, so this is harmless overlap.
set -a; source .env; set +a

# 1. Pre-fund pauser wallet so stage 9 skips its `read` prompt
PAUSER=$(jq -r '.pauserWallet // empty' config/global.json)
[[ -n "$PAUSER" ]] || { echo "pauserWallet missing in config/global.json" >&2; exit 1; }
cast send --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY_ANVIL" --value 1ether "$PAUSER" >/dev/null

# 2. Mock gum so the stage-selection prompt auto-picks "1)"
gum() {
if [[ "${1:-}" == "choose" ]]; then
    echo "1) Initial setup and CREATE3Factory deployment"
else
    command gum "$@"
fi
}
export -f gum

# 3. Drive the real deploy script.
# deployAllContracts and its helpers handle errors via explicit checkFailure
# and depend on `VAR=$(fn)` returning non-zero without aborting (e.g. the
# benign "no Mongo record" path in findContractInMasterLog). Disable -e/-u
# before invoking so that contract is preserved.
set +eu
source script/deploy/deployAllContracts.sh
deployAllContracts "$NETWORK" "$ENVIRONMENT"
