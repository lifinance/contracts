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

import type { ICheckDefinition, ICheckResult } from './check-ledger'
import type {
  ITargetStateFinding,
  ITargetStateVerdict,
  TargetStateStatus,
} from './pinned-target-state'

export const TARGET_STATE_CHECK_ID = 'target-state'

export const TARGET_STATE_CHECK: ICheckDefinition = {
  checkId: TARGET_STATE_CHECK_ID,
  section: 'Intent',
  checkClass: 'semantic',
  title: 'Facet version matches the declared target state',
}

/** Every check `confirm-safe-tx.ts` registers on the run's ledger. */
export const CONFIRM_CHECK_DEFINITIONS: readonly ICheckDefinition[] = [
  TARGET_STATE_CHECK,
]

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
