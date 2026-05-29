# Pauser Funds vs. pauseDiamond Cost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pauser-wallet funding driven by the real per-chain `pauseDiamond()` cost, and add a read-only cross-chain audit of whether each pauser wallet can afford a pause.

**Architecture:** One shared bash primitive (`estimatePauseCost`) in `script/helperFunctions.sh` computes `gasEstimate × gasPrice` for a single `pauseDiamond()`. Two consumers apply their own multiplier: a new read-only audit script (`script/utils/checkPauserFunds.sh`) and the existing new-chain funding step (`deployAllContracts.sh` stage 9).

**Tech Stack:** Bash (5.0+), Foundry `cast`, `jq`, `bc`. EVM networks only. Repo conventions in `.agents/rules/300-bash.md`.

**Spec:** `docs/superpowers/specs/2026-05-29-pauser-funds-vs-pause-cost-design.md`

**Verification reality:** the repo has no bash unit-test harness, so each task verifies with `bash -n`, `shellcheck`, and a live smoke run against real networks (read-only). All commands run from the repo root.

---

## File Structure

- **Modify** `script/helperFunctions.sh` — add `estimatePauseCost` (the shared primitive). Append near other network helpers.
- **Create** `script/utils/checkPauserFunds.sh` — read-only audit, sources `helperFunctions.sh`.
- **Modify** `script/deploy/deployAllContracts.sh` — stage 9 PauserWallet branch only (`:335-339`).

Dependency order: helper → audit script → funding change. Each task is independently committable.

---

## Task 1: Shared helper `estimatePauseCost`

**Files:**

- Modify: `script/helperFunctions.sh` (append the function; placement next to `getRPCUrl`/`getRpcUrlFromNetworksJson` is fine)

- [ ] **Step 1: Add the function**

Append this function to `script/helperFunctions.sh`:

```bash
# estimatePauseCost: Estimate the native-token cost (in wei) of one pauseDiamond() call.
# Computes gasEstimate × gasPrice for the production LiFiDiamond on NETWORK. EVM only.
#
# Usage: estimatePauseCost NETWORK [PAUSER_ADDRESS]
#   NETWORK        - Network key from networks.json
#   PAUSER_ADDRESS - Optional: address used as --from for the gas estimate.
#                    Defaults to .pauserWallet in config/global.json
#
# Returns:
#   exit 0 - echoes the single-pause cost in wei (decimal) to stdout
#   exit 2 - diamond is already paused (pauseDiamond() reverts DiamondIsPaused)
#   exit 1 - any other failure (reason on stderr): RPC error, missing diamond,
#            unauthorized --from, unparseable gas/price
# Example: COST=$(estimatePauseCost "mainnet") || echo "estimate failed (rc=$?)"
function estimatePauseCost() {
  local NETWORK="$1"
  local PAUSER_ADDRESS="${2:-}"
  # DiamondIsPaused() selector; matched in cast's revert output (cast lacks the ABI here,
  # so it surfaces the raw selector rather than the decoded name).
  local PAUSED_SELECTOR="0x0149422e"

  if [[ -z "$NETWORK" ]]; then
    error "estimatePauseCost: NETWORK argument is required"
    return 1
  fi

  # Resolve RPC: prefer the ETH_NODE_URI_* env var (used everywhere else); fall back to the
  # rpcUrl in networks.json so a cross-chain sweep works without every env var set.
  local RPC_URL
  if ! RPC_URL=$(getRPCUrl "$NETWORK" 2>/dev/null); then
    if ! RPC_URL=$(getRpcUrlFromNetworksJson "$NETWORK"); then
      error "estimatePauseCost: could not resolve an RPC URL for $NETWORK"
      return 1
    fi
  fi

  local DIAMOND_ADDRESS
  if ! DIAMOND_ADDRESS=$(getContractAddressFromDeploymentLogs "$NETWORK" "production" "LiFiDiamond"); then
    error "estimatePauseCost: no LiFiDiamond address in production deploy log for $NETWORK"
    return 1
  fi

  if [[ -z "$PAUSER_ADDRESS" ]]; then
    PAUSER_ADDRESS=$(getValueFromJSONFile "./config/global.json" "pauserWallet")
    if [[ -z "$PAUSER_ADDRESS" ]]; then
      error "estimatePauseCost: could not read pauserWallet from config/global.json"
      return 1
    fi
  fi

  local GAS_ESTIMATE
  if ! GAS_ESTIMATE=$(cast estimate "$DIAMOND_ADDRESS" "pauseDiamond()" --from "$PAUSER_ADDRESS" --rpc-url "$RPC_URL" 2>&1); then
    if [[ "$GAS_ESTIMATE" == *"$PAUSED_SELECTOR"* || "$GAS_ESTIMATE" == *"DiamondIsPaused"* ]]; then
      return 2
    fi
    error "estimatePauseCost: cast estimate failed for $NETWORK: $GAS_ESTIMATE"
    return 1
  fi
  if ! [[ "$GAS_ESTIMATE" =~ ^[0-9]+$ ]]; then
    error "estimatePauseCost: unexpected gas estimate for $NETWORK: $GAS_ESTIMATE"
    return 1
  fi

  local GAS_PRICE
  if ! GAS_PRICE=$(cast gas-price --rpc-url "$RPC_URL" 2>&1) || ! [[ "$GAS_PRICE" =~ ^[0-9]+$ ]]; then
    error "estimatePauseCost: could not read gas price for $NETWORK: $GAS_PRICE"
    return 1
  fi

  # wei overflows 64-bit bash arithmetic; use bc for the multiplication
  echo "$GAS_ESTIMATE * $GAS_PRICE" | bc
  return 0
}
```

- [ ] **Step 2: Syntax + lint**

Run:

```bash
bash -n script/helperFunctions.sh
shellcheck script/helperFunctions.sh
```

Expected: `bash -n` exits 0. `shellcheck` introduces no *new* warnings for the added function (the file may have pre-existing warnings; compare against `git stash` baseline if unsure — do not "fix" unrelated lines).

- [ ] **Step 3: Live smoke test (success path)**

Run:

```bash
bash -c 'source script/helperFunctions.sh; estimatePauseCost mainnet; echo "rc=$?"'
```

Expected: a large integer (wei, e.g. ~`1xxxxxxxxxxxxxx`) followed by `rc=0`. If `mainnet`'s env RPC is unset it should still work via the networks.json fallback.

- [ ] **Step 4: Live smoke test (error path)**

Run:

```bash
bash -c 'source script/helperFunctions.sh; estimatePauseCost no-such-network; echo "rc=$?"'
```

Expected: an `error:`-prefixed line on stderr and `rc=1` (no stdout cost).

- [ ] **Step 5: Commit**

```bash
git add script/helperFunctions.sh
git commit -m "feat(EXSC-370): add estimatePauseCost helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Audit script `checkPauserFunds.sh`

**Files:**

- Create: `script/utils/checkPauserFunds.sh`

- [ ] **Step 1: Create the script**

Create `script/utils/checkPauserFunds.sh` with exactly this content:

```bash
#!/bin/bash
#
# checkPauserFunds.sh — audit whether the pauser wallet on each production EVM network can
# afford pauseDiamond(). Read-only: estimates the single-pause cost, reads the pauser
# balance, and reports a ratio + status per network. EVM only (Tron / testnets skipped).
#
# Usage:
#   ./script/utils/checkPauserFunds.sh [NETWORK ...]
#     (no args)   audit all active, non-testnet, non-Tron networks in networks.json
#     NETWORK...  audit only the named networks
#
# Status:  OK (ratio >= 2.5)   WARNING (1 <= ratio < 2.5)   CRITICAL (ratio < 1)
#          PAUSED (already paused)   ERROR (estimate/RPC failed)   SKIP (filtered/no diamond)
# Exit code: 1 if any audited network is CRITICAL, else 0.
#
# Must be run from the repository root.

# NOTE: intentionally no `set -e` — failures are handled per-network so the sweep continues.
set -uo pipefail

function usage() {
  cat <<'EOF'
Usage: ./script/utils/checkPauserFunds.sh [NETWORK ...]
  No args     audit all active, non-testnet, non-Tron networks
  NETWORK...  audit only the named networks
Statuses: OK (>=2.5x)  WARNING (1x-2.5x)  CRITICAL (<1x)  PAUSED  ERROR  SKIP
Exit code 1 if any network is CRITICAL.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f script/helperFunctions.sh ]]; then
  echo "ERROR: run this script from the repository root (script/helperFunctions.sh not found)" >&2
  exit 1
fi
source script/helperFunctions.sh

# 2.5x expressed as 5/2 for integer bc math
readonly WARN_MULT_NUM=5
readonly WARN_MULT_DEN=2

# trimZeros: strip trailing zeros (and a trailing dot) from a decimal string for display.
# Usage: trimZeros DECIMAL_STRING
function trimZeros() {
  printf '%s' "$1" | sed -E 's/([0-9])0+$/\1/; s/\.$//'
}

# resolveRpc: ETH_NODE_URI_* env var first, networks.json rpcUrl as fallback.
function resolveRpc() {
  local NET="$1"
  getRPCUrl "$NET" 2>/dev/null || getRpcUrlFromNetworksJson "$NET"
}

# Build the network list: explicit args, else every key in networks.json.
NETWORKS=()
if [[ $# -gt 0 ]]; then
  NETWORKS=("$@")
else
  while IFS= read -r NET; do
    NETWORKS+=("$NET")
  done < <(getAllNetworksArray)
fi
if [[ ${#NETWORKS[@]} -eq 0 ]]; then
  error "no networks to audit"
  exit 1
fi

PAUSER=$(getValueFromJSONFile "./config/global.json" "pauserWallet")
if [[ -z "$PAUSER" ]]; then
  error "could not read pauserWallet from config/global.json"
  exit 1
fi

# Each entry: "SORTKEY|formatted row". SORTKEY orders the table:
#   -1 = ERROR (top, needs attention), then ratio ascending, then PAUSED, then SKIP.
ROWS=()
HAS_CRITICAL=0

# row formatting (shared widths so columns align)
ROW_FMT='%-22s %18s %18s %18s %8s %-9s'
function plainRow() { printf "$ROW_FMT" "$1" "-" "-" "-" "-" "$2"; }

for NETWORK in "${NETWORKS[@]}"; do
  if isTestnetNetwork "$NETWORK" 2>/dev/null || isTronNetwork "$NETWORK" 2>/dev/null; then
    ROWS+=("999999|$(plainRow "$NETWORK" "SKIP")")
    continue
  fi
  STATUS_FIELD=$(getValueFromJSONFile "./config/networks.json" "${NETWORK}.status")
  if [[ "$STATUS_FIELD" != "active" ]]; then
    ROWS+=("999999|$(plainRow "$NETWORK" "SKIP")")
    continue
  fi

  SYMBOL=$(getValueFromJSONFile "./config/networks.json" "${NETWORK}.nativeCurrency")
  [[ -z "$SYMBOL" ]] && SYMBOL="?"

  COST=$(estimatePauseCost "$NETWORK")
  RC=$?
  if [[ $RC -eq 2 ]]; then
    ROWS+=("999998|$(plainRow "$NETWORK" "PAUSED")")
    continue
  fi
  if [[ $RC -ne 0 || ! "$COST" =~ ^[0-9]+$ || "$COST" == "0" ]]; then
    ROWS+=("-1|$(plainRow "$NETWORK" "ERROR")")
    continue
  fi

  RPC_URL=$(resolveRpc "$NETWORK")
  BALANCE=$(cast balance "$PAUSER" --rpc-url "$RPC_URL" 2>/dev/null)
  if ! [[ "$BALANCE" =~ ^[0-9]+$ ]]; then
    ROWS+=("-1|$(plainRow "$NETWORK" "ERROR")")
    continue
  fi

  REQUIRED=$(echo "$COST * $WARN_MULT_NUM / $WARN_MULT_DEN" | bc)
  RATIO=$(echo "scale=2; $BALANCE / $COST" | bc)
  [[ "$RATIO" == .* ]] && RATIO="0$RATIO"   # bc prints ".40"; make it "0.40"

  if [[ $(echo "$BALANCE < $COST" | bc) -eq 1 ]]; then
    STATUS="CRITICAL"
    HAS_CRITICAL=1
  elif [[ $(echo "$BALANCE < $REQUIRED" | bc) -eq 1 ]]; then
    STATUS="WARNING"
  else
    STATUS="OK"
  fi

  COST_N=$(trimZeros "$(cast from-wei "$COST")")
  REQ_N=$(trimZeros "$(cast from-wei "$REQUIRED")")
  BAL_N=$(trimZeros "$(cast from-wei "$BALANCE")")

  ROWS+=("$RATIO|$(printf "$ROW_FMT" \
    "$NETWORK" "${COST_N} ${SYMBOL}" "${REQ_N} ${SYMBOL}" "${BAL_N} ${SYMBOL}" "$RATIO" "$STATUS")")
done

# header + sorted rows (general-numeric sort on SORTKEY, then strip the key)
printf "$ROW_FMT\n" "NETWORK" "COST(1x)" "REQUIRED(2.5x)" "BALANCE" "RATIO" "STATUS"
printf '%s\n' "${ROWS[@]}" | sort -t'|' -k1,1g | cut -d'|' -f2-

if [[ $HAS_CRITICAL -eq 1 ]]; then
  echo ""
  warning "one or more networks are CRITICAL (pauser cannot afford a single pause)"
  exit 1
fi
exit 0
```

- [ ] **Step 2: Make executable + syntax + lint**

Run:

```bash
chmod +x script/utils/checkPauserFunds.sh
bash -n script/utils/checkPauserFunds.sh
shellcheck script/utils/checkPauserFunds.sh
```

Expected: `bash -n` exits 0. `shellcheck` clean. Note: `printf "$ROW_FMT"` will raise SC2059 (variable in format string); this is intentional for a fixed internal format constant — add `# shellcheck disable=SC2059` immediately above each of the three `printf "$ROW_FMT"` uses (the two in functions and the header), with a short justification comment.

- [ ] **Step 3: Help text check**

Run:

```bash
./script/utils/checkPauserFunds.sh --help
```

Expected: prints the usage block, exits 0, makes zero RPC calls.

- [ ] **Step 4: Live smoke test (explicit networks)**

Run:

```bash
./script/utils/checkPauserFunds.sh mainnet arbitrum
```

Expected: a 3-line aligned table (header + mainnet + arbitrum) with plausible native amounts, a `RATIO` like `12.34`, and a status of `OK`/`WARNING`/`CRITICAL`. Exit code is `0` unless a wallet is genuinely under-funded.

- [ ] **Step 5: Live smoke test (full sweep)**

Run:

```bash
./script/utils/checkPauserFunds.sh; echo "exit=$?"
```

Expected: the full table sorted worst-ratio-first, testnets/Tron/inactive shown as `SKIP`, any unreachable chain as `ERROR`. This is the audit deliverable — note any CRITICAL/WARNING networks for the PR description.

- [ ] **Step 6: Commit**

```bash
git add script/utils/checkPauserFunds.sh
git commit -m "feat(EXSC-370): add checkPauserFunds.sh cross-chain audit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Computed funding default in `deployAllContracts.sh` stage 9

**Files:**

- Modify: `script/deploy/deployAllContracts.sh:335-339` (PauserWallet branch inside Stage 9)

- [ ] **Step 1: Replace the hardcoded default**

Find this block (the PauserWallet funding branch, around line 335):

```bash
    if [[ "$BALANCE" == "0" ]]; then
      local DEFAULT_FUND_AMOUNT=2000000000000000
      echo "PauserWallet balance is 0. Enter wei to send to $PAUSER_WALLET_ADDRESS (edit or press Enter to confirm default):"
      FUNDING_AMOUNT=$(gum input --value "$DEFAULT_FUND_AMOUNT" --placeholder "wei amount" --width 40)
      FUNDING_AMOUNT="${FUNDING_AMOUNT:-$DEFAULT_FUND_AMOUNT}"
```

Replace it with:

```bash
    if [[ "$BALANCE" == "0" ]]; then
      # Default funding = 2.5x the real per-chain cost of one pauseDiamond() (~2 pauses +
      # buffer). Fall back to a flat amount if estimation fails so a deploy is never blocked
      # on a transient RPC/estimate error.
      local FALLBACK_FUND_AMOUNT=2000000000000000
      local DEFAULT_FUND_AMOUNT
      local SINGLE_PAUSE_COST
      if SINGLE_PAUSE_COST=$(estimatePauseCost "$NETWORK" "$PAUSER_WALLET_ADDRESS") && [[ "$SINGLE_PAUSE_COST" =~ ^[0-9]+$ ]]; then
        DEFAULT_FUND_AMOUNT=$(echo "$SINGLE_PAUSE_COST * 5 / 2" | bc)
        echo "Computed PauserWallet funding default: $DEFAULT_FUND_AMOUNT wei (2.5x single pauseDiamond cost of $SINGLE_PAUSE_COST wei)"
      else
        DEFAULT_FUND_AMOUNT=$FALLBACK_FUND_AMOUNT
        warning "could not estimate pause cost for $NETWORK; falling back to default $DEFAULT_FUND_AMOUNT wei"
      fi
      echo "PauserWallet balance is 0. Enter wei to send to $PAUSER_WALLET_ADDRESS (edit or press Enter to confirm default):"
      FUNDING_AMOUNT=$(gum input --value "$DEFAULT_FUND_AMOUNT" --placeholder "wei amount" --width 40)
      FUNDING_AMOUNT="${FUNDING_AMOUNT:-$DEFAULT_FUND_AMOUNT}"
```

(The DevWallet branch below it is unchanged.)

- [ ] **Step 2: Syntax + lint**

Run:

```bash
bash -n script/deploy/deployAllContracts.sh
shellcheck script/deploy/deployAllContracts.sh
```

Expected: `bash -n` exits 0. `shellcheck` introduces no new warnings vs. the pre-edit baseline.

- [ ] **Step 3: Static verification of the edit**

Run:

```bash
grep -n "estimatePauseCost\|SINGLE_PAUSE_COST\|FALLBACK_FUND_AMOUNT" script/deploy/deployAllContracts.sh
```

Expected: shows the new lines inside Stage 9, and confirms `2000000000000000` now appears only as `FALLBACK_FUND_AMOUNT` in the PauserWallet branch (the DevWallet branch still has its own `DEFAULT_FUND_AMOUNT=2000000000000000`, which is correct and untouched).

> Stage 9 cannot be exercised without a real deploy; verification here is syntax + lint + static review. The `estimatePauseCost` success/error paths it depends on are already smoke-tested in Task 1.

- [ ] **Step 4: Commit**

```bash
git add script/deploy/deployAllContracts.sh
git commit -m "feat(EXSC-370): compute PauserWallet funding from pause cost

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `bash -n` clean on all three files.
- [ ] `shellcheck` clean (or only justified, annotated disables) on all three files.
- [ ] `checkPauserFunds.sh mainnet arbitrum` produces a correct table.
- [ ] Full-sweep audit run captured for the PR description (list any CRITICAL/WARNING networks — this is the ticket's core deliverable).
- [ ] Run `/pr-ready` (local CodeRabbit) and resolve findings before opening the PR.

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `estimatePauseCost` primitive (1× cost, exit 0/1/2, revert handling) | Task 1 |
| EVM-only / skip Tron + testnets | Task 2 (filters) + spec scope |
| `checkPauserFunds.sh` two-tier status, ratio, sorted table, exit code | Task 2 |
| Stage-9 funding default = 2.5× computed, `== 0` trigger kept, fallback | Task 3 |
| Shared helper used by both consumers (DRY) | Task 1 consumed by Tasks 2 & 3 |
