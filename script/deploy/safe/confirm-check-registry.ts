/**
 * Maps each sign-time gate's own verdict onto a `check-ledger` row.
 *
 * The translation lives here rather than in `check-ledger.ts` (which must not
 * know about any particular gate) or in the gates themselves (which must stay
 * usable without a ledger).
 *
 * Every mapping names the anchor the verdict actually rests on, so `recordCheck`
 * coerces a `pass` claimed on a reporting-only anchor to `error`. That backstop
 * reaches only the reporting-only anchors; a green on `A-LOCAL` or `A-CHAIN` is
 * not coerced, so each mapping that can emit one carries its own guard — the
 * target state's is the cross-check against `STATUSES_CLEARED_TO_PROCEED`.
 */

import type { ICheckDefinition, ICheckResult } from './check-ledger'
import {
  CHECK_TIMELOCK_DELAY,
  INTEGRITY_CHECKS_ALWAYS,
  INTEGRITY_CHECK_DEFINITIONS,
  type IIntegrityAssertRun,
} from './confirm-integrity-asserts'
import type { IExecutabilityVerdict } from './executability-simulation'
import type {
  ITargetStateFinding,
  ITargetStateVerdict,
  TargetStateStatus,
} from './pinned-target-state'
import { MIN_INDEPENDENT_PROVIDERS, type IRpcQuorumVerdict } from './rpc-quorum'

export const TARGET_STATE_CHECK_ID = 'target-state'

export const TARGET_STATE_CHECK: ICheckDefinition = {
  checkId: TARGET_STATE_CHECK_ID,
  section: 'Intent',
  checkClass: 'semantic',
  title: 'Facet version matches the declared target state',
}

interface IStatusMapping {
  status: ICheckResult['status']
  anchor: ICheckResult['anchor']
}

/**
 * How each graded status reaches the ledger.
 *
 * Split by the anchor each status rests on, not by whether it is cleared to
 * proceed. Every status that had to resolve the proposed version through the
 * deployment record is `A-MONGO` — including the three that then compared it
 * against `origin/main`, because the proposer writes that record and so owns
 * one side of the comparison. `A-MONGO` cannot decide a pass, so those three
 * ask a human instead, which a `semantic` check may legitimately do.
 *
 * The three unresolvable statuses reach `A-UNRESOLVED` because nothing
 * answered at all: an action that is not Add, Replace or Remove, calldata that
 * could not be read, or an anchor that could not be reached.
 *
 * Keyed exhaustively so a status added to `TargetStateStatus` fails to compile
 * here rather than falling through to a default that would grade it green.
 */
const STATUS_MAPPING: Readonly<Record<TargetStateStatus, IStatusMapping>> = {
  'matches-main': { status: 'needs-ack', anchor: 'A-MONGO' },
  'ahead-of-main': { status: 'needs-ack', anchor: 'A-MONGO' },
  // `origin/main` declares nothing for this contract, so nothing was compared.
  // The common path, not an edge case: the target-state update merges only
  // after execution, so every first deployment lands here.
  'not-previously-targeted': { status: 'needs-ack', anchor: 'A-MONGO' },
  // The removal branch returns before the anchor is read at all, so there is no
  // claim on `origin/main` to make — the same shape as `no-diamond-cut` below.
  removal: { status: 'pass', anchor: 'A-LOCAL' },
  // No cut to grade. A pass on `A-LOCAL` rather than a skipped row: the
  // calldata was read and found to install nothing, which is a verified fact
  // about this proposal, not an absence of evidence.
  'no-diamond-cut': { status: 'pass', anchor: 'A-LOCAL' },
  downgrade: { status: 'fail', anchor: 'A-MAIN' },
  'version-not-comparable': { status: 'error', anchor: 'A-MONGO' },
  'proposed-version-unresolved': { status: 'error', anchor: 'A-MONGO' },
  'contract-unidentified': { status: 'error', anchor: 'A-MONGO' },
  'deployment-record-ambiguous': { status: 'error', anchor: 'A-MONGO' },
  'unrecognised-cut-action': { status: 'error', anchor: 'A-UNRESOLVED' },
  'calldata-not-readable': { status: 'error', anchor: 'A-UNRESOLVED' },
  'pinned-state-unavailable': { status: 'error', anchor: 'A-UNRESOLVED' },
}

/**
 * Worst-first, so reducing many findings to one row cannot lose a refusal.
 *
 * `needs-ack` ranks below `error` because an acknowledgement has a human path
 * and an unverified check has none, so the acknowledgement must never stand in
 * for the thing nothing could grade.
 *
 * `fail` still ranks above `error`, which is not the same ordering: on a
 * `semantic` check `summariseLedger` sends a mismatch to acknowledgement and an
 * `error` to the hard block, so a row reduced from both understates by one
 * step. It is kept because the reduced row's `actual` lists every finding and a
 * mismatch is the more actionable line, and because the signing refusal does not
 * read this order at all — `STATUSES_CLEARED_TO_PROCEED` grades each finding
 * separately.
 */
const SEVERITY: readonly ICheckResult['status'][] = [
  'fail',
  'error',
  'needs-ack',
  'pass',
]

const worstOf = (
  left: ICheckResult['status'],
  right: ICheckResult['status']
): ICheckResult['status'] =>
  SEVERITY.indexOf(left) <= SEVERITY.indexOf(right) ? left : right

const describe = (finding: ITargetStateFinding): string => {
  const name = finding.contractName ?? finding.facetAddress ?? 'unnamed element'
  return `${name}: ${finding.status}`
}

/**
 * Reduces a network's target-state verdict to the single row the ledger holds.
 *
 * One row per network is the ledger's shape, so a proposal grading several
 * facets is represented by its worst finding; the per-finding detail is still
 * printed by `formatTargetStateLines`. A verdict with no findings at all is an
 * `error` on `A-UNRESOLVED` rather than a pass — nothing was graded, and the
 * denominator must not silently shrink.
 *
 * @param verdict - The network's graded verdict.
 * @param network - The network the verdict is about.
 * @returns The row to hand to `recordCheck`.
 */
export const targetStateCheckResult = (
  verdict: ITargetStateVerdict,
  network: string
): ICheckResult => {
  if (verdict.findings.length === 0)
    return {
      checkId: TARGET_STATE_CHECK_ID,
      network,
      status: 'error',
      expected: 'every element of the cut graded against origin/main',
      actual: 'the verdict graded nothing',
      anchor: 'A-UNRESOLVED',
      detail:
        'no finding was produced for this proposal, so no element was compared against the pinned target state',
    }

  let status: ICheckResult['status'] = 'pass'
  // Replaced by the first finding, since every mapped status outranks the seed.
  // `A-UNRESOLVED` rather than `A-MAIN` so the unreachable case still describes
  // a row nothing decided.
  let anchor: ICheckResult['anchor'] = 'A-UNRESOLVED'
  let detail: string | undefined
  let worstRank = SEVERITY.length

  for (const finding of verdict.findings) {
    const mapped = STATUS_MAPPING[finding.status]
    status = worstOf(status, mapped.status)

    // The anchor reported is the one the *worst* finding rests on, so the row
    // never claims a stronger anchor than the thing that decided it.
    // `detail` moves with the anchor for the same reason: taken from the first
    // failing finding in calldata order it can explain a different, milder
    // problem than the one the row is graded on.
    const rank = SEVERITY.indexOf(mapped.status)
    if (rank < worstRank) {
      worstRank = rank
      anchor = mapped.anchor
      detail = finding.detail
    }
  }

  const failing = verdict.findings.filter(
    (finding) => STATUS_MAPPING[finding.status].status !== 'pass'
  )

  return {
    checkId: TARGET_STATE_CHECK_ID,
    network,
    status,
    expected: 'every installed version at or ahead of origin/main',
    actual: (failing.length ? failing : verdict.findings)
      .map(describe)
      .join('; '),
    anchor,
    ...(failing.length && detail ? { detail } : {}),
  }
}

/**
 * Reduces every result a network produced to one row per check.
 *
 * `recordCheck` is called per proposal, but a ledger row is denominated per
 * network, and `rollUpChecks` treats repeat calls for one `(checkId, network)`
 * pair as retries — deliberately letting a later `pass` supersede an earlier
 * `error`. Two proposals on one network are not a retry of each other, so the
 * caller must reduce them here first: extending across proposals the same
 * worst-first reduction `targetStateCheckResult` runs across findings.
 *
 * Grouped by `checkId` so a run recording several checks per proposal reduces
 * each of them independently.
 *
 * @param results - Every result the network's proposals produced, in any order.
 * @returns The worst result for each check, in the order the checks first reported.
 */
export const worstResultPerCheck = (
  results: readonly ICheckResult[]
): ICheckResult[] => {
  const worst = new Map<string, ICheckResult>()

  for (const result of results) {
    const held = worst.get(result.checkId)
    // Strictly worse, so a tie keeps the row already held — the earlier
    // proposal's, which is the one the signer has already been shown.
    if (
      !held ||
      SEVERITY.indexOf(result.status) < SEVERITY.indexOf(held.status)
    )
      worst.set(result.checkId, result)
  }

  return [...worst.values()]
}

export const EXECUTABILITY_CHECK_ID = 'executability'

export const EXECUTABILITY_CHECK: ICheckDefinition = {
  checkId: EXECUTABILITY_CHECK_ID,
  section: 'Execution',
  // Semantic, not integrity: a `Predicted` finding rests on chain state as it
  // was read, and a queue that moves under it turns the answer over. An
  // integrity class would hard-block a legitimate proposal on a stale read with
  // no way for the signer to say so.
  checkClass: 'semantic',
  title: 'The proposal would execute rather than revert',
}

export const RPC_QUORUM_CHECK_ID = 'rpc-quorum'

export const RPC_QUORUM_CHECK: ICheckDefinition = {
  checkId: RPC_QUORUM_CHECK_ID,
  section: 'Evidence',
  checkClass: 'semantic',
  title: 'Chain reads agreed across independent providers',
}

/**
 * The integrity ids this registry mirrors onto the run-level ledger.
 *
 * One list, read by both the registration below and the recorder further down.
 * Two independent copies would let a check be registered here and never
 * answered for, and a registered check with no row is counted missing and
 * blocks — with no type error and no failing test to say why.
 */
const MIRRORED_INTEGRITY_CHECKS: readonly string[] = [
  ...INTEGRITY_CHECKS_ALWAYS,
  CHECK_TIMELOCK_DELAY,
]

/**
 * Every check `confirm-safe-tx.ts` registers on the run's ledger, in the order
 * a signer reads them: what this proposal *is*, then what it *changes*, then
 * whether it would *execute*, then how good the evidence for all of it was.
 *
 * The integrity checks are the same definitions `runIntegrityAsserts` registers
 * on its own per-proposal ledger, reused rather than restated: a second copy
 * would let the two drift in class, and `checkClass` is the field that decides
 * whether a mismatch can be acknowledged.
 *
 * `INT-TIMELOCK-DELAY` is registered here unconditionally even though
 * `runIntegrityAsserts` registers it only for a payload that is a schedule or
 * could not be decoded. A registered
 * check that never reports is counted missing and blocks, so the recorder below
 * has to answer for it on every proposal — which it does, with a pass on
 * `A-LOCAL` when the calldata was read and found not to be a schedule.
 */
export const CONFIRM_CHECK_DEFINITIONS: readonly ICheckDefinition[] = [
  ...MIRRORED_INTEGRITY_CHECKS.map((checkId) => {
    const definition = INTEGRITY_CHECK_DEFINITIONS[checkId]
    if (!definition)
      throw new Error(`CONFIRM_CHECK_DEFINITIONS: no definition for ${checkId}`)
    return definition
  }),
  TARGET_STATE_CHECK,
  EXECUTABILITY_CHECK,
  RPC_QUORUM_CHECK,
]

/**
 * How an executability verdict reaches the ledger.
 *
 * `error` is read before `refuses` for the same reason `toCancelDecisionExecutability`
 * orders them that way: a simulation that could not be made has not established
 * that the proposal reverts, and reporting it as a mismatch would put a
 * disagreement on the ledger that nothing observed.
 *
 * @param verdict - What `evaluateExecutability` decided.
 * @param network - The network the verdict is about.
 * @returns The row to hand to `recordCheck`.
 */
export const executabilityCheckResult = (
  verdict: IExecutabilityVerdict,
  network: string
): ICheckResult => {
  if (verdict.error)
    return {
      checkId: EXECUTABILITY_CHECK_ID,
      network,
      status: 'error',
      expected: 'every payload simulated against the state it will execute in',
      actual: verdict.errors.join(' ') || 'the simulation could not be made',
      anchor: 'A-UNRESOLVED',
    }

  if (verdict.refuses)
    return {
      checkId: EXECUTABILITY_CHECK_ID,
      network,
      status: 'fail',
      expected: 'no payload reverts',
      actual: verdict.reason,
      anchor: 'A-CHAIN',
    }

  return {
    checkId: EXECUTABILITY_CHECK_ID,
    network,
    status: 'pass',
    expected: 'no payload reverts',
    actual:
      verdict.notSimulated.length > 0
        ? `no revert found; ${verdict.notSimulated.length} payload(s) have no revert model`
        : 'no revert found in any payload',
    anchor: 'A-CHAIN',
  }
}

/**
 * How a quorum verdict reaches the ledger.
 *
 * Report-only: this check never records a `fail`. Its hard-block has an
 * infrastructure precondition — two independent providers on every production
 * chain — that this repo does not meet, and a fleet where a substantial share of
 * networks are still single-endpoint would turn missing redundancy into a
 * refusal to sign. So a quorum that was not reached is recorded as an acknowledgement,
 * which puts it on the signer's screen without blocking the run.
 *
 * `agreed-absent` is the exception worth naming: the providers did agree, and
 * what they agreed on is that nothing is at the address. That is the loudest
 * thing this read can say, so it is recorded as an acknowledgement rather than
 * folded into the pass its `status` shares a prefix with.
 *
 * @param verdict - What `evaluateRpcQuorum` decided.
 * @param network - The network the read was made on.
 * @returns The row to hand to `recordCheck`.
 */
export const rpcQuorumCheckResult = (
  verdict: IRpcQuorumVerdict,
  network: string
): ICheckResult => {
  const expected = `${verdict.quorum} independent providers agreeing`
  const actual = `${verdict.agreeingProviders} of ${verdict.independentProviders} agreed (${verdict.status})`

  if (verdict.reachesQuorum)
    return {
      checkId: RPC_QUORUM_CHECK_ID,
      network,
      status: 'pass',
      expected,
      actual,
      anchor: 'A-CHAIN',
    }

  return {
    checkId: RPC_QUORUM_CHECK_ID,
    network,
    status: 'needs-ack',
    expected,
    actual,
    // No quorum on the value the caller asked about: the providers disagreed,
    // there were not enough of them, or they agreed the value is empty, which
    // is agreement without the fact an integrity read wanted.
    anchor: 'A-UNRESOLVED',
    detail: verdict.detail,
  }
}

/** Every verdict one proposal produced, as the recorder below reads them. */
export interface IProposalCheckVerdicts {
  network: string
  /** Absent when the assertions never ran, which is itself a blocking state. */
  integrity: IIntegrityAssertRun | undefined
  targetState: ITargetStateVerdict
  /** Absent when the simulation was never attempted. */
  executability: IExecutabilityVerdict | undefined
  /**
   * Why this network is outside the simulator's declared scope, when it is.
   *
   * Distinct from an absent verdict on a network the simulator does cover: that
   * is a read which should have happened and did not, so it is unverified and
   * blocks. A chain the EVM simulator was never written for — Tron, reached
   * through its own executor — is a known limit, so the signer is asked to
   * acknowledge that it was not simulated rather than being refused a signature
   * the simulator was never going to authorise.
   */
  executabilityOutOfScope?: string
  /** Absent when no quorum read was made. */
  rpcQuorum: IRpcQuorumVerdict | undefined
}

const unresolved = (
  checkId: string,
  network: string,
  expected: string,
  actual: string
): ICheckResult => ({
  checkId,
  network,
  status: 'error',
  expected,
  actual,
  anchor: 'A-UNRESOLVED',
})

/**
 * Mirrors one proposal's integrity run onto the run-level ledger.
 *
 * `runIntegrityAsserts` keeps its own single-network ledger because the refusal
 * it drives is a statement about one transaction, and it must not be widened by
 * a sibling proposal's rows. The run-level ledger needs the same verdicts to
 * compose a report that covers them, so they are mirrored rather than moved —
 * the rows carry the statuses and anchors that run already decided, never a
 * re-derivation of them.
 *
 * A check the run did not register gets a row here regardless, because the
 * run-level ledger registered it and a registered check with no row is counted
 * missing and blocks. The only such check is the timelock delay, and the reason
 * it did not run is that the calldata was read and found not to be a schedule —
 * a verified fact about this proposal, so a pass on `A-LOCAL`, the same way
 * `no-diamond-cut` is a pass rather than an absence.
 */
const integrityResults = (
  run: IIntegrityAssertRun | undefined,
  network: string
): ICheckResult[] => {
  const registered = MIRRORED_INTEGRITY_CHECKS

  if (!run)
    return registered.map((checkId) =>
      unresolved(
        checkId,
        network,
        'the proposal integrity assertions ran',
        'the assertions produced no run for this proposal'
      )
    )

  const byCheckId = new Map<string, ICheckResult>()
  for (const result of run.ledger.results) byCheckId.set(result.checkId, result)

  return registered.map((checkId) => {
    const recorded = byCheckId.get(checkId)
    if (recorded) return { ...recorded, network }

    if (checkId === CHECK_TIMELOCK_DELAY)
      return {
        checkId,
        network,
        status: 'pass' as const,
        expected: "a schedule's delay is at least the timelock's live minimum",
        actual: 'this proposal carries no timelock schedule',
        anchor: 'A-LOCAL' as const,
      }

    return unresolved(
      checkId,
      network,
      'the assertion reported for this proposal',
      'the run registered this check and recorded no result for it'
    )
  })
}

/**
 * Every sign-time verdict for one proposal, in the order a signer reads them.
 *
 * Produces rows rather than recording them: a ledger row is denominated per
 * network, so the caller collects these across the network's proposals and
 * reduces them with `worstResultPerCheck` before recording. Recording here
 * would let a later proposal's `pass` supersede an earlier one's `error`.
 *
 * One ordered step, so the sequence *is* the report's order and a test can pin
 * it by reading the rows back.
 *
 * @param verdicts - What each gate decided for this proposal.
 * @returns One row per registered check, in reading order.
 */
export const proposalCheckResults = (
  verdicts: IProposalCheckVerdicts
): ICheckResult[] => {
  const { network } = verdicts

  return [
    ...integrityResults(verdicts.integrity, network),
    targetStateCheckResult(verdicts.targetState, network),
    verdicts.executability
      ? executabilityCheckResult(verdicts.executability, network)
      : verdicts.executabilityOutOfScope
      ? {
          checkId: EXECUTABILITY_CHECK_ID,
          network,
          status: 'needs-ack',
          expected:
            'every payload simulated against the state it will execute in',
          actual: verdicts.executabilityOutOfScope,
          anchor: 'A-UNRESOLVED',
        }
      : unresolved(
          EXECUTABILITY_CHECK_ID,
          network,
          'every payload simulated against the state it will execute in',
          'no simulation was attempted for this proposal'
        ),
    verdicts.rpcQuorum
      ? rpcQuorumCheckResult(verdicts.rpcQuorum, network)
      : {
          checkId: RPC_QUORUM_CHECK_ID,
          network,
          // Report-only, so an unmade read is an acknowledgement and not the
          // `error` every other unmade check here records: this gate must not
          // block a run on the fleet's missing endpoint redundancy.
          status: 'needs-ack',
          expected: `${MIN_INDEPENDENT_PROVIDERS} independent providers agreeing`,
          actual: 'no quorum read was made for this proposal',
          anchor: 'A-UNRESOLVED',
        },
  ]
}
