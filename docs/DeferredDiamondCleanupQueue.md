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
  taskKey: string            // dedup key: `${kind}|${network}|${environment}|${facetAddress}` (see §7)
  kind: 'facet-removal'      // extensible; only facet-removal in v1
  network: string            // lowercased, matches pendingTransactions convention
  environment: EnvironmentEnum // 'production' in v1 (§9)
  facetName: string          // human-readable LABEL for reports — NOT the identity
  diamondAddress: `0x${string}`  // snapshot from deploy log at enqueue (sanity/fallback)
  facetAddress: `0x${string}`    // the IDENTITY — selectors are NOT stored (see below)
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
or `already-gone`). **Wired into `execute-pending-timelock-tx` / `executeOperation`:**
immediately before `executeBatch`, the runner rebuilds the propose-time snapshot from
Remove payloads + parked tasks (`listParkedTasksBySafeTxHash` +
`buildRemovalSnapshotFromPayloads`) and aborts if `stale` is non-empty. Under the fold
that aborts the **entire** timelock batch (primary cut + removals) — the schedule is
immutable, so "re-propose from `stillRemovable`" means cancel the op and drain again.
Remove cuts with no parked rows for the Safe tx hash also abort (fail closed) —
doomed addresses are not recoverable from calldata (`facetAddress = 0`), so
executing blind would reopen silent live-selector deletion. That covers drain
unlink (best-effort `setSafeTxHash` never stamped) and legacy
`cleanUpProdDiamond` until those removals park too.

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

**Implementation shape (folds removals into the primary's `scheduleBatch`).** Extract the
current `runPropose` body into `_runPropose(options, extraTimelockCalls?, parkedTaskRefs?)`
— which appends the extra calls to `normalizeProposeCalls`'s `targets`/`calldatas` before
the timelock wrap and returns `{ safeTxHash, stored }`. The public `runPropose` drives it
through `proposeWithDrain`, which prepares the removal calls **before** the primary is
signed so they ride in the same single Safe transaction (Q4 revisited — see Batching
below):

```ts
// script/deploy/safe/propose-to-safe.ts
export async function _runPropose(
  options: IProposeToSafeOptions,
  extraTimelockCalls: ITimelockCall[] = [], // appended to the scheduleBatch inner calls
  parkedTaskRefs?: IParkedTaskRef[] // annotated onto the stored proposal
): Promise<{ safeTxHash: Hex; stored: boolean }> {
  /* normalizeProposeCalls → (append extraTimelockCalls) → initializeSafeClient →
     getSafeMongoCollection → getNextNonce → createTransaction → sign →
     storeTransactionInMongoDB(…, parkedTaskRefs) */
}

export async function runPropose(options: IProposeToSafeOptions) {
  // proposeWithDrain claims removals, folds them into the ONE proposal, then links
  // (or reverts) the claimed tasks; a drain problem falls back to primary-only.
  await proposeWithDrain(options, (extraCalls, refs) =>
    _runPropose(options, extraCalls, refs)
  )
}
```

- **New helper** `script/deploy/safe/drain-parked-tasks.ts` (mirrors the `parked-tasks.ts`
  kebab convention). It opens its own `getParkedTasksCollection()` (Fact 15) — the drain
  reads the queue on the non-sensitive cluster, independent of the signing store — and
  hands its removal calls to `_runPropose`, **not** by minting a second proposal or
  recursing through `runPropose`.
- **Flag-gated — `DRAIN_PARKED_TASKS` (Q6, semantics decided): ON for rollouts, OFF for
  emergencies.** Default **off** in v1. The point of the flag is scoping, not just a
  kill-switch: an urgent pause / break-glass proposal must **never** drag unrelated facet
  removals into its signing set, so emergency flows run with `DRAIN_PARKED_TASKS` unset
  and stay a single clean proposal; deliberate rollouts set it on to let removals ride.
- **Timelock-only.** Removals need the `scheduleBatch` to batch into, so the fold-in runs
  only when the primary proposal is timelocked (`isDrainEligible`). A non-timelock primary
  leaves the tasks `queued` for the next timelocked cut.
- **Reentrancy-guarded** so a primary proposal that itself re-enters `runPropose` can't
  re-trigger a drain.
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

1. Query `parkedTasks` for `{network, environment, status:'queued'}`. A legacy row
   whose stored `facetAddress` is not a valid EVM address is skipped + alerted
   (`invalidAddresses`) instead of aborting the network's drain.
2. `computeFacetRemovalsByAddress(network, environment, addresses)` for those tasks'
   stored `facetAddress`es (never their names — see §8). Partition the result:
   - `notFoundOnChain` → mark those records **`superseded`** (that exact facet is
     already gone — removed another way) — **unless** a facet of the task's NAME is
     still routed (`suspectSnapshots`): the snapshot may be wrong, so the task stays
     queued + alerts for a human.
   - `protectedSkipped` → mark **`cancelled`** + alert loudly (a protected facet
     should never have been queued — a bug in enqueue).
   - `stillExpected` → keep queued + alert (the address points at a facet target
     state still expects — a wrong snapshot must never remove a live facet).
   - `unverifiable` → keep queued + alert (no target-state entry, or the selector
     unions are unavailable — run `forge build`).
   - `removals` → proceed, but refuse (`nameMismatch`, keep queued + alert) any
     removal whose engine-resolved deploy-log name disagrees with the task's
     `facetName`, and skip (`duplicateAddresses`) any address already carried by
     another open task or claimed earlier in this run.
3. **Atomically** flip each removal's record `queued → proposed` via
   `claimForProposal(parkedTasks, taskKey)` (Fact 15) — the merged
   `findOneAndUpdate({taskKey, status:'queued'}, …)`. This is the dedup gate (§7): a
   concurrent drain finds no `queued` record, gets `null`, and skips it — so two parallel
   sessions draining the same network **cannot double-propose the same removal**,
   independent of the salt-nondeterministic `intentHash` (Fact 9).
4. Build **one `diamondCut` Remove call per claimed facet** →
   `buildDiamondCutRemoveCalldata([{name, selectors}])` — and hand those calls to
   `_runPropose` as `extraTimelockCalls`, which appends them to the primary proposal's
   `scheduleBatch` (Fact 9). No second proposal is minted.
5. Once `_runPropose` returns the primary's `safeTxHash`, set it on each flipped record
   (`setSafeTxHash`). If the primary proposal **fails** — or was a duplicate that created
   no new proposal — revert the flipped records with `revertToQueued` (Fact 15), clearing
   the stale `proposedAt`/`safeTxHash` so the next drain re-folds them cleanly. Preparation
   failures before the primary is signed revert their own claims and fall back to
   primary-only, so a drain problem never blocks the primary.

**Batching — one proposal, one signature (Q4 revisited).** Every claimed facet becomes its
own `diamondCut` Remove element **appended to the primary proposal's `scheduleBatch`** — so
a rollout that already signs one proposal signs exactly one, now carrying the cleanups too
(N parked facets → the primary's calls + N removal elements). This supersedes the earlier
"one *extra* proposal per network in the same signing session" recommendation: a separate
proposal is still a full second sign + schedule + execute, which defeated the near-zero
marginal-signing goal. The fold happens purely in TypeScript at the `runPropose` layer
(the primary's calldata is already TS by then), so it never threads removal logic into the
Solidity deploy scripts — the language-boundary concern in FacetRemovalReconciliation §4
only ever applied to a *single on-chain `diamondCut`*, not to a shared `scheduleBatch`.
Every removal call is captured by the same `list-pending-proposals.ts` sweep, lands in the
same rollout PR, and — carrying its origin PR via `parkedTaskRefs` — is reviewed inline in
the one proposal.

**Accepted tradeoff — review-time coupling.** Folding into one timelock operation couples
the removals to the upgrade: a reviewer who objects to a removal must reject the whole
proposal (upgrade included), not just the removal. That is acceptable because each removal
already carries its origin-PR link for review, and the `DRAIN_PARKED_TASKS`-off default
keeps emergency / break-glass proposals a single clean upgrade with nothing folded in.

**Accepted tradeoff — execution-time atomicity (TOCTOU).** Because the removals share the
upgrade's `scheduleBatch`, on-chain execution is atomic: a bad folded Remove would take
the primary cut with it. Two failure modes in the delay window: (1) selector already
gone → on-chain `FunctionDoesNotExist` revert of the whole batch; (2) selector
**re-pointed** to a live facet → the Remove (`facetAddress = 0`) would *succeed* and
silently delete the live selector. The pre-execute guard in `execute-pending-timelock-tx`
(§4) refuses both before `executeBatch`, marking the queue row `failed` so the cron does
not retry. The prepare-time partition still shrinks the window; the schedule remains
immutable once queued. Exposure is low in practice (parked removals target already-
deprecated facets), but larger than the old separate-proposal design. Mitigations if the
guard ever false-positives a rollout: cancel the op, or gate `DRAIN_PARKED_TASKS` off.
A rare false abort can also come from same-ms `proposedAt` ties mis-ordering the
trailing-N Remove zip (fail-safe, not silent delete) — accepted until claim-time
append indexing ships. Flagged for governance review; the default-off flag remains
the break-glass escape hatch.

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
   Include the origin-PR URLs in the proposal's line of the thread.

**Multiple parked tasks from different PRs on one network → folded into the one primary
proposal, carrying multiple PR links** (Q4 revisited, Batching above). `parkedTaskRefs` is
an array precisely so a network with facet *A* (PR #2046) and facet *B* (PR #2048) queued
appends **two** removal elements to the primary's `scheduleBatch` and shows **two**
origin-PR lines to the signer.

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
        │       executed / superseded  (terminal, = done)
        │                    │
        └────────────────────┘ reconcile: parked ADDRESS still routed AND still
                                 deprecated → reopen (EXSC-774)

             operator CLI (deprecation reverted / obsolete) ─► cancelled (terminal)
             network outside the active set (opt-in) ────────┘ (queued only)
```

`executed`/`superseded` are terminal but **not trusted**: every reconcile re-verifies
them against the loupe, because a removal recorded as done that never actually landed
was otherwise never re-checked and stayed invisible indefinitely (EXSC-774 — worldchain's
`AcrossFacetV3` sat live for 18 days behind an `executed` record). `cancelled` is the only
truly final state.

All six transitions ship as helpers in `parked-tasks.ts` (#2051, Fact 15):

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
- **executed/superseded → queued**: `reopenResolvedTask` — the reconcile finds the facet
  still routed despite a terminal status, so the removal never landed. Clears
  `resolvedAt`/`proposedAt`/`safeTxHash`, **recomputes `taskKey`** from the row's own
  fields (a legacy name-keyed row must re-enter the open index under the address key
  the dedup guarantees are built on), and alerts the CI-notifications channel.
  Addressed by `_id`, not `taskKey`: the partial unique index covers only the open
  statuses, so one key can own several terminal rows (parked → executed → re-parked →
  executed) and a key-matched write could modify a different row than the one the sweep
  decided on. Reopening also requires the facet to be **still removable**, judged by
  `computeFacetRemovalsByAddress` — the exact engine the drain removes through, so
  eval and remover cannot disagree: the address must land in its `removals`
  partition **and** its engine-resolved deploy-log name must agree with the task's
  `facetName` (mirroring the drain's own name-mismatch refusal). An address the
  engine refuses (`protectedSkipped`, or `stillExpected` because the deploy log
  names it as a target-state facet or it routes a selector an expected facet owns)
  is a deliberate re-add (an incident rollback re-cutting it, or a CREATE2 redeploy
  landing on the same address), so the reopen is withheld and reported as an
  anomaly instead of queueing a `Remove` for a live facet. The selector fallback is
  what keeps a *superseded* version reopenable: the live successor owns the name in
  target state, so a name-only gate would withhold exactly the co-registered case
  this queue exists for. Anything undecidable (`unverifiable`: no target-state entry,
  unreadable artifacts) withholds too. `cancelled` is deliberately excluded (it
  records an operator's decision, not a claim about on-chain state).
- **→ cancelled**: `markCancelled` (`:383`) — an operator explicitly abandons the intent
  (deprecation reverted, facet re-added, or a protected facet queued in error), via
  `bunx tsx script/deploy/safe/cancel-parked-task.ts --taskKey "<key>" --yes`. **Merged
  behaviour: restricted to `queued`** — cancelling a `proposed` task would orphan its
  already-minted Safe removal proposal from the origin-PR linkage (§6), so a claimed task
  must be `revertToQueued` first, then cancelled.
- **queued → cancelled (deprecated network)**: the reconcile evaluates network status
  *before* on-chain truth (`partitionByNetworkStatus` → `deprecatedNetworkDecision`),
  because a network that is not in the active set has no resolvable chain for the
  reconcile to read: `getViemChainForNetworkName` throws for an absent key, and no
  `ETH_NODE_URI_<NETWORK>` is configured for one that is not active. So the task is
  out of scope for on-chain reconciliation either way, and abandoning the intent is
  the only terminal answer available — but *being out of the active set is not proof
  the network was deprecated*.
  **Applying that cancellation is opt-in and single-network**
  (`--network <x> --cancel-deprecated --yes`): a non-active config entry is *not* proof
  of deprecation — `config/networks.json` is deliberately narrowed for emergency-pause
  rehearsals and then restored. An unattended
  fleet-wide run that cancelled on that signal would read a temporary config as a
  fleet-wide deprecation and terminally empty the queue, with no undo (`cancelled` is
  terminal and re-enqueue needs origin-PR context). So the cron only ever **reports**
  these; `/deprecate-network` does the cancelling, once, for the network a human named.
  Terminal tasks on a non-active network are also named in the failure alert — their
  false-resolution re-check is suspended while the config excludes the chain, and that
  suspension must be visible in Slack, not only the job log.
  A `proposed` task is **never** cancelled either way (same orphaned-proposal rule as
  above); it needs `revertToQueued` first, for which no operator CLI exists yet
  (EXSC-715).

**Idempotency / dedup**

- **Don't enqueue twice.** Partial unique index `unique_open_task_key` on `taskKey`
  (`${kind}|${network}|${environment}|${facetAddress}`) filtered to
  `status ∈ {queued, proposed}` (Fact 15) — mirrors `unique_pending_intent_hash`
  (Fact 8). A repeat `/deprecate-contract` of the same facet hits E11000 and
  `enqueueParkedTask` returns `null` — a harmless no-op. `facetAddress` is validated
  at enqueue: **EVM `0x` addresses only**, canonicalised to the checksummed form —
  no consumer (the EVM drain, the viem-based reconcile) can process anything else,
  so a non-EVM value would mint a row nothing can ever drain or verify.
- **Legacy name-based keys.** Rows parked before the key moved from `facetName` to
  `facetAddress` (EXSC-775) should be migrated with
  `bunx tsx script/deploy/safe/migrate-parked-task-keys.ts --apply`, but the
  invariant does not depend on the migration having run: the drain seeds its
  duplicate-address guard with every open (`queued` **and** `proposed`) task, records
  addresses even for lost claims, and `reopenResolvedTask` recomputes the key and
  pre-checks open rows by address — so two open tasks for one address can never fold
  two identical `Remove` calls into proposals, whatever their key format.
- **Don't re-propose if pending.** The atomic `claimForProposal` flip (above) is the
  guarantee; a `proposed` record whose proposal is still `pending` is skipped.
- **Safe re-runs.** The whole drain is idempotent: nothing `queued` ⇒ no-op.
- **No contradiction is removed.** The drain refuses (keeps queued + alerts) a task
  whose loupe-resolved deploy-log name disagrees with its parked `facetName`, one
  whose address target state still expects (`stillExpected`), one whose removability
  cannot be verified (`unverifiable` — the remedy there is `forge build`, not a
  cancellation), and a legacy row whose stored address is not a valid EVM address.
  The wrong-snapshot alerts name the `cancel-parked-task.ts` command that retires
  the task.

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
   `#dev-sc-github-ci-notifications` (`WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS`), naming
   the network, facets, and origin PRs, prompting a deliberate `--auto --network X` drain.
   `#dev-sc-multisig-proposals` stays reserved for please-sign announcements, so scheduled
   job output never competes with the signing worklist. Delivery requires `CI`: a local run
   (including the full-tunnel one §7 recommends) prints the alert to the console instead of
   posting it, so a rehearsal cannot page the team. Export `CI=1` to force delivery. On the
   scheduled run an unset webhook fails the job instead of dropping the alert, so the backstop
   cannot go quiet behind a green check.
3. **Observability** (§9) makes the backlog visible on demand.

**The backstop must survive a bad network.** The reconcile isolates each
`(network, environment)` group, **each per-task queue write**, the optional
proposal-store connection, each cancellation, and the sweep as a whole: an
unreachable chain, a missing RPC or a failed status write is logged and collected as
an `IReconcileFailure`, the remaining tasks and groups are still decided, and both
the failure alert and the TTL alert still fire — every skipped network is named in
Slack before the exit code is decided, so an `unreadable` group reddens the run without
the detail collapsing into a bare non-zero exit. The write path needs
the same isolation as the read path: an unguarded transition would unwind past every
group ordered after it, which is the same fleet-wide freeze from the read side.
A single unresolvable network aborting the batch would silently disable backstop 2
for the whole fleet, which is how the first four scheduled runs were lost.

**Deploy-log longevity hazard (important).** Because removal is now *deferred*
(possibly weeks), a name-resolving removal depends on the
`deployments/<network>.json` facet→address entry (Fact 2) surviving until the parked
task **retires** — longer than #2047's already-documented "don't prune until
executed" window (Fact 10). Two mitigations, both in this spec:

- **The queue never resolves a name (EXSC-775).** A task's identity is its
  `facetAddress` (§4), and the drain resolves it through
  `computeFacetRemovalsByAddress`, which matches the loupe by address and takes
  selectors from it. The deploy log supplies only a display label and the
  never-remove check, so a pruned entry cannot mis-resolve a removal. This also
  makes a *superseded* facet targetable: the log holds exactly one address per
  name, so while SymbiosisFacet v1.0.0 and v2.0.0 are both cut into 35 production
  diamonds (EXSC-750), only an address can say which one is doomed.
- `/deprecate-contract`'s existing "don't delete `deployments/*.json` entries until
  executed" warning (Fact 10) is **strengthened** to "until the parked task retires" —
  not for the drain (address-resolving, above) but because the health check's
  queue-aware stale-facet invariant (`no-stale-registered-facets`) maps on-chain
  addresses to names through the log in order to detect them at all (its queue
  coverage check is address-keyed, like the drain). The weekly reconcile job (§7) reports which
  entries are **safe to prune** (every covering task terminal); pruning then is a
  small reviewed PR.

**Network-retirement hazard.** `/deprecate-network` removes the network from
`config/networks.json` and its `deployments/*.json`, which takes away everything a
parked task on that network needs: there is no RPC to read the loupe with, no deploy
log to resolve the diamond from, and no future cut to ride along with. Such a task can
never reach a terminal state on its own. The reconcile therefore partitions those tasks
out **before** any I/O and reports them in the unreconciled-network alert as
`inactive-network` rows to cancel, and treats a per-network error as a skip rather than
an abort: otherwise a fleet loop that dies on its first unusable network takes the whole
sweep — and the TTL backstop alert, which runs after it — down with it. Only the
`unreadable` rows (RPC, deploy log, queue write) fail the run; an `inactive-network` row
repeats in the alert until the task is cancelled and must not keep the cron red.
A network deprecation should still abandon the retired network's open tasks rather
than leave them for the alert to repeat: `reconcile-parked-tasks --network <x>
--cancel-deprecated --yes` cancels the `queued` ones (§7), and a `proposed` one needs
`revertToQueued` first because `markCancelled` accepts only a `queued` task. Flip the
entry's `status` out of `active` before running it — while the network is still active
its tasks go to the loupe path and the command is a silent no-op.

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
already carry the primary proposal that the removals are folded into — the skill doc gains
only the PR-link surfacing (§6) and drops the manual `--auto` invocation.

---

## 11. Guardrails (non-negotiable)

| Guardrail | How |
|---|---|
| No new governance path / no bypass | Queue lives on the **non-sensitive `MONGODB_URI` cluster** (off the signing store), **mirroring** the existing `timelock-operations/queue` (Fact 5, 15). Removals still go loupe → `buildDiamondCutRemoveCalldata` → `wrapWithTimelockSchedule` → Safe → timelock → quorum, **unchanged** (Facts 2, 4, 9). Timelock/Safe never weakened (`002:29`, `105:15`). |
| PR link mandatory + reviewer-visible | `enqueueParkedTask` throws on a blank `prUrl` (Fact 15); drain **logs each removal loudly** and copies the link to `parkedTaskRefs` on the proposal; shown in `confirm-safe-tx` detailLines, `list-pending-proposals`, and Slack (§6). |
| No double-enqueue / no double-propose | Partial unique index `unique_open_task_key` on `taskKey`; the atomic `claimForProposal` flip — independent of the salt-nondeterministic `intentHash` (Facts 8, 9, 15; §7). |
| Never park/remove a protected facet | Enqueue and drain both call `getProtectedNames()` (`diamondRemovalDiff.ts`); a queued protected facet is `cancelled` + alerted (§6). The address path checks protection twice, the second side independent of the deploy log: an address the log cannot name (the normal case for a superseded version) is matched by **selector** against the union owned by the protected facets, and refused on a hit — or reported `unverifiable` when that union cannot be built from artifacts — never removed, and deliberately NOT reported as protected, since the drain *cancels* a protected task (terminal, "parked in error") while a missing artifact must leave it queued for the next run. Inherits every #2047 guardrail (drift gate is N/A — named path). |
| Deferred ≠ orphaned | Cold-network backstops: `--auto --all-networks` sweep + TTL Slack alert + observability CLI (§8). No silent truncation — the TTL alert names what's still queued. |
| Deploy-log longevity | Presence is resolved by the parked **address**, matching the drain (EXSC-775); a pruned log entry therefore cannot false-`superseded` a live facet, and the strengthened `/deprecate-contract` warning (§8) keeps the label resolvable. A snapshot address can still be flat wrong, so address-gone + **name still routed** on a task **no proposal ever claimed** resolves nothing: both the drain and the reconcile refuse the transition and alert instead (EXSC-774). A claimed task is exempt — the drain resolves selectors off the diamond's own loupe before claiming, so a linked `safeTxHash` proves the address was routed there and its absence is that removal landing, which is exactly the co-registered shape (EXSC-750); without the exemption every such removal would sit unresolved and re-alert forever. |
| A resolution can be wrong | `executed`/`superseded` are re-verified against the loupe on every reconcile and reopened when the facet is still routed **and still removable** (§7) — a facet that is expected again was re-added deliberately, so the reopen is withheld and alerted rather than queueing a `Remove` for a live facet. A stored terminal status is never taken as proof, and no contradictory data resolves silently: withheld decisions go to Slack, not just the job log. |
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
| Address-keyed removal identity (deploy-log-pruned robustness §8 + co-registered versions) | 3 | our build | ✅ **DONE — this PR** (`computeFacetRemovalsByAddress`, EXSC-775) |
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
4. ~~**Batching (§6).**~~ **RESOLVED, then REVISED (Daniel):** originally one consolidated
   *extra* per-network removal proposal in the same session; revised to **fold the removals
   into the primary proposal's `scheduleBatch`** (one `diamondCut` Remove element per
   claimed facet, carrying each origin PR via `parkedTaskRefs`) so a rollout signs exactly
   **one** proposal — a separate proposal was still a full second sign/schedule/execute.
   Accepted tradeoff: removals are coupled to the upgrade's timelock op (reject-one =
   reject-all). See §6 Batching. **Built in `prepareDrainNetwork` / `proposeWithDrain`.**
5. ~~**Deploy-log hazard (§8).**~~ **RESOLVED (EXSC-723/EXSC-775):** both, plus
   detection. The drain resolves removals by stored `facetAddress` and never by
   name, so a pruned or ambiguous log entry cannot mis-resolve one; the queue-aware
   health-check invariant `no-stale-registered-facets` flags any
   deprecated-but-registered facet with no open parked task, and the reconcile job
   reports deploy-log entries that are safe to prune once every covering task is
   terminal.
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
   │ opens deprecation PR #P                │ proposeWithDrain(X)  ◄── the ONE hook (§6)
   ▼                                        ▼  (DRAIN_PARKED_TASKS on; timelock; try/catch)
 enqueue parkedTask{                        │ 1. read status:queued for X
   kind: facet-removal,                     │ 2. computeFacetRemovalsByAddress (live loupe)
   network: X, facetAddress: A,             │ 3. claimForProposal flip queued→proposed  (dedup gate)
   prUrl: #P, status: queued }              │ 4. build one Remove call per facet, carrying #P link
   │                                        │ 5. _runPropose folds them into the primary scheduleBatch
   │  … survives across sessions …          │ 6. link claimed tasks → the primary's safeTxHash
   └───────────────────────────────────────┤     (revert on primary failure / duplicate)
                                            ▼
                            ONE Safe proposal (pendingTransactions) — primary + N Removes,
                                            │  reviewer sees "origin PR #P" per folded removal
                                            │  (confirm-safe-tx detailLines + list-pending + Slack)
                                            ▼
                            ≥quorum sign (Ledger) → timelock delay → execute
                                            ▼
                            reconcile: loupe shows F gone  →  parkedTask: executed ✅

 COLD NETWORK never touched? → --auto --all-networks sweep  ∪  TTL Slack alert  (§8)
```
