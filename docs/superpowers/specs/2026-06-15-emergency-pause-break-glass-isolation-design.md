# Emergency-Pause "Break-Glass" Isolation — Design

- **Date:** 2026-06-15
- **Tickets:** EXSC-366 (parent), EXSC-367, EXSC-368, EXSC-371, EXSC-507
- **Status:** Approved design — ready for implementation plan
- **Branch:** `feature/exsc-366-emergency-pause-hardening`

## Problem

The production emergency-pause runs from a GitHub Action
(`diamondEmergencyPause.yml` → `script/utils/diamondEMERGENCYPauseGitHub.sh`) that
depends on the shared scripting library — `script/universalCast.sh` and
`script/helperFunctions.sh` (`sendOrPropose` / `universalSend*`). Those files churn
constantly for unrelated reasons, and a change to the routing layer can silently break
the pause path. That is exactly the EXSC-367 class of bug: `pauseDiamond()` was routed
through `propose-to-safe.ts` because production `sendOrPropose` unconditionally proposes
to the Safe, even though the pauser is a non-Safe-owner EOA that must send directly.

Static cross-reference (a PR comment listing callers) and a behavioural routing smoke
test reduce the risk but do not eliminate it: the pause path still *rides on* the shared
library, so any unmodelled change can still ship. The incident-critical "break glass"
path needs a stronger guarantee than "we'll probably notice."

### Goals

- **(A) Insulation (primary):** a change to `universalCast` / `helperFunctions.sh` must
  not be able to alter the production emergency-pause behaviour — enforced mechanically,
  not by review vigilance.
- **(B) Continuous confidence (secondary):** ongoing proof that the pause path actually
  fires, exercising the *real* frozen code.

### Non-goals

- Replacing the interactive CLI ops tool (`script/tasks/diamondEMERGENCYPause.sh` via
  `scriptMaster.sh`) wholesale. It does more than pause — **unpause** (`unpauseDiamond`
  via Safe/Timelock governance) and **remove-facet** (`removeFacet`) — and those
  owner/governance paths legitimately need the shared library's `sendOrPropose →
  propose-to-safe` routing. Only its **pause** action is in scope here (see "Callers &
  wiring": it delegates pause to the break-glass script). Its unpause / remove-facet
  actions are unchanged.
- Changing the on-chain authorization model (`EmergencyPauseFacet` /
  `OnlyPauserWalletOrOwner`). The pauser remains an EOA registered on the diamond.

## Key decision: "frozen code, live data"

The isolation boundary is **code, not data**:

- The break-glass script vendors **no shared logic** — it does not `source`
  `helperFunctions.sh` or `universalCast.sh`, and never calls `universal*` /
  `sendOrPropose`.
- It still **reads the shared data files** — `config/networks.json`,
  `deployments/<network>.json`, `config/global.json` — with small inline `jq`.

Consequence: a newly-added production **EVM** diamond is **auto-covered** (read from the
live deploy logs, no code edit), while the churny routing code cannot touch the pause
path. The only residual drift is a rare *structural* change (e.g. the `troncast`
invocation, or a new non-EVM ecosystem), which is already caught by the team's practice
of **live-testing the pause on a freshly-added production diamond during onboarding**,
before that diamond is backend-integrated.

## Findings that shaped the design

1. `isTronNetwork` / `getTronEnv` are trivial (hardcoded `tron` / `tronshasta`) — safe to
   vendor verbatim.
2. **Tron is effectively broken in today's GitHub pause path.** `troncast` exposes only
   `address` / `call` / `code` / `send` — **no `balance`** — yet
   `diamondEMERGENCYPauseGitHub.sh` runs its pre-checks with EVM-only `cast wallet
   address` + `cast balance --rpc-url`. For Tron that errors on RPC lookup or runs
   `cast balance` against `api.trongrid.io` (not EVM JSON-RPC) and fails *before* the
   troncast dispatch. The isolated rewrite fixes this by branching every operation
   through `troncast` for Tron and skipping the unsupported native-balance pre-check.
3. The same private key controls both the EVM pauser and the Tron pauser address (Tron
   address = base58check of `0x41 || evmAddress`). The readiness script already derives
   the Tron address from the EVM key via `evmToTronBase58`; that helper is vendored.

## Chosen approach (Approach A)

A single, self-contained, environment-parameterized break-glass pause script, isolated
from the shared library and mechanically protected from re-coupling.

Alternatives considered and rejected:

- **B — stay coupled + behavioural freeze-test gate:** zero duplication and the pause
  keeps shared-lib improvements, but it does **not** meet Goal A — the pause still rides
  on the shared lib and the gate only forces a human to notice modelled breakages.
- **C — partial isolation (freeze only routing/dispatch):** less duplication, but it
  still `source`s `helperFunctions.sh`, so churn there can still bite, and the fuzzy
  boundary cannot be cleanly enforced by a grep-guard.

## Architecture

### Files

```
script/emergency/
  emergencyPauseBreakGlass.sh   # single self-contained entrypoint — sources NOTHING
  README.md                     # why frozen; how to change safely; onboarding live-test note
```

A single file (no internal `source`) maximises insulation and makes the enforcement check
trivial. Expected size ~300 lines (network loop + checks + dispatch + summary).

### Inputs

- **Env var `PRIVATE_KEY_PAUSER_WALLET`** — the pauser key (prod secret
  `PRIV_KEY_PAUSER_WALLET`; staging secret `PRIV_KEY_PAUSER_WALLET_STAGING`).
- **Env var `ENVIRONMENT`** — `production` (default) or `staging`. Selects the deploy-log
  filename (`deployments/<net>.json` vs `deployments/<net>.staging.json`) and the network
  set: full prod list (all `networks.json` mainnet entries) vs the staging subset
  (`bsc` / `arbitrum` / `optimism` / `base`, mirroring the original staging workflow).
- **Env var / arg `NETWORK` (optional)** — when set to a single network name, restrict the
  run to just that network; when unset or `all`, run the full set for the environment.
  Lets the interactive CLI delegate a single-network pause to this script (default: all).
- **Env vars `ETH_NODE_URI_<NET>`** — per-network EVM RPC endpoints, injected by the
  workflow's MongoDB-fetch step (unchanged).
- **Data files** — `config/networks.json`, `deployments/*`, `config/global.json`.

### Behaviour (per network, in parallel; mirrors current orchestration)

1. Enumerate networks: when `ENVIRONMENT=production`, take all keys of `config/networks.json`;
   when `ENVIRONMENT=staging`, take the hardcoded staging subset (`bsc/arbitrum/optimism/base`).
   In both cases, filter to the optional single-`NETWORK` arg if set, then skip any whose
   `type=="testnet"` (read from `networks.json`, not a hardcoded list). No separate
   `networks.staging.json` is read — staging vs production differ only in this network set and in
   the deploy-log filename (step "Resolve diamond").
2. Branch on a vendored `isTron` check (`tron` / `tronshasta`):
   - **EVM:**
     - Resolve RPC from `ETH_NODE_URI_<UPPER, "-"→"_">`.
     - Resolve diamond from the deploy log.
     - Pre-checks: `cast wallet address` → pauser address; `cast balance` > 0;
       `cast call owner()` to detect already-paused (`DiamondIsPaused` selector
       `0x0149422e`, i.e. `bytes4(keccak256("DiamondIsPaused()"))` — `owner()` reverts with
       this once the diamond is paused); `cast call pauserWallet()` matches the pauser address.
     - Dispatch: `cast send <diamond> <pauseDiamond-calldata> --rpc-url … --private-key …
       --legacy --gas-price <buffered> --confirmations 1` (verbatim from
       `universalSendRaw`'s EVM branch, incl. the `GAS_ESTIMATE_MULTIPLIER` gas buffer).
   - **Tron:**
     - `troncast --env <mainnet|testnet>` for all `call` / `send`.
     - Pauser address via vendored `evmToTron` base58 conversion.
     - **Native-balance pre-check skipped** (no `troncast balance`) — documented; the
       final pause verification still confirms success.
     - `owner()` / `pauserWallet()` checks via `troncast call`.
     - Dispatch via `troncast send <diamond> "" --calldata <pauseDiamond-calldata>
       --env <env> --private-key … --confirm`.
3. Final verification (both ecosystems): `owner()` must revert with `DiamondIsPaused`,
   with retries to cushion read-after-write lag. This is the canonical truth source for
   whether the diamond ended up paused (regardless of who paused it).
4. Aggregate per-network exit codes; print a status summary; exit non-zero if any prod
   network failed (per-network isolation — one failure does not abort the others).

### Vendored (frozen) logic, copied near-verbatim then never re-coupled

- `normalizePrivateKey` (EXSC-507): accept the key with/without `0x`, trim whitespace,
  lowercase, validate 64-hex, fail loud and early.
- `evmToTron` base58check conversion (from `verifyEmergencyPauseReadinessGitHub.sh`).
- `isTron` / Tron-env mapping.
- Deploy-log diamond read.
- RPC-env-var naming.
- Retry/back-off + logging (`error` / `warning` / `success` equivalents).
- Parallel-per-network launch + PID-based exit aggregation.

### Error handling

- Fail closed: if pause-state cannot be determined after retries, abort that network and
  report failure (never send `pauseDiamond()` blindly).
- Empty/malformed pauser key fails before any network work, with a format-specific message.
- Missing RPC / missing diamond / pauser mismatch each fail that single network and the
  loop continues; the run exits non-zero so the workflow turns red and Slack pages on-call.

## Callers & wiring

The break-glass script is the **single source of truth for how we pause**. Three callers:

- `diamondEmergencyPause.yml` "Pause Diamond" step → `bash
  script/emergency/emergencyPauseBreakGlass.sh` (env defaults to `production`, all networks).
- `diamondEmergencyPauseStaging.yml` → same script with `ENVIRONMENT=staging` and the
  staging network subset.
- **CLI ops tool** (`script/tasks/diamondEMERGENCYPause.sh`): its **"pause entirely"**
  action stops calling `universalCast "send"` (the EXSC-367 trap) and instead invokes the
  break-glass script as a subprocess, passing the selected `NETWORK` (single or all) and
  `ENVIRONMENT=production`. Because the dependency points *into* the frozen script (a
  subprocess call), the break-glass script's isolation is preserved — it still sources
  nothing, and the grep-guard still passes. The CLI's **unpause** and **remove-facet**
  actions are unchanged (they keep using the shared lib's governance routing).

Removed:

- **Delete** `script/utils/diamondEMERGENCYPauseGitHub.sh` and
  `script/utils/diamondEMERGENCYPauseStagingGitHub.sh` — both superseded by the break-glass
  script.
- **Drop** the `universalCastGuardrails.yml` workflow and
  `script/tasks/universalCastRoutingSmokeTest.sh` (the EXSC-368 (a) caller-check + (b)
  routing smoke test). They existed to protect a pause path that depended on `universalCast`;
  with the pause path now fully isolated, guarding `universalCast` for the pause's sake is
  moot. (These two were drafted earlier on this branch but never committed.)

Unchanged:

- The EXSC-371 runbook Slack link (the `EMERGENCY_PAUSE_RUNBOOK_URL` repository variable)
  stays in both workflows.

## Enforcement & protection

- **CI grep-guard** (new job, runs on every PR/dispatch): fail if any
  **non-comment** line in `script/emergency/*.sh` contains a `source ` statement or
  invokes `universalCast` / `universalSend` / `universalSendRaw` / `universalCall` /
  `universalCode` / `sendOrPropose` / references `helperFunctions`. Comment lines are
  stripped first so a comment explaining *why* the script avoids the shared lib does not
  trip the guard. This is the mechanical guarantee behind Goal A.
- **Anvil smoke test** for the isolated EVM dispatch: prove that the frozen `cast send`
  path actually signs and broadcasts against a local Anvil node (the pauser-key scenario).
  The break-glass script has no propose-vs-direct routing decision to assert — it always
  sends directly — so this test just proves the dispatch broadcasts.
- **Staging dry-run** (`diamondEmergencyPauseStaging.yml`, manual `workflow_dispatch`):
  runs the isolated script on real staging chains → continuous proof of the frozen path
  (Goal B). No auto-unpause; a human unpauses staging after the drill. Note: the staging
  subset is EVM-only (no staging Tron diamond), so the frozen **Tron** path is validated
  by the Anvil/structural review and the onboarding live-test rather than the dry-run.
- **CODEOWNERS** for `script/emergency/` → SC-core team. No CODEOWNERS file exists today,
  so this creates a scoped one. Recommended; separable from the core change.
- **Information Security Manager approval gate.** Extend
  `.github/workflows/protectSecurityRelevantCode.yml` so the `script/emergency/` directory
  joins `.github/` and `.husky/pre-commit` as protected paths. Today that workflow guards
  only `.github/**` and `.husky/pre-commit`, so the pause *workflows* already require ISM
  approval but the pause *scripts* (under `script/`) do not — this closes that gap for the
  break-glass logic. Concretely, the protected-path match becomes
  `'^\.github/|^\.husky/pre-commit|^script/emergency/'`, and the workflow's header comment
  is updated to list the emergency-pause scripts. Any PR touching `script/emergency/*` then
  requires an approving review from a member of the `InformationSecurityManager` team.
  (Changing the protect workflow itself is already ISM-gated, since it lives under
  `.github/`.)

## Reconciliation with the EXSC work already on this branch

- EXSC-367 (`sendRaw` direct dispatch) + EXSC-507 (key normalization): now **embedded
  inside** the isolated script rather than the (deleted) GitHub scripts.
- EXSC-371 (runbook Slack link): unchanged, in the two workflows.
- EXSC-368: the original (a) caller-check and (b) `universalCast` routing smoke test are
  **dropped** — the pause path no longer rides on `universalCast`, so guarding that layer
  for the pause's sake is moot. The ticket's intent ("make sure the critical scripts still
  work when dependencies change") is now met more strongly by **isolation + enforcement**:
  the grep-guard (the pause path *cannot* depend on the churny layer), the break-glass
  Anvil dispatch test, and the staging dry-run (c) on the isolated script.

## Drift management

`script/emergency/README.md` documents: this directory is frozen on purpose; do **not**
refactor it to reuse the shared libraries (the grep-guard will fail the PR); new EVM
chains need no edit (read from deploy logs); when adding a non-EVM ecosystem or changing
the `troncast` invocation, update here and run the live onboarding pause-test on the new
production diamond before it goes live.

## Testing strategy

- `bash -n` on the new script.
- Anvil-backed broadcast assertion for the EVM dispatch (run in CI + locally).
- Manual staging dry-run via `workflow_dispatch` to validate the end-to-end frozen path
  on real chains (and confirm the Slack message + runbook link render).
- Grep-guard self-check: a deliberately-violating fixture is not committed, but the guard
  logic is verified locally before merge.

## End-to-end testing checklist (manual — operator-run)

> ⚠️ **HARD SAFETY RULE: never trigger the *production* pause workflow as a test.** It pauses
> every production diamond. The only real-chain pause tests are (1) the **staging** dry-run
> and (2) the **onboarding live-test** on a brand-new prod diamond that is *not yet*
> backend-integrated. Every real pause MUST be followed by a verified **unpause**.

### Phase 0 — Preconditions (before any real-chain pause)

- [ ] **Confirm you can UNPAUSE staging before you pause it.** Identify the staging diamond
      owner on bsc/arbitrum/optimism/base and confirm you have the key / Safe access to run
      `unpauseDiamond([])`. Do not pause anything you cannot immediately unpause.
- [ ] Run the read-only **Verify Emergency Pause Readiness** workflow (`workflow_dispatch`)
      and confirm all checks are green: pauser secret matches config, on-chain `pauserWallet()`
      matches, timelock/Safe governance OK, pauser wallet funded. This validates secrets,
      RPCs, and deploy-log lookups *without* pausing anything.

### Phase 1 — Offline / local (safe; no real chains, no state change)

- [ ] `bash -n script/emergency/emergencyPauseBreakGlass.sh` passes.
- [ ] **Isolation grep-guard** passes locally: the script contains no `source ` statement and
      no non-comment reference to `universalCast` / `universalSend*` / `universalCall` /
      `universalCode` / `sendOrPropose` / `helperFunctions`. (Then deliberately add one such
      line in a scratch copy and confirm the guard *fails* — proves the guard works.)
- [ ] **Anvil dispatch test** passes: against a local Anvil node, the script's EVM dispatch
      signs + broadcasts a real `pauseDiamond()` tx from the pauser-key path (nonce advances).
- [ ] **EXSC-507 negative tests**: feed the script an empty key, a too-short key, and a
      non-hex key → each fails *before* any network work with a clear, format-specific error.
      Feed a valid key with and without the `0x` prefix and with surrounding whitespace →
      both are accepted and derive the identical pauser address.

### Phase 2 — Staging dry-run (real chains; pauses STAGING only)

- [ ] Trigger **"EMERGENCY >> Pause STAGING diamonds"** (`workflow_dispatch`, type
      `UNDERSTOOD`). Confirm it runs the break-glass script with `ENVIRONMENT=staging`.
- [ ] Each staging network (bsc/arbitrum/optimism/base): log shows pauser-balance OK,
      `pauserWallet()` match, pause tx sent **directly** (no `propose-to-safe` invocation in
      the logs), and final verification reports the diamond paused (`DiamondIsPaused`).
- [ ] Re-run the workflow while staging is already paused → it detects "already paused" and
      exits cleanly (idempotent), no error.
- [ ] **Slack (EXSC-371)**: the SC-general message renders on its own lines with `Status:`,
      `GH run:` (clickable), and `Runbook:` showing the `EMERGENCY_PAUSE_RUNBOOK_URL` value
      (or the explicit "not configured" fallback if the repo variable is unset).
- [ ] **UNPAUSE staging** (CLI tool → "unpause the diamond", or the staging owner key) and
      verify every staging diamond is live again (`owner()` returns the address, no revert).

### Phase 3 — CLI delegation (the "pause entirely" action calls break-glass)

- [ ] In `scriptMaster.sh` → emergency pause, choose **one** staging network and the "pause
      entirely" action. Confirm the CLI invokes the break-glass script (not `universalCast
      "send"`) and that single staging diamond pauses directly. **Unpause it afterwards.**
- [ ] Confirm the CLI's **unpause** and **remove-facet** actions still work (unchanged,
      shared-lib governance path) — at minimum a dry/dispatch check that they route to the
      Safe/Timelock as before.

### Phase 4 — Tron path (no staging Tron diamond — exercise with care)

- [ ] Structural review: confirm the vendored Tron branch uses `troncast call` for
      `owner()` / `pauserWallet()`, derives the pauser Tron base58 from the key, skips the
      native-balance pre-check, and dispatches via `troncast send … --confirm`.
- [ ] Validate the real Tron write path during the **next new-Tron-style onboarding** or on a
      Tron testnet diamond (tronshasta) you control — pause then unpause — rather than on the
      live `tron` prod diamond.

### Phase 5 — New-EVM-chain onboarding live-test (real prod diamond, pre-integration only)

- [ ] When a new prod EVM diamond is added but **not yet** backend-integrated: run the
      production pause flow against it, confirm it pauses, then **unpause** it before it goes
      live. This is the standing practice that covers "frozen code / live data" drift.

### Phase 6 — Governance / protection gates

- [ ] Open the PR and confirm **`protectSecurityRelevantCode.yml`** flags the
      `script/emergency/` change and requires an `InformationSecurityManager` approval.
- [ ] Confirm the **isolation grep-guard** CI job is green on the PR and would go red if the
      script regained a shared-lib dependency.

### Phase 7 — Post-test sweep (leave nothing paused)

- [ ] Re-run **Verify Emergency Pause Readiness** (read-only) and/or check each touched
      diamond's `owner()`: **no staging or production diamond is left paused.**
- [ ] Confirm pauser wallet balances are still sufficient on all production chains.

## Acceptance criteria

- [ ] `script/emergency/emergencyPauseBreakGlass.sh` exists, sources nothing, and pauses
      both EVM and Tron production diamonds (Tron via `troncast`, native-balance check
      skipped).
- [ ] Both pause workflows call the isolated script (prod = production, staging =
      staging); the two old GitHub pause scripts are deleted.
- [ ] The CLI ops tool's "pause entirely" action delegates to the break-glass script
      (passing the selected network + production env) and no longer calls
      `universalCast "send"`; its unpause / remove-facet actions are unchanged.
- [ ] CI grep-guard fails any attempt to re-couple `script/emergency/*` to the shared libs.
- [ ] Anvil smoke test for the isolated EVM dispatch passes in CI.
- [ ] Staging dry-run runs the isolated script and pauses staging diamonds successfully.
- [ ] EXSC-371 runbook link present in both workflows (unchanged).
- [ ] `protectSecurityRelevantCode.yml` protects `script/emergency/` (ISM approval required
      to change the break-glass logic).
- [ ] README documents the freeze contract and the onboarding live-test obligation.

## Open / follow-up

- **In-repo (not in this design's scope):** the CLI ops tool's **remove-facet** action
  (`removeFacet(address)` via `universalCast "send" … production … pauserKey`) carries the
  *same* EXSC-367 trap as the old pause action — `removeFacet` is `OnlyPauserWalletOrOwner`,
  so from the pauser EOA it should send directly, not propose to the Safe. Not fixed here
  (this branch's decision was scoped to the pause action); worth a follow-up ticket.
- **Optional:** dropping `universalCastGuardrails.yml` also removes the advisory routing
  guard for the *non-critical* `universalCast` callers (deploy / sync / update scripts).
  They were never the EXSC-368 concern; if a routing-regression guard is wanted for them,
  it can be a separate, clearly-scoped ticket — not part of the break-glass isolation.
- **Outside this repo:**
  - Set the `EMERGENCY_PAUSE_RUNBOOK_URL` repository variable + author the runbook (EXSC-432).
  - Document the expected pauser-secret format (1Password note + test-plan checklist) (EXSC-507).
  - Add a runbook entry on how to investigate a failed staging drill (EXSC-368).
