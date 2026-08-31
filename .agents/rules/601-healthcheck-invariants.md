---
name: Health-check invariant maintenance
description: Keep the declarative health-check invariant registry in sync when facets/periphery contracts are added, removed, or changed
globs:
  - 'src/Facets/**/*.sol'
  - 'src/Periphery/**/*.sol'
  - 'script/deploy/_targetState.json'
paths:
  - 'src/Facets/**/*.sol'
  - 'src/Periphery/**/*.sol'
  - 'script/deploy/_targetState.json'
---

## Health-check invariant registry ([CONV:HEALTHCHECK-INVARIANTS])

Every production diamond is swept daily against a fixed set of on-chain invariants
(facets deployed & registered, periphery wired correctly, ownership handed to the right
wallets/timelock, whitelist synced). Those invariants live as a single declarative array,
`HEALTH_CHECK_INVARIANTS`, in `script/deploy/healthCheckInvariants.ts` — this is the
**single edit surface**. Adding a check is appending one `{ name, description, severity,
scope, run() }` descriptor to that array; it is a registry edit, not bespoke control flow.

When you add, remove, or change a facet or periphery contract (including adding/removing
it from `script/deploy/_targetState.json`), review the registry and decide whether an
invariant must be added, adjusted, or removed. Use this checklist:

- **Facet added** → deployment + registration is already covered generically by the
  `facets-registered` invariant plus the target-state facet lists. Add a bespoke invariant
  **only** if the facet introduces a new binding, authorization, or owner relationship that
  the generic checks don't assert (e.g. it stores an address it must stay wired to, or it
  grants a wallet/role new execution rights).
- **Periphery added that binds to the Diamond / Executor / ERC20Proxy** (a new Receiver, a
  new proxy, etc.) → add a binding invariant mirroring `executor-erc20proxy-binding` /
  `receiver-executor-binding`: register the contract and its getter (for Receivers, extend
  the `RECEIVER_EXECUTOR_GETTERS` list) and assert it points at the deployed counterpart.
- **Contract removed / deprecated** → remove its registry entry and any hardcoded name
  lists that reference it (e.g. drop the contract from `RECEIVER_EXECUTOR_GETTERS`).
- **Struct, authorization, or owner semantics changed** → adjust the affected invariant so
  its assertion still matches on-chain reality (e.g. a changed expected owner, a new
  authorized selector, a renamed getter).

If none of the above applies, no registry change is needed — but the review itself is not
optional. Edits to `healthCheckInvariants.ts` follow `200-typescript.md` (module header,
JSDoc on exports, `bunx eslint` + `bunx tsc-files --noEmit`).

## Intent-aware invariants, chain-only generators ([CONV:HEALTHCHECK-INTENT])

Several invariants compare on-chain reality against a _desired_ state that a merged PR
already records — `_targetState.json` for `facets-registered` and `periphery-registered`, a
deleted source file for `no-stale-registered-facets`. Between that merge and the multisig
operation acting on it the two legitimately disagree, and the remediation is "wait", not
"fix".

Invariants may consult operator intent to resolve that window and report the finding as
**expected-pending** instead of a failure:

- Additions read the timelock execution queue (`script/deploy/safe/pending-registrations.ts`)
  and downgrade only when a `queued` operation registers **exactly** the deploy-log address,
  on **that** network's diamond. Keying by address rather than by name is deliberate — the
  same lesson as the parked queue (EXSC-750/EXSC-775).
- Removals read the parked-task queue (`script/deploy/safe/parked-tasks.ts`), and only while
  the task is **live** — a claim held with no Safe proposal past `STALE_PARKED_CLAIM_DAYS` is
  breakage, not progress, and covers nothing.

Know what the addition side does **not** cover, so nobody reads a red network as a bug in the
invariant:

- A queue row exists only once the Safe transaction executing `scheduleBatch` has been mined,
  so the multisig **signing** window before it stays red. Only the timelock delay itself
  (plus execution lag) is covered.
- A rollout proposed **without** `--timelock` writes no row at all, and so is never downgraded.
- **Tron** rolls out through `contracts-tron` and has no EVM queue row; it is skipped by branch.
- A row is honoured only while it is plausibly still waiting. A never-scheduled or
  directly-cancelled operation is reported and skipped by the execution runner *without* a
  status change, so it stays `queued` forever; honouring it indefinitely would mask the very
  never-landed cut these gates exist to catch. Rows past their delay plus a grace window are
  therefore dropped and report as hard errors.

Two boundaries are not negotiable:

- **Never let intent drive a generator.** A bad queue read, or an operation cancelled later,
  costs a false alert that self-corrects on the next sweep; the same bad read inside
  `saveDiamondFacets` leaves a wrong deploy log committed to git with nobody owning the
  compensating write. Deploy logs stay a pure function of the loupe
  ([docs/DeploymentLogs.md](../../docs/DeploymentLogs.md)).
- **An unreachable queue must never suppress a finding.** What decides the degradation is
  what the check is *for*, not its severity — all three are error-severity.
  `no-stale-registered-facets` exists _only_ to police queue coverage, so without the queue
  every finding it could make is noise: it skips and reports the reduced coverage.
  `facets-registered` and `periphery-registered` stand on an independent on-chain signal, so
  they keep every error and add a warning naming the degraded coverage — a MongoDB blip
  turning genuinely missing registrations green is far worse than a false alert during a
  rollout.
