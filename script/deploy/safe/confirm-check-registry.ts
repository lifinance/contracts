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
import type { ICodehashSignGate } from './codehash-sign-gate'
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
import type { IPreBroadcastAuthority } from './prebroadcast-authorities'
import { MIN_INDEPENDENT_PROVIDERS, type IRpcQuorumVerdict } from './rpc-quorum'
import type { ISignedAuthorityEntry } from './signed-set-record'

export const TARGET_STATE_CHECK_ID = 'target-state'

export const TARGET_STATE_CHECK: ICheckDefinition = {
  checkId: TARGET_STATE_CHECK_ID,
  section: 'Intent',
  checkClass: 'semantic',
  gate: 'H',
  title: 'Contract version matches target state',
}

/** Persisted in signed-set records, so it does not follow the title. */
export const STORAGE_AUTHORITY_CHECK_ID = 'storage-authority'

export const STORAGE_AUTHORITY_CHECK: ICheckDefinition = {
  checkId: STORAGE_AUTHORITY_CHECK_ID,
  section: 'Deployed state',
  checkClass: 'integrity',
  gate: 'G',
  title: 'Contract owner matches what main declares',
  // Every diamond cut carries `LiFiDiamond.owner`, whose expectation comes from
  // the deployment record — so without this the one gate that reads live
  // authorities refuses every honest proposal, and the remedy it prints cannot
  // be followed. A mismatch is untouched and still hard-blocks.
  undecidableIsAcknowledgeable: true,
}

const DECIDING_EXPECTATION_SOURCES: ReadonlySet<
  IPreBroadcastAuthority['expectationSource']
> = new Set(['globalConfig', 'zeroAddress'])

/**
 * Where each authority's expectation came from, as an anchor.
 *
 * `config/global.json` is a repo file the proposer's branch cannot change
 * without review, so it may decide a pass, and so may the zero address, which
 * is written here and read from nowhere. The deployment record is written by
 * the proposer, so it may only report: a match against it means no more than
 * "the value matched the one we were handed", which is for the signer to
 * accept rather than for the gate to grade green.
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
      DECIDING_EXPECTATION_SOURCES.has(authority.expectationSource)
        ? ('A-LOCAL' as const)
        : ('A-MONGO' as const),
    ])
  )

export const EVERY_INSTALLED_CONTRACT_OWNED =
  'every contract this installs owned by the wallet main declares'

/**
 * Reduces a network's storage-authority observations to the one row the ledger
 * holds.
 *
 * The comparison is a live chain read against a declaration in `main`, so the
 * live side is `A-CHAIN` — but the row is anchored on the weaker of the two,
 * because a comparison is only as good as its expectation. An authority whose
 * expected value comes from the deployment record is `A-MONGO`: the proposer
 * writes that record and therefore owns one side of the comparison, so an
 * all-matched row on it grades `needs-ack` rather than green, naming the labels
 * whose expectation it rests on. One sourced from `config/global.json` is
 * `A-LOCAL` and may decide.
 *
 * Only the all-matched case is acknowledgeable. A live value that disagrees, a
 * read that failed and an expectation of unknown provenance all keep the
 * integrity class's hard block.
 *
 * An empty set is `not-applicable`, never a pass: this proposal installs no
 * contract whose constructor-written storage there is anything to assert, so
 * the row satisfies no verified counter and blocks nothing. The caller owes the
 * distinction — a set that is empty because the calldata could not be read
 * through never reaches here, because a scope nobody could read is not a scope
 * known to be empty.
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
      status: 'not-applicable',
      expected: EVERY_INSTALLED_CONTRACT_OWNED,
      actual: 'this proposal installs no contract whose owner main declares',
      anchor: 'A-LOCAL',
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
  // proposer-written, so it takes the weakest anchor in the set. `A-UNRESOLVED`
  // is decided before `A-MONGO` rather than by whichever comes last in calldata
  // order, because the acknowledgement below turns on that answer.
  const recordSourced: string[] = []
  if (failing.length === 0) {
    let unresolved = false
    for (const entry of entries) {
      const entryAnchor = expectationAnchors.get(entry.label) ?? 'A-UNRESOLVED'
      if (entryAnchor === 'A-UNRESOLVED') unresolved = true
      else if (entryAnchor === 'A-MONGO') recordSourced.push(entry.label)
    }
    if (unresolved) anchor = 'A-UNRESOLVED'
    else if (recordSourced.length > 0) anchor = 'A-MONGO'
  }

  // `A-MONGO` and nothing else. The record is proposer-written, so the row may
  // not grade green — but every value was read live and matched, and the signer
  // can be told exactly which expectations rest on the record and take them on.
  // `A-UNRESOLVED` is the case where nothing answered, so there is nothing to
  // take on and it keeps blocking.
  const acknowledgeable = status === 'pass' && anchor === 'A-MONGO'
  if (acknowledgeable) status = 'needs-ack'

  return {
    checkId: STORAGE_AUTHORITY_CHECK_ID,
    network,
    status,
    expected: EVERY_INSTALLED_CONTRACT_OWNED,
    actual: failing.length
      ? failing.join('; ')
      : `${entries.length} declared authority value(s) match config`,
    anchor,
    ...(acknowledgeable
      ? {
          detail: `read live and matched, but the expected value came from the deployment record the proposer writes: ${recordSourced.join(
            ', '
          )}`,
        }
      : {}),
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
 *
 * A row that compared exactly one element prints that element's declared
 * version instead — see `comparedVersions`. A version is the same requirement
 * stated exactly, and only the single-element case can state it without being
 * false about a second facet.
 */
export const ORDERING_HOLDS =
  'no installed version behind what origin/main declares'
export const EVERY_ELEMENT_COMPARED =
  'every installed element compared against origin/main'
/** Why the delay gate stood down, as the signer reads it under "observed". */
export const NO_TIMELOCK_SCHEDULE =
  'this proposal carries no timelock schedule, so there is no delay to compare'
export const NOTHING_TO_COMPARE =
  'a cut that installs nothing requiring a version comparison'
/** Why this gate stood down, as the signer reads it under "observed". */
export const NOTHING_INSTALLED_TO_COMPARE =
  'this proposal installs no facet code, so there is no version to compare'

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
/**
 * Exported so the detail block's stand-down set can be checked against this map
 * rather than against a restatement of it: two copies of one rule agree with
 * each other while both drift from the page.
 */
export const STATUS_MAPPING: Readonly<
  Record<TargetStateStatus, IStatusMapping>
> = {
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
  removal: {
    status: 'not-applicable',
    anchor: 'A-LOCAL',
    expected: NOTHING_TO_COMPARE,
  },
  'no-diamond-cut': {
    status: 'not-applicable',
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
/**
 * The statuses that mean this row compared nothing.
 *
 * A set rather than a `!== 'pass'` test: `not-applicable` is not a finding a
 * signer has to read, and listing it beside `pass` is what keeps it out of the
 * `failing` list that drives `actual` and `detail`.
 */
const GRADED_NOTHING: ReadonlySet<ICheckResult['status']> = new Set([
  'pass',
  'not-applicable',
])

const SEVERITY: readonly ICheckResult['status'][] = [
  'fail',
  'error',
  'needs-ack',
  'pass',
  // Listed rather than left out: a status this array omits gets -1 from
  // `indexOf`, which ranks it ahead of `fail`.
  'not-applicable',
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
 * The statuses whose two versions were successfully ordered.
 *
 * `version-not-comparable` is deliberately absent, though it too carries both:
 * a pair printed alone reads as a comparison, and that status exists precisely
 * because the two could not be compared. Its row keeps the status name, which is
 * the only cue the signer gets — the bucket it prints under blames their
 * environment, and a malformed version string is the proposer's.
 */
const COMPARED_BOTH_VERSIONS: ReadonlySet<TargetStateStatus> = new Set([
  'matches-main',
  'ahead-of-main',
  'downgrade',
])

/**
 * The version pair a row prints under "expected" and "observed", when it has
 * one to print.
 *
 * The two sides come from different places and only one of them is the
 * proposer's: the expectation is what `origin/main` declares, the observation is
 * what the deployment record the proposer writes says the proposed address is.
 * That is the comparison this gate exists to make, so the signer reads the two
 * versions rather than a sentence about them — and `hashPair` in the signer view
 * then marks the character that differs.
 *
 * Only for a row that graded exactly one element. `expected` has to hold for the
 * whole row, and a row covering two facets cannot name one facet's version
 * without being false about the other.
 *
 * Which statuses qualify is an allow-list, not a test that both fields are
 * populated: a `contract-unidentified` finding carries the record's version
 * under a blank name, and reading a version off one would print a number no
 * comparison produced as though it had been compared.
 *
 * The name comes back with the pair because the pair displaces it. `actual` used
 * to carry it, and the surfaces that print a row without its findings beside it
 * — the run-wide ledger, the proposal card, a superseded-attempt note — have
 * nowhere else to read which element the two versions belong to.
 *
 * @param graded - The findings this row was graded on.
 * @returns The pair and the element it belongs to, or nothing when the row must state its requirement instead.
 */
const comparedVersions = (
  graded: readonly ITargetStateFinding[]
): { expected: string; actual: string; contractName: string } | null => {
  if (graded.length !== 1) return null
  const [only] = graded
  if (!only || !COMPARED_BOTH_VERSIONS.has(only.status)) return null
  if (!only.mainVersion || !only.proposedVersion || !only.contractName)
    return null
  return {
    expected: `v${only.mainVersion}`,
    actual: `v${only.proposedVersion}`,
    contractName: only.contractName,
  }
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
 * Where the row graded a single element, `comparedVersions` replaces the
 * requirement sentence and the status list with the two versions themselves.
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

  // Seeded at the weakest status in `SEVERITY`, not at `pass`: `worstOf` keeps
  // the lower-ranked side, so a `pass` seed would outrank every finding that
  // maps to `not-applicable` and a cut installing nothing would reduce to a
  // green row claiming a comparison that never happened.
  let status: ICheckResult['status'] = 'not-applicable'
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
    (finding) => !GRADED_NOTHING.has(STATUS_MAPPING[finding.status].status)
  )

  const versions = comparedVersions(failing)
  const listed =
    status === 'not-applicable'
      ? // Every finding said "nothing to compare", so the row is the reason
        // rather than a list of element names: `actual` is what a signer reads
        // to learn why a gate stood down, and `FacetX: removal` does not say it.
        NOTHING_INSTALLED_TO_COMPARE
      : (failing.length ? failing : verdict.findings).map(describe).join('; ')

  return {
    checkId: TARGET_STATE_CHECK_ID,
    network,
    status,
    expected: versions?.expected ?? expected,
    actual: versions?.actual ?? listed,
    anchor,
    // The name is prefixed here rather than written into the finding's own
    // detail, which `formatTargetStateLines` already prints under the element's
    // name — there it would read twice.
    ...(failing.length && detail
      ? { detail: versions ? `${versions.contractName}: ${detail}` : detail }
      : {}),
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

export const EVERY_TARGET_ATTESTED =
  'every address this cut installs carrying bytecode an attested build produces'
/** Why this gate stood down, as the signer reads it under "observed". */
export const NOTHING_INSTALLED_TO_HASH =
  'this proposal installs no facet code, so there is no bytecode to compare'

/**
 * How the codehash gate reaches the ledger.
 *
 * Reporting only. The refusal this gate drives stays in
 * `assertCodehashSignGateAllowsSigning`, which every sign path funnels through;
 * this row exists so the gate is accounted for in the same book as the other
 * ten, and a bug here can make the report wrong but can never make an unsigned
 * proposal signable.
 *
 * `madeNoClaim` is two different facts and is split on `unopened`, never on the
 * summary sentence: a payload read to the end that contains no cut has nothing
 * to check, and a payload whose frames would not open has not been checked. The
 * second is the case a proposer can manufacture, so it errors on
 * `A-UNRESOLVED` and blocks — the same input Gate G already refuses on, which
 * is what makes this row a second lock on that door rather than a new one.
 *
 * @param gate - The evaluated gate for this proposal.
 * @param network - The network the gate judged against.
 * @returns The row to hand to `recordCheck`.
 */
export const codehashCheckResult = (
  gate: ICodehashSignGate,
  network: string
): ICheckResult => {
  if (!gate.evaluated)
    return unresolved(
      CODEHASH_CHECK_ID,
      network,
      EVERY_TARGET_ATTESTED,
      gate.summary || 'the codehash gate produced no verdict for this proposal'
    )

  if (gate.madeNoClaim)
    return gate.unopened && gate.unopened.length > 0
      ? unresolved(
          CODEHASH_CHECK_ID,
          network,
          EVERY_TARGET_ATTESTED,
          `this decoder could not open ${gate.unopened.join(
            ', '
          )}, so whether this proposal installs code is unknown`
        )
      : {
          checkId: CODEHASH_CHECK_ID,
          network,
          status: 'not-applicable',
          expected: EVERY_TARGET_ATTESTED,
          actual: NOTHING_INSTALLED_TO_HASH,
          anchor: 'A-LOCAL',
        }

  if (gate.blocksSigning)
    return {
      checkId: CODEHASH_CHECK_ID,
      network,
      // A refusal is not a codehash disagreement — it is the cut being
      // malformed, or the gate being unable to judge it. Only a target the
      // gate did compare and found different is a mismatch.
      status: gate.refusals.length > 0 ? 'error' : 'fail',
      expected: EVERY_TARGET_ATTESTED,
      actual: gate.refusals.length
        ? gate.refusals.join(' ')
        : gate.targets
            .filter((target) => target.verdict !== 'MATCH')
            .map((target) => `${target.address}: ${target.verdict}`)
            .join('; '),
      anchor: gate.refusals.length > 0 ? 'A-UNRESOLVED' : 'A-AUDIT',
      ...(gate.summary ? { detail: gate.summary } : {}),
    }

  // A cut this gate did open and found no code in — a removal, whose every
  // facet address is zero. `madeNoClaim` does not cover it: that is the payload
  // with no cut at all. Left on the `pass` below it graded as "0 installed
  // address(es) match an attested build", which is a green row satisfying a
  // verified counter on the strength of nothing.
  if (gate.targets.length === 0)
    return {
      checkId: CODEHASH_CHECK_ID,
      network,
      status: 'not-applicable',
      expected: EVERY_TARGET_ATTESTED,
      actual: NOTHING_INSTALLED_TO_HASH,
      anchor: 'A-LOCAL',
    }

  return {
    checkId: CODEHASH_CHECK_ID,
    network,
    status: 'pass',
    expected: EVERY_TARGET_ATTESTED,
    actual: `${gate.targets.length} installed address(es) match an attested build`,
    anchor: 'A-AUDIT',
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
  gate: 'I',
  title: 'Transaction / calldata would not revert',
}

export const RPC_QUORUM_CHECK_ID = 'rpc-quorum'

export const RPC_QUORUM_CHECK: ICheckDefinition = {
  checkId: RPC_QUORUM_CHECK_ID,
  section: 'Evidence',
  checkClass: 'semantic',
  gate: 'J',
  title: 'Independent RPCs agree',
}

export const CODEHASH_CHECK_ID = 'codehash'

/**
 * Registered, and answered for by `codehashCheckResult`.
 *
 * The gate also refuses inside `confirm-integrity-asserts`, outside the ledger.
 * That refusal is why it needs a letter and a subject of its own: a harness
 * that cannot run it prints it as not-applicable, and a row with no definition
 * renders as `Gate undefined`.
 */
export const CODEHASH_CHECK: ICheckDefinition = {
  checkId: CODEHASH_CHECK_ID,
  section: 'Deployed state',
  checkClass: 'integrity',
  gate: 'K',
  title: "Facet bytecode matches main's build",
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
  CODEHASH_CHECK,
  STORAGE_AUTHORITY_CHECK,
  TARGET_STATE_CHECK,
  EXECUTABILITY_CHECK,
  RPC_QUORUM_CHECK,
]

/**
 * Every gate this repo has a name for, registered or not.
 *
 * The naming authority, so the letters stay unique across gates that never
 * share a ledger: `CONFIRM_CHECK_DEFINITIONS` is the subset a run must answer
 * for, and anything a view might have to name belongs here too.
 *
 * Keyed by `checkId` rather than concatenated, because a gate named here may
 * also be registered — the codehash gate refuses outside the ledger today and
 * is expected to gain a row. Appending it would then list it twice and give the
 * roster two entries sharing one letter, which the manifest renders as two
 * gates and the uniqueness check below reads as a collision.
 */
export const ALL_GATE_DEFINITIONS: readonly ICheckDefinition[] = [
  ...new Map(
    [...CONFIRM_CHECK_DEFINITIONS, CODEHASH_CHECK].map((definition) => [
      definition.checkId,
      definition,
    ])
  ).values(),
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

  if (verdict.refuses) {
    // Which calls, not every reason: a row's `actual` is one value a signer
    // compares against `expected` and the ledger stores verbatim, and
    // `verdict.reason` is the whole finding list joined — including whatever
    // the node echoed back, which for viem is the entire calldata. The reasons
    // are not lost: `assertProposalWouldExecute` still refuses with the full
    // `reason`, and the signer view prints one section per call.
    const reverting = verdict.calls
      .filter((call) => call.outcome === 'would-revert')
      .map((call) => call.path)

    return {
      checkId: EXECUTABILITY_CHECK_ID,
      network,
      status: 'fail',
      expected: 'no payload reverts',
      actual: reverting.length
        ? `${reverting.length} of ${
            verdict.calls.length
          } call(s) would revert: ${reverting.join(', ')}`
        : verdict.reason,
      anchor: 'A-CHAIN',
    }
  }

  // A payload with no bespoke revert model is still simulated: its target is
  // checked for code and its calldata is sent in an eth_call from the account
  // that will really send it, and both of those had to come back clean to
  // reach here. Whether we could also have predicted the revert from the bytes
  // is a property of our modelling, not evidence about the proposal, so it does
  // not lower the grade. Every way to arrive here without that evidence is
  // already an `error` above: an eth_call never attempted, a payload with no
  // result, a call that could not be read through.
  return {
    checkId: EXECUTABILITY_CHECK_ID,
    network,
    status: 'pass',
    expected: 'no payload reverts',
    actual:
      verdict.notSimulated.length > 0
        ? `no revert found in any payload; ${verdict.notSimulated.length} of them judged on their target holding code and a clean eth_call alone`
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
 * The branch keys on `reachesQuorum`, never on the status text, which is what
 * keeps `agreed-absent` out of the pass its name shares a prefix with: the
 * providers did agree there, and what they agreed on is that nothing is at the
 * address, so `evaluateRpcQuorum` leaves `reachesQuorum` false and the row is an
 * acknowledgement.
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
    // Keyed on providers, worded as providers. `independentProviders` collapses
    // endpoints that share an upstream, so a network with three endpoints from
    // one provider still counts as one — telling that operator they have one
    // *endpoint* sends them to re-run a command that would change nothing.
    detail:
      verdict.independentProviders < MIN_INDEPENDENT_PROVIDERS
        ? `${verdict.detail} — ${verdict.independentProviders} independent provider(s) across ${verdict.endpointsConsulted} configured endpoint(s); a second provider is needed, which "bun fetch-rpcs" picks up where MongoDB holds one`
        : verdict.detail,
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
  /**
   * The codehash gate's verdict for this proposal.
   *
   * Required, not optional: the gate is evaluated for every proposal and the
   * caller starts each one at `blockingUnevaluatedGate()`, so there is no path
   * on which it is legitimately absent — and an optional field would let a
   * caller that forgot to pass it produce a report with a silent hole where the
   * eleventh gate should be.
   */
  codehash: ICodehashSignGate
  /**
   * What the run read at each declared storage authority, and where each
   * expectation came from.
   *
   * Absent means the read was never made, which blocks: gate G exists to
   * refuse a proposal whose authorities could not be shown to match, and a
   * silent absence would be the one way to get past it.
   */
  storageAuthority:
    | {
        entries: readonly ISignedAuthorityEntry[]
        anchors: ReadonlyMap<string, ICheckResult['anchor']>
        /**
         * Calls whose contents could not be read through, if any.
         *
         * What this proposal installs is decoded from its own calldata, so a
         * call that would not decode leaves the subject set unknown rather than
         * empty — and an unknown scope read as an empty one is how a gate comes
         * to report "nothing to check" about a payload nobody could open.
         */
        scopeUnreadable?: readonly string[]
      }
    | undefined
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
 * so the row is `not-applicable` with that reason on it. Not a pass: nothing
 * was compared, and a pass would put the row in the verified numerator.
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

    // Only when the assertions never registered the delay check, which is how
    // they say the calldata was read and found not to be a schedule. Registered
    // with no row means the assertion did not finish, and the two are opposite
    // facts: `run.registered` is what separates them.
    if (
      checkId === CHECK_TIMELOCK_DELAY &&
      !run.registered.includes(CHECK_TIMELOCK_DELAY)
    )
      return {
        checkId,
        network,
        status: 'not-applicable' as const,
        expected: "a schedule's delay is at least the timelock's live minimum",
        actual: NO_TIMELOCK_SCHEDULE,
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
    codehashCheckResult(verdicts.codehash, network),
    verdicts.storageAuthority
      ? verdicts.storageAuthority.scopeUnreadable?.length
        ? unresolved(
            STORAGE_AUTHORITY_CHECK_ID,
            network,
            EVERY_INSTALLED_CONTRACT_OWNED,
            `what this proposal installs could not be read from ${verdicts.storageAuthority.scopeUnreadable.join(
              ', '
            )}, so the contracts whose authorities to read are unknown`
          )
        : storageAuthorityCheckResult(
            verdicts.storageAuthority.entries,
            network,
            verdicts.storageAuthority.anchors
          )
      : unresolved(
          STORAGE_AUTHORITY_CHECK_ID,
          network,
          EVERY_INSTALLED_CONTRACT_OWNED,
          'no storage-authority read was made for this proposal'
        ),
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
