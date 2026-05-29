# Pauser-wallet funds vs. `pauseDiamond()` cost

**Ticket:** [EXSC-370](https://linear.app/lifi-linear/issue/EXSC-370/cross-chain-audit-pauser-wallet-funds-vs-pausediamond-cost)
**Date:** 2026-05-29
**Status:** Approved design

## Problem

Rootstock's emergency pause failed (EXSC-369): the pauser wallet held dust — enough to
pass the existing `balance > 0` gate but not enough to actually send `pauseDiamond()`
(~6.7M gas × 0.026 gwei ≈ 0.000175 RBTC required, only 0.000071 RBTC available). The
funding default elsewhere is a flat hardcoded `0.002 ETH`, which is unrelated to the real
per-chain cost of a pause. Two gaps:

1. No way to audit, across chains, whether each pauser wallet can actually afford a pause.
2. New-chain funding seeds a hardcoded amount instead of one derived from the real cost.

## Scope

Three deliverables, sharing one cost-estimation primitive:

- **Read-only check script** — `script/utils/checkPauserFunds.sh` (ticket option (a)).
- **Calculated funding** — `deployAllContracts.sh` stage 9 PauserWallet branch.
- **Shared helper** — `estimatePauseCost` in `script/helperFunctions.sh`.

### Out of scope (deferred to follow-up tickets)

- (b) Recurring GitHub Action + Slack alerting.
- (c) Inline guardrail in `diamondEMERGENCYPauseGitHub.sh`.
- (d) Auto-top-up via the `automate-wallet-dev-fees` flow.
- **Tron / non-EVM** — `cast estimate`/`gas-price`/`balance` are EVM-only; Tron pauser
  coverage is a separate follow-up.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Tron coverage | EVM-only; skip Tron and testnets |
| Check threshold | Two-tier: `ratio < 1` CRITICAL, `1 ≤ ratio < 2.5` WARNING, `≥ 2.5` OK |
| Funding multiplier | `2.5 ×` single-pause cost (≈ 2 pauses + buffer) |
| Funding trigger | Keep existing `balance == 0` trigger; only the amount changes |
| Shared primitive | Returns **single-pause cost (1×)** in wei; callers apply their own multiplier |
| Big-number math | `bc` throughout (wei overflows 64-bit bash arithmetic) |

## Component 1 — `estimatePauseCost` (shared helper)

Lives in `script/helperFunctions.sh`, sourced by both consumers. The single shared primitive.

```
estimatePauseCost NETWORK [PAUSER_ADDRESS]
```

- **NETWORK** — network key from `networks.json`.
- **PAUSER_ADDRESS** — optional `--from` for the estimate. Defaults to
  `getValueFromJSONFile ./config/global.json pauserWallet` (the wallet we hold the key for
  and fund).

Resolution, all via existing helpers:

- RPC: `getRPCUrl "$NETWORK"`
- Diamond: `getContractAddressFromDeploymentLogs "$NETWORK" production LiFiDiamond`
- `GAS = cast estimate "$DIAMOND" "pauseDiamond()" --from "$PAUSER" --rpc-url "$RPC"`
- `PRICE = cast gas-price --rpc-url "$RPC"`
- `COST = GAS * PRICE` (via `bc`)

**Output / exit codes:**

| Exit | Meaning | stdout |
|---|---|---|
| 0 | success | single-pause cost in wei |
| 2 | diamond already paused (`pauseDiamond()` reverts `DiamondIsPaused`) | — |
| 1 | any other failure (RPC down, unauthorized `--from`, missing diamond) | — (reason on stderr) |

**Revert handling:** `pauseDiamond()` is access-controlled and reverts when already paused.
On a failed `cast estimate`, inspect captured stderr: contains `DiamondIsPaused` → exit 2;
otherwise → exit 1 with the message. Mirrors the selector match the pause script already
does (`diamondEMERGENCYPauseGitHub.sh:128`).

**Note:** `eth_estimateGas` for `pauseDiamond()` carries no value, so it does not require
the `--from` wallet to hold a balance — estimation works even on an empty/dust pauser.

Documented with the repo's helper-function doc-comment format (`.agents/rules/300-bash.md`).

## Component 2 — `checkPauserFunds.sh` (read-only audit)

`script/utils/checkPauserFunds.sh`, sources `helperFunctions.sh`.

```
checkPauserFunds.sh [NETWORK ...]    # no args → all production EVM networks
```

**Network selection:** `getAllNetworksArray`, filtered to exclude `isTestnetNetwork`,
`isTronNetwork`, `status != active`, and chains with no native currency
(`nativeCurrency == "N/A"`, e.g. `tempo`, which pays gas in a non-native token — a native
balance vs native gas-cost comparison is meaningless there). Positional args override the
sweep → audit only those networks (still validated against the same filters; a filtered
network named explicitly is reported as `SKIP`).

**Per network:**

1. `COST = estimatePauseCost "$NETWORK"` (handle exit 2 = PAUSED, exit 1 = ERROR).
2. `BALANCE = cast balance "$PAUSER" --rpc-url "$RPC"`.
3. `RATIO = BALANCE / COST` (`bc`, 2 decimals; guard `COST == 0`).
4. Status:
   - `RATIO < 1` → **CRITICAL**
   - `1 ≤ RATIO < 2.5` → **WARNING**
   - `RATIO ≥ 2.5` → **OK**
   - estimate exit 2 → **PAUSED**; exit 1 → **ERROR**; no diamond → **SKIP**

**Output:** one table, **sorted by affordability ascending** (worst first), aligned via
`column -t`:

```
NETWORK · COST(1x, native) · REQUIRED(2.5x, native) · BALANCE(native) · NUM OF PAUSES · STATUS
```

`NUM OF PAUSES = balance ÷ single-pause cost` — i.e. how many `pauseDiamond()` calls the
wallet can fund. Named `NUM OF PAUSES` (not "ratio") so the denominator is unambiguous: it is
relative to the 1× cost, not the 2.5× target. It is the primary signal (unitless, comparable
across chains), displayed via `%g` so extreme over-funding (cheap-gas chains) compacts to
scientific notation; the raw value is still the sort key. Native amounts are rendered to 3
significant figures (`%.3g` on `cast from-wei`) — enough to eyeball funding without 18-digit
noise. Gas and gas-price are intermediate inputs folded into `cost`, not shown as separate
columns — `estimatePauseCost` returns a single wei value, keeping the shared contract minimal
for the funding consumer.

**Presentation:**

- A startup banner and per-network `[i/N] <network>` progress print to **stderr** so a long
  sweep visibly advances; the table and a `PAUSES = …` legend round it out.
- `STATUS` is color-coded (CRITICAL/ERROR red, WARNING yellow, OK green, PAUSED cyan, SKIP
  dim) — applied **after** `column -t` (so escape codes can't skew alignment) and **only when
  stdout is a TTY**, so piped/redirected output stays plain and parseable.
- stdout carries only the table; banner, progress, legend, and the CRITICAL summary go to
  stderr. The exit code (`1` if any CRITICAL) is the machine-readable signal.

**Exit code:** `1` if any network is CRITICAL, else `0`. ERROR/PAUSED/SKIP do not fail the
run. (Lets a future GH Action (b) gate on a clean exit.)

**Execution model:** sequential (~3 RPC calls/chain) for deterministic, sorted output.
Parallelization noted as a future optimization if the full sweep is too slow.

## Component 3 — `deployAllContracts.sh` stage 9 funding

Change **only** the PauserWallet branch (`deployAllContracts.sh:335-339`). DevWallet
funding is untouched (it covers timelock-execution gas, not pause cost).

- Keep the `balance == 0` trigger and the `gum` accept/override prompt.
- Replace `DEFAULT_FUND_AMOUNT=2000000000000000` with:
  - `SINGLE = estimatePauseCost "$NETWORK" "$PAUSER_WALLET_ADDRESS"`
  - `DEFAULT_FUND_AMOUNT = SINGLE * 5 / 2` (2.5×, `bc`)
- **Fallback:** if `estimatePauseCost` fails (e.g. pauser not yet registered at stage 9, or
  RPC hiccup), `warning` and fall back to the existing `0.002 ETH` default rather than
  blocking the deploy. Deployment must stay unblockable on the critical path.

## Data flow

```
                    ┌─────────────────────────────┐
                    │ estimatePauseCost (helper)  │
                    │  gasEstimate × gasPrice = 1× │
                    └──────────────┬──────────────┘
            ┌──────────────────────┴───────────────────────┐
            ▼                                               ▼
  checkPauserFunds.sh                          deployAllContracts.sh stage 9
  ratio = balance / 1×                         default = 1× × 2.5
  thresholds: 1× / 2.5×                        send on balance == 0
  read-only report + exit code                 deployer → pauser transfer
```

## Error handling

- All RPC-touching steps reuse repo conventions (`error`/`warning`/`success`, `checkFailure`).
- `estimatePauseCost` never aborts a caller implicitly — it returns a classified exit code;
  each caller decides (check script → table row; funding → fallback amount).
- Big-number comparisons and ratios use `bc`; numeric inputs validated with `=~ ^[0-9]+$`
  before arithmetic (matches `diamondEMERGENCYPauseGitHub.sh:150`).

## Testing & verification

No bash unit harness exists in the repo. Verification:

- `bash -n` + `shellcheck` on all three touched files.
- Live smoke: `estimatePauseCost mainnet` returns a sane wei number; `checkPauserFunds.sh
  mainnet arbitrum` prints a correct two-row table with plausible ratios/status.
- `/pr-ready` (local CodeRabbit) before opening the PR.

## Acceptance criteria (from ticket)

- [x] Decision recorded on which options to implement → (a) + funding change + shared helper; (b)/(c)/(d) deferred.
- [ ] (a) at minimum: under-funded networks identified (script runs and flags shortfalls).
- [ ] Shared helper used by both consumers (no duplicated cost logic).
- [ ] Stage-9 funding default is computed (2.5×), not hardcoded.
