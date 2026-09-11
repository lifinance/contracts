/**
 * Maps each sign-time gate's own verdict onto a `check-ledger` row.
 *
 * The gates were built as independent modules, each printing its own block. The
 * ledger is where they become one verdict, so the translation lives here rather
 * than in `check-ledger.ts` (which must not know about any particular gate) or
 * in the gates themselves (which must stay usable without a ledger).
 *
 * Every mapping names the anchor the verdict actually rests on. `recordCheck`
 * coerces a `pass` claimed on a reporting-only anchor to `error`, so a mapping
 * that names its anchor honestly cannot produce a false green even if the
 * status below it is wrong.
 */

import {
  recordCheck,
  type ICheckDefinition,
  type ICheckLedger,
  type ICheckResult,
} from './check-ledger'
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
 * proceed: the four record-derived statuses are `A-MONGO` because the value
 * that produced them came from a document the proposer writes, and the two
 * unreadable-calldata statuses resolve to nothing at all. Keyed exhaustively so
 * a status added to `TargetStateStatus` fails to compile here rather than
 * falling through to a default that would grade it green.
 */
const STATUS_MAPPING: Readonly<Record<TargetStateStatus, IStatusMapping>> = {
  'matches-main': { status: 'pass', anchor: 'A-MAIN' },
  'ahead-of-main': { status: 'pass', anchor: 'A-MAIN' },
  removal: { status: 'pass', anchor: 'A-MAIN' },
  'not-previously-targeted': { status: 'pass', anchor: 'A-MAIN' },
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

/** Worst-first, so reducing many findings to one row cannot lose a refusal. */
const SEVERITY: readonly ICheckResult['status'][] = [
  'fail',
  'needs-ack',
  'error',
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
  let anchor: ICheckResult['anchor'] = 'A-MAIN'
  let worstRank = SEVERITY.length

  for (const finding of verdict.findings) {
    const mapped = STATUS_MAPPING[finding.status]
    status = worstOf(status, mapped.status)

    // The anchor reported is the one the *worst* finding rests on, so the row
    // never claims a stronger anchor than the thing that decided it.
    const rank = SEVERITY.indexOf(mapped.status)
    if (rank < worstRank) {
      worstRank = rank
      anchor = mapped.anchor
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
    ...(failing.length
      ? {
          detail: failing[0]?.detail ?? undefined,
        }
      : {}),
  }
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
 * `runIntegrityAsserts` registers it only for a schedule payload. A registered
 * check that never reports is counted missing and blocks, so the recorder below
 * has to answer for it on every proposal — which it does, with a pass on
 * `A-LOCAL` when the calldata was read and found not to be a schedule.
 */
export const CONFIRM_CHECK_DEFINITIONS: readonly ICheckDefinition[] = [
  ...[...INTEGRITY_CHECKS_ALWAYS, CHECK_TIMELOCK_DELAY].map((checkId) => {
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
 * chain — that this repo does not meet, and a fleet where roughly a third of
 * networks are single-endpoint would turn missing redundancy into a refusal to
 * sign. So a quorum that was not reached is recorded as an acknowledgement,
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
    // Nothing decided the read: either the providers disagreed, or there were
    // not enough of them to establish agreement either way.
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
  const registered = [...INTEGRITY_CHECKS_ALWAYS, CHECK_TIMELOCK_DELAY]

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
 * Records every sign-time verdict for one proposal, in the order a signer reads
 * them.
 *
 * One ordered step rather than a `recordCheck` beside each gate: the sequence
 * the ledger holds *is* the report's order, so pinning it here makes it a
 * property of the recorded rows that a test can read back, instead of a
 * property of where the calls happen to sit in a 1400-line CLI.
 *
 * @param ledger - The run's ledger, mutated in place.
 * @param verdicts - What each gate decided for this proposal.
 */
export const recordProposalChecks = (
  ledger: ICheckLedger,
  verdicts: IProposalCheckVerdicts
): void => {
  const { network } = verdicts

  for (const result of integrityResults(verdicts.integrity, network))
    recordCheck(ledger, result)

  recordCheck(ledger, targetStateCheckResult(verdicts.targetState, network))

  recordCheck(
    ledger,
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
        )
  )

  recordCheck(
    ledger,
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
        }
  )
}
