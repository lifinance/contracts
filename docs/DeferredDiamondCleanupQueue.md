# Deferred Diamond-Cleanup Queue

Design doc / spec for a **durable queue of deferred diamond-maintenance tasks** so
that facet removals (and similar non-urgent diamond changes) are **parked** when a
facet is deprecated and **drained opportunistically** the next time any multisig
action happens on that network — instead of firing a heavy, dedicated fleet-wide
removal event.

Builds directly on **PR #2047** / [docs/FacetRemovalReconciliation.md](https://github.com/lifinance/contracts/blob/main/docs/FacetRemovalReconciliation.md)
(the removal *mechanism*). This spec adds the *scheduling* layer: it changes
`/deprecate-contract` from **"propose now"** to **"enqueue"**, and adds an
opportunistic **drain**.

Status: **proposed** (draft PR, for review — no production code). Author: Daniel B. (SC).

> **Provenance note.** All `[code]` facts below were verified against the **PR #2047
> branch** (`claude/upbeat-gagarin-1a715a`), which is **open, not yet merged** — so
> the removal mechanism this builds on isn't on `main` yet. Line numbers are against
> that branch. Anything not confirmed is marked `[unverified]` rather than asserted.

---

## 1. Problem

PR #2047 makes facet removal *possible and safe* (`computeNamedFacetRemovals` →
loupe selectors → `buildDiamondCutRemoveCalldata` → `wrapWithTimelockSchedule` →
`sendOrPropose`), and wires it into `/deprecate-contract` step 6 so a deprecation
**immediately proposes** a timelock-wrapped Safe removal on every production diamond
that still registers the facet.

That "propose immediately" is the problem this spec fixes:

- On-chain facet removal after `/deprecate-contract` is **not time-critical** — the
  selectors are dead code paths on a facet nobody calls anymore; they just need to
  come off *eventually*. It should ride along whenever we're already doing a multisig
  action on that network, at ~no extra signing cost.
- Doing it eagerly across all **71 mainnet production diamonds** (Fact 1) at
  deprecation time is a **mass signing event**: 71 Safe proposals, each needing
  ≥ quorum Ledger signatures on an **irreversible** `diamondCut`. That manufactures
  signer fatigue, which is itself a security risk (FacetRemovalReconciliation §4-A).
- FacetRemovalReconciliation already recognises this: its model **(B) lazy /
  opportunistic** adds a *stateless, opt-in* reconcile step to `multisig-rollout`
  (Phase 3.5) that recomputes the diff at rollout time. This spec makes that idea
  **durable and complete**:
  1. a **persistent queue** so a deprecation's intent survives across sessions and
     isn't re-derived by a live diff each time;
  2. a drain triggered by **any** routine multisig action on the network, not only a
     `multisig-rollout` run;
  3. a first-class **link from each parked task to its originating deprecation PR**,
     surfaced to the multisig reviewer at signing time.

### The PR-link requirement (first-class acceptance criterion)

When a parked removal finally rides along — potentially weeks later, inside an
unrelated rollout's signing session — the multisig reviewer staring at a
`diamondCut(Remove)` proposal must be able to see **which PR / rationale this change
belongs to**. Today nothing in the signer's view carries that (Fact 6). Carrying the
deprecation-PR URL onto the minted proposal, and showing it at signing, is a
non-negotiable part of this design (§6).

---

## 2. Facts ledger

Every load-bearing claim is verified against the repo this session. `[code]` = read
directly; `[observed]` = derived by running/inspecting; `[unverified]` = stated in
the source prompt or inferred, **not** confirmed.

1. `[code]` Scale: 71 active mainnet production networks (`jq` over
   `config/networks.json` this session). FacetRemovalReconciliation Fact 11 counts 78
   networks in `_targetState.json`, 76 active.
2. `[code]` The named removal path resolves each facet's **address + selectors from
   the on-chain loupe** at call time, keyed by facet **name**:
   `computeNamedFacetRemovals(network, environment, names, io?)` →
   `INamedRemovalResult { removals: {name, address, selectors}[], notFoundOnChain[],
   protectedSkipped[] }` — `script/deploy/safe/diamondRemovalDiff.ts:510`,
   `:429`. Selectors come from `facets()`, not `out/`, so it works after the source
   was deleted (`:441`).
3. `[code]` Both proposal-creation entry points funnel through
   `storeTransactionInMongoDB(pendingTransactions, safeAddress, network, chainId,
   safeTx, safeTxHash, proposer)` — `script/deploy/safe/safe-utils.ts:1263`. It is
   the single point where a proposal is *persisted*, but it is called from ~9 sites,
   not via one wrapper; it receives a **pre-signed** `safeTx` and has **no Safe SDK
   client** in scope.
4. `[code]` The two shared *entry points* that own a network + a live Safe client are
   `sendOrPropose({calldata, network, environment, diamondAddress})` —
   `script/safe/safeScriptHelpers.ts:29` — and `runPropose(options)` —
   `script/deploy/safe/propose-to-safe.ts:58`. Both do `getSafeMongoCollection →
   getNextNonce → safe.createTransaction → sign → storeTransactionInMongoDB`.
   `cleanUpProdDiamond`'s removal path funnels through `sendOrPropose`
   (`script/tasks/cleanUpProdDiamond.ts:515` `proposeRemovals` → `:35` import).
5. `[code]` Proposals are stored in **one** MongoDB collection: DB `sc_private`,
   collection `pendingTransactions` — `safe-utils.ts:1395-1398`. Access is gated on
   `SC_MONGODB_URI` (throws if missing — `:1362`) **and** a VPN IP check (throws
   `VPN connection required…` if the public IP ≠ the office egress — `:1364-1376`).
   A **second** durable queue already reuses the same `MongoClient`/`SC_MONGODB_URI`
   plumbing: DB `timelock-operations`, collection `queue`, doc `ITimelockQueueDoc`
   (`script/deploy/safe/timelock-queue.ts:37,40`).
6. `[code]` `ISafeTxDocument` (`safe-utils.ts:112-124`) is **purely structural**:
   `safeAddress, network, chainId, safeTx, safeTxHash, proposer, timestamp, status,
   executionHash?, submittedAt?, intentHash?`. **No** description / label / note /
   URL field. The signer's view is built from it: `confirm-safe-tx.ts` shows an
   ABI-decode block (via `formatDecodedTxDataForDisplay`, mandated single entry point
   — `.agents/rules/201-safe-decode-scripts.md:12`) plus a plain-string
   `detailLines` "Safe Transaction Details" block (`confirm-safe-tx.ts:497-512`).
   `list-pending-proposals.ts` prints `IProposalSummary` (`safe-utils.ts:139-153`).
   None carry free text today.
7. `[code]` Proposal `status` is a 4-state machine `pending | submitted | executed |
   reverted` (`safe-utils.ts:110`, lifecycle doc `:97-109`). Inserted as `pending`
   (`:1291`); transitioned by `confirm-safe-tx.ts:239-253` and the reconcile sweeps
   `reconcile.ts:346/361/381`. `getNextNonce` treats `pending`+`submitted` as
   nonce-consuming (`:1415`).
8. `[code]` Dedup on `pendingTransactions` is a **partial unique index**
   `unique_pending_intent_hash` on `{intentHash}` filtered to `status:'pending'`
   (`safe-utils.ts:1322-1349`); `intentHash = keccak256(network, chainId,
   safeAddress, to, value, data, operation)` (`:1218-1249`). Duplicate insert → E11000
   → returns `null` (`:1296-1309`).
9. `[code]` **Timelock-wrap salt is time-derived and non-deterministic:**
   `wrapWithTimelockSchedule` builds `salt = 0x{Date.now()…}` (`safe-utils.ts:2392`)
   and always encodes a single `scheduleBatch` (N inner calls; length-1 for one).
   ⇒ Two wraps of the **same** removal cut produce **different** calldata → different
   `intentHash`. **The Mongo `intentHash` dedup (Fact 8) cannot prevent a duplicate
   removal re-proposal.** Dedup must be enforced at the queue layer.
10. `[code]` `/deprecate-contract` step 6 today builds the removal proposals eagerly
    (`--facets '[…]' --all-networks --environment production --yes`) and already
    warns not to delete `deployments/*.json` facet→address entries until the removal
    has **executed** (`.agents/commands/deprecate-contract.md:97-128`, `:130-136`).
11. `[code]` `multisig-rollout` Phase 3.5 is the current opt-in opportunistic hook —
    stateless, off by default, `cleanUpProdDiamond --auto` per network
    (`.agents/commands/multisig-rollout.md:104-122`). Phase 8 already posts the
    rollout PR URL to `#dev-sc-multisig-proposals` (`:166-189`).
12. `[code]` A reusable Slack path exists for alerts:
    `script/utils/send-slack-webhook-message.ts` + `notifyProposalsCreatedToSlack`
    (`script/multiNetworkExecution.sh:1386-1397`), env
    `WEBHOOK_DEV_SC_MULTISIG_PROPOSALS`.
13. `[code]` Staging / testnet / `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true` bypass the
    Safe and broadcast directly from an EOA (`safeScriptHelpers.ts:42-93`); only
    production mainnets go through Safe + timelock + quorum.
14. `[code]` Repo standards binding this work: timelock/Safe **cannot be bypassed or
    weakened** (`.agents/rules/002-architecture.md:29`, `105-security.md:15`);
    TypeScript/Bash only, **no Python** (`.agents/rules/000-global-standards.md:15`);
    viem for all contract interaction (`200-typescript.md:14`); reuse existing
    helpers (`:24`); new TS helpers need a colocated `*.test.ts` at **100% coverage**
    (`:120`); CLI via `citty`/`consola`/`getEnvVar()` (`:116`). Dry-run-default and
    injectable-I/O are **#2047 conventions**, not rules (confirmed: not present in
    002/105/200).

---

## 3. Goals / non-goals

**Goals**

- Change deprecation-driven facet removal from an **eager fleet-wide propose** to a
  **park now, drain opportunistically** model, so removals cost ~zero marginal
  signing effort and never manufacture a mass signing event.
- A **durable** queue: a deprecation's intent survives sessions, machine restarts,
  and long idle periods until the network is next touched.
- **Any** routine multisig action on a network drains that network's parked tasks —
  not only a `multisig-rollout` run — via **one** hook, without editing every call
  site.
- Each parked task **carries its originating deprecation-PR URL**, surfaced to the
  multisig reviewer **at signing time**.
- Reuse the **existing** MongoDB + Safe + timelock plumbing and #2047's engine. No
  new governance path, no new bypass; removals stay conspicuous, peer-reviewed,
  timelock-gated.
- Nothing is orphaned forever: a cold network that never gets another action is still
  caught (§8).

**Non-goals (v1)**

- Periphery de-registration (out of scope in #2047 too).
- Auto-executing anything. The queue only schedules a **proposal**; humans sign, the
  timelock delays.
- Removing the #2047 backstop diff path. The target-state-diff sweep
  (`--auto --all-networks`) stays — it is the cold-network escape hatch (§8) and
  composes with the queue.
- A general "diamond maintenance task" framework. `kind` is modelled extensibly
  (§4) but **only `facet-removal` is implemented in v1**.

---

## 4. What is a parked task? (record schema — Q1)

A parked task is the **durable intent** "remove facet *F* from network *N*'s
production diamond, eventually, on behalf of PR *P*." One record **per facet per
network** (finest grain); the drain batches all of a network's queued records into
one removal proposal (§6).

```ts
/** A deferred diamond-maintenance task, parked until the network is next touched. */
export interface IParkedTask {
  _id?: ObjectId
  taskKey: string            // dedup key: `${kind}|${network}|${environment}|${facetName}` (see §7)
  kind: 'facet-removal'      // extensible; only facet-removal in v1
  network: string            // lowercased, matches pendingTransactions convention
  environment: EnvironmentEnum // 'production' in v1 (§9)
  facetName: string          // the IDENTITY — selectors are NOT stored (see below)
  diamondAddress: `0x${string}`  // snapshot from deploy log at enqueue (sanity/fallback)
  facetAddress: `0x${string}`    // snapshot; re-verified against the loupe at drain
  prUrl: string              // originating deprecation PR — REQUIRED, first-class (§6)
  status: 'queued' | 'proposed' | 'executed' | 'cancelled' | 'superseded'
  enqueuer: string           // git user.email / actor, for audit
  createdAt: Date
  proposedAt?: Date          // set at drain
  safeTxHash?: string        // set at drain → links to the pendingTransactions proposal
  resolvedAt?: Date          // set on executed/cancelled/superseded
  notes?: string
}
```

### Store selectors, or resolve from the loupe at drain time?

**Recommendation: store the facet *name* (+ address snapshot); resolve selectors from
the loupe at drain time.** This is not a close call, and it follows #2047's core
philosophy that *the loupe is the source of truth for which selectors a facet owns*:

| | Store selectors at enqueue | Resolve at drain (**recommended**) |
|---|---|---|
| Correctness | Selectors can go **stale** between enqueue and drain (a later partial cut, a re-point, a re-add). A stored list risks a `Remove` cut that no longer matches on-chain reality — exactly the class of bug #2047's held-back-selector guard exists to prevent. | Always matches current on-chain routing; `computeNamedFacetRemovals` already does this (Fact 2). |
| Reuse | Would duplicate loupe logic. | Calls the existing engine unchanged. |
| Failure mode | Silent wrong-cut. | If the facet is already gone at drain → mark `superseded` (self-heals). |

The `facetAddress` snapshot is stored **only** as a robustness aid: the drain
verifies that address is still in the loupe (see §8 deploy-log hazard), but the
**selectors it proposes always come from the live loupe**.

---

## 5. Where does it live? (store choice — Q2)

Three options compared. Requirement weighting follows the constraints: *reuse
existing Mongo/Safe plumbing; no parallel governance system;* and the *first-class*
requirement is **PR-link-to-reviewer at signing** (met identically by all three —
see §6 — because it lives on the *minted proposal*, not the queue).

| Criterion | (a) New Mongo collection **[recommended]** | (b) Extend `pendingTransactions` with a `parked` status | (c) Git-tracked queue file |
|---|---|---|---|
| Durability | ✅ Mongo, same as proposals | ✅ | ✅ (repo) |
| Concurrency / atomic dedup | ✅ partial unique index + atomic `findOneAndUpdate` for the queued→proposed flip | ✅ (same collection) | ⚠️ parallel sessions → JSON merge conflicts (same failure model as `_targetState.json`) |
| Dedup vs re-propose (Fact 9) | ✅ solved by an atomic status flip, independent of the salt-nondeterministic `intentHash` | ✅ | ⚠️ needs a **commit** to record `proposed`, else next drain re-proposes |
| Lifecycle vs on-chain truth | ✅ reconcilable like `pendingTransactions` (loupe + linked proposal status) | ✅ | ❌ a git file can't observe execution; needs an out-of-band reconcile anyway |
| Blast radius on audited signing code | ✅ none (separate collection) | ❌ **high** — a `parked` row has no real `safeTx`/nonce/signatures; every consumer (`confirm-safe-tx`, `reconcile`, `getNextNonce`, `list-pending`) must learn to skip it | ✅ none |
| Reviewer/git-auditability of the *parked set* | ⚠️ not in git; mitigated by (i) the deprecation PR that created it, (ii) a `list-parked-tasks` CLI (§9), (iii) the drain's proposals landing in a rollout PR | ⚠️ same as (a) | ✅ **best** — the parked entry is a diff in the deprecation PR, peer-reviewed at merge |
| VPN / `SC_MONGODB_URI` dependency | ❌ enqueue needs VPN | ❌ | ✅ enqueue works offline |
| "No parallel governance system" | ✅ **literally the existing pattern** — mirrors `timelock-operations/queue` (Fact 5) | ✅ | ⚠️ a new ad-hoc store type |

**Recommendation: (a) a new collection `sc_private.parkedTasks`**, modelled on the
existing `timelock-operations/queue` (Fact 5). It reuses the exact durable-store
pattern the repo already runs a second queue on — so it is provably *not* a parallel
governance system — and it wins the two places the git file is weakest: **atomic
dedup** (which the salt-nondeterministic `intentHash`, Fact 9, cannot provide) and
**on-chain-truth reconciliation**. The git file's one real virtue — the parked set
being a peer-reviewed diff — is preserved operationally: every entry is *created by*
the reviewed deprecation PR, and is listable via a `list-parked-tasks` command
mirroring `list-pending-proposals.ts`.

**(b) is rejected:** overloading the audited signing collection with rows that aren't
real signed transactions forces changes into `confirm-safe-tx` / `reconcile` /
`getNextNonce` — exactly the code the constraints say to leave untouched.

**(c) is the runner-up** and worth a second look **if** parallel deprecations are
rare *and* the team values the parked set being a git artifact over atomic dedup.
Flip conditions in the open questions (§11).

---

## 6. Drain: how a parked task becomes a proposal, and how the PR link reaches the reviewer (Q3, Q4)

### The drain chokepoint (Q3)

There is **no single function** through which *every* "multisig action on network X"
passes with both the network **and** a live Safe client in scope. `storeTransaction­
InMongoDB` (Fact 3) is the universal *persistence* funnel but is the wrong hook: it
fires **after** signing, per single proposal, with only a pre-signed `safeTx` and no
signer — it cannot mint the additional removal proposals a drain needs.

The two shared library entry points that **do** own `{network, environment, safe
client, Mongo collection}` are `sendOrPropose` and `runPropose` (Fact 4). Every
routine production multisig action routes through one of them:

- `multisig-rollout` deploy mode → `deploy-contract` → `sendOrPropose`/`runPropose`;
- whitelist sync → the same;
- `cleanUpProdDiamond` removals → `sendOrPropose`.

**Recommended hook (least-invasive): a single new helper**

```ts
// script/deploy/safe/drainParkedTasks.ts  (new)
export async function maybeDrainParkedTasks(ctx: {
  network: string
  environment: EnvironmentEnum
  safe: SafeClient            // already in scope in both entry points
  chain: Chain
  safeAddress: Address
  pendingTransactions: Collection<ISafeTxDocument>
}): Promise<void>
```

called **once at the tail of `sendOrPropose` and `runPropose`**, after the primary
proposal is stored. That is **two edits, no leaf-script changes** — it satisfies "any
multisig action drains, without touching every call site." It is:

- **Flag-gated** (`DRAIN_PARKED_TASKS=true`, default **off** in v1) so no rollout
  silently starts removing facets — mirrors #2047's opt-in Phase 3.5 (Fact 11).
- **Reentrancy-guarded** so the drain's *own* removal proposals (also minted through
  the low-level store) don't re-trigger a drain.
- **Production/Safe-only**: on a direct-send environment (Fact 13) it no-ops (§9).

**Known gap (stated, not hidden):** the four bespoke task scripts that call
`storeTransactionInMongoDB` directly (`proposePolymerCCTPChainIdMappings`,
`proposeMegaETHBridgeRegistrations`, `unpauseAllDiamonds`,
`proposeDeBridgeDlnChainIdMappings`) bypass both entry points and will **not** trigger
a drain. These are rare admin one-offs, and the cold-network backstop (§8) covers
anything the opportunistic path misses. Alternative considered — a command-level step
in `multisig-rollout` only (like Phase 3.5) — is even less invasive but drains *only*
on rollouts, failing the "any action" goal; rejected as the primary, kept as the
fallback if the two-entry-point hook is judged too broad.

### Drain algorithm

1. Query `parkedTasks` for `{network, environment, status:'queued'}`.
2. `computeNamedFacetRemovals(network, environment, names)` (Fact 2) for those facet
   names. Partition the result:
   - `notFoundOnChain` → mark those records **`superseded`** (facet already gone —
     removed another way). **But first** cross-check the stored `facetAddress`
     against the loupe: if the log entry was pruned yet the address is still routed,
     it is **not** superseded (see §8 hazard) — keep it queued and alert.
   - `protectedSkipped` → mark **`cancelled`** + alert loudly (a protected facet
     should never have been queued — a bug in enqueue).
   - `removals` → proceed.
3. **Atomically** flip each removal's record `queued → proposed`
   (`findOneAndUpdate({taskKey, status:'queued'}, {$set:{status:'proposed', …}})`).
   This is the dedup gate (§7): a concurrent drain finds no `queued` record and skips.
4. Build **one consolidated** `buildDiamondCutRemoveCalldata(removals)` →
   `prepareTimelockCalldata` (→ `scheduleBatch`, Fact 9) → mint the proposal via the
   low-level store (**not** recursing through `sendOrPropose`), carrying the PR links
   (below). Set `safeTxHash` on the flipped records.
5. On mint failure, revert the flipped records to `queued`.

One consolidated removal proposal per network — **not** merged into the upgrade's Safe
transaction (FacetRemovalReconciliation §4 already argues why: the upgrade cut is
Solidity-built, the removal cut is TS-built; one extra proposal in the same signing
session delivers the batching without threading removal logic across the language
boundary). It is captured by the same `list-pending-proposals.ts` sweep, lands in the
same rollout PR, and is signed in the same session.

### How the PR link reaches the reviewer (Q4) — the acceptance criterion

`ISafeTxDocument` has no free-text field (Fact 6), so the drain-minted proposal is
extended with **one optional field** and surfaced at the three places the reviewer
looks — none of which touch the rule-201 decode formatter:

```ts
// extend ISafeTxDocument (safe-utils.ts:112) — optional, backward-compatible
parkedTaskRefs?: { facet: string; prUrl: string }[]
```

1. **`confirm-safe-tx.ts` signing view (primary).** Append to the plain-string
   `detailLines` block (`:497-512`) — confirm-safe-tx's *own* output, outside the
   shared decode formatter, so rule 201 is untouched:

   ```text
   Parked cleanup — origin PRs:
       GenericSwapFacet   → https://github.com/lifinance/contracts/pull/2046
       AcrossFacetV3      → https://github.com/lifinance/contracts/pull/2046
   ```

2. **`list-pending-proposals.ts`.** Add `parkedTaskRefs` to `IProposalSummary`
   (`safe-utils.ts:139`) → one extra console line + the `--json` shape.
3. **Slack** (`multisig-rollout` Phase 8, Fact 11 / the webhook helper Fact 12).
   Include the origin-PR URLs in the removal proposal's line of the thread.

**Multiple parked tasks from different PRs on one network → one batched removal
proposal carrying multiple PR links.** `parkedTaskRefs` is an array precisely so a
network with facet *A* (PR #2046) and facet *B* (PR #2051) queued produces a single
`scheduleBatch` Remove with **two** origin-PR lines shown to the signer.

---

## 7. Lifecycle / state machine (Q5) & idempotency (Q6)

```text
                 /deprecate-contract enqueue (§10)
                              │
                              ▼
        ┌───────────────► queued ──────────────────────────┐
        │                    │                              │
        │        drain: atomic flip (§6.3)      facet already gone on-chain
        │                    │                     (loupe check) → superseded
        │                    ▼                              │
        │                proposed ──── proposal reverted ───┘ (→ back to queued)
        │                    │
        │       linked proposal executed + loupe confirms facet absent
        │                    ▼
        │                executed  (terminal, = done)
        │
        └── operator CLI (deprecation reverted / obsolete) ─► cancelled (terminal)
```

- **queued → proposed**: the drain, via an **atomic** `findOneAndUpdate` filtered on
  `status:'queued'` (§6.3). This is the dedup gate that replaces the unusable
  `intentHash` dedup (Fact 9): only one drain can win the flip, so **no double
  proposal**; a re-run finds nothing `queued`.
- **proposed → executed**: reconciled against **on-chain truth**, not the queue's
  say-so — the linked `pendingTransactions` proposal reaches `executed` (Fact 7)
  **and** the loupe confirms the facet's selectors are gone. Reuse the existing
  `reconcile.ts` sweep pattern (extend it, or a small standalone job — §11 Q7).
- **proposed → queued**: if the linked proposal `reverted` (Fact 7), the removal
  didn't happen — re-open for the next drain.
- **queued/proposed → superseded**: the facet is already absent on-chain (removed via
  another route) — self-healing reconcile.
- **→ cancelled**: an operator explicitly cancels (deprecation reverted, facet
  re-added). Manual CLI transition only.

**Idempotency / dedup (Q6)**

- **Don't enqueue twice.** Partial unique index on `taskKey`
  (`${kind}|${network}|${environment}|${facetName}`) filtered to
  `status ∈ {queued, proposed}` — mirrors `unique_pending_intent_hash` (Fact 8). A
  repeat `/deprecate-contract` of the same facet is a no-op upsert.
- **Don't re-propose if pending.** The atomic queued→proposed flip (above) is the
  guarantee; a `proposed` record whose proposal is still `pending` is skipped.
- **Safe re-runs.** The whole drain is idempotent: nothing `queued` ⇒ no-op.

---

## 8. Cold-network fallback (Q7) — nothing orphaned forever

A network that never gets another multisig action never drains opportunistically.
Three composed backstops, none silent:

1. **The #2047 target-state-diff sweep** — `cleanUpProdDiamond --auto
   --all-networks` — still exists and is the **deliberate escape hatch**. Its diff
   path (source-gone gate) naturally catches queued deprecations (their `src/` is
   gone), so a periodic hygiene sweep drains the fleet regardless of queue state.
   The drain should **reconcile** its parked records against what the sweep proposes
   (match by facet+network) so the two paths don't double-propose.
2. **TTL / age alert.** A scheduled job reads `parkedTasks`; any record `queued`
   longer than *N* days (default **30** `[unverified]` — team to set) → post to
   `#dev-sc-multisig-proposals` via the existing webhook (Fact 12), naming the
   network, facets, and origin PRs, prompting a deliberate `--auto --network X` drain.
3. **Observability** (§9) makes the backlog visible on demand.

**Deploy-log longevity hazard (important).** Because removal is now *deferred*
(possibly weeks), the `deployments/<network>.json` facet→address entry that
`computeNamedFacetRemovals` uses to resolve the address (Fact 2) must survive until
the parked task **retires** — longer than #2047's already-documented "don't prune
until executed" window (Fact 10). Two mitigations, both in this spec:

- The record stores `facetAddress` at enqueue (§4). The drain checks that address
  against the loupe **directly**; if the log entry was pruned but the address is still
  routed, the facet is **not** treated as superseded — it stays queued and alerts.
  *(This needs a small engine affordance: resolve a named removal by stored address
  when the log no longer maps it — a minor extension to `computeNamedFacetRemovals`/
  `diffNamedFacets`. Flagged in §11 Q5.)*
- `/deprecate-contract`'s existing "don't delete `deployments/*.json` entries until
  executed" warning (Fact 10) is **strengthened** to "until the parked task retires."

---

## 9. Observability (Q8)

`script/deploy/safe/list-parked-tasks.ts` (new), mirroring `list-pending-proposals.ts`
(`citty`/`consola`, `--json`, VPN/`SC_MONGODB_URI`-gated, exit codes per rule
`200-typescript.md:116`):

- `--network <csv>` / `--pr <url>` / `--status <state>` filters.
- Console: grouped by network, one line per task: `facet | status | age | origin PR |
  safeTxHash?`. Plus a per-network `queued`/`proposed` count summary.
- `--json`: `{ count, tasks: [ …IParkedTask ] }`.

---

## 10. Wiring the commands

### `/deprecate-contract` step 6 — "propose now" → "enqueue" (Q, primary change)

Step 6 (`deprecate-contract.md:97-128`, Fact 10) is rewritten from *create the
proposals* to *park them*:

- Resolve the affected production networks (those whose deploy log lists the facet),
  and for each, **enqueue** one `parkedTask` per (facet, network) carrying
  `prUrl = <this deprecation PR>`, `diamondAddress`/`facetAddress` snapshots, and
  `enqueuer`. No Safe proposal is created at deprecation time.
- The `prUrl` is **required** — enqueue refuses a task without it (the acceptance
  criterion is enforced at the source).
- The existing "don't prune `deployments/*.json` until executed" warning becomes
  "until the parked task **retires**" (§8 hazard).
- Because the enqueue is part of the deprecation PR, the parked set is peer-reviewed
  at merge (§5 auditability mitigation).

> Chicken-and-egg: the PR URL isn't known until the PR is opened. Enqueue therefore
> happens (or is finalised) **after** the deprecation PR exists — either the command
> writes records with a placeholder and a follow-up sets the URL, or (cleaner)
> enqueue runs as the last step once `gh pr create` has returned the URL. `[unverified]`
> — team to pick; noted in §11 Q8.

### `multisig-rollout` — the drain rides along

Phase 3.5 (Fact 11) is **superseded** by the automatic drain hook (§6): when
`DRAIN_PARKED_TASKS` is on, any rollout's `sendOrPropose`/`runPropose` calls drain the
target network. The rollout's Phase 4 capture, Phase 5 PR, and Phase 8 Slack post
already carry the extra removal proposal — the doc gains only the PR-link surfacing
(§6) and drops the manual `--auto` invocation.

---

## 11. Guardrails (non-negotiable)

| Guardrail | How |
|---|---|
| No new governance path / no bypass | New collection **mirrors** the existing `timelock-operations/queue` (Fact 5). Removals still go loupe → `buildDiamondCutRemoveCalldata` → `wrapWithTimelockSchedule` → Safe → timelock → quorum, **unchanged** (Facts 2, 4, 9). Timelock/Safe never weakened (`002:29`, `105:15`). |
| PR link mandatory + reviewer-visible | Enqueue rejects a task with no `prUrl`; drain copies it to `parkedTaskRefs` on the proposal; shown in `confirm-safe-tx` detailLines, `list-pending-proposals`, and Slack (§6). |
| No double-enqueue / no double-propose | Partial unique index on `taskKey`; atomic `queued→proposed` flip — independent of the salt-nondeterministic `intentHash` (Facts 8, 9; §7). |
| Never park/remove a protected facet | Enqueue and drain both call `getProtectedNames()` (`diamondRemovalDiff.ts:119`); a queued protected facet is `cancelled` + alerted (§6). Inherits every #2047 guardrail (drift gate is N/A — named path). |
| Deferred ≠ orphaned | Cold-network backstops: `--auto --all-networks` sweep + TTL Slack alert + observability CLI (§8). No silent truncation — the TTL alert names what's still queued. |
| Deploy-log longevity | Address snapshot + loupe-by-address check so pruning the log doesn't false-`superseded` a live facet; strengthened `/deprecate-contract` warning (§8). |
| Opt-in in v1 | `DRAIN_PARKED_TASKS` default off; reentrancy-guarded (§6). |
| Direct-send safety | Drain no-ops on staging/testnet/`SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` (Fact 13; §9 below). |
| Rule compliance | TS/Bash, no Python (`000:15`); viem (`200:14`); reuse helpers (`:24`); new helpers 100%-covered colocated tests (`:120`); `citty`/`consola`/`getEnvVar` CLI (`:116`); `I`-prefixed interfaces; injectable I/O + dry-run-default per #2047 convention (Fact 14). |

### Governance flow (unchanged from #2047)

The drain-minted removal proposal is byte-for-byte the same governance object
`cleanUpProdDiamond` already produces: a Safe tx wrapping Timelock `scheduleBatch`,
signed by ≥ quorum SC signers on Ledger, executed after the delay. The queue changes
**when** the proposal is created and **what annotation it carries**, never **how** it
is authorized.

---

## 12. Staging / testnet / `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` (Q9)

The queue is a **production-mainnet** construct — the fatigue problem it solves is
prod Safe signing (Fact 13). Therefore:

- **Enqueue** only for `environment = production` in v1.
- **Drain** no-ops when the environment routes to a **direct EOA broadcast**
  (staging, testnet, or `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true`): there is no Safe
  reviewer, so the PR-link requirement is moot, and a direct removal is cheap — the
  existing eager path (or a plain `cleanUpProdDiamond` run) handles those without a
  queue.
- New-chain pre-handover (`SEND_PROPOSALS_DIRECTLY_TO_DIAMOND=true`, still deployer-
  owned) is explicitly a **no-drain** case: removals there broadcast directly and need
  no deferral. `[unverified]` — confirm this matches how the team runs pre-handover.

---

## 13. Effort estimate (Fibonacci; bucketed by who-blocks)

| Phase | Points | Blocks on |
|---|---|---|
| `parkedTasks` collection + `IParkedTask` schema + store helpers (get/enqueue/atomic-flip/list) + unit tests (100%) | 3 | our build |
| Drain helper + hook into `sendOrPropose` + `runPropose` (flag-gated, reentrancy-safe) + tests | 3 | our build |
| PR-link surfacing: extend `ISafeTxDocument` + `confirm-safe-tx` detailLines + `IProposalSummary`/list-pending + Slack | 2 | our build |
| `/deprecate-contract` step 6 rewrite (propose → enqueue) + `multisig-rollout` doc update | 1 | our build |
| Reconcile (proposed→executed/superseded via loupe) + TTL Slack alert (cron) | 2 | our build |
| `list-parked-tasks` observability CLI + tests | 1 | our build |
| Loupe-by-address engine affordance (deploy-log-pruned robustness, §8) | 1 | our build |
| Review + first real park → drain → execute cycle (Safe signing + timelock) | 5 | human decision / operational |

Total ≈ **18**; **our-build share 13/18 ≈ 72%**. The remaining 5 is review + the
governance-gated first live cycle — human/operational by nature.

Recommended first PR: schema + store + drain hook (default **off**) + PR-link
surfacing + `/deprecate-contract` rewrite + observability, as a **draft**. The first
live drain is a separate, deliberate operational step (flip the flag on one network).

---

## 14. Open questions for the teammate discussion

1. **Store (§5).** Mongo collection (recommended) vs git-tracked file. Do we value
   the parked set being a peer-reviewed *git diff* enough to accept the git file's
   dedup-needs-a-commit and on-chain-lifecycle friction? (Flip to git file if
   parallel deprecations are rare and auditability-in-repo is prized.)
2. **Chokepoint (§6).** Hook **both** library entry points (`sendOrPropose` +
   `runPropose`) — broad, drains on any action — vs a single command-level step in
   `multisig-rollout` — narrower, drains only on rollouts. Accept that the 4 bespoke
   direct-`storeTransactionInMongoDB` task scripts won't trigger a drain?
3. **PR-link field (§6).** Extend the shared `ISafeTxDocument` (touches the signing
   schema, but backward-compatible/optional) vs a side-car lookup keyed by
   `safeTxHash`. Blast radius vs cleanliness.
4. **Batching (§6).** One consolidated removal proposal per network carrying multiple
   origin PRs — confirmed? Or one proposal per originating PR (more proposals, cleaner
   1:1 PR↔proposal mapping for the reviewer)?
5. **Deploy-log hazard (§8).** Harden the drain to resolve by stored `facetAddress`
   when the log entry was pruned (small engine extension), **and/or** just enforce
   "don't prune the log until the parked task retires"? (Recommend both.)
6. **Opt-in default (§6/§11).** `DRAIN_PARKED_TASKS` off in v1 — when do we flip it
   on by default, and per-network or global?
7. **Reconcile ownership (§7).** Extend the existing `reconcile.ts` sweep vs a
   standalone `reconcile-parked-tasks` job + cron.
8. **Enqueue timing (§10).** The `prUrl` isn't known until the deprecation PR exists.
   Enqueue after `gh pr create` returns the URL, vs placeholder-then-backfill?
9. **Scope of `kind` (§3/§4).** Facet-removal-only v1 with an extensible `kind`, vs
   design the other "non-urgent diamond changes" now (which? periphery de-register?
   selector re-points?).
10. **TTL (§8).** What age triggers the cold-network alert (default 30d proposed)?

---

## 15. Enqueue → park → drain → propose → execute (at a glance)

```text
 DEPRECATION TIME                         SOME LATER MULTISIG ACTION ON NETWORK X
 ────────────────                         ──────────────────────────────────────
 /deprecate-contract F                    rollout / whitelist sync / any sendOrPropose|runPropose
   │ (removes F from codebase)              │
   │ opens deprecation PR #P                │ primary proposal stored (unchanged)
   ▼                                        ▼
 enqueue parkedTask{                      maybeDrainParkedTasks(X, prod)   ◄── the ONE hook (§6)
   kind: facet-removal,                     │
   network: X, facetName: F,                │ 1. read status:queued for X
   prUrl: #P, status: queued }              │ 2. computeNamedFacetRemovals (live loupe)
   │                                        │ 3. atomic flip queued→proposed  (dedup gate)
   │  … survives across sessions …          │ 4. ONE scheduleBatch Remove, carrying #P link
   └───────────────────────────────────────┤
                                            ▼
                            Safe proposal (pendingTransactions) — reviewer sees "origin PR #P"
                                            │  (confirm-safe-tx detailLines + list-pending + Slack)
                                            ▼
                            ≥quorum sign (Ledger) → timelock delay → execute
                                            ▼
                            reconcile: loupe shows F gone  →  parkedTask: executed ✅

 COLD NETWORK never touched? → --auto --all-networks sweep  ∪  TTL Slack alert  (§8)
```
