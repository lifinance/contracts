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

### 2.1 What the deployer key can do

The deployer wallet (`config/global.json` `deployerWallet`, key
`PRIVATE_KEY_PRODUCTION`) is the only key that appears at every stage: it
deploys, writes the deployment record, creates the proposal, holds one of the
Safe owner slots, and holds `CANCELLER_ROLE` on every timelock. Against an
**already-deployed** governance Safe its power is bounded to **DoS and
griefing** — it cannot schedule or push a bad operation, because both need the
Safe threshold, and it holds one signature of `SAFE_THRESHOLD`
(`script/deploy/shared/constants.ts`). Deploying the Safe itself is the one
exception, below.

`bun deployer-key-power` prints the full inventory and refuses if the config
grants the wallet anything outside the documented set. The check walks the whole
of `config/global.json` and `config/networks.json` rather than a list of known
field names — matching addresses used as values and as object keys, and the
`41`-prefixed TronWeb hex form as well as the EVM hex form — so a newly added
field pointing at the deployer is caught too, and it runs in `bun test:ts`
(whose path filter includes `config/**`).

One production-mainnet **integrity** power is disclosed rather than bounded away:
the deployer can deploy the governance Safe and choose its owner set and
threshold. `script/deploy/safe/deploy-safe.ts` unions `--owners` into
`globalConfig.safeOwners`, accepts any `--threshold` of 1 or more, defaults
`allowOverride` to `true` so the "Safe already deployed on …" guard does not fire
without a flag, signs with `PRIVATE_KEY_PRODUCTION`, and rewrites
`config/networks.json` with the resulting `safeAddress`. Its own on-chain
verification compares `getOwners()` and `getThreshold()` against the same
expanded arguments it was handed, so it confirms "deployed as asked", not "as
configured". `script/deploy/tron/deploy-safe-tron.ts` is the Tron equivalent.
This is not bring-up-only. What bounds it is **detection**, not prevention: the
`safe-config` health-check invariant asserts the Safe owner set in both
directions, so an owner the config does not declare is reported (PR #2337,
EXSC-943). The inventory carries the power in
`ACKNOWLEDGED_PRODUCTION_INTEGRITY_POWERS`, and an integrity power that no
disclosure names a detection for refuses. An empty map is the target state:
detection is weaker than removal, so each entry also names the work that retires
it — here EXSC-944, which defaults `allowOverride` to `false` and refuses a
production threshold below `SAFE_THRESHOLD`.

Two further scoped exceptions are part of the inventory rather than hidden by it.
On **testnets** the deployer owns the diamond outright, in every environment —
those networks have no Safe or timelock. Staging on a mainnet network is a
different key, not a deployer power: `getPrivateKey` in
`script/helperFunctions.sh` returns `PRIVATE_KEY` for a staging environment, and
`script/deploy/healthCheck.ts` resolves `ctx.deployerWallet` to
`globalConfig.devWallet` there; the `diamond-owner` invariant skips staging
entirely. And during **production bring-up** the deployer owns the diamond
between `transferOwnership(timelock)` and the Safe-executed
`confirmOwnershipTransfer()`; a network left in that state is reported unhealthy
by the `diamond-owner` invariant.

Timelock execution is **not** a deployer power today: `EXECUTOR_ROLE` is granted
to `address(0)`, so execution is permissionless. It becomes one when the F7
executor restriction lands (EXSC-872), and the inventory carries it as `pending`
until then.

The Tron and EVM deployer identities are the same key
(`tronWallets.deployerWallet` decodes to `deployerWallet`), so there is one
deployer key, not two.

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
provenance of the run that produced it: the deployer's HEAD `gitCommitHash`,
the `repo` it was cloned from, the `gitBranch` checked out, the `actor`
(`human`, `bot` for a job that set `SAFE_PROPOSAL_ACTOR=bot`, `ci`, or
`UNKNOWN` when nothing identified the caller), and `dirtyTreeScoped` — the
working-tree paths that differed from that commit, excluding the artefacts the
deploy pipeline rewrites during its own run (`deployments/`). Governance
inputs such as `script/deploy/_targetState.json` stay in the list. An **empty
`dirtyTreeScoped` means the capture ran and the tree was clean; an absent one
means no capture ran, or ran and could not read the tree** — the same shape
every record written before the field existed has. A later clean re-log does
not `$set` an empty list over a dirty one already stored. Branch, tree, actor
and commit are read through the same `captureGitProvenance` helper the Safe
proposal document is built from, so a deployment record and the proposal that
installs it describe them by one definition rather than two. The capture is self-reported context, not a
control: it makes an honest mistake such as a deploy from an uncommitted edit
visible, while `assertTreeRecordable` — not this record — is what refuses such
a deploy, on the narrower set of build-affecting paths. Add `--dryRun` (or
`--dry-run`) to the `add` command to print the upsert it would apply without
writing. File logs (`deployments/{network}.json`) only land in git at PR
merge; the deploy scripts never commit.

### 4.2 Propose

All EVM funnels end in `storeTransactionInMongoDB`
(`script/deploy/safe/safe-utils.ts`), which is where the Linear ticket link is
required and the missing-reason warning is emitted — placing them there rather
than per entry point means no funnel can be added that skips them. The refusal
happens before the proposal document is inserted, so a refused proposal is never
created and claims no nonce, and it names both `--ticket` and
`SAFE_PROPOSAL_TICKET`.

That check is the backstop, not the first line: the entry points whose late
failure costs most — `unpauseAllDiamonds.ts`, `add-safe-owners-and-threshold.ts`,
the Tron route, and the TS `sendOrPropose` — also call `assertTicketPresent`
before they sign, and `propose-to-safe.ts` resolves the same intent up front in
`runPropose`, so an unset ticket costs one message
rather than a signature or a device confirmation per network. Those pre-checks
run only on the branches that actually propose; a staging or testnet-only run, a
`--check` audit and a `--dryRun` need no ticket.

`SAFE_PROPOSAL_TICKET` is the channel every path reads; `--ticket` is offered by
`propose-to-safe.ts`, `propose-to-safe-tron.ts`, `unpauseAllDiamonds.ts` and
`add-safe-owners-and-threshold.ts`, and by no other route. Two of the flagless
ones are worth naming because they front those funnels: the bash `sendOrPropose`
chokepoint takes six positional arguments and forwards them wholesale to
`propose-to-safe.ts`, and `cleanUpProdDiamond.ts` reaches the TS `sendOrPropose`
through several positional helpers. Neither is closed to a flag —
`cleanUpProdDiamond.ts` already threads a signing-options object down those same
hops — they are simply unwired. The rest are the `script/tasks/propose*.ts`
mapping scripts and `parked-tasks.ts`, which carry no entry-point check either,
so they are refused at store time — after a signature has been spent. Where flag
and variable are both set the flag wins, and a valueless `--ticket` falls
through to the variable rather than consuming the slot.

Entry points:

- **`script/deploy/safe/propose-to-safe.ts`** (`runPropose`) — the main
  funnel, invoked by the bash `sendOrPropose` chokepoint in
  `script/helperFunctions.sh`, by `script/tasks/diamondUpdateFacet.sh`,
  `diamondUpdatePeriphery.sh`, and `diamondEMERGENCYPause.sh` (all with
  `--timelock`), programmatically by `proposeDiamondCut`
  (`script/deploy/shared/propose-diamond-cut.ts`), and manually via
  `bun propose-safe-tx`.
- **TS `sendOrPropose`** (`script/safe/safeScriptHelpers.ts`) — used by
  `script/tasks/cleanUpProdDiamond.ts`. Signs the Safe proposal with
  `PRIVATE_KEY_PRODUCTION` by default, or with a Ledger via `--ledger`
  (`--ledgerLive` + `--accountIndex <n>`, or `--derivationPath <path>`).
  Refused rather than silently accepted: the two path options together, a
  non-integer `--accountIndex`, a non-zero `--accountIndex` without
  `--ledgerLive` (the Ledger Live path is the only one that reads it), a blank
  `--derivationPath`, `--ledgerLive` or `--derivationPath` without `--ledger`,
  any value other than `true`/`false` on `--ledger` / `--ledgerLive`, any of the
  four flags passed twice, and `--ledger` on a run that would propose more than
  once — `--all-networks`, or a `--periphery` selection naming several
  contracts, since each proposal opens its own unclosed Ledger connection and
  asks for its own device confirmation. The signer is checked against the Safe's
  owners before the proposal is stored. The direct-send path still signs with the
  environment key and warns that `--ledger` is ignored, but the flag-format and
  multi-proposal refusals run before the route is chosen, so a malformed signing
  flag also fails a staging or testnet run.
- **Deferred-cleanup drain** (`script/deploy/safe/drain-parked-tasks.ts`) —
  gated on `DRAIN_PARKED_TASKS`, hooked at the tail of `runPropose`
  ([DeferredDiamondCleanupQueue.md](./DeferredDiamondCleanupQueue.md)).
- **Bespoke task scripts** that store proposals directly:
  `script/tasks/proposeMegaETHBridgeRegistrations.ts`,
  `proposeDeBridgeDlnChainIdMappings.ts`,
  `proposePolymerCCTPChainIdMappings.ts`, `unpauseAllDiamonds.ts`,
  `script/deploy/safe/add-safe-owners-and-threshold.ts`, and two more chain-id
  mapping tasks (`proposeAllBridgeChainIdMappings.ts`,
  `proposeFraxChainIdMappings.ts`) — there is **no single chokepoint**. All of
  them reach `storeTransactionInMongoDB` directly rather than through
  `propose-to-safe.ts`, so the deploy gate below does not see them. None encodes
  a `diamondCut` today, so none installs facet code; the list is what
  `grep -rn storeTransactionInMongoDB script/` returns, not a fixed set, so
  check it rather than trusting this sentence.
- **Tron** is a parallel flow (`script/deploy/tron/propose-to-safe-tron.ts`).

The proposal funnel additionally runs the production deploy gate before it signs
anything (PR #2128 / EXSC-687, re-homed by EXSC-704). It sits in
`propose-to-safe.ts` and `propose-to-safe-tron.ts` rather than in each caller, so
every path that *proposes* reaches it once per proposal — including the bash
`sendOrPropose` chokepoint in `script/helperFunctions.sh` on its propose route.
(The identically-named TypeScript `sendOrPropose` in
`script/safe/safeScriptHelpers.ts` proposes without either funnel and carries
the gate call inline instead; §4.2 says why.)

**A proposal is not the only way a cut reaches a production diamond, and the
funnel gate only sees proposals.** `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true`
broadcasts the cut straight from the deployer key, reaching neither funnel, so
`script/tasks/diamondUpdateFacet.sh` gates that route itself through
`assertDirectBroadcastDeployGate` — keyed on facet names, since there is no
proposal calldata to read. The two gates are disjoint: a cut is gated by the
funnel or by the shell, never both, and never neither. The bash `sendOrPropose`
direct route (`script/helperFunctions.sh`, the `universalCast sendRaw` branch)
is **not** gated today; it never was, and closing it is tracked separately.

The funnel is handed calldata, not
facet names, so `funnel-deploy-gate.ts` recovers the facet set from the cut:
`diamondCut` Add and Replace entries, unwrapping a timelock `scheduleBatch` so a
pre-wrapped payload cannot slip past, then attributed to a contract name through
the network's production deployment log. A `Remove` entry installs no code and is
out of scope; an address the log cannot attribute, and a `diamondCut` selector
whose arguments do not decode, are both refused rather than treated as "not a
cut" — as is a call that is not well-formed `0x`-prefixed calldata, because every
selector and offset is read positionally and a skip would be a pass. One refusal
has no self-service route: a few production logs record a name whose source has
since been superseded (`GenericSwapFacet` → `GenericSwapFacetV3`,
`LiFiIntentEscrowFacet` → `LiFiIntentEscrowFacetV2`), so a `Replace` cut pointing
back at one of those addresses is refused for having no `src/Facets/<name>.sol`.
That is the gate working — the checkout genuinely cannot vouch for that code —
but it needs a human decision, not a workaround. A production deploy is allowed when each
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
(`git diff --ignore-submodules=untracked`, which catches both a submodule checked out
off its recorded commit and one with modified tracked files, while ignoring stray
untracked files that change no bytecode — most of these submodules do not gitignore
`.DS_Store`, so the stricter `none` would block every deploy from a Mac); a divergence
there is not excused by an open PR or an audit freeze. The remote calls run with
prompts disabled and a 30 s timeout, so a stalled or credential-prompting remote fails
the gate instead of hanging the rollout. Staging is not gated, and neither are
testnets — deploying an unmerged facet to a testnet is how it is validated before
the audit, and no Safe is involved there.

The gate runs once per proposal — a cut adding three facets is one evaluation, where
the retired `diamondUpdateFacet.sh` call site was one per *(network, facet)*. For a
fixed branch and environment its
verdict depends only on the working tree and the facet set, so a fleet rollout would
otherwise recompute the same answer for
every network — 71 `ls-remote` round trips and 71 chances for a flaky remote to abort the
rollout fail-closed, with the concurrent workers of `proposeContractToNetworks.sh` racing
each other's `git fetch` on `refs/remotes/origin/main.lock`. A **pass is therefore
recorded once per run** and reused while the tree stays put
(`script/deploy/github/deploy-gate-cache.ts`, PR #2286): keyed on `HEAD` plus the content
of the diff against it — not merely the `git status` file names, which do not change when
an already-modified file is edited again — plus the branch, the facet set, and the
environment. The record lives in the checkout's git directory rather than a
world-writable temp directory, and the full key is re-compared on read, so a planted
entry cannot stand in for a different tree. Only a **pass** is ever recorded: a failing
gate aborts the rollout, so there is nothing to save, and a cached failure could outlive
the PR that was opened to satisfy it. Anything unexpected — an unreadable, unparsable, or
expired record, or a git command that fails while the key is built — is a miss, never a
pass, and the check runs for real. What the cache does trade away is freshness within a
run: for up to 30 minutes the rollout is judged against `origin/main`, and against the
open-PR lookup, as they stood at its first invocation — so `main` moving, or the anchoring
PR being closed, does not stop the remaining networks. Both are benign for a single
operator action on an unchanged tree, and `DEPLOY_GATE_SKIP_VERDICT_CACHE=true` forces a
fresh verdict. Concurrent invocations
take a single-flight lock, so exactly one of a rollout's workers does the network work and
the rest reuse its verdict.

Note what this gate does and does not assert. It enforces **main-equivalence**,
with an audited-freeze exception for unmerged code; it does not verify that what
reaches production was audited, because code that matches `main` passes without
any audit lookup at all. True audit enforcement is the separate bytecode ↔ audit
attestation item in §9. The check is further **not** a GitHub SC+auditor
review check.

There are **three** gate call sites, all calling the same module:
`propose-to-safe.ts`, `propose-to-safe-tron.ts`, and the TypeScript
`sendOrPropose` described at the end of this section. `diamondUpdatePeriphery.sh`,
`diamondEMERGENCYPause.sh`, `proposeDiamondCut`
(`script/deploy/shared/propose-diamond-cut.ts`, the funnel the six Tron
`deploy-and-register-*-facet.ts` scripts route through) and the bash
`sendOrPropose` in `script/helperFunctions.sh` all reach it, because all of them
propose through `propose-to-safe.ts` or `propose-to-safe-tron.ts`. What decides
whether the gate does anything is the **calldata**, not which script called: a
proposal whose calls encode no facet-installing `diamondCut` is skipped. So
periphery registration and emergency pause pass through untouched without being
exempted by name. **The only exemption is the network**: any chain whose
`config/networks.json` type is `testnet`, which is how `tronshasta` stays open.
There is deliberately no environment exemption — reaching a funnel for a
non-testnet network means proposing to a production Safe and signing with the
production key, since a staging deploy sends straight to the diamond rather than
proposing. The shell gate on the direct-broadcast route reads the environment
because it has no calldata to judge instead, and it matches `!= staging` rather
than `== production` so it stays at least as broad as the key `getPrivateKey`
hands out.

Facet **removals** are outside it for the same reason rather than by exemption:
`cleanUpProdDiamond.ts` and the deferred-cleanup drain (`drain-parked-tasks.ts`,
which folds extra removal calls into whatever proposal `runPropose` is already
building) propose real diamond cuts, but a `Remove` entry carries the zero
address and installs no bytecode, so a main-equivalence check has nothing to
compare. Their safety comes from the removal-specific controls in the table
below.

**One propose path does not go through either funnel**, and it is not the bash
`sendOrPropose`: the identically-named **TypeScript** `sendOrPropose`
(`script/safe/safeScriptHelpers.ts`) signs and stores a proposal itself. It is the
third call site, carrying the same gate call inline so the two cannot diverge. A
*fourth* proposer written against `storeTransactionInMongoDB` directly would not
be covered — see the bespoke task scripts listed in §4.1, and the `sendOrPropose`
gap recorded in
[DeferredDiamondCleanupQueue.md](./DeferredDiamondCleanupQueue.md) §6.

Two limits of the gate worth stating plainly. Its unknown-envelope backstop reaches
exactly "the `diamondCut` selector, verbatim and byte-aligned": an envelope that
splits or transforms those bytes and reassembles them on chain is not caught, and
would need a bespoke batcher the Safe was pointed at. And parked-task removals
folded in by the drain (`drain-parked-tasks.ts`) are appended *after* the gate runs,
which is safe only because that path builds Remove cuts in process and never
replays stored calldata.

`runPropose` owner-gates the proposer on-chain; with `--timelock` it wraps all
calls into one `scheduleBatch` via `wrapWithTimelockSchedule` (`safe-utils.ts`;
live `getMinDelay()` with `config/timelockController.json` fallback, timestamp
salt), resolves the nonce (`getNextNonce`), **signs immediately** (`eth_sign` over the `safeTxHash`),
computes the `safeTxHash` via the Safe's on-chain `getTransactionHash`, and
stores. The document (`ISafeTxDocument`) carries the raw Safe tx fields, the
proposer's wallet address, an `intentHash` dedup key, a
`pending → submitted → executed / reverted` status, the origin-PR
`parkedTaskRefs` on a drained facet removal, and a `provenance` block
(`IProposalProvenance`) holding the rationale, proposer identity and actor, git
commit and branch, scoped working-tree dirtiness, the branch's PR link and any
capture errors. **Rows stored before that block existed carry none of it**,
which is why both the signing prompt and the Slack card state each absence
explicitly instead of dropping the line.
`notifyProposalsCreatedToSlack` (`script/multiNetworkExecution.sh`) posts the
signing-ask card rendered by `script/deploy/safe/render-proposal-card.ts` —
reason, proposer, PR, commit, working-tree state and a per-network
`bun confirm-safe-tx` command — to `#dev-sc-multisig-proposals`, falling back to
a count + contract + network line only if the render fails.

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
3. The value to verify on the device, which depends on the signing mode. In
   the default hash mode: the single message screen, compared character by
   character against the hash in the out-of-band message from the proposer —
   not against the hash stored with the proposal, which the proposer controls
   alongside the calldata. Under `ENABLE_SAFE_EIP712_SIGNING=true`
   and only when the transaction carries calldata: a **Ledger Flex
   "filmstrip"** (`renderLedgerFlexFlow`, `ledger-flex-preview.ts`), an ASCII
   replica of the device screens for the exact to-be-signed values.
4. **The sign-time codehash gate** (`codehash-sign-gate.ts`, deciding through
   `script/deploy/codehash/`). Where the calldata decodes to a `diamondCut` —
   timelock-wrapped and batched frames included — every address the cut would
   install is compared against a local rebuild at the commit that address's
   production deployment record names. **Not** against `main`: per D3 the
   verifier asserts that the commit is present and fetchable, never that it is
   an ancestor of `main`. The verdict **blocks the signature**, and `MATCH`,
   `MISMATCH` and `UNVERIFIABLE` stay three separate buckets — both of the
   latter stop a signature but they are different facts, and collapsing them is
   what teaches a signer to click through grey. A removal installs nothing and
   is not gated; a removal-only cut carrying `_init` is refused outright,
   because `_init` is delegatecalled in the diamond's own storage context
   whatever the entries describe. It judges the normalised transaction, the same
   struct that gets hashed and signed, so what it vouches for cannot drift from
   what the device shows.

   Infrastructure failures block as well, and they land in two different places
   depending on how far the gate got. One that stops it reaching any verdict —
   an unreadable `foundry.toml`, so the legitimate toolchain set cannot be
   derived — is a **refusal**, rendered `⛔ REFUSED`, because there is no verdict
   to render. One that stops it judging a *particular address* — an RPC that
   will not answer, an attestation store that is down — is that address's
   verdict, and it is **`UNVERIFIABLE`**, the same grey bucket as an address with
   no attested build. Both stop the signature; neither is ever a pass, because
   "we could not check" and "we checked and it is fine" are the pair this gate
   exists to keep apart. Worth knowing when reading a grey line: it means the
   check did not conclude, not necessarily that a rebuild is missing.

   Three limits are put on screen rather than hidden. A hash match with bytes
   excluded as immutables renders grey rather than green, until the
   per-immutable check (WP-2.3) can price those bytes. Calldata this decoder
   cannot open makes **no claim** — it names the frames it could not read
   instead of reporting a pass. And calldata that decodes to no cut at all is
   outside its scope and says so; a proposal with empty calldata prints no gate
   line, because there is nothing to judge.

5. The action prompt: `Do Nothing` / `Sign` / `Sign & Execute` /
   `Sign and Execute With Deployer` / `Execute with Deployer`. The two
   deployer variants are the usual choice — see §2 on why the deployer
   wallet broadcasts.

Signing is `eth_sign` over the `safeTxHash`, read from the Safe's own
on-chain `getTransactionHash` so the digest is correct for that Safe's version.
The device shows one value, which is the value the signer compares against the
out-of-band message — rather than a typed-data payload hardware wallets render
inconsistently and reject outright once it grows large. EIP-712 typed data
remains available behind `ENABLE_SAFE_EIP712_SIGNING=true`; there is no
automatic switch between the two, because a mode change mid-flow re-prompts the
device in a different rendering than the one the signer was reading. Each owner
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
| Propose | Proposer must be a current Safe owner (on-chain `getOwners()`) | Block | `propose-to-safe.ts` (`runPropose`), `safeScriptHelpers.ts` (`sendOrPropose`) |
| Propose | Ledger signing flags: unambiguous value, no repeat, no unusable combination, no multi-proposal run (see the `sendOrPropose` bullet in §3) | Block | `script/deploy/safe/cli-flags.ts`, `resolveSafeSigningOptions` in `safe-utils.ts`, `cleanUpProdDiamond.ts` |
| Propose | Nonce safety: override collision checks, auto-nonce clamped to on-chain | Block / auto-correct | `propose-to-safe.ts`, `getNextNonce` in `safe-utils.ts` |
| Propose | Duplicate-intent dedup (partial unique index on pending rows) | Block insert | `computeProposalIntentHash` + index in `safe-utils.ts` |
| Propose | Timelock-wrapped proposals dedup on every EVM path: the `scheduleBatch` salt is derived from the action (chain, timelock, targets, payloads, attempt) instead of the clock, so re-proposing the same wrapped work yields the same salt while that candidate is still free. The timelock is asked whether that operation id exists — **pending blocks** (the proposal duplicates work already scheduled and not executed), **executed** advances to the next deterministic salt so a legitimate repeat does not revert after signing, and 16 taken attempts refuse. Same salt is not the same calldata: `minDelay` is also a `scheduleBatch` argument, so **Safe intent dedup** (`computeProposalIntentHash`) does not apply across an `updateDelay`, nor across `wrapWithTimelockSchedule`'s `getMinDelay` fallback (the task scripts have no fallback — a failed read throws). The **timelock** check is unaffected: `hashOperationBatch` hashes targets, values, payloads, predecessor and salt only, so the pending/executed states still hold across a delay change. **The Tron proposal path still uses a clock salt** and is not covered | Block (pending) / auto-advance (executed) / refuse after 16 | `pickTimelockSalt` in `safe-utils.ts` + `deriveTimelockSalt` in `timelock-abi.ts`; reached via `wrapWithTimelockSchedule` (from `propose-to-safe.ts` and `cleanUpProdDiamond.ts`) and directly from the five `script/tasks/propose{AllBridge,PolymerCCTP,Frax,DeBridgeDln,MegaETHBridge}*.ts` batch builders |
| Propose | Every proposal carries a Linear issue link, from `--ticket` or `SAFE_PROPOSAL_TICKET`. The shape is validated, so a non-Linear or malformed URL is refused rather than recorded as "a link". Checked before the insert, so a refused proposal is never created and claims no nonce | Block insert | `resolveProposalIntent` in `proposal-intent.ts`, called from `storeTransactionInMongoDB` |
| Propose | One-line reason (`--reason` / `SAFE_PROPOSAL_REASON`). Optional, warned once per process — OQ3 flips it to mandatory once the warning has fired zero times across 30 consecutive proposals | Warn | `proposal-intent.ts`; read the trigger with `report-reason-adoption.ts` (read-only) |
| Propose | In-flight nonce uniqueness per Safe: concurrent proposers may still derive the same nonce, but only one insert survives (partial unique index over `pending` + `submitted`, compared case-insensitively so the Tron and EVM spellings of one Safe collide). The guarantee is **absent** if the index could not be built — in-flight rows already sharing a nonce, or a role without `createIndex` — and the build warns in both cases. Nothing is ever dropped, so a pre-`_ci` index from an earlier build stays as a weaker, redundant constraint | Block insert, re-run required | `unique_inflight_safe_nonce_ci` index in `safe-utils.ts`; diagnose with `report-nonce-collisions.ts` (read-only) |
| Propose | Removal safety: protected-facet allowlist, live-selector hold-back, fail-closed diffs | Block + alert | `diamondRemovalDiff.ts`, `drain-parked-tasks.ts` |
| Propose | Production: each facet the cut installs must have its `src/` import closure match `origin/main`, else open PR + audit-log commit freeze (audit log read from `main`); judged on the working tree, so a checkout on `main` is not exempt; testnets are not gated, and there is no environment exemption | Block (prod non-testnet facet **additions and replacements**, on every path that reaches either funnel, the bash `sendOrPropose` included, plus the TypeScript `sendOrPropose` which carries the same call inline — periphery registration, emergency pause and removals install no facet code and are out of scope) | `funnel-deploy-gate.ts` in `propose-to-safe.ts` / `propose-to-safe-tron.ts`, deciding through `script/deploy/github/verify-approvals.ts`; verdict cached per run by `deploy-gate-cache.ts`, passes only (PR #2128, #2286, EXSC-929). **Caveat on Tron:** cut proposals are run from a `contracts-tron` checkout ([TronFork.md](./TronFork.md)), and the gate compares whatever working tree it is run in against *that* checkout's `origin/main` and audit log — not `lifinance/contracts` main |
| Confirm | Signer must be an owner; network must be active; threshold and nonce read on-chain per Safe | Block / skip | `confirm-safe-tx.ts`, `safe-utils.ts` |
| Confirm | `operation` must be exactly `Call` (0). A DelegateCall, or any other value, on the signed struct is refused before `SafeClient` signs or broadcasts — decoded calldata is not consulted. Sign/Execute options are hidden | Block | `delegatecall-gate.ts`, `SafeClient.signTransaction` / `executeTransaction` |
| Confirm | Ledger blind-signing enabled, fail-fast before any review | Block | `checkBlindSigningEnabled` in `ledger.ts` |
| Confirm | Sign-time codehash gate: every address a decoded `diamondCut` installs — `Add`/`Replace` targets plus a non-zero `_init` — must match a local rebuild at the commit its production deployment record names, under the toolchain that network's `foundry.toml` profile pins. **Not** an ancestry check against `main` — per D3 the referenced commit need only be present and fetchable, so this row is anchored differently from the Propose row above it. MATCH passes; MISMATCH and UNVERIFIABLE both block and stay distinct. A removal-only cut carrying `_init` is refused rather than gated. A MATCH with bytes excluded as immutables is downgraded to UNVERIFIABLE until WP-2.3 checks their values, and calldata the decoder cannot open makes **no claim** rather than reporting a pass. Asserted on both the sign and the execute route, not only at signature time — a proposal already at threshold is broadcast through a different funnel. Infrastructure failures block too, in two places: one that stops any verdict being reached (config unreadable) is a refusal, while one that stops a single address being judged (RPC or attestation store unreachable) is that address's `UNVERIFIABLE` verdict | Block | `codehash-sign-gate.ts` + `codehash-sign-gate-deps.ts` in `confirm-safe-tx.ts`, deciding through `script/deploy/codehash/` (EXSC-906) |
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
- **Bytecode of anything a cut does not install.** The sign-time codehash gate
  (§4.3) machine-asserts the facet addresses and `_init` target of a decoded
  `diamondCut` and nothing else — a fee change, a role grant or an ordinary
  call is displayed and not vouched for, and it says so rather than leaving the
  signer to infer it. One exception, in the safe direction: calldata it cannot
  open is byte-scanned for the `diamondCut` selector, and a hit **blocks**, so
  an unknown envelope carrying a cut is not merely displayed.
- **That an attested commit is on `main`.** The gate rebuilds at the commit each
  deployment record names and compares bytes; per D3 it asserts that commit is
  present and fetchable, not that it is an ancestor of `main`. Code deployed
  honestly from an unmerged branch therefore reads MATCH. The audit/approval
  gate at Propose time (§5) is what anchors content to `main`, not this.

## 7. Emergency path

This is the one **break-glass** path, and it is deliberately asymmetric: the
fast, non-Safe leg can only *reduce* the diamond's capabilities, never grant
or change any. Restoring capability always requires the Safe.

**A Linear ticket is required here too — there is no break-glass exemption.**
Both unpause routes are ordinary Safe proposals, so the mandatory ticket link
applies unchanged: `export SAFE_PROPOSAL_TICKET=<url|TEAM-123>` before running
`unpauseAllDiamonds.ts` or `diamondEMERGENCYPause.sh`. `unpauseAllDiamonds.ts`
also takes `--ticket <url|TEAM-123>`; `diamondEMERGENCYPause.sh` has no flag of
its own, so there the exported variable is the only channel. An incident is when
the record matters most, and the cost is one `export` before anything is signed.
The check runs at each script's
entry rather than only in `storeTransactionInMongoDB`, because the funnel check
alone spends a signature per network before refusing — and on
`unpauseAllDiamonds.ts` the per-network `catch` then swallows the refusal, so a
fleet-wide run ends with zero mainnets unpaused and no obvious cause.

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
| `script/safe/safeScriptHelpers.ts` | TS `sendOrPropose` (env key or `--ledger`) |
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
  source-file freeze in the proposal funnel is a different check already
  described in §4.2 / §5 — it is not bytecode attestation, and it judges
  source files rather than the deployed bytes.)
