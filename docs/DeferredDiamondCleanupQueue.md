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

Status: **being built.** The **store layer** is built and merged
([PR #2051](https://github.com/lifinance/contracts/pull/2051),
`script/deploy/safe/parked-tasks.ts` + the `enqueue-parked-task.ts` /
`list-parked-tasks.ts` CLIs) and the **removal engine + `/deprecate-contract`
park wiring** in [PR #2047](https://github.com/lifinance/contracts/pull/2047). The
**drain chokepoint, PR-link surfacing, reconcile/TTL job, and the loupe-by-address
engine affordance** are built in the follow-up draft PR (see §13). The only
remaining piece is the governance-gated **first live park → drain → execute
cycle** (a deliberate operational step, flag flipped on for one network).
Author: Daniel B. (SC).

> **Provenance note.** `[code]` facts about the **store layer** and the **drain
> chokepoint** are verified against `origin/main` this session — the store shipped in
> #2051 (`parked-tasks.ts`), and the `runPropose` funnel this hooks
> (`script/deploy/safe/propose-to-safe.ts`, `script/deploy/shared/propose-diamond-cut.ts`)
> is on `main`; line numbers are against `origin/main`. `[code]` facts about the
> **removal mechanism** are against the **PR #2047 branch**
> (`claude/upbeat-gagarin-1a715a`), which is **open, not yet merged** — those line
> numbers are against that branch and are flagged inline. Anything not confirmed is
> marked `[unverified]` rather than asserted.

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
  2. a drain triggered by **any facet cut** on the network (via the `runPropose`
     funnel — §6), not only a `multisig-rollout` run;
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
   protectedSkipped[], unresolved[] }` — `script/deploy/safe/diamondRemovalDiff.ts`.
   Selectors come from `facets()`, not `out/`, so it works after the source
   was deleted. `unresolved[]` carries on-chain facet addresses absent from the
   deploy log — a named facet registered at an unlogged address lands here (not
   silently in `notFoundOnChain`) so the drain surfaces it for investigation.
3. `[code]` Both proposal-creation entry points funnel through
   `storeTransactionInMongoDB(pendingTransactions, safeAddress, network, chainId,
   safeTx, safeTxHash, proposer)` — `script/deploy/safe/safe-utils.ts:1263`. It is
   the single point where a proposal is *persisted*, but it is called from ~9 sites,
   not via one wrapper; it receives a **pre-signed** `safeTx` and has **no Safe SDK
   client** in scope.
4. `[code]` **`runPropose(options)` — `script/deploy/safe/propose-to-safe.ts:58` — is
   the true funnel for programmatic Safe proposals**, and it owns `{network,
   environment, safe client, Mongo collection}`. It does `normalizeProposeCalls →
   initializeSafeClient → getSafeMongoCollection → getNextNonce → safe.createTransaction
   → sign → storeTransactionInMongoDB` (`:59-249`). Everything else routes *into* it:
   the manual CLI `main` (`:257`) only parses argv and calls `runPropose` (`:356`,
   `runMain(main)` `:375`); the **facet-cut path** `proposeDiamondCut`
   (`script/deploy/shared/propose-diamond-cut.ts:53`) calls `runPropose` for EVM
   (`../safe/propose-to-safe`, `:75`) and the Tron `runPropose` for TVM
   (`../tron/propose-to-safe-tron`, `:66`) — **never touching `main`**. This is the
   agentic case a deprecation-driven drain must ride (a deploy-and-register facet cut
   is `proposeDiamondCut → runPropose`, no CLI). A *separate* helper
   `sendOrPropose({calldata, network, environment, diamondAddress})` —
   `script/safe/safeScriptHelpers.ts:29` — does its own `getSafeMongoCollection →
   getNextNonce → createTransaction → sign → storeTransactionInMongoDB` and **does not
   call `runPropose`**; it backs whitelist-sync and `cleanUpProdDiamond` removals
   (`script/tasks/cleanUpProdDiamond.ts:515` `proposeRemovals`). So a `runPropose` hook
   covers the facet-cut funnel but **not** the `sendOrPropose` funnel (§6 gap).
5. `[code]` **Two distinct clusters are in play, and the queue follows the
   non-sensitive one.** The **signing** store — DB `sc_private`, collection
   `pendingTransactions` (`safe-utils.ts:1395-1398`) — is gated on `SC_MONGODB_URI`
   (throws if missing — `:1362`) **and** reachable only through the internal tunnel
   (legacy VPN, now `lifi-connect`); missing access throws. But the repo already runs a
   durable **queue** on the **non-sensitive `MONGODB_URI` cluster, un-gated**: DB
   `timelock-operations`, collection `queue`, opened via `getEnvVar('MONGODB_URI')` in
   `getTimelockQueueCollection()` (`script/deploy/safe/timelock-queue.ts:37,40,115-122`).
   The parked-tasks store mirrors **this queue sibling** — not the signing store — so it
   needs no tunnel (§5).
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
15. `[code]` **The store layer is built and merged (#2051, on `main`).**
    `script/deploy/safe/parked-tasks.ts` opens the queue via
    `getParkedTasksCollection()` (`:199`) against `getEnvVar('MONGODB_URI')` — DB
    `deferred-cleanup` (`:49`), collection `parkedTasks` (`:52`) — the **non-sensitive,
    un-gated** cluster (Fact 5), exactly mirroring `getTimelockQueueCollection()`. It
    ships the `IParkedTask` schema (§4), `computeTaskKey` (`:139`), a partial unique
    index `unique_open_task_key` on `taskKey` filtered to the open statuses
    `{queued, proposed}` (`ensureParkedTasksIndexes` `:162`, `:171`), `enqueueParkedTask`
    (`:234`, throws on a blank `prUrl`/`facetName`, E11000 → `null` dedup),
    `listParkedTasks` (`:281`), the atomic `queued → proposed` flip `claimForProposal`
    (`:324`), and the `markExecuted`/`markSuperseded`/`markCancelled`/`revertToQueued`
    transitions (`:342-410`; `markCancelled` restricted to `queued`). All I/O is an
    injected `Collection<IParkedTask>` (100% unit-covered except the live adapter). The
    two CLIs — `enqueue-parked-task.ts` (production-only, viem-validated, `enqueuer`
    from `git user.email`) and `list-parked-tasks.ts` (grouped by network, `--json`) —
    also shipped, both **un-gated** on `MONGODB_URI`.

---

## 3. Goals / non-goals

**Goals**

- Change deprecation-driven facet removal from an **eager fleet-wide propose** to a
  **park now, drain opportunistically** model, so removals cost ~zero marginal
  signing effort and never manufacture a mass signing event.
- A **durable** queue: a deprecation's intent survives sessions, machine restarts,
  and long idle periods until the network is next touched.
- **Any facet cut** on a network drains that network's parked tasks — not only a
  `multisig-rollout` run — via **one** hook at the `runPropose` funnel (§6), without
  editing every call site. (The `sendOrPropose` funnel — whitelist sync, cleanup — is
  out of scope for the opportunistic drain; the cold-network backstop §8 covers it.)
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

## 4. What is a parked task? (record schema — shipped #2051)

A parked task is the **durable intent** "remove facet *F* from network *N*'s
production diamond, eventually, on behalf of PR *P*." One record **per facet per
network** (finest grain); the drain batches all of a network's queued records into
one removal proposal (§6). The schema below **shipped verbatim** as `IParkedTask` in
`script/deploy/safe/parked-tasks.ts` (#2051, Fact 15).

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

### Mandatory pre-execute re-validation (propose→execute race)

Resolving selectors from the loupe at **drain/propose** time is necessary but not
sufficient. A facet removal is proposed as a timelock `scheduleBatch` and executed
**≥ the timelock delay later** (48h prod). In that window an intervening rollout can
re-point one of the snapshotted selectors onto a new, live facet; the already-queued
`Remove` (`facetAddress = address(0)`) would then delete a live selector →
`FunctionDoesNotExist` on every call until a corrective cut ships (it can also revert
outright if a selector was removed in the meantime).

The engine ships the guard for this in #2047:
`revalidateRemovalsOnChain(network, diamondAddress, snapshot, io?)` (pure core
`filterRePointedRemovals`) re-reads the loupe and returns `{ stillRemovable, stale }`,
dropping any selector that no longer routes to the doomed facet address (`re-pointed`
or `already-gone`). **The drain/execute consumer MUST call it immediately before
executing a queued removal op** and abort (or re-propose from `stillRemovable`) if
`stale` is non-empty. This is a first-class acceptance criterion for the drain-hook
follow-up, not an optional hardening step.

---

## 5. Where does it live? (store choice — Q1, RESOLVED)

**Decision (Goran + Daniel): a new Mongo collection on the _non-sensitive_
`MONGODB_URI` cluster — DB `deferred-cleanup`, collection `parkedTasks` — mirroring
the `timelock-operations/queue` sibling (Fact 5), _not_ the `sc_private` signing
store.** Shipped in #2051 (Fact 15). Three options were compared:

| Criterion | (a) New Mongo collection **[DECIDED — #2051]** | (b) Extend `pendingTransactions` with a `parked` status | (c) Git-tracked queue file |
|---|---|---|---|
| Durability | ✅ Mongo, cross-session | ✅ | ✅ (repo) |
| Mutable cross-session state (`queued → claimed → done`) | ✅ a live-updatable record, the natural fit | ✅ | ❌ every status flip is a commit; a git file models a snapshot, not a mutating queue |
| Concurrency / atomic dedup | ✅ partial unique index + atomic `claimForProposal` flip (Fact 15) | ✅ (same collection) | ⚠️ parallel sessions → JSON merge conflicts (same failure model as `_targetState.json`) |
| Dedup vs re-propose (Fact 9) | ✅ solved by the atomic status flip, independent of the salt-nondeterministic `intentHash` | ✅ | ⚠️ needs a **commit** to record `proposed`, else next drain re-proposes |
| Lifecycle vs on-chain truth | ✅ reconcilable (loupe + linked proposal status) | ✅ | ❌ a git file can't observe execution; needs an out-of-band reconcile anyway |
| Blast radius on audited signing code | ✅ none (separate collection, separate cluster) | ❌ **high** — a `parked` row has no real `safeTx`/nonce/signatures; every consumer (`confirm-safe-tx`, `reconcile`, `getNextNonce`, `list-pending`) must learn to skip it | ✅ none |
| Cluster / tunnel dependency | ✅ **non-sensitive `MONGODB_URI`, no tunnel** — CI, reconcile/TTL jobs, and agent-driven `/deprecate-contract` all reach it without `lifi-connect` | ❌ inherits `sc_private` + tunnel gate | ✅ none (in-repo) |
| "No parallel governance system" | ✅ **literally the existing pattern** — mirrors `timelock-operations/queue` (Fact 5) | ✅ | ⚠️ a new ad-hoc store type |

**Why the non-sensitive cluster (not `sc_private`).** Nothing a parked task holds is
secret — public facet names, on-chain addresses, and PR URLs. The security boundary
that matters is **on-chain**: calldata verification, the timelock delay, and Safe
quorum, none of which the queue touches. Putting the queue behind the `sc_private`
tunnel gate would only block the automated consumers this design depends on (CI backlog
reports, the reconcile/TTL jobs, and non-interactive agent runs of
`/deprecate-contract`) for zero security gain. So it lives on the same un-gated
`MONGODB_URI` cluster the timelock queue already runs on.

**Why Mongo, not a git file.** A parked task is **mutable cross-session state** — it
transitions `queued → proposed (claimed) → executed` over what may be weeks, driven by
whichever session next touches the network. A git file models a *snapshot* reviewed at
merge, not a record that flips status out-of-band; recording each `proposed`/`executed`
flip as a commit is friction, and concurrent drains would collide on JSON merges. Mongo
also wins the two places the git file is weakest: **atomic dedup** (the
salt-nondeterministic `intentHash`, Fact 9, cannot provide it — `claimForProposal` does,
§7) and **on-chain-truth reconciliation**.

The git file's one real virtue — the parked set being a peer-reviewed diff — is
preserved operationally: every entry is *created by* the reviewed deprecation PR, and is
listable via `list-parked-tasks` (§9), mirroring `list-pending-proposals.ts`.

**(b) was rejected:** overloading the audited signing collection with rows that aren't
real signed transactions forces changes into `confirm-safe-tx` / `reconcile` /
`getNextNonce` — exactly the code the constraints say to leave untouched — and it drags
the queue back behind the `sc_private` tunnel gate.

### Required MongoDB privilege on `deferred-cleanup` (operational prerequisite)

The queue depends on one **partial unique index** — `unique_open_task_key` on `taskKey`
filtered to the open statuses (§7) — which `getParkedTasksCollection()` ensures on
connect via `createIndex`. Creating an index is a **`createIndex` privileged action**;
plain `readWrite` does **not** grant it. So the `MONGODB_URI` role used by rollouts / CI
/ `/deprecate-contract` must have **`readWrite` _plus_ index-creation on the
`deferred-cleanup` DB** (equivalently: the built-in `readWrite` role already covers
`createIndex`, but a **custom/scoped** role that only grants `find`/`insert`/`update`
does not — that is the trap).

- **Observed failure (EXSC-611 rollout, 2026-07-22).** Running a facet cut with
  `DRAIN_PARKED_TASKS=true`, and independently `list-parked-tasks.ts`, both failed with
  `not authorized on deferred-cleanup to execute command { createIndexes: "parkedTasks", … }`.
  The `clusterTime` signature in the error proves `MONGODB_URI` **is** set and points at
  a real cluster that has the `deferred-cleanup` DB — the role simply lacks
  `createIndex` **on that DB**. The sibling `timelock-operations/queue` on the same
  cluster works, so the grant almost certainly **drifted**: the newer `deferred-cleanup`
  DB was added without extending the service role to it.
- **Infra fix (preferred, durable).** Grant the `MONGODB_URI` service role
  `readWrite` (with index privileges) on `deferred-cleanup`, mirroring its grant on
  `timelock-operations`. Equivalently, create `unique_open_task_key` **once** via an
  admin/migration; then every runtime consumer only needs `readWrite`, and even a
  `createIndex`-less role degrades cleanly (below).
- **Code robustness (already in place).** `ensureParkedTasksIndexes`
  (`parked-tasks.ts`) treats an authorization failure (server code 13) as **non-fatal**:
  it checks via `listIndexes` (a `read` action) whether `unique_open_task_key` already
  exists. If it does, dedup is intact and the queue is fully functional on a
  `readWrite`-only role; if it does not, it **warns loudly that enqueue dedup is
  unenforced** but still lets reads / enqueue / claim / drain proceed. This keeps the
  un-gated design promise (CI, rollouts, reconcile jobs reach the queue without a
  tunnel) alive even before the infra grant lands — at the cost of dedup until the index
  exists. **With this fix the drain and `list-parked-tasks` run to completion on a
  `readWrite`-only role instead of aborting; the only degradation until the index exists
  is that enqueue dedup is unenforced (duplicate open tasks are possible — harmless: the
  drain processes each and a re-park whose facet is already gone resolves to
  `superseded`). The cold-network reconcile backstop (§8) remains the catch-all.**

---

## 6. Drain: how a parked task becomes a proposal, and how the PR link reaches the reviewer (chokepoint Q2 → RESOLVED)

### The drain chokepoint (Q2 → RESOLVED)

**Decision (Goran + Daniel): hook the drain into `runPropose`
(`script/deploy/safe/propose-to-safe.ts:58`) — _not_ `sendOrPropose`, _not_ `main()`,
and _not_ the `multisig-rollout` skill.**

`runPropose` is the true funnel for programmatic Safe proposals (Fact 4). Everything
that mints a production facet-cut routes *into* it:

- the manual CLI `main` (`propose-to-safe.ts:257`) only parses argv, then calls
  `runPropose` (`:356`);
- the **facet-cut path** — a `deploy-and-register` script → `proposeDiamondCut`
  (`script/deploy/shared/propose-diamond-cut.ts:53`) → `runPropose` (EVM `:75`, Tron
  `:66`) — **never touches `main`**.

That second point is decisive: hooking `main()` would drain only on *manual CLI* runs
and would **miss the agentic facet-cut case this whole design exists for** (a deprecation
rides along with the next automated cut). Hooking the `multisig-rollout` skill would
miss any cut done outside a rollout. `runPropose` is the one point both reach.

**Implementation shape (least-invasive, keeps signing pure).** Extract the current
`runPropose` body into a pure `_runPropose(options)`; the public `runPropose` becomes a
thin wrapper that runs the primary proposal first and then drains, guarded so the drain
can never affect the primary proposal or the process exit code:

```ts
// script/deploy/safe/propose-to-safe.ts
export async function _runPropose(options: IProposeToSafeOptions) {
  /* … the existing body verbatim: normalizeProposeCalls → initializeSafeClient →
     getSafeMongoCollection → getNextNonce → createTransaction → sign →
     storeTransactionInMongoDB … (propose-to-safe.ts:59-252 today) */
}

export async function runPropose(options: IProposeToSafeOptions) {
  await _runPropose(options) // the primary ("main") proposal — unchanged behaviour
  // opt-in, best-effort: a drain failure must never fail the primary proposal
  await drainParkedTasks(options).catch((e) =>
    consola.warn('parked-task drain failed (primary proposal unaffected):', e)
  )
}
```

- **New helper** `script/deploy/safe/drain-parked-tasks.ts` (mirrors the `parked-tasks.ts`
  kebab convention). It opens its own `getParkedTasksCollection()` (Fact 15) — the drain
  reads the queue on the non-sensitive cluster, independent of the signing store — and
  mints the removal proposal through the low-level store, **not** by recursing through
  `runPropose`.
- **Flag-gated — `DRAIN_PARKED_TASKS` (Q6, semantics decided): ON for rollouts, OFF for
  emergencies.** Default **off** in v1. The point of the flag is scoping, not just a
  kill-switch: an urgent pause / break-glass proposal must **never** drag unrelated facet
  removals into its signing set, so emergency flows run with `DRAIN_PARKED_TASKS` unset
  and stay a single clean proposal; deliberate rollouts set it on to let removals ride.
- **Reentrancy-guarded** so the drain's *own* removal proposal (minted through the
  low-level store) can't re-trigger a drain.
- **Production/Safe-only**: on a direct-send environment (Fact 13) it no-ops (§12).

**Known gap (stated, not hidden).** `sendOrPropose` (`safeScriptHelpers.ts:29`) is a
*separate* funnel that does **not** call `runPropose` (Fact 4), so actions that go only
through it — **whitelist syncs** and `cleanUpProdDiamond` removals — will **not** drain
opportunistically, nor will the four bespoke scripts that call `storeTransactionInMongoDB`
directly (`proposePolymerCCTPChainIdMappings`, `proposeMegaETHBridgeRegistrations`,
`unpauseAllDiamonds`, `proposeDeBridgeDlnChainIdMappings`). This is an accepted
consequence of hooking the facet-cut funnel only: deprecation removals naturally ride
facet cuts (`proposeDiamondCut → runPropose`), and the **cold-network backstop (§8)**
catches anything the opportunistic path misses. Extending the hook to `sendOrPropose` is
a deliberate future option, not part of v1.

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
3. **Atomically** flip each removal's record `queued → proposed` via
   `claimForProposal(parkedTasks, taskKey)` (Fact 15) — the merged
   `findOneAndUpdate({taskKey, status:'queued'}, …)`. This is the dedup gate (§7): a
   concurrent drain finds no `queued` record, gets `null`, and skips it — so two parallel
   sessions draining the same network **cannot double-propose the same removal**,
   independent of the salt-nondeterministic `intentHash` (Fact 9).
4. Build the removal cut → `buildDiamondCutRemoveCalldata(removals)` →
   `prepareTimelockCalldata` (→ `scheduleBatch`, Fact 9) → mint the proposal via the
   low-level store (**not** recursing through `runPropose`), carrying the PR links
   (below). Set `safeTxHash` on the flipped records.
5. On mint failure, revert the flipped records with `revertToQueued` (Fact 15), which
   clears the stale `proposedAt`/`safeTxHash` so the next drain re-proposes cleanly.

**Batching — one consolidated removal proposal per network (recommended; Q4 still open,
§14).** The recommendation is a single per-network `scheduleBatch` Remove carrying every
queued facet's origin PR — **not** merged into the upgrade's Safe transaction
(FacetRemovalReconciliation §4 argues why: the upgrade cut is Solidity-built, the removal
cut is TS-built; one extra proposal in the same signing session delivers the batching
without threading removal logic across the language boundary). It is captured by the same
`list-pending-proposals.ts` sweep, lands in the same rollout PR, and is signed in the same
session. The one-proposal-per-origin-PR alternative (cleaner 1:1 PR↔proposal mapping, more
proposals) was **not** settled in the thread — see §14 Q4.

### How the PR link reaches the reviewer — the acceptance criterion (visibility decided)

**Decision (Goran + Daniel): the drained removal must be logged _loudly_ AND carry its
originating deprecation-PR link into what the signer reviews** — otherwise the "surprise
removal" problem just moves up one level (the signer now sees a mystery `diamondCut`
instead of a mystery deprecation). So the drain both `consola`-logs each removal it adds
(facet + origin PR) at mint time, and threads the PR link onto the minted proposal.

`ISafeTxDocument` has no free-text field (Fact 6), so the drain-minted proposal is
extended with **one optional field** and surfaced at the three places the reviewer looks
— none of which touch the rule-201 decode formatter (the field-vs-side-car choice itself
is §14 Q3):

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
       AcrossFacetV3      → https://github.com/lifinance/contracts/pull/2048
   ```

2. **`list-pending-proposals.ts`.** Add `parkedTaskRefs` to `IProposalSummary`
   (`safe-utils.ts:139`) → one extra console line + the `--json` shape.
3. **Slack** (`multisig-rollout` Phase 8, Fact 11 / the webhook helper Fact 12).
   Include the origin-PR URLs in the removal proposal's line of the thread.

**Multiple parked tasks from different PRs on one network → one batched removal proposal
carrying multiple PR links** (under the recommended per-network batching, Q4).
`parkedTaskRefs` is an array precisely so a network with facet *A* (PR #2046) and facet
*B* (PR #2048) queued produces a single `scheduleBatch` Remove with **two** origin-PR
lines shown to the signer.

---

## 7. Lifecycle / state machine & idempotency

```text
                 /deprecate-contract enqueue (§10)
                              │
                              ▼
        ┌───────────────► queued ──────────────────────────┐
        │                    │                              │
        │     drain: claimForProposal (§6 step 3)  facet already gone on-chain
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

All five transitions ship as helpers in `parked-tasks.ts` (#2051, Fact 15):

- **queued → proposed**: the drain, via the atomic `claimForProposal(parkedTasks,
  taskKey)` (`:324`) filtered on `status:'queued'` (§6 step 3). This is the dedup gate
  that replaces the unusable `intentHash` dedup (Fact 9): only one drain can win the
  flip, so **no double proposal**; a concurrent drain gets `null` and a re-run finds
  nothing `queued`.
- **proposed → executed**: `markExecuted` (`:342`), driven by **on-chain truth**, not
  the queue's say-so — the linked `pendingTransactions` proposal reaches `executed`
  (Fact 7) **and** the loupe confirms the facet's selectors are gone. Reuse the existing
  `reconcile.ts` sweep pattern (extend it, or a small standalone job — §14 Q7).
- **proposed → queued**: `revertToQueued` (`:402`) — if the linked proposal `reverted`
  (Fact 7) the removal didn't happen; it clears `proposedAt`/`safeTxHash` so the next
  drain re-proposes cleanly.
- **queued/proposed → superseded**: `markSuperseded` (`:360`, accepts both open states)
  — the facet is already absent on-chain (removed via another route); self-healing
  reconcile.
- **→ cancelled**: `markCancelled` (`:383`) — an operator explicitly abandons the intent
  (deprecation reverted, facet re-added, or a protected facet queued in error). **Merged
  behaviour: restricted to `queued`** — cancelling a `proposed` task would orphan its
  already-minted Safe removal proposal from the origin-PR linkage (§6), so a claimed task
  must be `revertToQueued` first, then cancelled.

**Idempotency / dedup**

- **Don't enqueue twice.** Partial unique index `unique_open_task_key` on `taskKey`
  (`${kind}|${network}|${environment}|${facetName}`) filtered to
  `status ∈ {queued, proposed}` (Fact 15) — mirrors `unique_pending_intent_hash`
  (Fact 8). A repeat `/deprecate-contract` of the same facet hits E11000 and
  `enqueueParkedTask` returns `null` — a harmless no-op.
- **Don't re-propose if pending.** The atomic `claimForProposal` flip (above) is the
  guarantee; a `proposed` record whose proposal is still `pending` is skipped.
- **Safe re-runs.** The whole drain is idempotent: nothing `queued` ⇒ no-op.

---

## 8. Cold-network fallback — nothing orphaned forever

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
  `diffNamedFacets`. Flagged in §14 Q5.)*
- `/deprecate-contract`'s existing "don't delete `deployments/*.json` entries until
  executed" warning (Fact 10) is **strengthened** to "until the parked task retires."

---

## 9. Observability

`script/deploy/safe/list-parked-tasks.ts` — **shipped in #2051** (Fact 15), mirroring
`list-pending-proposals.ts` (`citty`/`consola`, `--json`, exit codes per rule
`200-typescript.md:116`). It reads the queue from the **non-sensitive `MONGODB_URI`
cluster and is _un-gated_** — no `lifi-connect` tunnel — so CI and the reconcile/TTL
jobs can run it non-interactively:

- `--network <csv>` / `--pr <url>` / `--status <state>` filters.
- Console: grouped by network, one line per task: `facet | status | age | origin PR |
  safeTxHash?`. Plus a per-network `queued`/`proposed` count summary.
- `--json`: `{ count, tasks: [ …IParkedTask ] }`.

---

## 10. Wiring the commands

### `/deprecate-contract` step 6 — "propose now" → "enqueue" (primary change)

The enqueue primitive is already built: `enqueueParkedTask` and the
`enqueue-parked-task.ts` CLI shipped in #2051 (Fact 15). The remaining change is to
**call** it from `/deprecate-contract` step 6 (`deprecate-contract.md:97-128`, Fact 10),
rewriting it from *create the proposals* to *park them*:

- Resolve the affected production networks (those whose deploy log lists the facet),
  and for each, **enqueue** one `parkedTask` per (facet, network) carrying
  `prUrl = <this deprecation PR>`, `diamondAddress`/`facetAddress` snapshots, and
  `enqueuer`. No Safe proposal is created at deprecation time.
- The `prUrl` is **required** — `enqueueParkedTask` throws on a missing/blank `prUrl`
  (Fact 15), so the acceptance criterion is enforced at the source.
- The existing "don't prune `deployments/*.json` until executed" warning becomes
  "until the parked task **retires**" (§8 hazard).
- Because the enqueue is part of the deprecation PR, the parked set is peer-reviewed
  at merge (§5 auditability mitigation).

> **Enqueue timing (Q8 — open recommendation).** The `prUrl` isn't known until the PR is
> opened, so enqueue must happen **after** the deprecation PR exists. **Recommended: run
> enqueue as the last step, once `gh pr create` has returned the URL** — cleaner than
> writing placeholder records and backfilling the URL in a follow-up. This was **not**
> explicitly nailed in the thread; both options remain on the table — see §14 Q8.

### `multisig-rollout` — the drain rides along (no skill edit)

Phase 3.5 (Fact 11) is **superseded** by the automatic drain hook (§6): when
`DRAIN_PARKED_TASKS` is on, any rollout's `runPropose` calls drain the target network.
Crucially, the drain is **not** a new `multisig-rollout` skill step and needs **no edit
to the skill** — it fires from the `runPropose` chokepoint (§6), so it rides *any* facet
cut, rollout or not. The rollout's Phase 4 capture, Phase 5 PR, and Phase 8 Slack post
already carry the extra removal proposal — the skill doc gains only the PR-link surfacing
(§6) and drops the manual `--auto` invocation.

---

## 11. Guardrails (non-negotiable)

| Guardrail | How |
|---|---|
| No new governance path / no bypass | Queue lives on the **non-sensitive `MONGODB_URI` cluster** (off the signing store), **mirroring** the existing `timelock-operations/queue` (Fact 5, 15). Removals still go loupe → `buildDiamondCutRemoveCalldata` → `wrapWithTimelockSchedule` → Safe → timelock → quorum, **unchanged** (Facts 2, 4, 9). Timelock/Safe never weakened (`002:29`, `105:15`). |
| PR link mandatory + reviewer-visible | `enqueueParkedTask` throws on a blank `prUrl` (Fact 15); drain **logs each removal loudly** and copies the link to `parkedTaskRefs` on the proposal; shown in `confirm-safe-tx` detailLines, `list-pending-proposals`, and Slack (§6). |
| No double-enqueue / no double-propose | Partial unique index `unique_open_task_key` on `taskKey`; the atomic `claimForProposal` flip — independent of the salt-nondeterministic `intentHash` (Facts 8, 9, 15; §7). |
| Never park/remove a protected facet | Enqueue and drain both call `getProtectedNames()` (`diamondRemovalDiff.ts:119`); a queued protected facet is `cancelled` + alerted (§6). Inherits every #2047 guardrail (drift gate is N/A — named path). |
| Deferred ≠ orphaned | Cold-network backstops: `--auto --all-networks` sweep + TTL Slack alert + observability CLI (§8). No silent truncation — the TTL alert names what's still queued. |
| Deploy-log longevity | Address snapshot + loupe-by-address check so pruning the log doesn't false-`superseded` a live facet; strengthened `/deprecate-contract` warning (§8). |
| Opt-in in v1 | `DRAIN_PARKED_TASKS` **default off; ON for rollouts, OFF for emergencies** (§6) — an urgent pause/break-glass proposal never drags unrelated removals into its signing set; reentrancy-guarded (§6). |
| Direct-send safety | Drain no-ops on staging/testnet/`SEND_PROPOSALS_DIRECTLY_TO_DIAMOND` (Fact 13; §12). |
| Rule compliance | TS/Bash, no Python (`000:15`); viem (`200:14`); reuse helpers (`:24`); new helpers 100%-covered colocated tests (`:120`); `citty`/`consola`/`getEnvVar` CLI (`:116`); `I`-prefixed interfaces; injectable I/O + dry-run-default per #2047 convention (Fact 14). |

### Governance flow (unchanged from #2047)

The drain-minted removal proposal is byte-for-byte the same governance object
`cleanUpProdDiamond` already produces: a Safe tx wrapping Timelock `scheduleBatch`,
signed by ≥ quorum SC signers on Ledger, executed after the delay. The queue changes
**when** the proposal is created and **what annotation it carries**, never **how** it
is authorized.

---

## 12. Staging / testnet / `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND`

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

| Phase | Points | Blocks on | Status |
|---|---|---|---|
| `parkedTasks` collection + `IParkedTask` schema + store helpers (get/enqueue/atomic-flip/list) + unit tests (100%) | 3 | our build | ✅ **DONE — #2051** |
| `list-parked-tasks` observability CLI + `enqueue-parked-task` CLI + tests | 1 | our build | ✅ **DONE — #2051** |
| Drain helper (`drain-parked-tasks.ts`) + hook into `runPropose` (extract pure `_runPropose`; drain in try/catch; flag-gated, reentrancy-safe) + tests | 3 | our build | ✅ **DONE — this PR** |
| PR-link surfacing: extend `ISafeTxDocument` + `confirm-safe-tx` detailLines + `IProposalSummary`/list-pending + Slack | 2 | our build | ✅ **DONE — this PR** |
| `/deprecate-contract` step 6 rewrite (propose → call `enqueueParkedTask`) + `multisig-rollout` doc update | 1 | our build | ✅ **DONE** — step 6 in #2047, `multisig-rollout` doc this PR |
| Reconcile (proposed→executed/superseded via loupe) + TTL Slack alert (cron) | 2 | our build | ✅ **DONE — this PR** (`reconcile-parked-tasks.ts` + `reconcileParkedTasks.yml`) |
| Loupe-by-address engine affordance (deploy-log-pruned robustness, §8) | 1 | our build | ✅ **DONE — this PR** (`prunedButRouted`) |
| Review + first real park → drain → execute cycle (Safe signing + timelock) | 5 | human decision / operational | todo |

Total ≈ **18**; **our-build share 13/18 ≈ 72%**, all now built — **4 points (store +
observability/enqueue CLIs) merged in #2051**, the engine + park wiring in #2047, and
the remaining **9 our-build points (drain + PR-link surfacing + reconcile/TTL +
loupe-by-address affordance) in the follow-up draft PR**. The remaining 5 is review +
the governance-gated first live cycle — human/operational by nature.

The follow-up PR ships the drain helper + `runPropose` hook (default **off**) +
PR-link surfacing + reconcile/TTL job + the loupe-by-address affordance, as a
**draft**. The first live drain stays a separate, deliberate operational step (flip
`DRAIN_PARKED_TASKS` on for one network).

---

## 14. Open questions for the teammate discussion

1. ~~**Store (§5).**~~ **RESOLVED (Goran + Daniel):** a new Mongo collection on the
   non-sensitive `MONGODB_URI` cluster (`deferred-cleanup.parkedTasks`), mirroring
   `timelock-operations/queue` — chosen over a git file because the state is mutable
   cross-session (`queued → claimed → done`) and the queue needs atomic dedup + on-chain
   reconciliation the git file can't give. **Shipped in #2051.**
2. ~~**Chokepoint (§6).**~~ **RESOLVED (Goran + Daniel):** hook `runPropose` only — the
   funnel every facet cut reaches (`main` and `proposeDiamondCut` both route through it;
   the agentic cut never touches `main`). Accepted consequence: the `sendOrPropose`
   funnel (whitelist sync, `cleanUpProdDiamond`) and the 4 bespoke direct-store scripts
   won't drain opportunistically — the cold-network backstop (§8) covers them.
3. ~~**PR-link field (§6).**~~ **RESOLVED (Daniel):** extend the shared
   `ISafeTxDocument` with the optional, backward-compatible `parkedTaskRefs?:
   { facet, prUrl }[]` field (over a side-car lookup) — simplest read path at all
   three surfaces; purely additive to the schema. **Built in the follow-up PR.**
4. ~~**Batching (§6).**~~ **RESOLVED (Daniel):** one consolidated per-network
   removal proposal — a single `scheduleBatch` Remove carrying every queued facet's
   origin PR via the `parkedTaskRefs` array (fewer proposals, one extra signature in
   the session). **Built in the follow-up PR** (`drainNetwork`).
5. **Deploy-log hazard (§8).** Harden the drain to resolve by stored `facetAddress`
   when the log entry was pruned (small engine extension), **and/or** just enforce
   "don't prune the log until the parked task retires"? (Recommend both.)
6. **Opt-in default (§6/§11).** Semantics **decided**: `DRAIN_PARKED_TASKS` default off,
   **ON for rollouts, OFF for emergencies**. Still open: **when** we flip it on by
   default, and whether that's per-network or global.
7. ~~**Reconcile ownership (§7).**~~ **RESOLVED (Daniel):** a standalone
   `reconcile-parked-tasks.ts` job + cron (`.github/workflows/reconcileParkedTasks.yml`),
   not folded into the audited `reconcile.ts` sweep — keeps the parked-task lifecycle
   self-contained and independently runnable (loupe-primary; `pendingTransactions`
   status optional via tunnel). **Built in the follow-up PR.**
8. **Enqueue timing (§10) — OPEN, recommendation stands.** The `prUrl` isn't known until
   the deprecation PR exists. **Recommend enqueue as the last step, once `gh pr create`
   returns the URL** (over writing placeholder records and backfilling). **Not**
   explicitly nailed in the thread — team to confirm.
9. **Scope of `kind` (§3/§4).** Facet-removal-only v1 with an extensible `kind`, vs
   design the other "non-urgent diamond changes" now (which? periphery de-register?
   selector re-points?).
10. ~~**TTL (§8).**~~ **RESOLVED (Daniel): 60 days.** The cold-network alert fires
    for any open task older than 60d (`DEFAULT_TTL_DAYS`, overridable via `--ttlDays`).
    **Built in the follow-up PR** (`reconcile-parked-tasks.ts` + weekly cron).

---

## 15. Enqueue → park → drain → propose → execute (at a glance)

```text
 DEPRECATION TIME                         SOME LATER FACET CUT ON NETWORK X
 ────────────────                         ──────────────────────────────────────
 /deprecate-contract F                    rollout / any proposeDiamondCut → runPropose
   │ (removes F from codebase)              │
   │ opens deprecation PR #P                │ primary proposal stored (_runPropose, unchanged)
   ▼                                        ▼
 enqueue parkedTask{                      drainParkedTasks(X)  ◄── runPropose tail, the ONE hook (§6)
   kind: facet-removal,                     │  (DRAIN_PARKED_TASKS on; try/catch)
   network: X, facetName: F,                │ 1. read status:queued for X
   prUrl: #P, status: queued }              │ 2. computeNamedFacetRemovals (live loupe)
   │                                        │ 3. claimForProposal flip queued→proposed  (dedup gate)
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
