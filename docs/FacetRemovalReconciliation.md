# Facet Removal Reconciliation

Design doc / spec for automatically removing deprecated facets from production
diamonds. Ticket: **EXSC-193** follow-up #2 (on-chain removal of the facets
deprecated in PR #2046 — `GenericSwapFacet`, `AcrossFacetPacked`,
`AcrossFacetPackedV3`, `AcrossFacetV3`). Parent epic: **EXP-350** "Deprecation of
GenericSwapFacet and old Across facets".

Status: **proposed** (draft PR). Author: Daniel B. (SC).

---

## 1. Problem

`/deprecate-contract` (`.agents/commands/deprecate-contract.md`) removes a facet
from the **codebase** only: source, deploy/update scripts, tests, docs,
`script/deploy/_targetState.json` (all networks), and the `coreFacets` array in
`config/global.json`. It does **not** touch any deployed diamond.

The result: the facet's selectors stay registered and callable on every
production `LiFiDiamond` forever. Today the only remedy is running
`script/tasks/cleanUpProdDiamond.ts` **by hand, per network**, naming the facets
explicitly — 71 mainnet production diamonds, one interactive invocation each.
That has not been done systematically, so orphaned facets accumulate.

Two structural gaps make this worse than "just run the script 71 times":

- **The manual script can't remove an _already-deprecated_ facet.**
  `cleanUpProdDiamond.ts`'s headless path derives selectors via
  `getFunctionSelectors(name)`, which reads `out/<Name>.sol/<Name>.json`
  (`script/utils/viemScriptHelpers.ts:357`). Once deprecation deletes the
  source, that artifact never rebuilds, so the exact case we care about
  (removing a facet after it was deprecated) throws. The on-chain loupe is the
  only reliable selector source post-deprecation.
- **No diff.** Nothing computes _which_ facets are stale. The operator must
  already know the list and type it in.

The routine per-facet upgrade flow does not help either. `UpdateScriptBase.sol`
(`buildDiamondCut`, lines 139–210) only reconciles add/replace/remove of
selectors **within the single named facet being updated**; it never removes a
facet that was dropped from target state, because no update script names a
deleted facet.

## 2. Facts ledger

Every load-bearing claim below is verified against the repo checkout (not
inferred). `[code]` = read directly this session.

1. `[code]` Deprecation strips the facet from `_targetState.json` and from
   `config/global.json.coreFacets` — `.agents/commands/deprecate-contract.md`
   §2, §4.
2. `[code]` `buildDiamondCutRemoveCalldata({name, selectors}[])` builds a single
   `diamondCut` with `facetAddress=0`, `action=2` (Remove), one `FacetCut` per
   named facet — `script/utils/viemScriptHelpers.ts:419`.
3. `[code]` `cleanUpProdDiamond.ts` production path: build remove calldata →
   `wrapWithTimelockSchedule` → `sendOrPropose` (Safe + MongoDB). Staging /
   testnet / `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true` → direct broadcast, no
   timelock — `script/tasks/cleanUpProdDiamond.ts:53`, `script/safe/safeScriptHelpers.ts:29`.
4. `[code]` Headless facet removal derives selectors from `out/` (breaks for
   deprecated facets) — `cleanUpProdDiamond.ts:227`, `viemScriptHelpers.ts:357`.
5. `[code]` `_targetState.json` shape: `network → environment → "LiFiDiamond" →
   {contractName: version}`; facets and periphery are flat siblings; value is a
   semver string, **not** an address — `script/deploy/safe/facet-version-utils.ts:105`.
6. `[code]` Addresses live in `deployments/<network>.json` /
   `deployments/<network>.staging.json` as a flat `{name: address}` map;
   `getDeployments(network, environment)` returns it — `script/utils/deploymentHelpers.ts:26`,
   `viemScriptHelpers.ts:329`.
7. `[code]` `healthCheck.ts` inverts that map to resolve on-chain facet
   address→name, but its diff is **one-way** (flags target-state facets missing
   on-chain); it has no reverse "on-chain facet absent from target state" check,
   and silently drops on-chain addresses it can't resolve —
   `script/deploy/healthCheck.ts:363`–`408`.
8. `[code]` Protected sets: `getCoreFacets()` / `getCorePeriphery()` read
   `config/global.json` — `script/deploy/shared/globalContractLists.ts`. Current
   `coreFacets` includes `DiamondCutFacet`, `DiamondLoupeFacet`, `OwnershipFacet`,
   `EmergencyPauseFacet`, `AccessManagerFacet`, `PeripheryRegistryFacet`,
   `WhitelistManagerFacet`, `WithdrawFacet` (+ business facets like
   `GenericSwapFacet`).
9. `[code]` Production rollouts already emit **one timelock-wrapped Safe proposal
   per contract per network** (`propose-to-safe.ts --timelock`), all captured
   into one PR + one signing session by `list-pending-proposals.ts` —
   `.agents/commands/multisig-rollout.md`.
10. `[code]` `LiFiDiamondImmutable` exists in prod deploy logs and cannot be cut;
    the mutable diamond is `LiFiDiamond` — `deployments/mainnet.json`.
11. `[code]` Scale: 78 networks in `_targetState.json`; 76 active (71 mainnet
    production, 5 testnet) — `config/networks.json`, `jq` counts this session.
12. `[observed]` **`on-chain ∖ target-state` ≠ deprecated.** A live smoke run of
    the engine against the real mainnet diamond found 8 facets on-chain and
    absent from target state that are **not** deprecated — `PaxosTransitFacet`,
    `MegaETHBridgeFacet`, `PolymerCCTPFacet`, `AcrossV4SwapFacet`,
    `NEARIntentsFacet`, `EcoFacet`, `GardenFacet`, `UnitFacet` — i.e. target
    state simply *lags* live deployments. A naïve diff would have proposed
    removing all 8. The discriminator: a **deprecated** facet has had its `src/`
    source deleted by `/deprecate-contract`; a drifted-but-live facet still has
    its `.sol`. Source-presence is therefore a hard removal gate (§5.1 step 7).

## 3. Goals / non-goals

**Goals**

- **Primary:** when a facet is deprecated via `/deprecate-contract`, **park** a
  removal task per (facet, network) into the deferred diamond-cleanup queue —
  keyed by the explicit facet name + the deployment logs (the authoritative
  facet→address map per network). No proposal is created at deprecation time; the
  parked task is drained into one peer-reviewed Safe proposal per network on a
  later rollout. See
  [docs/DeferredDiamondCleanupQueue.md](./DeferredDiamondCleanupQueue.md).
- **Backstop:** reconcile deployed `LiFiDiamond` facets against
  `_targetState.json` to catch orphans that nobody explicitly deprecated
  (historical, or deployed to the wrong chain).
- Both go through the **existing** Safe + timelock governance path — no new
  bypass — via one shared set of engine + proposal helpers.
- Removals are conspicuous and hard to fat-finger, because they are
  irreversible timelock+Safe actions.

**Non-goals (v1)**

- Periphery de-registration. `cleanUpProdDiamond.ts` already does it manually;
  reconciling periphery against `_targetState.json` is a follow-up. v1 is
  facets-only, matching the EXSC-193 scope.
- Removing selectors from `LiFiDiamondImmutable` (impossible by design).
- Auto-executing anything. The mechanism only **proposes**; humans sign, the
  timelock delays.

## 4. Two selection signals, one plumbing

The removal **plumbing** (loupe selectors → `buildDiamondCutRemoveCalldata` →
timelock wrap → `sendOrPropose`) is shared. What differs is *how the facets to
remove are selected*:

### Named (primary) — driven by `/deprecate-contract`

The deprecation **names** the facet. So the removal is explicit: for each named
facet, find the PROD diamonds whose deployment log lists it and **park** a
removal task per (facet, network) into the deferred diamond-cleanup queue. No
diff, no target-state dependency, no source/drift gate needed — the operator has
stated intent. At **drain** time the engine reads the facet's current selectors
from the on-chain loupe and proposes the removal, with the same guardrails
(never-remove allowlist, immutable diamond, on-chain verification). The engine is
`computeNamedFacetRemovals` + `cleanUpProdDiamond.ts --facets '[...]'`, consumed
by the drain; `/deprecate-contract` step 6 **parks** via
`script/deploy/safe/enqueue-parked-task.ts`
(see [docs/DeferredDiamondCleanupQueue.md](./DeferredDiamondCleanupQueue.md)).

> **Sequencing constraint:** the parked task snapshots each facet's address from
> `deployments/<network>.json` at enqueue time, and the drain resolves it from
> that snapshot, so those log entries must not be deleted until the parked task
> **retires** (executed, cancelled, or superseded). `/deprecate-contract` warns
> accordingly.

### Diff (backstop) — reconcile loupe vs target state

For orphans nobody explicitly named (historical deprecations, wrong-chain
deploys), diff the on-chain loupe against `_targetState.json`. Here the
source-presence gate is essential to tell *deprecated* (source gone) from
*drift* (target state merely lags — Fact 12). This is `computeFacetRemovalDiff`

+ `--auto` / `--all-networks`, and it's what the opportunistic rollout step (B)
and the eager sweep (A) below consume.

The delivery-timing choice (A vs B) applies to the **backstop**; the named path
**parks** at deprecation time by construction and drains on the next rollout to
each network.

### (A) Eager fleet sweep

On deprecation, run the reconciliation across all networks at once, producing a
dedicated removal proposal per network.

- **Pro:** stale facets gone everywhere immediately; deterministic.
- **Con:** up to 71 mainnet Safe proposals in one batch. Every one needs Ledger
  signatures from ≥ quorum signers + a timelock delay. That is heavy, and worse,
  it invites rubber-stamping — signer fatigue is itself a security risk on
  irreversible actions.

### (B) Lazy / opportunistic (recommended core)

Add a reconciliation **step** to the routine per-network production rollout
(`multisig-rollout`). Whenever any facet is deployed/updated on a network, the
step also computes that network's stale-facet drop-set and emits **one
consolidated removal proposal** (all of the network's stale facets in a single
`diamondCut` Remove call). It is captured by the same
`list-pending-proposals.ts` sweep, lands in the same PR, and is signed in the
same session as the upgrade proposals.

- **Pro:** near-zero marginal signing load — the signers are already in session
  for that network. Naturally batched. No dedicated "removal day".
- **Con:** a network that never gets another rollout keeps its orphans until it
  does. Acceptable, and covered by (A) as an escape hatch.

> **Why not literally the _same_ Safe transaction as the upgrade?** The upgrade
> cut is built in Solidity (`UpdateScriptBase.sol`, per facet); the removal cut
> is built in TypeScript. Merging them into one on-chain `diamondCut` would mean
> threading removal logic through the audited deploy scripts and across the
> language boundary. `propose-to-safe.ts` can `scheduleBatch` multiple calls into
> one Safe proposal, but wiring that to a specific deploy invocation couples
> removal to deploy timing for little benefit. **One extra proposal per network,
> in the same signing session**, delivers the batching goal without touching
> Solidity. (Fact 9.)

### (C) Hybrid — chosen

The named path (primary, §4 above) **parks at deprecation time** — that's where
"remove this specific facet" belongs, and it's what `/deprecate-contract`
drives — then drains into the same rollout-batched proposal later, so deprecation
never triggers a standalone mass signing event. The backstop diff engine is then
consumed for orphans nobody named, at a delivery timing that avoids a mass
signing event:

- **(B)** an opt-in step in `multisig-rollout` — orphans ride out on the next
  rollout's signing session.
- **(A)** `--auto --all-networks` on the CLI — the deliberate, on-demand sweep
  (e.g. periodic hygiene), the escape hatch for networks that rarely roll out.

Everything (`diamondRemovalDiff.ts` engine, named + diff selection, all three
CLI modes) feeds the **same** `cleanUpProdDiamond.ts` build → timelock-wrap →
propose plumbing (Fact 3). Recommendation: **ship all of it now** — the named
path wired into `/deprecate-contract` as a **park** into the deferred cleanup
queue (primary), the diff backstop as `--auto`

+ the opt-in rollout step. Rationale in §8.

## 5. Architecture

### 5.1 Engine — `script/deploy/safe/diamondRemovalDiff.ts` (new)

Pure, side-effect-free, unit-tested. Exposes both selection functions
(`computeFacetRemovalDiff` for the backstop, `computeNamedFacetRemovals` for the
primary named path), the pure cores (`diffFacets`, `diffNamedFacets`), and the
pre-execute re-validation guard `revalidateRemovalsOnChain` / pure core
`filterRePointedRemovals` — which the deferred-cleanup drain/execute consumer
calls right before executing a queued removal to drop any selector re-pointed to a
live facet (or already gone) during the timelock delay window
(see [docs/DeferredDiamondCleanupQueue.md](./DeferredDiamondCleanupQueue.md)).
Signature (illustrative):

```ts
export interface IFacetRemoval {
  name: string
  address: `0x${string}`
  selectors: `0x${string}`[] // taken from the on-chain loupe
}
export interface IRemovalDiff {
  network: string
  environment: EnvironmentEnum
  removals: IFacetRemoval[]
  protectedSkipped: string[]        // on-chain, absent from target state, but on the never-remove allowlist
  unresolved: `0x${string}`[]       // on-chain facet addresses not found in the deploy log
  heldBackSelectors: {              // selectors an active facet is expected to own — refused, mis-wiring signal
    facet: string
    selectors: `0x${string}`[]
  }[]
  targetStateMissingProtected: string[] // allowlisted facet dropped from target state (target-state bug)
  driftDetected: string[]               // on-chain, absent from target state, but source still exists — NOT removed
}

// Backstop path: diff loupe vs target state (needs the source/drift gate).
export async function computeFacetRemovalDiff(
  network: string,
  environment: EnvironmentEnum,
  io?: Partial<IRemovalDiffIO>, // all I/O injectable for tests
): Promise<IRemovalDiff>

// Primary path: explicit names (from /deprecate-contract). No diff, no source
// gate — just "is it on this diamond" + never-remove allowlist.
export async function computeNamedFacetRemovals(
  network: string,
  environment: EnvironmentEnum,
  names: string[],
  io?: Partial<IRemovalDiffIO>,
): Promise<INamedRemovalResult>
```

**Algorithm**

1. Resolve the mutable diamond address from the deploy log (`LiFiDiamond`). If
   absent for this network/environment, return an empty diff (nothing to do).
2. `expected` = the set of keys under
   `_targetState[network][environment]["LiFiDiamond"]` (facets **and** periphery
   — anything listed is treated as "keep"). **If the network has no `LiFiDiamond`
   target-state block at all, `computeFacetRemovalDiff` THROWS** rather than
   treating it as "expects zero facets": an absent network would classify every
   on-chain facet as a removal candidate. The fleet loop records the throwing
   network as failed and continues. (Fact 5.)
3. On-chain truth: call `facets() → ((address,bytes4[])[])` on the diamond. Each
   entry gives an address and the selectors the diamond **currently** routes to
   it. (This is the source of truth for _which_ selectors a facet owns.)
4. `addressToName` = invert `getDeployments(network, environment)` (Fact 6),
   case-insensitive — same inversion `healthCheck.ts` uses (Fact 7).
5. `protected` = **hardcoded hard allowlist**
   `{DiamondCutFacet, DiamondLoupeFacet, OwnershipFacet, EmergencyPauseFacet}`
   ∪ `getCoreFacets()` ∪ `getCorePeriphery()` ∪ `{LiFiDiamond, LiFiDiamondImmutable}`.
   The hardcoded four are the diamond machinery whose removal permanently bricks
   the diamond — they are protected **independent of config**, because
   deprecation edits config and we must not let a bad edit make them removable.
6. For each on-chain facet `{addr, sels}`:
   - `name = addressToName[addr]`. **Undefined → `unresolved`**; never removed
     (could be a newer deploy not yet logged, or a rogue addition — a human must
     look). This is strictly safer than `healthCheck`, which drops it silently.
   - `name ∈ protected` → skip. If also `name ∉ expected`, additionally record
     `targetStateMissingProtected` (a target-state bug worth surfacing loudly).
   - `name ∈ expected` → active, keep.
   - `name` still has a `.sol` under `src/` → **drift**, not deprecation (Fact
     12): recorded in `driftDetected`, **never removed**. This is the gate that
     stops the mechanism from removing a live facet whose target-state entry
     merely lags. Only a facet whose source was deleted proceeds. The `src/` root
     is resolved **absolutely from the module location** (not `process.cwd()`),
     so the gate can't silently disable itself when run from another directory.
   - else → **removal candidate**, selectors = `sels` (from the loupe, Fact 4 —
     this is why deprecated facets with no `out/` artifact work).
7. **Shared / re-registered selector guard.** The diamond maps each selector to
   exactly one facet, so no two on-chain facets can share a live selector. The
   real hazard is a selector still pointing at the stale facet that _target
   state expects an active facet to own_ (a missed re-point). Compute
   `expectedActiveSelectors` = ∪ `getFunctionSelectors(name)` over the expected
   names **scoped to real facets only** — names whose source lives under
   `src/Facets/`. This scoping is essential: a target-state `LiFiDiamond` block
   also lists periphery/util contracts (`Executor`, `GasZipPeriphery`,
   `LiFiDEXAggregator`, `Receiver*`, …), whose ABIs are **not** diamond-routed;
   feeding them in would wrongly hold back a deprecated facet's selectors that
   merely share a signature with a periphery ABI (e.g. `GasZipFacet` /
   `GasZipPeriphery` share `GAS_ZIP_ROUTER()`), leaving them dangling after the
   cut. Any candidate selector in the facet-scoped set is **held back** (excluded
   from the removal cut) and reported in `heldBackSelectors`. Scoping to real
   facets also stops one stale periphery/util entry in target state from
   fail-closing (`getFunctionSelectors` throws on a missing artifact) the whole
   fleet sweep. (Guardrail: "handle selectors shared/re-registered across facets.")
8. Return the diff. Empty `removals` ⇒ nothing to propose for this network.

The **named** path (`computeNamedFacetRemovals` / `diffNamedFacets`) additionally
returns `unresolved: 0x…[]` — on-chain facet addresses absent from the deploy log.
A requested facet registered at an unlogged address (redeploy drift, pruned/stale
log entry, name mismatch) lands there rather than being silently reported as
`notFoundOnChain`, so the operator investigates instead of believing cleanup
succeeded.

### 5.2 CLI — extend `script/tasks/cleanUpProdDiamond.ts`

All modes share `proposeRemovals` (build → timelock-wrap → `sendOrPropose`); no
new proposal code. `--auto`/`--all-networks` sweeps dry-run unless `--yes`. The
**headless `--facets` path requires `--yes` in a non-TTY**: rather than silently
degrading an unconfirmed `prompt` to a no-op dry-run (which would hide a missed
removal from a cron/runbook that expected the old auto-submitting `--facets`
path), it now **exits non-zero** with a message telling the operator to re-run
with `--yes` or in an interactive terminal.

- `--facets '[...]'` — **named (primary)**. Resolves the named facets on the
  diamond via `computeNamedFacetRemovals` (loupe selectors — works after source
  deletion) and proposes their removal. With `--network` for one network, or
  `--all-networks` to hit every network whose PROD log lists them. This is what
  the **drain** invokes (and what a manual on-demand removal uses);
  `/deprecate-contract` step 6 no longer calls it directly — it **parks** the
  (facet, network) tasks, which the drain later feeds through this same
  `--facets` path. (This also replaces the old `out/`-based `--facets` selector
  derivation, which threw for already-deprecated facets.)
- `--auto` — **diff backstop**. Runs `computeFacetRemovalDiff` for
  `--network`, prints the conspicuous diff (§6), proposes the stale set. This is
  the unit `multisig-rollout` Phase 3.5 calls per network.
- `--auto --all-networks` — model (A) eager sweep: `--auto` across every active
  network (skipping diamond-less ones). Per-network branching (prod Safe /
  staging / testnet direct) is handled by `prepareTimelockCalldata` +
  `sendOrPropose`.

The interactive multiselect path is unchanged.

### 5.3 Rollout wiring — `.agents/commands/multisig-rollout.md`

Add an **opt-in** phase (after register, before proposal capture) gated behind
an explicit operator flag (e.g. `--reconcile-removals`) that runs
`cleanUpProdDiamond.ts --auto --network <n> --environment production` for each
target network. Its proposals are captured by the existing
`list-pending-proposals.ts` phase, PR'd and Slack'd by the existing tail
(Fact 9). Off by default in v1 so no rollout silently starts removing facets;
the operator turns it on when a deprecation is in flight.

> **Named-park vs drift-`--auto` overlap.** This drift path is a *different*
> selection signal from the named park (§4). A facet deprecated via
> `/deprecate-contract` is parked into the deferred queue; if the same facet is
> also drift-detected here (absent from target state **and** source-gone) this
> path may propose its removal directly, ahead of the queue draining it. That is
> safe on-chain (one idempotent removal either way), but the now-redundant parked
> task must be reconciled to `superseded`. That reconciliation — and the
> automatic drain of parked tasks during a rollout — is the **drain hook**, a
> deliberate follow-up (see [docs/DeferredDiamondCleanupQueue.md](./DeferredDiamondCleanupQueue.md)
> §6/§10); v1 here only **parks**.

### 5.4 `/deprecate-contract` wiring (primary path)

`.agents/commands/deprecate-contract.md` gains a step 6 "On-chain removal — park
it into the deferred diamond-cleanup queue (facets)": after the codebase removal
**and** after the deprecation PR is opened (so the real PR URL exists), it
enqueues one parked task per (facet, network) via
`script/deploy/safe/enqueue-parked-task.ts --network <n> --facetName <F>
--diamondAddress <d> --facetAddress <f> --prUrl <deprecation PR>`, for every
PROD network whose deploy log lists the facet. No proposal is created at
deprecation time — the parked task is drained into the removal proposal on a
later rollout (see [docs/DeferredDiamondCleanupQueue.md](./DeferredDiamondCleanupQueue.md)).
The command enforces the §4 sequencing constraint: the "Remaining Occurrences"
step warns not to delete `deployments/*.json` facet entries until the parked
task retires.

## 6. Guardrails (non-negotiable)

| Guardrail | How |
|---|---|
| Never-remove allowlist (core + machinery) | Hardcoded `{DiamondCut, DiamondLoupe, Ownership, EmergencyPause}` ∪ `getCoreFacets()` ∪ `getCorePeriphery()`; protected even if dropped from target state (§5.1 step 5). |
| Skip `LiFiDiamondImmutable` | Engine only queries the `LiFiDiamond` address; immutable diamond never referenced (Fact 10). |
| Drift ≠ deprecation (source-presence gate) | **Backstop path only.** A facet on-chain and absent from target state is removed **only if its `src/` source is gone**. Source still present → `driftDetected`, never removed (§5.1 step 6; Fact 12). The named path doesn't need this gate — intent is explicit. |
| Deploy-log sequencing (named path) | The parked task snapshots facet→address from `deployments/<network>.json` at enqueue time, and the drain resolves it from that snapshot. Those entries must not be deleted until the parked task **retires** (executed/cancelled/superseded); `/deprecate-contract` warns accordingly. |
| On-chain loupe is source of truth | Selectors come from `facets()`, never from `out/` for the facet being removed (§5.1 step 3/6; fixes Fact 4). |
| Conspicuous removals | Diff printed as a banner per network: each facet name, address, selector count + list, and any held-back/unresolved items, before any propose; headless requires `--yes`. |
| Shared / re-registered selectors | Held back if an active facet is expected to own them (§5.1 step 7). |
| Unresolved on-chain facets | Never auto-removed; surfaced for human review (§5.1 step 6). |
| Governance path unchanged | Reuses `prepareTimelockCalldata` + `sendOrPropose`: production always wraps in the timelock schedule and proposes to the Safe; staging/testnet use the existing sanctioned direct-send. No new owner/emergency path (`.agents/rules/002-architecture.md` §GOVERNANCE, `105-security.md`). |

### Governance flow — who signs / broadcasts / `msg.sender` / authorization

| Branch | Signs | Broadcasts | `msg.sender` at diamond | Authorizes removal |
|---|---|---|---|---|
| Production (default) | ≥ quorum SC signers (Ledger) on a Safe tx wrapping Timelock `schedule` | Safe executes Timelock `execute` after the delay → diamond `diamondCut` | `LiFiTimelockController` | Safe quorum **and** timelock delay |
| Production, `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true` (new chain pre-handover) | — | production deployer EOA | production deployer (still diamond owner) | diamond ownership, pre-handover (existing sanctioned path) |
| Staging | — | dev/deployer EOA | dev/deployer EOA (staging diamond owner) | staging diamond ownership |
| Testnet | — | deployer EOA | deployer EOA (EOA-owned diamond) | EOA ownership |

Only the first row applies to the fleet of production mainnets; it is byte-for-byte
the same governance path `cleanUpProdDiamond.ts` already uses.

## 7. Self-adversarial pass

Attacks considered and their mitigations:

- **Remove a live facet because target state lags (not deprecated).** This is
  real, not hypothetical: the mainnet smoke run surfaced 8 such facets (Fact 12).
  Mitigated by the source-presence gate — a facet is removed only if its `src/`
  source is gone, which happens exclusively via `/deprecate-contract`. Live
  facets with drifted target state land in `driftDetected` and are never
  removed.
- **Remove a still-needed selector of a genuinely-deprecated facet.** Target
  state only decides _whether_ a facet should exist; the loupe decides _which_
  selectors it owns. Active-facet selectors are held back (§5.1 step 7). Any
  false positive still has to survive a printed banner, ≥ quorum human
  signatures, and the timelock delay.
- **Silently remove an unknown on-chain facet.** Unresolved addresses are never
  removed, only reported.
- **Cut the immutable diamond.** Engine never addresses it.
- **New bypass of timelock/Safe.** None added; production path is unchanged.
- **Deprecated core-ish facet (e.g. `GenericSwapFacet`) protected forever.** The
  hardcoded allowlist covers only true machinery; business facets like
  `GenericSwapFacet` are removable once deprecation drops them from config and
  target state — which is the whole point.
- **Many proposals → rubber-stamping.** Deprecating a facet that's live on N
  diamonds inherently needs N removals — that's the work, not avoidable. Each is
  a distinct conspicuous banner, an independent peer review, and a timelock
  delay. For the *backstop* (orphans), (B) rides existing sessions and (A) is a
  deliberate opt-in, so no gratuitous mass event is manufactured.
- **Deprecated facet has no `out/` artifact.** Loupe selectors, not `out/` —
  true for both the named and diff paths.
- **Deploy log deleted before removal (named path).** The enqueue snapshots the
  facet→address at deprecation time, and the drain resolves it from that
  snapshot; if the snapshot were missing the facet simply wouldn't be found (a
  false *negative*, safe). `/deprecate-contract` warns not to delete the log
  entries until the parked task retires, so this doesn't happen in practice.

## 8. Phasing

Effort in Fibonacci points; bucketed by who-blocks.

| Phase | Points | Blocks on |
|---|---|---|
| Engine (named + diff) + unit tests | 3 | our build |
| CLI `--facets`/`--auto`/`--all-networks`/`--yes` + banners | 2 | our build |
| `/deprecate-contract` step 6 wiring — park into the deferred queue (primary) | 1 | our build |
| `multisig-rollout` opt-in step (backstop) | 1 | our build |
| Review + first real removal (Safe signing + timelock) | 5 | human decision / operational |

Our-build share (engine + CLI + both wirings): **7/12 ≈ 58%**. The remaining 5
is review + the governance-gated first execution, human/operational by nature.

Recommended first PR (this one): engine + tests + CLI + `/deprecate-contract`
park wiring (enqueue into the deferred cleanup queue) + the opt-in rollout doc,
as a **draft**. The drain hook and the first live removal are separate,
deliberate steps.

## 9. Testing

- `diamondRemovalDiff.test.ts` — all decision logic covered
  (`.agents/rules/200-typescript.md`). Diff path: removal candidate; **drift
  (source present) → never removed**; protected-hardcoded; protected-via-config;
  unresolved address; held-back shared selector (partial and full);
  `targetStateMissingProtected`; empty/no-diamond; source-scan present/absent.
  Named path: on-chain named removal; protected-name refused; not-on-chain
  reported; no-diamond. All I/O is injected; the only uncovered function is the
  thin live-RPC adapter `readFacetsFromChain` (unreachable offline).
- **Live smoke runs** against the real mainnet production diamond (dry-run,
  nothing proposed): the *diff* path returned 0 removals with 8 drift facets
  correctly held back (Fact 12); the *named* path with
  `["GenericSwapFacet","PaxosTransitFacet","TotallyMadeUpFacet"]` correctly
  refused the protected `GenericSwapFacet`, flagged `PaxosTransitFacet` for
  removal with its 4 on-chain selectors, and reported the made-up name as not
  registered.
- CLI: dry-run (no `--yes`, or non-TTY) proposes nothing; `--all-networks` skips
  diamond-less networks; per-branch routing via `prepareTimelockCalldata` +
  `sendOrPropose`.
- No Solidity changes → no `forge` impact; `bun test`, `bunx eslint`,
  `bunx tsc-files --noEmit` on changed files.

## 10. Open decisions (recommended defaults in **bold**)

1. Rollout step default: **opt-in** (explicit flag) vs opt-out (every rollout).
   Opt-in first given irreversibility; flip is one line later.
2. First PR scope: **engine + CLI + opt-in doc** vs also flipping the rollout
   step on. Draft PR, so reviewer decides.
3. Periphery reconciliation: **defer to follow-up** (facets-only v1).

## 11. Tracking & delivery

- **Linear:** a ticket under **SmartContract**, child of **EXP-350** (falls back
  to standalone if it doesn't fit), captures this spec. _Blocked:_ the Linear
  connector is unauthorized in this session, so the ticket must be created once
  the connector is authorized; ready-to-paste content is in the PR description.
- **PR:** draft, from the repo template, linking the Linear task.
