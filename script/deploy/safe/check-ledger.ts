/**
 * Check ledger for a multi-network Safe confirmation run.
 *
 * Import this from any script that runs pre-signing checks. Every check records
 * one result per network carrying its expected value, its actual value and the
 * anchor the expectation came from; the run then rolls those up into per-check
 * `N/N` counts and a single verdict. `render-check-ledger.ts` prints it.
 *
 * The distinction the module exists for: a check that *could not run* is not a
 * check that passed. It is recorded as `error`, counted as unverified, and
 * blocks — so flaky infrastructure can never render as a green line.
 */

import { keccak256, stringToHex, type Hex } from 'viem'

/**
 * `error` means the check could not run — unreachable store, failed RPC,
 * unreadable anchor. It is never a synonym for `fail`, which is a real
 * mismatch, and never collapses into `pass`.
 */
export type CheckStatus = 'pass' | 'fail' | 'error' | 'needs-ack'

/**
 * `integrity` checks answer "is the code/authority what it claims to be" and
 * have no acknowledgement path at all (T3). `semantic` checks answer "is this
 * the change we meant", where a human acknowledgement is a legitimate answer.
 */
export type CheckClass = 'integrity' | 'semantic'

/**
 * Where a result's expectation came from. Recorded per result rather than per
 * check because one check can fall back between anchors network by network, and
 * a signer reading a green line needs to know which one answered.
 */
export type AnchorId =
  | 'A-CI'
  | 'A-LOCAL'
  | 'A-MAIN'
  | 'A-AUDIT'
  | 'A-CHAIN'
  | 'A-MONGO'
  | 'A-PROPOSAL'
  | 'A-UNRESOLVED'

/**
 * Anchors that may *report* but never *decide* a green verdict.
 *
 * The deployment record and the proposal document are both writable by the
 * proposer, so a value read back from either can only ever produce a red or an
 * unverified result — never a pass (N3). `A-UNRESOLVED` is the case where nothing
 * answered at all.
 */
const REPORTING_ONLY_ANCHORS: ReadonlySet<AnchorId> = new Set<AnchorId>([
  'A-MONGO',
  'A-PROPOSAL',
  'A-UNRESOLVED',
])

export interface ICheckDefinition {
  checkId: string
  /** Groups checks into the one-line-per-section report. */
  section: string
  checkClass: CheckClass
  title: string
}

export interface ICheckResult {
  checkId: string
  network: string
  status: CheckStatus
  /** The value the anchor says this network should have. */
  expected: string
  /** The value actually observed, or why nothing could be observed. */
  actual: string
  anchor: AnchorId
  /** The next action for a non-green row, or why a status was coerced. */
  detail?: string
}

export interface ICheckLedger {
  readonly checks: ReadonlyMap<string, ICheckDefinition>
  readonly expectedNetworks: readonly string[]
  /** Append log; the last entry for a (check, network) pair is the outcome. */
  readonly results: ICheckResult[]
}

const normaliseNetwork = (network: string): string =>
  network.trim().toLowerCase()

/**
 * Joins the parts of a composite key and of a digested row.
 *
 * A printable separator would let one field's value impersonate a boundary — a
 * check id containing the separator could collide with another check's row, and
 * two different result sets could digest identically. No check id, network name
 * or recorded value can contain U+0000.
 */
const FIELD_SEPARATOR = '\u0000'

const resultKey = (checkId: string, network: string): string =>
  `${checkId}${FIELD_SEPARATOR}${network}`

/**
 * Creates a ledger with its coverage denominator fixed up front.
 *
 * Both lists are required and must be non-empty: a ledger with no expected
 * networks or no registered checks reports `0/0` on everything, which renders
 * as a fully green run that verified nothing.
 * @param init - The networks every check is expected to answer for, and the checks that must answer.
 * @returns An empty ledger.
 * @throws If either list is empty, or two checks share a `checkId`.
 */
export const createCheckLedger = (init: {
  expectedNetworks: string[]
  checks: ICheckDefinition[]
}): ICheckLedger => {
  const expectedNetworks = [
    ...new Set(init.expectedNetworks.map(normaliseNetwork).filter(Boolean)),
  ]
  if (expectedNetworks.length === 0)
    throw new Error('createCheckLedger: expectedNetworks is empty')
  if (init.checks.length === 0)
    throw new Error('createCheckLedger: no checks registered')

  const checks = new Map<string, ICheckDefinition>()
  for (const check of init.checks) {
    if (checks.has(check.checkId))
      throw new Error(`createCheckLedger: duplicate checkId "${check.checkId}"`)
    checks.set(check.checkId, check)
  }

  return { checks, expectedNetworks, results: [] }
}

/**
 * Records one check's outcome on one network, coercing the two statuses that
 * would otherwise overstate what was verified.
 *
 * A `pass` whose anchor can only report is stored as `error`, and a `needs-ack`
 * on an integrity check is stored as `fail` — neither coercion can be undone by
 * a caller, which is the point: the rules live here rather than in each check.
 * @param ledger - The run's ledger, mutated in place.
 * @param result - The check's outcome, its expected and actual values, and its anchor.
 * @returns The result as stored, which may differ in `status` from the one passed.
 * @throws If the check was never registered, or the network is outside the declared denominator.
 */
export const recordCheck = (
  ledger: ICheckLedger,
  result: ICheckResult
): ICheckResult => {
  const definition = ledger.checks.get(result.checkId)
  if (!definition)
    throw new Error(
      `recordCheck: check "${result.checkId}" is not registered on this ledger`
    )

  const network = normaliseNetwork(result.network)
  if (!ledger.expectedNetworks.includes(network))
    throw new Error(
      `recordCheck: "${network}" is not among the expected networks of this ledger`
    )

  const stored = coerceStatus({ ...result, network }, definition)
  ledger.results.push(stored)

  return stored
}

function coerceStatus(
  result: ICheckResult,
  definition: ICheckDefinition
): ICheckResult {
  if (result.status === 'needs-ack' && definition.checkClass === 'integrity')
    return {
      ...result,
      status: 'fail',
      detail: `integrity checks have no acknowledgement path (T3)${
        result.detail ? ` — ${result.detail}` : ''
      }`,
    }

  if (result.status === 'pass' && REPORTING_ONLY_ANCHORS.has(result.anchor))
    return {
      ...result,
      status: 'error',
      detail: `anchor ${
        result.anchor
      } cannot decide a pass — it reports, it does not decide${
        result.detail ? ` — ${result.detail}` : ''
      }`,
    }

  return result
}

export interface ICheckRollup extends ICheckDefinition {
  /** The coverage denominator: how many networks this check had to answer for. */
  expected: number
  passed: number
  failed: number
  errored: number
  needsAck: number
  /** Expected networks that produced no result at all. */
  missing: number
  /** Everything that did not produce a verdict either way. */
  unverified: number
  green: boolean
  anchors: AnchorId[]
  missingNetworks: string[]
  /** One entry per network that reported, in the declared network order. */
  results: ICheckResult[]
}

/**
 * Groups the append log into one rollup per registered check.
 *
 * Every registered check appears, in registration order, whether or not it
 * reported — a check that ran nowhere is the most important row in the report
 * and must not be absent from it. Where a check reported twice for one network
 * the last entry wins, so a run may record a provisional result and supersede it.
 * @param ledger - The run's ledger.
 * @returns One rollup per registered check, in registration order.
 */
export const rollUpChecks = (ledger: ICheckLedger): ICheckRollup[] => {
  const latest = new Map<string, ICheckResult>()
  for (const result of ledger.results)
    latest.set(resultKey(result.checkId, result.network), result)

  return [...ledger.checks.values()].map((definition) => {
    const results = ledger.expectedNetworks
      .map((network) => latest.get(resultKey(definition.checkId, network)))
      .filter((result): result is ICheckResult => result !== undefined)

    const countOf = (status: CheckStatus): number =>
      results.filter((result) => result.status === status).length

    const expected = ledger.expectedNetworks.length
    const passed = countOf('pass')
    const errored = countOf('error')
    const missingNetworks = ledger.expectedNetworks.filter(
      (network) => !latest.has(resultKey(definition.checkId, network))
    )

    return {
      ...definition,
      expected,
      passed,
      failed: countOf('fail'),
      errored,
      needsAck: countOf('needs-ack'),
      missing: missingNetworks.length,
      unverified: errored + missingNetworks.length,
      green: passed === expected,
      anchors: [...new Set(results.map((result) => result.anchor))].sort(),
      missingNetworks,
      results,
    }
  })
}

export type OpProfile = 'subtractive' | 'additive' | 'mixed' | 'unknown'

/**
 * Whether `--triage` may relax one check on one operation profile (T2).
 *
 * Two independent conditions, both necessary: the operation must be purely
 * subtractive, and the check must be semantic. An integrity check is refused on
 * every profile, so the codehash gate is never relaxed by triage.
 * @param request - The operation's profile and the class of the check being considered.
 * @returns Whether the relaxation is permitted, and the reason either way.
 */
export const isTriageRelaxationAllowed = (request: {
  profile: OpProfile
  checkClass: CheckClass
}): { allowed: boolean; reason: string } => {
  if (request.checkClass === 'integrity')
    return {
      allowed: false,
      reason: 'integrity checks are never relaxed (T3)',
    }
  if (request.profile !== 'subtractive')
    return {
      allowed: false,
      reason: `triage relaxes only a purely subtractive op, this one is ${request.profile} (T2)`,
    }

  return { allowed: true, reason: 'subtractive op, semantic check' }
}

export interface IBlockingResult {
  checkId: string
  network: string
  status: 'fail' | 'error' | 'missing'
  reason: string
  expected?: string
  actual?: string
  anchor?: AnchorId
}

export interface ILedgerTotals {
  pass: number
  fail: number
  error: number
  needsAck: number
  missing: number
}

export interface ILedgerVerdict {
  /** True when something blocks with no acknowledgement path available. */
  hardBlocked: boolean
  blocking: IBlockingResult[]
  /** Semantic non-passes a human may acknowledge; the run stops until they do. */
  requiresAcknowledgement: ICheckResult[]
  /** Acknowledgements `--triage` dropped, kept so the report can name them. */
  relaxed: ICheckResult[]
  totals: ILedgerTotals
}

/**
 * Reduces the ledger to the one decision a signer needs.
 *
 * `error` and a missing result block on either class: both mean the check was
 * not shown to have run, and T3 gives neither an acknowledgement path. An
 * integrity `fail` blocks for the same reason. Only a semantic non-pass is
 * acknowledgeable, and `--triage` can drop those on a subtractive op alone.
 * @param ledger - The run's ledger.
 * @param options - `triageProfile` enables the T2-narrowed relaxation.
 * @returns The verdict, the blocking rows, what awaits acknowledgement, and the totals.
 */
export const summariseLedger = (
  ledger: ICheckLedger,
  options: { triageProfile?: OpProfile } = {}
): ILedgerVerdict => {
  const blocking: IBlockingResult[] = []
  const requiresAcknowledgement: ICheckResult[] = []
  const relaxed: ICheckResult[] = []
  const totals: ILedgerTotals = {
    pass: 0,
    fail: 0,
    error: 0,
    needsAck: 0,
    missing: 0,
  }

  for (const rollup of rollUpChecks(ledger)) {
    for (const result of rollup.results) {
      if (result.status === 'pass') {
        totals.pass += 1
        continue
      }

      if (result.status === 'error') {
        totals.error += 1
        blocking.push({
          checkId: result.checkId,
          network: result.network,
          status: 'error',
          reason: `the check could not run — recorded unverified, and an unverified check has no acknowledgement path (T3)${
            result.detail ? `: ${result.detail}` : ''
          }`,
          expected: result.expected,
          actual: result.actual,
          anchor: result.anchor,
        })
        continue
      }

      if (result.status === 'fail') totals.fail += 1
      else totals.needsAck += 1

      if (rollup.checkClass === 'integrity') {
        blocking.push({
          checkId: result.checkId,
          network: result.network,
          status: 'fail',
          reason: `integrity mismatch — hard block, no acknowledgement path (T3)${
            result.detail ? `: ${result.detail}` : ''
          }`,
          expected: result.expected,
          actual: result.actual,
          anchor: result.anchor,
        })
        continue
      }

      if (
        options.triageProfile &&
        isTriageRelaxationAllowed({
          profile: options.triageProfile,
          checkClass: rollup.checkClass,
        }).allowed
      )
        relaxed.push(result)
      else requiresAcknowledgement.push(result)
    }

    for (const network of rollup.missingNetworks) {
      totals.missing += 1
      blocking.push({
        checkId: rollup.checkId,
        network,
        status: 'missing',
        reason:
          'no result was recorded — the check cannot be shown to have run on this network',
      })
    }
  }

  return {
    hardBlocked: blocking.length > 0,
    blocking,
    requiresAcknowledgement,
    relaxed,
    totals,
  }
}

export interface IReviewAttestationCheck {
  checkId: string
  expected: number
  passed: number
  unverified: number
  green: boolean
  anchors: AnchorId[]
}

export interface IReviewAttestation {
  /** Binds the attestation to the exact results it was written over. */
  ledgerDigest: Hex
  reviewer: string
  reviewedAt: string
  hardBlocked: boolean
  totals: ILedgerTotals
  checks: IReviewAttestationCheck[]
}

/**
 * Builds the record of a completed review, for the caller to store on the
 * proposal document.
 *
 * The digest covers the coverage denominator and every stored result, sorted, so
 * it is stable across the order a run happened to record them in and moves if
 * any value, status, anchor or network changes. It is a reconstruction record,
 * not an oracle: nothing may later read it back and treat a stored pass as
 * verification (T5).
 * @param ledger - The run's ledger.
 * @param review - Who reviewed, and when, as an ISO timestamp.
 * @returns The attestation record.
 */
export const buildReviewAttestation = (
  ledger: ICheckLedger,
  review: { reviewer: string; reviewedAt: string }
): IReviewAttestation => {
  const rollups = rollUpChecks(ledger)
  const verdict = summariseLedger(ledger)

  const rows = rollups.flatMap((rollup) =>
    rollup.results.map((result) =>
      [
        result.checkId,
        result.network,
        result.status,
        result.expected,
        result.actual,
        result.anchor,
      ].join(FIELD_SEPARATOR)
    )
  )

  return {
    ledgerDigest: keccak256(
      stringToHex(
        JSON.stringify({
          networks: [...ledger.expectedNetworks].sort(),
          checks: [...ledger.checks.keys()].sort(),
          rows: rows.sort(),
        })
      )
    ),
    reviewer: review.reviewer,
    reviewedAt: review.reviewedAt,
    hardBlocked: verdict.hardBlocked,
    totals: verdict.totals,
    checks: rollups.map((rollup) => ({
      checkId: rollup.checkId,
      expected: rollup.expected,
      passed: rollup.passed,
      unverified: rollup.unverified,
      green: rollup.green,
      anchors: rollup.anchors,
    })),
  }
}
