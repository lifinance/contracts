/**
 * Grades two passes of the confirm gate chain against each other.
 *
 * Import this from the rehearsal CLI, which runs the chain and hands the
 * resulting ledgers here. Running it is deliberately not this module's job:
 * `confirm-safe-tx.ts` is an interactive command that signs, so the rehearsal
 * reaches the gates without going near that path, and the grading stays
 * testable without a store or a chain behind it.
 *
 * Two passes over the same input must produce the same verdicts. A difference
 * is not noise to retry past — it means something in the chain reads a moving
 * value, and that finding is worth more than a green run.
 */

import { type IShadowObservation } from '../codehash/false-refusal-budget'

import { checkResultKey, type ICheckLedger } from './check-ledger'

/** One proposal's ledger, as one pass graded it. */
export interface IRehearsalPassEntry {
  /** Stable identity of the proposal — its `safeTxHash` in a live run. */
  readonly proposal: string
  readonly ledger: ICheckLedger
}

/** One field of one row that two passes disagreed about. */
export interface IDeterminismFinding {
  readonly proposal: string
  readonly checkId: string
  readonly network: string
  readonly field: 'proposal' | 'status' | 'actual' | 'expected' | 'anchor'
  readonly first: string
  readonly second: string
}

/** The fields a pass must reproduce exactly, and how to read each off a row. */
const COMPARED_FIELDS = ['status', 'expected', 'actual', 'anchor'] as const

/**
 * The last result recorded for each (check, network) pair.
 *
 * The ledger is an append log whose last entry for a pair is the outcome, so a
 * comparison over every entry would report a superseded mismatch as a
 * difference on a run that in fact agreed.
 */
const outcomesOf = (ledger: ICheckLedger) => {
  const outcomes = new Map<string, ICheckLedger['results'][number]>()
  for (const result of ledger.results)
    outcomes.set(checkResultKey(result.checkId, result.network), result)
  return outcomes
}

/**
 * Compares two passes over the same proposal set.
 *
 * @param first - the first pass
 * @param second - the second pass
 * @returns one finding per field the two passes disagreed about, empty when
 * they agreed everywhere
 */
export const comparePasses = (
  first: readonly IRehearsalPassEntry[],
  second: readonly IRehearsalPassEntry[]
): readonly IDeterminismFinding[] => {
  const findings: IDeterminismFinding[] = []
  const secondByProposal = new Map(
    second.map((entry) => [entry.proposal, entry])
  )

  for (const entry of first) {
    const counterpart = secondByProposal.get(entry.proposal)
    if (!counterpart) {
      findings.push({
        proposal: entry.proposal,
        checkId: '-',
        network: '-',
        field: 'proposal',
        first: 'graded',
        second: 'absent',
      })
      continue
    }

    const firstOutcomes = outcomesOf(entry.ledger)
    const secondOutcomes = outcomesOf(counterpart.ledger)

    for (const [key, firstResult] of firstOutcomes) {
      const secondResult = secondOutcomes.get(key)
      if (!secondResult) {
        findings.push({
          proposal: entry.proposal,
          checkId: firstResult.checkId,
          network: firstResult.network,
          field: 'status',
          first: firstResult.status,
          second: 'not recorded',
        })
        continue
      }

      for (const field of COMPARED_FIELDS)
        if (firstResult[field] !== secondResult[field])
          findings.push({
            proposal: entry.proposal,
            checkId: firstResult.checkId,
            network: firstResult.network,
            field,
            first: String(firstResult[field]),
            second: String(secondResult[field]),
          })
    }
  }

  for (const entry of second)
    if (!first.some((candidate) => candidate.proposal === entry.proposal))
      findings.push({
        proposal: entry.proposal,
        checkId: '-',
        network: '-',
        field: 'proposal',
        first: 'absent',
        second: 'graded',
      })

  return findings
}

/**
 * Every status that stops a signer, and so counts as a refusal to be graded.
 *
 * `needs-ack` is in: it is a row a human has to answer before the run proceeds,
 * so a chain that produces one on a correct proposal is costing a signer the
 * same attention a red does, which is exactly what a false-refusal budget
 * measures.
 */
const REFUSING_STATUSES: ReadonlySet<string> = new Set([
  'fail',
  'error',
  'needs-ack',
])

/**
 * The refusal this release has already decided is correct.
 *
 * Third-party deploys are parked for V2 (EXSC-982, EXSC-879), so a cut naming a
 * facet no deployment record resolves is a proposal the gate is right to refuse
 * — not a false red to be budgeted against.
 *
 * Deliberately narrow, and deliberately not a new entry in the budget's own
 * `ACCEPTED_FALSE_RED_RULES`: that list is closed because growing it is how a
 * budget of zero is faked. This marks the class as a true positive, which is
 * the caller-supplied classification the budget is designed to take.
 */
const KNOWN_CORRECT_REFUSAL = 'contract-unidentified'

/**
 * Turns one pass's ledgers into observations the false-refusal budget can grade.
 *
 * Every row becomes an observation, refusing or not, because the budget's
 * denominator is rows graded rather than refusals seen — a loader that emitted
 * only the refusals would report a rate of 1.0 on a clean run.
 *
 * @param pass - one pass's per-proposal ledgers
 * @returns one observation per recorded row
 */
export const collectRefusalObservations = (
  pass: readonly IRehearsalPassEntry[]
): readonly IShadowObservation[] =>
  pass.flatMap((entry) =>
    [...outcomesOf(entry.ledger).values()].map((result) => ({
      slot: `${entry.proposal}/${result.checkId}/${result.network}`,
      refused: REFUSING_STATUSES.has(result.status),
      reason: REFUSING_STATUSES.has(result.status)
        ? `${result.status}: expected ${result.expected}, observed ${result.actual}`
        : '',
      ...(REFUSING_STATUSES.has(result.status) &&
      result.actual.includes(KNOWN_CORRECT_REFUSAL)
        ? { truePositive: true }
        : {}),
    }))
  )

/**
 * What a rehearsal established, or failed to.
 *
 * `not-measured` is its own verdict rather than a green with a zero next to it.
 * Two passes over an empty corpus agree perfectly, so a boolean alone would
 * report a run that graded nothing as deterministic — the same mistake the
 * false-refusal budget guards against by refusing to divide by zero.
 */
export type RehearsalVerdict =
  | 'deterministic'
  | 'non-deterministic'
  | 'not-measured'

export interface IRehearsalSummary {
  readonly rowsGraded: number
  /** Undefined when nothing was graded — neither true nor false is honest there. */
  readonly deterministic: boolean | undefined
  readonly verdict: RehearsalVerdict
  readonly findings: readonly IDeterminismFinding[]
}

/**
 * Grades two passes, keeping "agreed" apart from "had nothing to disagree on".
 *
 * @param passes.first - the first pass
 * @param passes.second - the second pass over the same input
 * @returns the rows graded, the findings, and a verdict that says which of the
 * three outcomes this was
 */
export const summariseRehearsal = (passes: {
  first: readonly IRehearsalPassEntry[]
  second: readonly IRehearsalPassEntry[]
}): IRehearsalSummary => {
  const rowsGraded = passes.first.reduce(
    (total, entry) => total + outcomesOf(entry.ledger).size,
    0
  )
  const findings = comparePasses(passes.first, passes.second)

  if (rowsGraded === 0)
    return {
      rowsGraded,
      deterministic: undefined,
      verdict: 'not-measured',
      findings,
    }

  return {
    rowsGraded,
    deterministic: findings.length === 0,
    verdict: findings.length === 0 ? 'deterministic' : 'non-deterministic',
    findings,
  }
}

/** Whether the deliberately damaged pass proved the chain can still refuse. */
export type CorruptionProbeOutcome =
  | 'refused'
  | 'did-not-refuse'
  | 'not-exercised'

/**
 * Grades the corruption probe.
 *
 * An empty pass is `not-exercised`, never `did-not-refuse`: a corpus with
 * nothing in it to damage says nothing about whether the chain can refuse, and
 * reporting it as a failure would train a reader to ignore the real one.
 *
 * @param corrupted - the pass run over deliberately damaged input
 * @returns which of the three outcomes the probe reached
 */
export const gradeCorruptionProbe = (
  corrupted: readonly IRehearsalPassEntry[]
): CorruptionProbeOutcome => {
  const observations = collectRefusalObservations(corrupted)
  if (observations.length === 0) return 'not-exercised'
  return observations.some((observation) => observation.refused)
    ? 'refused'
    : 'did-not-refuse'
}
