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
import { NOTHING_TO_COMPARE } from './confirm-check-registry'

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

    // The second pass's own keys, for the mirror case. Walking only the first
    // pass's would grade a run green where the second answered for a check or
    // network the first never reached — a pass that did strictly more work
    // reads as agreement.
    for (const [key, secondResult] of secondOutcomes)
      if (!firstOutcomes.has(key))
        findings.push({
          proposal: entry.proposal,
          checkId: secondResult.checkId,
          network: secondResult.network,
          field: 'status',
          first: 'not recorded',
          second: secondResult.status,
        })
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
 * Whether every finding behind a refusal is the known-correct class.
 *
 * `actual` joins one clause per failing element, so a substring test over the
 * whole string lets one unidentified element launder the rest of the cut — a
 * version **downgrade**, the most dangerous verdict this gate produces, would
 * be filed as expected because some other element in the same cut resolved to
 * nothing. Each clause must end in the class for the refusal to count as one,
 * and the suffix is anchored so a contract whose own name contains the phrase
 * cannot qualify on its name alone.
 */
const isKnownCorrectRefusal = (actual: string): boolean => {
  const clauses = actual.split('; ').filter(Boolean)
  return (
    clauses.length > 0 &&
    clauses.every((clause) => clause.endsWith(`: ${KNOWN_CORRECT_REFUSAL}`))
  )
}

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
      isKnownCorrectRefusal(result.actual)
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

  // Only a run that graded nothing *and* found nothing is unmeasured. An
  // asymmetric pair grades zero rows on one side while still disagreeing, and
  // calling that "not measured" would file a real difference as an absence.
  if (rowsGraded === 0 && findings.length === 0)
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
 * Grades the corruption probe, row by row against the undamaged baseline.
 *
 * Graded per row because "some row refused" is not evidence. On real corpora
 * most rows already refuse for their own reasons, so a probe asking whether
 * *anything* refused answers yes before the corruption is applied — it reports
 * success on a chain that graded every damaged proposal clean.
 *
 * The population that carries the evidence is the rows the chain had read and
 * graded without stopping on them — which includes `needs-ack`, where the bytes
 * were understood and only the intent is open. Each of those must refuse after
 * corruption. A corpus with none of them is `not-exercised` rather than a pass,
 * for the same reason an empty run is not deterministic.
 *
 * @param baseline - the pass over undamaged input
 * @param corrupted - the pass over deliberately damaged input
 * @returns which of the three outcomes the probe reached
 */
export const gradeCorruptionProbe = (
  baseline: readonly IRehearsalPassEntry[],
  corrupted: readonly IRehearsalPassEntry[]
): CorruptionProbeOutcome => {
  const afterCorruption = hardRefusalsBySlot(corrupted)
  const population = gradedPopulation(baseline)
  if (population.length === 0) return 'not-exercised'

  return population.every((slot) => afterCorruption.get(slot) === true)
    ? 'refused'
    : 'did-not-refuse'
}

/**
 * The statuses that mean the chain stopped on the bytes themselves.
 *
 * Narrower than {@link REFUSING_STATUSES}, which the budget uses. `needs-ack`
 * belongs there — it costs a signer attention — but not here: it says the
 * payload was read and understood and only the intent is open, which is the
 * opposite of the chain having caught damage.
 */
const HARD_REFUSING_STATUSES: ReadonlySet<string> = new Set(['fail', 'error'])

/**
 * The rows a corruption probe may legitimately hold to account.
 *
 * Two exclusions, both because the row cannot answer the question. A row that
 * already refused proves nothing by refusing again. A row the gate graded as
 * having no cut to compare cannot be made to refuse at all: damaging a payload
 * that is not a diamond cut leaves it not a diamond cut, so demanding a refusal
 * from it makes the probe permanently red for a reason that is about the corpus
 * rather than about the chain.
 */
const gradedPopulation = (
  baseline: readonly IRehearsalPassEntry[]
): readonly string[] => {
  const slots: string[] = []
  for (const entry of baseline)
    for (const result of outcomesOf(entry.ledger).values()) {
      // Already stopped on the bytes, so refusing again proves nothing.
      if (HARD_REFUSING_STATUSES.has(result.status)) continue
      if (result.expected === NOTHING_TO_COMPARE) continue
      slots.push(`${entry.proposal}/${result.checkId}/${result.network}`)
    }
  return slots
}

/**
 * The rows the chain graded the same way before and after corruption.
 *
 * Reported rather than merely counted: these are proposals whose damaged bytes
 * changed no verdict, which is the finding the probe exists to produce.
 *
 * @param baseline - the pass over undamaged input
 * @param corrupted - the pass over deliberately damaged input
 * @returns the slots that survived corruption ungraded
 */
export const survivedCorruption = (
  baseline: readonly IRehearsalPassEntry[],
  corrupted: readonly IRehearsalPassEntry[]
): readonly string[] => {
  const afterCorruption = hardRefusalsBySlot(corrupted)
  return gradedPopulation(baseline).filter(
    (slot) => afterCorruption.get(slot) !== true
  )
}

/** Which slots the chain stopped on outright, keyed for lookup. */
const hardRefusalsBySlot = (
  pass: readonly IRehearsalPassEntry[]
): Map<string, boolean> => {
  const refusals = new Map<string, boolean>()
  for (const entry of pass)
    for (const result of outcomesOf(entry.ledger).values())
      refusals.set(
        `${entry.proposal}/${result.checkId}/${result.network}`,
        HARD_REFUSING_STATUSES.has(result.status)
      )
  return refusals
}

/**
 * Rows each check answered for, counted once per (check, network).
 *
 * Counted off the deduplicated outcomes rather than the ledger's append log, so
 * the roster's `rows=` and the determinism summary's `rowsGraded` are derived
 * the same way. A check that supersedes a result — which `check-ledger.ts`
 * documents as expected — would otherwise be counted twice in one report
 * section and once in the other.
 *
 * @param pass - one pass's per-proposal ledgers
 * @returns row count keyed by check id
 */
export const rowCountsByCheck = (
  pass: readonly IRehearsalPassEntry[]
): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const entry of pass)
    for (const result of outcomesOf(entry.ledger).values())
      counts[result.checkId] = (counts[result.checkId] ?? 0) + 1
  return counts
}

/**
 * The distinct refusal classes a run actually produced.
 *
 * A refusal budget divides refusals into true positives, named false reds and
 * unexplained. When only one class is reachable and this release has already
 * ruled that class correct, every refusal lands in the first bucket and the
 * unexplained count is 0 for any corpus, on any day — a constant rather than a
 * measurement. Counting the classes is how the caller can tell the two apart
 * and decline to publish a rate that cannot vary.
 *
 * @param pass - one pass's per-proposal ledgers
 * @returns each distinct class, in first-seen order
 */
export const refusalClasses = (
  pass: readonly IRehearsalPassEntry[]
): readonly string[] => {
  const classes = new Set<string>()
  for (const observation of collectRefusalObservations(pass)) {
    if (!observation.refused) continue
    for (const clause of observation.reason.split('; ')) {
      const separator = clause.lastIndexOf(': ')
      const verdict = (
        separator === -1 ? clause : clause.slice(separator + 2)
      ).trim()
      if (verdict) classes.add(verdict)
    }
  }
  return [...classes]
}
