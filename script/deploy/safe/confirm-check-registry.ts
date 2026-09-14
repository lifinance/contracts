/**
 * Maps each sign-time gate's own verdict onto a `check-ledger` row.
 *
 * The gates were built as independent modules, each printing its own block. The
 * ledger is where they become one verdict, so the translation lives here rather
 * than in `check-ledger.ts` (which must not know about any particular gate) or
 * in the gates themselves (which must stay usable without a ledger).
 *
 * Every mapping names the anchor the verdict actually rests on, so `recordCheck`
 * coerces a `pass` claimed on a reporting-only anchor to `error`. That backstop
 * only covers the record-derived rows; the two mappings that can emit a green
 * sit on `A-LOCAL`, which decides, so what actually guards them is the
 * cross-check against `STATUSES_CLEARED_TO_PROCEED`.
 */

import type { ICheckDefinition, ICheckResult } from './check-ledger'
import type {
  ITargetStateFinding,
  ITargetStateVerdict,
  TargetStateStatus,
} from './pinned-target-state'
import type { IPreBroadcastAuthority } from './prebroadcast-authorities'
import type { ISignedAuthorityEntry } from './signed-set-record'

export const TARGET_STATE_CHECK_ID = 'target-state'

export const TARGET_STATE_CHECK: ICheckDefinition = {
  checkId: TARGET_STATE_CHECK_ID,
  section: 'Intent',
  checkClass: 'semantic',
  title: 'Facet version matches the declared target state',
}

export const STORAGE_AUTHORITY_CHECK_ID = 'storage-authority'

export const STORAGE_AUTHORITY_CHECK: ICheckDefinition = {
  checkId: STORAGE_AUTHORITY_CHECK_ID,
  section: 'Integrity',
  checkClass: 'integrity',
  title: 'Storage authorities match what main declares',
}

/** Every check `confirm-safe-tx.ts` registers on the run's ledger. */
export const CONFIRM_CHECK_DEFINITIONS: readonly ICheckDefinition[] = [
  TARGET_STATE_CHECK,
  STORAGE_AUTHORITY_CHECK,
]

/**
 * Where each authority's expectation came from, as an anchor.
 *
 * `config/global.json` is a repo file the proposer's branch cannot change
 * without review, so it may decide a pass. The deployment record is written by
 * the proposer, so it may only report — the ledger coerces a `pass` on it to
 * `error`, which is the correct reading of "the value matched the one we were
 * handed".
 *
 * @param authorities - Observation rows from `observeCalldata`.
 * @returns Label → anchor, for `storageAuthorityCheckResult`.
 */
export const authorityExpectationAnchors = (
  authorities: readonly IPreBroadcastAuthority[]
): ReadonlyMap<string, ICheckResult['anchor']> =>
  new Map(
    authorities.map((authority) => [
      authority.label,
      authority.expectationSource === 'globalConfig'
        ? ('A-LOCAL' as const)
        : ('A-MONGO' as const),
    ])
  )

export const EVERY_AUTHORITY_MATCHES =
  'every declared storage authority holding the address main declares'

/**
 * Reduces a network's storage-authority observations to the one row the ledger
 * holds.
 *
 * The comparison is a live chain read against a declaration in `main`, so the
 * live side is `A-CHAIN` — but the row is anchored on the weaker of the two,
 * because a comparison is only as good as its expectation. An authority whose
 * expected value comes from the deployment record is `A-MONGO`, which the
 * ledger treats as reporting-only and so coerces to `error` rather than letting
 * it grade green: the proposer writes that record and therefore owns one side
 * of the comparison. One sourced from `config/global.json` is `A-LOCAL` and may
 * decide.
 *
 * An empty set is an `error` on `A-UNRESOLVED`, not a pass. No contract in the
 * calldata carried a declared authority, so nothing was compared, and the
 * denominator must not silently shrink.
 *
 * @param entries - Authority observations for this network's proposal.
 * @param network - The network the observations are about.
 * @param expectationAnchors - Per-label anchor for where the expectation came
 * from, as `resolveExpectedAuthority` resolved it.
 * @returns The row to hand to `recordCheck`.
 */
export const storageAuthorityCheckResult = (
  entries: readonly ISignedAuthorityEntry[],
  network: string,
  expectationAnchors: ReadonlyMap<string, ICheckResult['anchor']>
): ICheckResult => {
  if (entries.length === 0)
    return {
      checkId: STORAGE_AUTHORITY_CHECK_ID,
      network,
      status: 'error',
      expected: EVERY_AUTHORITY_MATCHES,
      actual: 'no contract in this proposal declares a storage authority',
      anchor: 'A-UNRESOLVED',
      detail:
        'nothing was compared, so this is an absence of evidence rather than a clean read',
    }

  let status: ICheckResult['status'] = 'pass'
  let anchor: ICheckResult['anchor'] = 'A-CHAIN'
  let worstRank = SEVERITY.length
  const failing: string[] = []

  for (const entry of entries) {
    const entryStatus: ICheckResult['status'] =
      entry.readError !== undefined || entry.liveValue === undefined
        ? 'error'
        : entry.expectedValue === undefined
        ? 'error'
        : entry.liveValue.trim().toLowerCase() !==
          entry.expectedValue.trim().toLowerCase()
        ? 'fail'
        : 'pass'

    if (entryStatus !== 'pass')
      failing.push(
        entry.readError !== undefined
          ? `${entry.label}: NOT READ — ${entry.readError}`
          : entry.expectedValue === undefined
          ? `${entry.label}: main declares nothing to judge ${entry.liveValue} against`
          : `${entry.label}: holds ${entry.liveValue}, main declares ${entry.expectedValue}`
      )

    status = worstOf(status, entryStatus)

    // The row reports the anchor the worst row rests on, so it never claims a
    // stronger one than the thing that decided it.
    const rank = SEVERITY.indexOf(entryStatus)
    const entryAnchor =
      entry.readError !== undefined || entry.liveValue === undefined
        ? 'A-UNRESOLVED'
        : expectationAnchors.get(entry.label) ?? 'A-UNRESOLVED'
    if (rank < worstRank) {
      worstRank = rank
      anchor = entryAnchor
    }
  }

  // Every entry passed, so no single finding set the anchor. The row still must
  // not claim `A-CHAIN` when an expectation it compared against was
  // proposer-written, so it takes the weakest anchor in the set.
  if (failing.length === 0)
    for (const entry of entries) {
      const entryAnchor = expectationAnchors.get(entry.label) ?? 'A-UNRESOLVED'
      if (entryAnchor === 'A-MONGO' || entryAnchor === 'A-UNRESOLVED')
        anchor = entryAnchor
    }

  return {
    checkId: STORAGE_AUTHORITY_CHECK_ID,
    network,
    status,
    expected: EVERY_AUTHORITY_MATCHES,
    actual: failing.length
      ? failing.join('; ')
      : `${entries.length} declared authority value(s) match config`,
    anchor,
  }
}

interface IStatusMapping {
  status: ICheckResult['status']
  anchor: ICheckResult['anchor']
  /**
   * Carried per status rather than derived from the anchor, which tracks where
   * the evidence came from and so cannot say whether a comparison happened.
   */
  expected: ICheckResult['expected']
}

/**
 * What each status says the network should have.
 *
 * Every one is a requirement, never a description of the row — `expected` is
 * rendered verbatim after the word "expected", and a sentence that diagnoses
 * the situation instead ("a first deployment") is false as soon as one cut
 * carries two elements. It also makes the reduction below safe: findings of
 * equal rank keep the first in calldata order, which only ever costs
 * specificity when both sentences are requirements.
 */
export const ORDERING_HOLDS =
  'no installed version behind what origin/main declares'
export const EVERY_ELEMENT_COMPARED =
  'every installed element compared against origin/main'
export const NOTHING_TO_COMPARE =
  'a cut that installs nothing requiring a version comparison'

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
  'matches-main': {
    status: 'needs-ack',
    anchor: 'A-MONGO',
    expected: ORDERING_HOLDS,
  },
  'ahead-of-main': {
    status: 'needs-ack',
    anchor: 'A-MONGO',
    expected: ORDERING_HOLDS,
  },
  // `origin/main` declares nothing for this contract, so nothing was compared.
  // The common path, not an edge case: the target-state update merges only
  // after execution, so every first deployment lands here — and so does every
  // new network for a contract already live elsewhere, since the declaration is
  // keyed per network.
  'not-previously-targeted': {
    status: 'needs-ack',
    anchor: 'A-MONGO',
    expected: ORDERING_HOLDS,
  },
  // The removal branch returns before the anchor is read at all, so there is no
  // claim on `origin/main` to make — the same shape as `no-diamond-cut` below.
  removal: { status: 'pass', anchor: 'A-LOCAL', expected: NOTHING_TO_COMPARE },
  // No cut to grade. A pass on `A-LOCAL` rather than a skipped row: the
  // calldata was read and found to install nothing, which is a verified fact
  // about this proposal, not an absence of evidence.
  'no-diamond-cut': {
    status: 'pass',
    anchor: 'A-LOCAL',
    expected: NOTHING_TO_COMPARE,
  },
  downgrade: { status: 'fail', anchor: 'A-MAIN', expected: ORDERING_HOLDS },
  // Ordering was attempted and the pair could not be ordered, so this one did
  // reach the comparison.
  'version-not-comparable': {
    status: 'error',
    anchor: 'A-MONGO',
    expected: ORDERING_HOLDS,
  },
  'proposed-version-unresolved': {
    status: 'error',
    anchor: 'A-MONGO',
    expected: EVERY_ELEMENT_COMPARED,
  },
  'contract-unidentified': {
    status: 'error',
    anchor: 'A-MONGO',
    expected: EVERY_ELEMENT_COMPARED,
  },
  'deployment-record-ambiguous': {
    status: 'error',
    anchor: 'A-MONGO',
    expected: EVERY_ELEMENT_COMPARED,
  },
  'unrecognised-cut-action': {
    status: 'error',
    anchor: 'A-UNRESOLVED',
    expected: EVERY_ELEMENT_COMPARED,
  },
  'calldata-not-readable': {
    status: 'error',
    anchor: 'A-UNRESOLVED',
    expected: EVERY_ELEMENT_COMPARED,
  },
  'pinned-state-unavailable': {
    status: 'error',
    anchor: 'A-UNRESOLVED',
    expected: EVERY_ELEMENT_COMPARED,
  },
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
      expected: EVERY_ELEMENT_COMPARED,
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
  let expected = EVERY_ELEMENT_COMPARED
  let detail: string | undefined
  let worstRank = SEVERITY.length

  for (const finding of verdict.findings) {
    const mapped = STATUS_MAPPING[finding.status]
    status = worstOf(status, mapped.status)

    // The anchor reported is the one the *worst* finding rests on, so the row
    // never claims a stronger anchor than the thing that decided it.
    // `detail` and `expected` move with the anchor for the same reason: taken
    // from the first failing finding in calldata order they can describe a
    // different, milder problem than the one the row is graded on. `actual`
    // still lists every finding, so nothing is lost by reducing these three.
    const rank = SEVERITY.indexOf(mapped.status)
    if (rank < worstRank) {
      worstRank = rank
      anchor = mapped.anchor
      expected = mapped.expected
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
    expected,
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
