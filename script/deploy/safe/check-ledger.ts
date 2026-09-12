/**
 * Check ledger for a multi-network Safe confirmation run.
 *
 * Import this from any script that runs pre-signing checks. Every check records
 * one result per network carrying its expected value, its actual value and the
 * anchor the expectation came from; the run then rolls those up into per-check
 * `N/N` counts and a single verdict.
 *
 * A check that could not run is not a check that passed: it is recorded as
 * `error`, counted as unverified, and the verdict comes back blocked with no
 * acknowledgement path. A check that had nothing to grade is neither: it is
 * recorded as `not-applicable`, counted outside both numerator and denominator,
 * and a run made only of those closes as having reviewed nothing.
 */

import { keccak256, stringToHex, type Hex } from 'viem'

/**
 * `error` means the check could not run — unreachable store, failed RPC,
 * unreadable anchor. It is never a synonym for `fail`, which is a real
 * mismatch, and never collapses into `pass`.
 *
 * `not-applicable` means the run established there was nothing here to grade —
 * a network whose only pending proposal this signer had already signed. It does
 * not block, because nothing is wrong, and it never counts as verified, because
 * nothing was checked.
 */
export type CheckStatus =
  | 'pass'
  | 'fail'
  | 'error'
  | 'needs-ack'
  | 'not-applicable'

/**
 * `integrity` checks answer "is the code/authority what it claims to be" and
 * have no acknowledgement path at all. `semantic` checks answer "is this the
 * change we meant", where a human acknowledgement is a legitimate answer.
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
 * unverified result — never a pass. `A-UNRESOLVED` is the case where nothing
 * answered at all.
 */
const REPORTING_ONLY_ANCHORS: ReadonlySet<AnchorId> = new Set<AnchorId>([
  'A-MONGO',
  'A-PROPOSAL',
  'A-UNRESOLVED',
])

/** Every status a result may carry, for validating a value that bypassed the type. */
const CHECK_STATUSES: ReadonlySet<string> = new Set<CheckStatus>([
  'pass',
  'fail',
  'error',
  'needs-ack',
  'not-applicable',
])

/** Every anchor a result may name, for validating a value that bypassed the type. */
const ANCHOR_IDS: ReadonlySet<string> = new Set<AnchorId>([
  'A-CI',
  'A-LOCAL',
  'A-MAIN',
  'A-AUDIT',
  'A-CHAIN',
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
  /**
   * Set when this result superseded a mismatch on the same network.
   *
   * The verdict needs one row per network, so the disagreement it replaced has
   * nowhere else to be reported — and "retry this" reads differently when the
   * network in question has already disagreed once.
   */
  supersededMismatch?: string
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
 * check id containing the separator could collide with another check's row.
 * `createCheckLedger` refuses an id or a network that contains it, so the
 * property the keys rest on is enforced rather than assumed.
 */
const FIELD_SEPARATOR = '\u0000'

/**
 * Identifies one check's result on one network.
 *
 * Exported so a consumer can look a result up by identity rather than by object
 * reference: a rollup is rebuilt on every call, and matching references across
 * two calls would fail silently the day one of them copies a result.
 * @param checkId - The check's id.
 * @param network - The network, as normalised by the ledger.
 * @returns A key unique to that pair.
 */
export const checkResultKey = (checkId: string, network: string): string =>
  `${checkId}${FIELD_SEPARATOR}${network}`

/**
 * Refuses a value that could forge a key boundary.
 *
 * `checkResultKey` concatenates a check id and a network around the separator,
 * so a value containing it makes one recorded result answer for two different
 * pairs — the second pair then reads as verified while nothing ran on it.
 */
function rejectSeparator(label: string, value: string): void {
  if (value.includes(FIELD_SEPARATOR))
    throw new Error(
      `createCheckLedger: ${label} contains the field separator (U+0000)`
    )
}

/**
 * Creates a ledger with its coverage denominator fixed up front.
 *
 * Both lists are required and must be non-empty: a ledger with no expected
 * networks or no registered checks reports `0/0` on everything, which renders as
 * a fully green run that verified nothing. A blank network is refused rather
 * than dropped, for the same reason — silently shrinking the denominator is the
 * one thing this factory exists to prevent.
 * @param init - The networks every check is expected to answer for, and the checks that must answer.
 * @returns An empty ledger.
 * @throws If either list is empty, a network is blank, two checks share a `checkId`, or an id or network contains the field separator.
 */
export const createCheckLedger = (init: {
  expectedNetworks: string[]
  checks: ICheckDefinition[]
}): ICheckLedger => {
  if (init.expectedNetworks.length === 0)
    throw new Error('createCheckLedger: expectedNetworks is empty')
  if (init.checks.length === 0)
    throw new Error('createCheckLedger: no checks registered')

  const expectedNetworks = [
    ...new Set(
      init.expectedNetworks.map((network) => {
        const normalised = normaliseNetwork(network)
        if (!normalised)
          throw new Error('createCheckLedger: a declared network is blank')
        rejectSeparator('network', normalised)

        return normalised
      })
    ),
  ]

  const checks = new Map<string, ICheckDefinition>()
  for (const check of init.checks) {
    rejectSeparator('checkId', check.checkId)
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
 * on an integrity check is stored as `fail`. Both rules live here rather than in
 * each check, so no check can opt out of them by how it reports.
 * @param ledger - The run's ledger, mutated in place.
 * @param result - The check's outcome, its expected and actual values, and its anchor.
 * @returns The result as stored, which may differ in `status` from the one passed.
 * @throws If the check was never registered, the network is outside the declared denominator, or the status or anchor is not one this module defines.
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

  // Both fields the verdict rests on, validated at the boundary: a value that
  // arrived from JSON rather than from TypeScript would otherwise land in a
  // fall-through branch and be graded by whatever that branch happens to do.
  if (!CHECK_STATUSES.has(result.status))
    throw new Error(`recordCheck: unknown status "${String(result.status)}"`)
  if (!ANCHOR_IDS.has(result.anchor))
    throw new Error(`recordCheck: unknown anchor "${String(result.anchor)}"`)

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
      detail: `integrity checks have no acknowledgement path${
        result.detail ? ` — ${result.detail}` : ''
      }`,
    }

  // An anchor nobody recognises is treated as one that may only report: an
  // unknown name is what a value that never went through `recordCheck` looks
  // like, and the safe reading is that nothing authoritative answered.
  if (
    result.status === 'pass' &&
    (REPORTING_ONLY_ANCHORS.has(result.anchor) ||
      !ANCHOR_IDS.has(result.anchor))
  )
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
  /** The declared denominator: how many networks this check had to answer for. */
  expected: number
  /** Networks that had nothing for this check to grade. */
  notApplicable: number
  /**
   * The coverage denominator `passed` is measured against: `expected` less the
   * networks that had nothing to grade.
   *
   * A shrunk denominator is the module's own stated hazard, so it is never
   * shrunk silently — `expected` stays on the rollup and every line that prints
   * `passed/graded` prints the not-applicable count beside it, which is what
   * makes the shrink recoverable rather than invisible.
   */
  graded: number
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
 * the last entry wins, so a run may record a provisional result and supersede
 * it; the one exception is a mismatch, which nothing that would soften the
 * verdict may erase — only another mismatch, or an `error`, which blocks the
 * same way.
 *
 * The status coercions are re-applied here rather than trusted from write time,
 * so a result that reached the log some other way — a rehydrated document, a
 * direct push — is graded by the same rules, and every consumer of a rollup
 * inherits them instead of re-deriving them.
 * @param ledger - The run's ledger.
 * @returns One rollup per registered check, in registration order.
 */
export const rollUpChecks = (ledger: ICheckLedger): ICheckRollup[] =>
  [...ledger.checks.values()].map((definition) => {
    const latest = new Map<string, ICheckResult>()
    const mismatched = new Set<string>()
    // What each network's last disagreement was, kept for the whole run: the
    // note belongs to the network, not to whichever row happens to be displaced,
    // so it survives any number of failed retries.
    const lastMismatch = new Map<string, string>()

    for (const raw of ledger.results) {
      if (raw.checkId !== definition.checkId) continue

      // Coerced before the supersession decision, so a status the rules would
      // downgrade cannot be superseded as if it had been the milder one.
      // Stripped, never trusted: this field is a claim about the ledger's own
      // history, so accepting an incoming one lets a rehydrated document assert
      // a disagreement the log never recorded — and the digest names seven
      // fields, not this one, so it could not be seen there either. Derived
      // below or absent.
      const { supersededMismatch: _incoming, ...clean } = raw
      const result = coerceStatus(clean as ICheckResult, definition)
      if (result.status === 'fail') {
        mismatched.add(result.network)
        lastMismatch.set(
          result.network,
          `an earlier attempt disagreed: expected ${result.expected}, observed ${result.actual} (anchor ${result.anchor})`
        )
      }

      // A retry may turn an unverified result green — recording a retryable
      // failure exists for exactly that. A mismatch may not: the anchor and the
      // observed value genuinely disagreed, and a milder result recorded after
      // it would erase that with no trace.
      //
      // `error` is not milder: it blocks with no acknowledgement path, so
      // letting it supersede keeps the run hard-blocked. Refusing it would leave
      // the mismatch standing with nothing counted as unverified, which is
      // acknowledgeable.
      if (
        result.status !== 'fail' &&
        result.status !== 'error' &&
        mismatched.has(result.network)
      )
        continue

      // One row per network is what the verdict needs, and it cannot hold both
      // "it disagreed" and "the retry could not run". The surviving row carries
      // the disagreement it replaced so neither fact is lost.
      const carriedNote =
        result.status === 'fail' ? undefined : lastMismatch.get(result.network)
      const carried =
        carriedNote === undefined
          ? result
          : { ...result, supersededMismatch: carriedNote }

      latest.set(result.network, carried)
    }

    const results = ledger.expectedNetworks
      .map((network) => latest.get(network))
      .filter((result): result is ICheckResult => result !== undefined)

    const countOf = (status: CheckStatus): number =>
      results.filter((result) => result.status === status).length

    const expected = ledger.expectedNetworks.length
    const passed = countOf('pass')
    const notApplicable = countOf('not-applicable')
    // A network that reported nothing at all stays in here, so it still rolls
    // up as missing and blocks; only a network that positively answered "there
    // was nothing to grade" leaves the denominator.
    const graded = expected - notApplicable
    // Anything outside this module's statuses counts here, because that is how the
    // verdict grades it — otherwise such a status sits in the denominator and in
    // no numerator.
    const errored = results.filter(
      (result) =>
        result.status === 'error' || !CHECK_STATUSES.has(result.status)
    ).length
    const missingNetworks = ledger.expectedNetworks.filter(
      (network) => !latest.has(network)
    )

    return {
      ...definition,
      expected,
      notApplicable,
      graded,
      passed,
      failed: countOf('fail'),
      errored,
      needsAck: countOf('needs-ack'),
      missing: missingNetworks.length,
      unverified: errored + missingNetworks.length,
      // `graded > 0` is the half that matters: `passed === graded` is `0 === 0`
      // for a check that graded nothing, which is the reading that closed a run
      // green over a proposal it never looked at.
      green: graded > 0 && passed === graded,
      anchors: [...new Set(results.map((result) => result.anchor))].sort(),
      missingNetworks,
      results,
    }
  })

export type OpProfile = 'subtractive' | 'additive' | 'mixed' | 'unknown'

/**
 * Whether triage may relax one of this ledger's checks on one operation profile.
 *
 * Three independent conditions, all necessary: the operation must be purely
 * subtractive, the check must be semantic, and the result must be an unanswered
 * acknowledgement rather than a mismatch. An integrity check is refused on every
 * profile, so the codehash gate is never relaxed by triage.
 *
 * The class is read from the ledger's own registration rather than taken from
 * the caller — a caller that could name the class could relax the codehash gate
 * by describing it as semantic.
 * @param ledger - The run's ledger, which holds the authoritative check class.
 * @param request - The check, the status of its result, and the operation's profile.
 * @returns Whether the relaxation is permitted, and the reason either way.
 */
export const isTriageRelaxationAllowed = (
  ledger: ICheckLedger,
  request: { checkId: string; status: CheckStatus; profile: OpProfile }
): { allowed: boolean; reason: string } => {
  const definition = ledger.checks.get(request.checkId)
  if (!definition)
    return {
      allowed: false,
      reason: `check "${request.checkId}" is not registered on this ledger`,
    }
  if (definition.checkClass === 'integrity')
    return {
      allowed: false,
      reason: 'integrity checks are never relaxed',
    }
  if (request.profile !== 'subtractive')
    return {
      allowed: false,
      reason: `triage relaxes only a purely subtractive op, this one is ${request.profile}`,
    }
  if (request.status !== 'needs-ack')
    return {
      allowed: false,
      reason: `triage drops an unanswered acknowledgement, not a ${request.status}`,
    }

  return {
    allowed: true,
    reason: 'subtractive op, semantic check, acknowledgement outstanding',
  }
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
  /** Results the run established there was nothing to grade for. */
  notApplicable: number
}

export interface ILedgerVerdict {
  /** True when something blocks with no acknowledgement path available. */
  hardBlocked: boolean
  /**
   * True when no result was graded at all — every one of them was
   * `not-applicable`.
   *
   * Carried separately from `hardBlocked` because the two answer different
   * questions, and a consumer reading only "nothing blocks" would read a run
   * that reviewed nothing as a run that reviewed everything.
   */
  nothingGraded: boolean
  blocking: IBlockingResult[]
  /** Semantic non-passes a human may acknowledge; the caller must ask before proceeding. */
  requiresAcknowledgement: ICheckResult[]
  /** Acknowledgements triage dropped, kept so the report can name them. */
  relaxed: ICheckResult[]
  totals: ILedgerTotals
}

/**
 * Reduces the ledger to the one decision a signer needs.
 *
 * `error` and a missing result block on either class: both mean the check was
 * not shown to have run, so there is nothing for a human to acknowledge. An
 * integrity `fail` blocks too, because the integrity class has no
 * acknowledgement path at all. Only a semantic non-pass is acknowledgeable, and
 * triage can drop one on a subtractive op alone.
 *
 * `not-applicable` blocks nothing and is owed to nobody, so it lands in its own
 * total and in `nothingGraded`. It is the one status that is neither a finding
 * nor a verification, which is why a caller reading `hardBlocked` alone cannot
 * tell a clear run from an empty one.
 *
 * A status this module does not define is treated as unverified and blocks.
 * `recordCheck` refuses one, so this is only reachable by a result that entered
 * the log some other way — and the safe reading of a status nothing recognises
 * is that nothing was verified.
 * @param ledger - The run's ledger.
 * @param options - `triageProfile` enables the narrowed relaxation.
 * @returns The verdict, the blocking rows, what awaits acknowledgement, and the totals.
 */
export const summariseLedger = (
  ledger: ICheckLedger,
  options: { triageProfile?: OpProfile } = {}
): ILedgerVerdict => {
  // A ledger that verified nothing is not a clear result, and `passed ===
  // expected` is `0 === 0`. The factory refuses to build one, but every
  // consumer here takes a plain `ICheckLedger`, which a rehydrated document or
  // a direct push reaches without passing the factory.
  if (ledger.checks.size === 0 || ledger.expectedNetworks.length === 0)
    throw new Error(
      `Refusing to summarise a ledger that verifies nothing: ${ledger.checks.size} checks over ${ledger.expectedNetworks.length} networks. A verdict about no results is not a pass, and reporting one as green is the failure this ledger exists to prevent.`
    )

  const blocking: IBlockingResult[] = []
  const requiresAcknowledgement: ICheckResult[] = []
  const relaxed: ICheckResult[] = []
  const totals: ILedgerTotals = {
    pass: 0,
    fail: 0,
    error: 0,
    needsAck: 0,
    missing: 0,
    notApplicable: 0,
  }

  for (const rollup of rollUpChecks(ledger)) {
    for (const result of rollup.results) {
      if (result.status === 'pass') {
        totals.pass += 1
        continue
      }

      // Ahead of the unrecognised-status branch and of the acknowledgement
      // fall-through below: a status that lands in neither numerator would be
      // graded by whichever branch happens to catch it, and the one under this
      // would file it as awaiting a human acknowledgement that nobody owes.
      if (result.status === 'not-applicable') {
        totals.notApplicable += 1
        continue
      }

      const unrecognised = !CHECK_STATUSES.has(result.status)

      if (result.status === 'error' || unrecognised) {
        totals.error += 1
        blocking.push({
          checkId: result.checkId,
          network: result.network,
          status: 'error',
          reason: unrecognised
            ? `status "${String(
                result.status
              )}" is not one this ledger recognises — treated as unverified`
            : `the check could not run — recorded unverified, and an unverified check has no acknowledgement path${
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
          reason: `integrity mismatch — hard block, no acknowledgement path${
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
        isTriageRelaxationAllowed(ledger, {
          checkId: result.checkId,
          status: result.status,
          profile: options.triageProfile,
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
    // Every result the run graded, whichever way it graded it, plus the ones it
    // never recorded — so this is false the moment anything at all was looked
    // at, and cannot mask a run that had both skipped and graded networks.
    nothingGraded:
      totals.pass +
        totals.fail +
        totals.error +
        totals.needsAck +
        totals.missing ===
      0,
    blocking,
    requiresAcknowledgement,
    relaxed,
    totals,
  }
}

export interface IReviewAttestationCheck {
  checkId: string
  checkClass: CheckClass
  expected: number
  /** Without it, a check that graded nothing reads as one that graded and failed. */
  notApplicable: number
  passed: number
  failed: number
  needsAck: number
  unverified: number
  green: boolean
  anchors: AnchorId[]
}

export interface IReviewAttestation {
  /** Binds the attestation to the exact results and verdict it was written over. */
  ledgerDigest: Hex
  reviewer: string
  reviewedAt: string
  /** The profile triage ran under, or `none` when it did not run. */
  triageProfile: OpProfile | 'none'
  hardBlocked: boolean
  /** Results still awaiting a human acknowledgement when the record was written. */
  awaitingAcknowledgement: number
  /** Acknowledgements triage dropped, so a triaged clear is never read as a clean one. */
  relaxed: number
  totals: ILedgerTotals
  checks: IReviewAttestationCheck[]
}

/**
 * Builds the record of a completed review, for the caller to store on the
 * proposal document.
 *
 * The digest covers the coverage denominator, every registered check *including
 * its class*, every stored result, and the verdict the record carries — sorted,
 * so it is stable across the order a run happened to record them in and moves if
 * any of it changes. The class is in there because it is the field that decides
 * whether a mismatch blocks: without it, demoting the codehash gate to semantic
 * and acknowledging it would leave the digest untouched. The triage profile is
 * digested for the same reason — a review that only cleared because triage
 * dropped an acknowledgement must not be editable into one that had nothing to
 * acknowledge.
 *
 * It is a reconstruction record, not an oracle: nothing may later read it back
 * and treat a stored pass as verification.
 * @param ledger - The run's ledger.
 * @param review - Who reviewed, when as an ISO timestamp, and the triage profile the run used.
 * @returns The attestation record.
 */
export const buildReviewAttestation = (
  ledger: ICheckLedger,
  review: { reviewer: string; reviewedAt: string; triageProfile?: OpProfile }
): IReviewAttestation => {
  const rollups = rollUpChecks(ledger)
  const verdict = summariseLedger(
    ledger,
    review.triageProfile ? { triageProfile: review.triageProfile } : {}
  )

  // Each row is an array rather than a joined string: JSON delimits the fields
  // itself, so a recorded value can never shift a field boundary and make two
  // different result sets digest identically.
  // Every stored result, not the surviving rollup rows. Supersession drops a
  // result from what is rendered, so digesting only the survivors leaves a run
  // in which something disagreed indistinguishable from one in which nothing
  // did.
  const rows = ledger.results.map((result) => [
    result.checkId,
    result.network,
    result.status,
    result.expected,
    result.actual,
    result.anchor,
    result.detail ?? '',
  ])
  const checks = [...ledger.checks.values()].map((definition) => [
    definition.checkId,
    definition.checkClass,
    definition.section,
    // The only text saying what is being checked, so relabelling a check must
    // move the digest.
    definition.title,
  ])
  const byJson = (left: string[], right: string[]): number =>
    JSON.stringify(left) < JSON.stringify(right) ? -1 : 1

  return {
    ledgerDigest: keccak256(
      stringToHex(
        JSON.stringify({
          networks: [...ledger.expectedNetworks].sort(),
          checks: checks.sort(byJson),
          rows: rows.sort(byJson),
          verdict: {
            triageProfile: review.triageProfile ?? 'none',
            hardBlocked: verdict.hardBlocked,
            awaitingAcknowledgement: verdict.requiresAcknowledgement.length,
            relaxed: verdict.relaxed.length,
          },
        })
      )
    ),
    reviewer: review.reviewer,
    reviewedAt: review.reviewedAt,
    triageProfile: review.triageProfile ?? 'none',
    hardBlocked: verdict.hardBlocked,
    awaitingAcknowledgement: verdict.requiresAcknowledgement.length,
    relaxed: verdict.relaxed.length,
    totals: verdict.totals,
    checks: rollups.map((rollup) => ({
      checkId: rollup.checkId,
      checkClass: rollup.checkClass,
      expected: rollup.expected,
      notApplicable: rollup.notApplicable,
      passed: rollup.passed,
      failed: rollup.failed,
      needsAck: rollup.needsAck,
      unverified: rollup.unverified,
      green: rollup.green,
      anchors: rollup.anchors,
    })),
  }
}
