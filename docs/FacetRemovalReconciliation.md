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

- Reconcile deployed `LiFiDiamond` facets against `_targetState.json` and remove
  facets that were dropped (i.e. deprecated), through the **existing** Safe +
  timelock governance path — no new bypass.
- One reusable diff engine, consumed by both a routine rollout step (default)
  and an on-demand fleet sweep.
- Removals are conspicuous and hard to fat-finger, because they are
  irreversible timelock+Safe actions.

**Non-goals (v1)**

- Periphery de-registration. `cleanUpProdDiamond.ts` already does it manually;
  reconciling periphery against `_targetState.json` is a follow-up. v1 is
  facets-only, matching the EXSC-193 scope.
- Removing selectors from `LiFiDiamondImmutable` (impossible by design).
- Auto-executing anything. The mechanism only **proposes**; humans sign, the
  timelock delays.

## 4. Delivery models

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

One **reusable diff engine** (`diamondRemovalDiff.ts`) consumed by:

- **(B)** an opt-in step in `multisig-rollout` — the default path stale facets
  ride out on.
- **(A)** a `--all-networks` sweep mode on the reconciliation CLI — the
  deliberate, on-demand escape hatch (e.g. right after a big deprecation, or run
  on a schedule).

Both feed the **same** `cleanUpProdDiamond.ts` build → timelock-wrap → propose
plumbing (Fact 3). Recommendation: **ship the engine + CLI + sweep now; wire the
rollout step as opt-in.** Rationale in §8.

## 5. Architecture

### 5.1 Diff engine — `script/deploy/safe/diamondRemovalDiff.ts` (new)

Pure, side-effect-free, unit-tested. Signature (illustrative):

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

export async function computeFacetRemovalDiff(
  network: string,
  environment: EnvironmentEnum,
  publicClient?: PublicClient, // injectable for tests
): Promise<IRemovalDiff>
```

**Algorithm**

1. Resolve the mutable diamond address from the deploy log (`LiFiDiamond`). If
   absent for this network/environment, return an empty diff (nothing to do).
2. `expected` = the full set of keys under
   `_targetState[network][environment]["LiFiDiamond"]` (facets **and** periphery
   — using the full key set is deliberately conservative: anything listed is
   protected). (Fact 5.)
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
     merely lags. Only a facet whose source was deleted proceeds.
   - else → **removal candidate**, selectors = `sels` (from the loupe, Fact 4 —
     this is why deprecated facets with no `out/` artifact work).
7. **Shared / re-registered selector guard.** The diamond maps each selector to
   exactly one facet, so no two on-chain facets can share a live selector. The
   real hazard is a selector still pointing at the stale facet that _target
   state expects an active facet to own_ (a missed re-point). Compute
   `expectedActiveSelectors` = ∪ `getFunctionSelectors(name)` over active facets
   whose source is present (`out/` exists — active facets are, by definition,
   still in the repo). Any candidate selector in that set is **held back**
   (excluded from the removal cut) and reported in `heldBackSelectors` — removing
   it would leave the diamond without that function until a corrective replace
   cut runs. (Guardrail: "handle selectors shared/re-registered across facets.")
8. Return the diff. Empty `removals` ⇒ nothing to propose for this network.

### 5.2 CLI — extend `script/tasks/cleanUpProdDiamond.ts`

Add two flags, reusing the file's existing `prepareTimelockCalldata` +
`sendOrPropose` (no new proposal code):

- `--auto` — for the given `--network`/`--environment`, run
  `computeFacetRemovalDiff`, print the conspicuous diff (§6), build one Remove
  cut via `buildDiamondCutRemoveCalldata(diff.removals)`, wrap for timelock,
  propose/send. This is the unit `multisig-rollout` calls per network.
- `--all-networks` — model (A): iterate `getAllActiveNetworks()` (skipping
  networks with no `LiFiDiamond` in the target environment), run `--auto` for
  each. Per-network branching (prod Safe / staging / testnet direct) is already
  correct via `prepareTimelockCalldata` + `sendOrPropose`.
- `--yes` — required to actually propose in headless/sweep mode; without it the
  run is a dry-run that only prints diffs. Interactive mode keeps its existing
  confirm prompt.

The existing manual `--facets '[...]'` path is untouched.

### 5.3 Rollout wiring — `.agents/commands/multisig-rollout.md`

Add an **opt-in** phase (after register, before proposal capture) gated behind
an explicit operator flag (e.g. `--reconcile-removals`) that runs
`cleanUpProdDiamond.ts --auto --network <n> --environment production` for each
target network. Its proposals are captured by the existing
`list-pending-proposals.ts` phase, PR'd and Slack'd by the existing tail
(Fact 9). Off by default in v1 so no rollout silently starts removing facets;
the operator turns it on when a deprecation is in flight.

## 6. Guardrails (non-negotiable)

| Guardrail | How |
|---|---|
| Never-remove allowlist (core + machinery) | Hardcoded `{DiamondCut, DiamondLoupe, Ownership, EmergencyPause}` ∪ `getCoreFacets()` ∪ `getCorePeriphery()`; protected even if dropped from target state (§5.1 step 5). |
| Skip `LiFiDiamondImmutable` | Engine only queries the `LiFiDiamond` address; immutable diamond never referenced (Fact 10). |
| Drift ≠ deprecation (source-presence gate) | A facet on-chain and absent from target state is removed **only if its `src/` source is gone**. Source still present → `driftDetected`, never removed (§5.1 step 6; Fact 12). |
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
- **71 proposals → rubber-stamping.** Exactly why (B) is the default and (A) is
  opt-in.
- **Deprecated facet has no `out/` artifact.** Loupe selectors, not `out/`.

## 8. Phasing

Effort in Fibonacci points; bucketed by who-blocks.

| Phase | Points | Blocks on |
|---|---|---|
| Diff engine + 100% unit tests | 3 | our build |
| CLI `--auto` / `--all-networks` / `--yes` + dry-run diff | 2 | our build |
| `multisig-rollout` opt-in step (doc) | 1 | our build |
| Review + first real sweep (Safe signing + timelock) | 5 | human decision / operational |

Our-build share (engine + CLI + doc): **6/11 ≈ 55%**. The remaining 5 is
review + the governance-gated first execution, which is human/operational by
nature and not something code can shorten.

Recommended first PR (this one): engine + tests + CLI + the opt-in rollout doc,
as a **draft**. The first live sweep is a separate, deliberate operational step.

## 9. Testing

- `diamondRemovalDiff.test.ts` — all decision logic covered
  (`.agents/rules/200-typescript.md`): removal candidate; **drift (source
  present) → never removed**; protected-hardcoded; protected-via-config;
  unresolved address; held-back shared selector (partial and full);
  `targetStateMissingProtected`; empty diff; no-diamond network; source-scan
  present/absent. All I/O is injected; the only uncovered function is the
  thin live-RPC adapter `readFacetsFromChain` (unreachable offline, injected
  around in tests).
- **Live smoke run** against the real mainnet production diamond: 0 removals,
  8 drift facets correctly held back, 1 target-state discrepancy surfaced,
  nothing proposed — proving the source gate on production data (Fact 12).
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
