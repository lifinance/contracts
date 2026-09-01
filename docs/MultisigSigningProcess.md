# Multisig Signing Process

Authoritative current-state description of how a production change reaches a
LI.FI diamond: deploy → propose → confirm/sign → execute, including the
timelock leg, the automated checks at each stage, and what still relies on
human review. This documents what **is** — §9 alone describes plans.

Status: **current state**, verified against the repo. Author: Daniel B. (SC).

---

## 1. Purpose & scope

- **Safe + timelock + quorum is mandatory for every live production mainnet
  diamond and cannot be opted out of.** Staging and testnets have no Safe and
  broadcast directly from an EOA — see `sendOrPropose` in
  `script/helperFunctions.sh` and in `script/safe/safeScriptHelpers.ts`.
- The direct-broadcast escape hatch `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true`
  is **only** for a *new* production network during bring-up, before diamond
  ownership is transferred to the timelock — it is not a way to skip
  governance on a live network. Two things enforce that: `scriptMaster.sh`
  prints a standing warning whenever the flag is set, and once ownership has
  moved, the diamond's `LibDiamond.enforceIsContractOwner` makes any direct
  EOA call revert. "Diamond is owned by the timelock (mainnet)" is a
  health-check invariant (`script/deploy/healthCheckInvariants.ts`), so a
  network left in the bring-up state is reported as unhealthy.
- Scale: every active mainnet network in `config/networks.json` has its own
  Safe (`safeAddress`) and `LiFiTimelockController`. The set changes as
  networks are added and deprecated, so treat that file as the live list
  rather than any count quoted elsewhere:
  `jq -r 'to_entries[] | select(.value.status=="active" and .value.type=="mainnet") | .key' config/networks.json`
- There is **no Safe Transaction Service and no Safe{Wallet} UI** anywhere in
  the flow: proposals live in our own MongoDB store, and all Safe interaction
  goes through the hand-rolled viem-based `SafeClient` class in
  `script/deploy/safe/safe-utils.ts`.

## 2. Roles

| Role | Who | What they run |
|---|---|---|
| Proposer | The dev (or agent-driven rollout) doing a deploy/upgrade/config change | The deploy/update scripts, which call `script/deploy/safe/propose-to-safe.ts` (manual variant: `bun propose-safe-tx`); see §4.2 for every entry point |
| Signer-reviewer | Safe owners (SC signers), recruited via the `#dev-sc-multisig-proposals` Slack thread | `bun confirm-safe-tx` — decode, review, sign on Ledger (default signer); the last signer picks one of the execute variants |
| Executor (Safe leg) | Any owner may execute once the threshold is met, but in practice the **deployer wallet** broadcasts: it is the only owner funded on every chain, whereas the signer hardware wallets are not | The "…With Deployer" execute variants inside `bun confirm-safe-tx`, which broadcast with `PRIVATE_KEY_PRODUCTION` |
| Executor (timelock leg) | The **"Timelock Auto Execution" GitHub cron** (`.github/workflows/runPendingTimelockTXs.yml`), every 10 minutes, gated on repo var `ENABLE_TIMELOCK_AUTO_EXECUTION` | `script/deploy/safe/execute-pending-timelock-tx.ts --executeAll`, signing with `TIMELOCK_EXECUTOR_PRIVATE_KEY` — a pure gas-payer EOA with no protocol authority (`EXECUTOR_ROLE` is open). Manual fallback: `bun execute-timelock` |

## 3. Architecture

Two MongoDB clusters with different trust profiles:

| Cluster (env key) | Reachability | DB.collection | Role |
|---|---|---|---|
| `SC_MONGODB_URI` | Gated: `lifi-connect` tunnel (`script/deploy/safe/with-safe-tunnel.sh`); NOT reachable from CI | `sc_private.pendingTransactions` (`getSafeMongoCollection` in `safe-utils.ts`) | **The proposal/signing store** — system of record for Safe proposals |
| `MONGODB_URI` | Un-gated, reachable from CI | `timelock-operations.queue` (`timelock-queue.ts`); `deferred-cleanup.parkedTasks` (`parked-tasks.ts`); the deployment master log (`script/deploy/update-deployment-logs.ts`) | Timelock auto-execution queue, deferred-cleanup queue, deployment log |

Governance shape, per network: the Safe (address in `config/networks.json`)
owns a `LiFiTimelockController` with **minDelay 10800 s (3 h)**
(`config/timelockController.json`). The Safe is the timelock's only PROPOSER
and its external admin. **The Safe is not the only CANCELLER**, so a queued
operation can be cancelled without a quorum: OZ's constructor grants
CANCELLER_ROLE to every proposer, and `LiFiTimelockController` additionally
grants it to the `_cancellerWallet` constructor arg (the deployer wallet at
deploy time). The holder set is mutable afterwards — `manageTimelockCanceller`
in `script/playgroundHelpers.sh` adds, removes, or replaces a canceller by
Safe proposal — so read the live holders on-chain rather than inferring them
from `config/global.json`. **EXECUTOR_ROLE is granted to `address(0)`, so
anyone may execute a ready operation** — in practice the 10-minute cron
(`script/deploy/facets/DeployLiFiTimelockController.s.sol`,
`src/Security/LiFiTimelockController.sol`).

## 4. Lifecycle, step by step

### 4.1 Deploy

`script/deploy/deploySingleContract.sh` is the universal wrapper. It parses
the version from the source's `/// @custom:version` tag, attempts explorer
verification, and calls `logContractDeploymentInfo` →
`script/deploy/update-deployment-logs.ts add` — a **Mongo upsert at deploy
time, from the dev's machine**. The record (`IDeploymentRecord` in
`script/deploy/shared/mongo-log-utils.ts`) carries name, network, version,
address, constructor args, salt, a self-reported `verified` boolean, and the
deployer's HEAD `gitCommitHash` — no branch, dirty-tree flag, or human
identity. File logs (`deployments/{network}.json`) only land in git at PR
merge; the deploy scripts never commit.

### 4.2 Propose

All EVM funnels end in `storeTransactionInMongoDB`
(`script/deploy/safe/safe-utils.ts`). Entry points:

- **`script/deploy/safe/propose-to-safe.ts`** (`runPropose`) — the main
  funnel, invoked by the bash `sendOrPropose` chokepoint in
  `script/helperFunctions.sh`, by `script/tasks/diamondUpdateFacet.sh`,
  `diamondUpdatePeriphery.sh`, and `diamondEMERGENCYPause.sh` (all with
  `--timelock`), programmatically by `proposeDiamondCut`
  (`script/deploy/shared/propose-diamond-cut.ts`), and manually via
  `bun propose-safe-tx`.
- **TS `sendOrPropose`** (`script/safe/safeScriptHelpers.ts`) — used by
  `script/tasks/cleanUpProdDiamond.ts`; env private key only, no Ledger.
- **Deferred-cleanup drain** (`script/deploy/safe/drain-parked-tasks.ts`) —
  gated on `DRAIN_PARKED_TASKS`, hooked at the tail of `runPropose`
  ([DeferredDiamondCleanupQueue.md](./DeferredDiamondCleanupQueue.md)).
- **Bespoke task scripts** that store proposals directly:
  `script/tasks/proposeMegaETHBridgeRegistrations.ts`,
  `proposeDeBridgeDlnChainIdMappings.ts`,
  `proposePolymerCCTPChainIdMappings.ts`, `unpauseAllDiamonds.ts`,
  `script/deploy/safe/add-safe-owners-and-threshold.ts` — there is **no
  single chokepoint**.
- **Tron** is a parallel flow (`script/deploy/tron/propose-to-safe-tron.ts`).

`diamondUpdateFacet.sh` additionally runs `verify-approvals.ts` before
proposing (PR #2128 / EXSC-687). A production deploy is allowed when each
selected facet's transitive `src/` import closure matches `origin/main` — the
usual rollout, branch off main and deploy already-merged code without touching
that Solidity. If a closure diverges, the branch needs an open PR **and** the
working-tree files must equal the `audit/auditLog.json` commit for the current
`@custom:version`, with that audit log read from `main` rather than the working
tree so a deploy cannot certify itself. What is compared is always the working
tree, never the branch name: a checkout sitting on `main` earns no exemption, so
uncommitted edits and a stale local `main` both block (and no PR can have `main`
as its head, so the open-PR exception cannot apply there). `origin/main` itself is
refreshed first — the remote tip is read with `ls-remote` and fetched only when it
differs — so a never-fetched checkout cannot pass by comparing against a stale main,
and an unreachable remote fails the gate rather than falling back to the local copy.
Dependencies under `lib/` are compiled into every facet but their content is not in
this repo's tree, so they are compared by **submodule gitlink** instead
(`git diff --ignore-submodules=none`, which catches both a submodule checked out off
its recorded commit and one with a dirty working tree); a divergence there is not
excused by an open PR or an audit freeze. Staging is not gated, and neither are
testnets — deploying an unmerged facet to a testnet is how it is validated before
the audit, and no Safe is involved there.

Note what this gate does and does not assert. It enforces **main-equivalence**,
with an audited-freeze exception for unmerged code; it does not verify that what
reaches production was audited, because code that matches `main` passes without
any audit lookup at all. True audit enforcement is the separate bytecode ↔ audit
attestation item in §9. The check is further **not** a GitHub SC+auditor
review check, and it does not wrap the other `propose-to-safe` entry points:
`diamondUpdatePeriphery.sh` and `diamondEMERGENCYPause.sh` are ungated.

The same gate is applied a second time in `proposeDiamondCut`
(`script/deploy/shared/propose-diamond-cut.ts`), the funnel the six Tron
`deploy-and-register-*-facet.ts` scripts route through (note
`deploy-and-register-periphery.ts` does **not** — it calls `runPropose`
directly). Gating the funnel rather than each script means a future caller is
covered without anyone remembering to add it; the exemptions match the bash path
(staging, and any network whose `config/networks.json` type is `testnet`, which
is how `tronshasta` stays open).

Facet **removals** are deliberately outside both gates: `cleanUpProdDiamond.ts`
and the deferred-cleanup drain (`drain-parked-tasks.ts`, which folds extra
removal calls into whatever proposal `runPropose` is already building) propose
real diamond cuts, but a removal installs no new bytecode, so a
main-equivalence check has nothing to compare. Their safety comes from the
removal-specific controls in the table below. The generic bash `sendOrPropose`
chokepoint can likewise propose arbitrary calldata and is not gated.

`runPropose` owner-gates the proposer on-chain; with `--timelock` it wraps all
calls into one `scheduleBatch` via `wrapWithTimelockSchedule` (`safe-utils.ts`;
live `getMinDelay()` with `config/timelockController.json` fallback, timestamp
salt), resolves the nonce (`getNextNonce`), **signs immediately** (EIP-712),
computes the `safeTxHash` via the Safe's on-chain `getTransactionHash`, and
stores. The document (`ISafeTxDocument`) carries the raw Safe tx fields, the
proposer's wallet address, an `intentHash` dedup key, and a
`pending → submitted → executed / reverted` status — but **no description, PR
link (except drain `parkedTaskRefs`), git commit, or human identity**.
`notifyProposalsCreatedToSlack` (`script/multiNetworkExecution.sh`) posts
count + contract + network to `#dev-sc-multisig-proposals`; the rich
signing-ask thread is a manual step per `.agents/commands/multisig-rollout.md`.

### 4.3 Confirm / sign

`bun confirm-safe-tx` = tunnel + typechain build +
`script/deploy/safe/confirm-safe-tx.ts`. **Ledger is the default signer**
(`--ledger=false` falls back to env keys), with a blind-signing fail-fast
(`checkBlindSigningEnabled` in `ledger.ts`). Per pending transaction the
signer sees:

1. **Decoded calldata** via `formatDecodedTxDataForDisplay`
   (`script/deploy/safe/safe-decode-utils.ts`): batch params, per-call target
   + resolved name, nested diamond-cut details (facet address,
   Add/Replace/Remove, per-selector names, decoded init call), and the
   **deployed vs `_targetState.json` version mismatch highlight**
   (`facet-version-utils.ts`).
2. **Safe transaction details** — nonce (current/stale/future coloring), `to`
   + resolved name, raw data, proposer, stored `safeTxHash`, signature count
   vs threshold, drain origin-PR links where present.
3. A **Ledger Flex "filmstrip"** (`renderLedgerFlexFlow`,
   `ledger-flex-preview.ts`) — ASCII replica of the device screens for the
   exact to-be-signed values.
4. The action prompt: `Do Nothing` / `Sign` / `Sign & Execute` /
   `Sign and Execute With Deployer` / `Execute with Deployer`. The two
   deployer variants are the usual choice — see §2 on why the deployer
   wallet broadcasts.

Signing is EIP-712 over the `SafeTx` struct, reconstructed from the row's raw
fields — what is displayed and on the Ledger is what is signed. Each owner
runs the tool independently until the Safe's threshold is met — read
on-chain per Safe at confirm time, never assumed; a new proposal already
carries the proposer's signature.

### 4.4 Execute

**Direct (Safe) leg:** `executeTransaction` in `confirm-safe-tx.ts` recomputes
the hash on-chain, validates and concatenates signatures sorted by signer
(`safe-utils.ts`), and broadcasts `execTransaction` through
`script/deploy/safe/executors/evm-executor.ts`. Gas = estimate ×
`GAS_ESTIMATE_MULTIPLIER`, with a fixed fallback that still broadcasts on
estimation failure (`executors/gas-with-fallback.ts`). `safeTxGas` is 0, so an
inner-call failure reverts top-level without consuming the Safe nonce.
**Nothing simulates the transaction before signatures exist.**

**Timelock leg:** if the executed calldata is a `scheduleBatch`,
`enqueueTimelockOpIfApplicable` (`timelock-queue.ts`) upserts a row into
`timelock-operations.queue` keyed `(network, operationId)`. The 10-minute cron
runs `execute-pending-timelock-tx.ts --executeAll`, which **re-derives the
operationId from the row's params** (a tampered row can only DoS, never
redirect), checks the row's timelock address against the deploy log, verifies
on-chain `isOperationReady`, then broadcasts `executeBatch`; the row flips to
`executed` only when `isOperationDone` confirms on-chain
(`confirm-timelock-execution.ts`). `backfill-timelock-queue.ts` repairs
missed enqueues.

### 4.5 Bookkeeping

`script/deploy/safe/reconcile.ts` (`reconcileAllSubmittedSafeTxs`, also run at
`confirm-safe-tx` startup) promotes `submitted` rows to `executed`/`reverted`
from receipts, demotes truly-missing broadcasts back to `pending`, and
back-fills from `ExecutionSuccess`/`ExecutionFailure` logs when the on-chain
nonce has moved. Inspection CLIs: `list-pending-proposals.ts`,
`list-timelock-queue.ts`, `list-parked-tasks.ts`;
`delete-pending-proposals.ts` refuses multi-signed rows without `--force`;
parked tasks are reconciled weekly by `reconcileParkedTasks.yml`.

## 5. Automated checks by stage

| Stage | Check category | Behavior | Enforced by |
|---|---|---|---|
| Propose | CLI input validation: `--to`/`--calldata` pairing, address/hex validity, multi-call requires `--timelock` | Block | `script/deploy/safe/propose-calls.ts`, `timelock-abi.ts` |
| Propose | Proposer must be a current Safe owner (on-chain `getOwners()`) | Block | `propose-to-safe.ts` (`runPropose`) |
| Propose | Nonce safety: override collision checks, auto-nonce clamped to on-chain | Block / auto-correct | `propose-to-safe.ts`, `getNextNonce` in `safe-utils.ts` |
| Propose | Duplicate-intent dedup (partial unique index on pending rows) | Block insert | `computeProposalIntentHash` + index in `safe-utils.ts` |
| Propose | Removal safety: protected-facet allowlist, live-selector hold-back, fail-closed diffs | Block + alert | `diamondRemovalDiff.ts`, `drain-parked-tasks.ts` |
| Propose | Production `diamondUpdateFacet`: each selected facet's `src/` import closure must match `origin/main`, else open PR + audit-log commit freeze (audit log read from `main`); judged on the working tree, so a checkout on `main` is not exempt; staging and testnets are not gated | Block (prod non-testnet facet **additions** via `diamondUpdateFacet` and `proposeDiamondCut` only — not periphery, emergency pause, removals, or the generic `sendOrPropose` chokepoint) | `script/deploy/github/verify-approvals.ts` via `diamondUpdateFacet.sh` (PR #2128, #2286) |
| Confirm | Signer must be an owner; network must be active; threshold and nonce read on-chain per Safe | Block / skip | `confirm-safe-tx.ts`, `safe-utils.ts` |
| Confirm | Ledger blind-signing enabled, fail-fast before any review | Block | `checkBlindSigningEnabled` in `ledger.ts` |
| Confirm | Full calldata decode: diamond cut, scheduleBatch, whitelist, periphery, roles; per-selector name resolution | Display / warn only | `safe-decode-utils.ts` (`formatDecodedTxDataForDisplay`) |
| Confirm | Deployed-version vs target-state mismatch highlight | **Warn only** | `facet-version-utils.ts`, `safe-utils.ts` |
| Confirm | Stale nonce blocks Execute; future nonce prompts | Block / prompt | `confirm-safe-tx.ts` |
| Execute | Signature format + sorting; threshold gating of the Execute option | Block / hide option | `safe-utils.ts` |
| Timelock exec | operationId re-derived from row params; timelock address vs deploy log; on-chain `isOperationReady`/`isOperationDone` | Block, mark failed | `execute-pending-timelock-tx.ts`, `timelock-queue.ts`, `confirm-timelock-execution.ts` |
| Housekeeping | Receipt-based status reconcile with grace period; nonce-gap log scan | Auto-heal | `reconcile.ts` |
| CI (PR gate) | Version bump required for audit-relevant `src/` changes; audit-log entry + report + auditor verified | Block PR | `.github/workflows/versionControlAndAuditCheck.yml` (labels protected by `protectAuditLabels.yml`) |
| CI (PR gate) | ≥ 1 approval from the SC core team | Block merge | Repository ruleset `main protection` — `required_reviewers` on the `smart-contract-core` team |
| CI (PR gate) | Security-relevant paths need ISM/CTO approval | Block PR | `protectSecurityRelevantCode.yml` |
| CI (PR gate) | Static analysis; LibAsset routing; config/deploy-log consistency and JSON validity; clear-signing sync; deploy smoke test; signed commits; solc floor; SPDX | Block PR | `olympixStaticAnalysis.yml` + `securityAlertsReview.yml`, `enforceLibAssetRouting.yml`, `deploymentAddressConsistency.yml`, `jsonChecker.yml`, `verifyClearSigning.yml`, `deploy-smoke-test.yml`, `verifyCommitsSigned.yml`, `solc-floor-build.yml`, `spdxLicenseChecker.yml` |
| CI (ops) | Daily on-chain health check of every production diamond; weekly emergency-pause readiness | Alert | `healthCheckAllNetworks.yml`, `verifyEmergencyPauseReadiness.yml` |

## 6. What the signer must verify manually today

Honest list — the tooling displays these, but does **not** machine-assert them:

- **Intent.** No description, PR link (drain excepted), or human identity on
  the proposal — the signer matches calldata against Slack/PR context.
- **Version mismatches.** The deployed-vs-target-state highlight is
  display-only; it never blocks or prompts.
- **Unknown targets.** `to`-address name resolution is display-only; an
  unknown target renders without a label — the absence is the only signal.
- **The Safe itself.** The `safeAddress` comes from the proposal document and
  is not cross-checked against `config/networks.json` at confirm time.
- **Unknown selectors.** Names for selectors without a local ABI come from
  the external `api.4byte.sourcify.dev` database, displayed as-is.
- **Execution outcome.** No simulation at review or sign time; the first
  signal is the broadcast itself.

## 7. Emergency path

This is the one **break-glass** path, and it is deliberately asymmetric: the
fast, non-Safe leg can only *reduce* the diamond's capabilities, never grant
or change any. Restoring capability always requires the Safe.

- **Pause** sits outside the Safe flow for speed:
  `EmergencyPauseFacet.pauseDiamond` is callable by the registered pauser
  wallet (or the owner). `.github/workflows/diamondEmergencyPause.yml` pauses
  **every** production diamond directly from the PauserWallet EOA via the
  frozen `script/emergency/emergencyPauseBreakGlass.sh`; readiness is verified
  weekly (`verifyEmergencyPauseReadiness.yml`). The authority this grants is
  strictly de-privileging: `pauseDiamond` only redirects existing selectors to
  a reverting fallback and `removeFacet` only removes a registered facet —
  neither can add code, move funds, or change ownership. Governance is not
  weakened, only the ability to keep serving traffic.
- **Unpause** goes back through the Safe — it can never be done by the pauser
  wallet. `EmergencyPauseFacet.unpauseDiamond` is diamond-owner-only, i.e. the
  timelock. Two routes exist, and **both require full Safe threshold/quorum**:
  - `LiFiTimelockController.unpauseDiamond` is `TIMELOCK_ADMIN_ROLE`-gated
    (the Safe) and **bypasses `minDelay` only** — the 3 h delay is skipped so
    an outage can be ended promptly; the multisig quorum is not. Fleet-wide
    unpause proposals target it via `script/tasks/unpauseAllDiamonds.ts`.
  - The per-network `script/tasks/diamondEMERGENCYPause.sh` instead proposes
    the diamond's `unpauseDiamond` wrapped in a regular timelock schedule,
    keeping the full 3 h delay.

## 8. Related scripts & workflows

| Path | Role |
|---|---|
| `script/deploy/safe/propose-to-safe.ts` | Main proposal funnel (`runPropose`); `bun propose-safe-tx` |
| `script/deploy/safe/confirm-safe-tx.ts` | Signer review/sign/execute CLI; `bun confirm-safe-tx` |
| `script/deploy/safe/safe-utils.ts` | `SafeClient`, Mongo store, signing, timelock wrap |
| `script/deploy/safe/safe-decode-utils.ts` | Calldata decode for the signing view |
| `script/deploy/safe/reconcile.ts` | Status reconciliation sweeps |
| `script/deploy/safe/timelock-queue.ts` / `execute-pending-timelock-tx.ts` / `confirm-timelock-execution.ts` / `backfill-timelock-queue.ts` | Timelock queue + executor (`bun execute-timelock`) |
| `script/deploy/safe/parked-tasks.ts` / `drain-parked-tasks.ts` | Deferred diamond-cleanup queue + drain |
| `script/deploy/safe/list-pending-proposals.ts` / `list-timelock-queue.ts` / `list-parked-tasks.ts` / `delete-pending-proposals.ts` | Inspection and guarded deletion |
| `script/safe/safeScriptHelpers.ts` | TS `sendOrPropose` (env-key funnel) |
| `script/helperFunctions.sh` | bash `sendOrPropose` chokepoint + deploy logging |
| `.github/workflows/runPendingTimelockTXs.yml` | "Timelock Auto Execution" 10-min cron |
| `.github/workflows/reconcileParkedTasks.yml` | Weekly parked-task reconcile + TTL alert |
| `.agents/commands/multisig-rollout.md` | The end-to-end rollout runbook |

## 9. Planned improvements (proposal stage — NOT yet implemented)

Design themes under discussion. Nothing below exists in the repo today:

- **Provenance on proposals** — attach human identity, git commit/branch, and
  a PR link/description to each proposal, shown at signing.
- **Integrity asserts + check report** — machine-assert what §6 leaves to the
  signer (recomputed `safeTxHash`, `safeAddress` vs `config/networks.json`,
  mismatches escalated from warn), summarized per proposal.
- **Executability simulation** — simulate the Safe transaction and its inner
  timelock payload before signatures are collected.
- **Bytecode ↔ audit attestation** — verify the deployed bytecode/commit
  against the audited commit in `audit/auditLog.json` at signing time,
  instead of inferring "audited" from the version string. (Propose-time
  source-file freeze on `diamondUpdateFacet` is a different check already
  described in §4.2 / §5 — it is not bytecode attestation and does not
  cover the other propose entry points.)
