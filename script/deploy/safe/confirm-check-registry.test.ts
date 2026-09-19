// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type { ITargetVerdict } from '../codehash/verify-cut-targets'

import {
  createCheckLedger,
  isAcknowledgeable,
  recordCheck,
  gateLabel,
  rollUpChecks,
  summariseLedger,
  type CheckStatus,
  type ICheckLedger,
  type ICheckResult,
} from './check-ledger'
import {
  CODEHASH_GATE_HEADING,
  renderCodehashSignGate,
  type ICodehashSignGate,
} from './codehash-sign-gate'
import {
  ALL_GATE_DEFINITIONS,
  authorityExpectationAnchors,
  CODEHASH_CHECK,
  CODEHASH_CHECK_ID,
  IMMUTABLES_CHECK,
  IMMUTABLES_CHECK_ID,
  immutablesCheckResult,
  CONFIRM_CHECK_DEFINITIONS,
  EVERY_ELEMENT_COMPARED,
  EXECUTABILITY_CHECK_ID,
  NO_TIMELOCK_SCHEDULE,
  NOTHING_INSTALLED_TO_COMPARE,
  NOTHING_INSTALLED_TO_HASH,
  NOTHING_TO_COMPARE,
  ORDERING_HOLDS,
  RPC_QUORUM_CHECK_ID,
  STORAGE_AUTHORITY_CHECK_ID,
  TARGET_STATE_CHECK,
  TARGET_STATE_CHECK_ID,
  VERSION_MATCHES_PIN,
  codehashCheckResult,
  executabilityCheckResult,
  proposalCheckResults,
  rpcQuorumCheckResult,
  STATUS_MAPPING,
  storageAuthorityCheckResult,
  targetStateCheckResult,
  worstResultPerCheck,
  type IProposalCheckVerdicts,
} from './confirm-check-registry'
import {
  CHECK_TIMELOCK_DELAY,
  INTEGRITY_CHECKS_ALWAYS,
  INTEGRITY_CHECK_DEFINITIONS,
  type IIntegrityAssertRun,
} from './confirm-integrity-asserts'
import type {
  IExecutabilityCall,
  IExecutabilityVerdict,
} from './executability-simulation'
import {
  formatTargetStateLines,
  STATUSES_CLEARED_TO_PROCEED,
  STATUSES_THAT_CONSULTED_NOTHING,
  TARGET_STATE_GATE_HEADING,
  type ITargetStateFinding,
  type ITargetStateVerdict,
  type TargetStateStatus,
} from './pinned-target-state'
import type { IPreBroadcastAuthority } from './prebroadcast-authorities'
import { renderCheckLedger } from './render-check-ledger'
import type { IRpcQuorumVerdict, TQuorumStatus } from './rpc-quorum'
import type { ISignedAuthorityEntry } from './signed-set-record'
import {
  GATE_BODY_INDENT,
  GATE_TITLE_INDENT,
  manifestTitleWidth,
  renderCheckGroups,
} from './signer-view'
import { CHECK_DOCS } from './signer-zones'

const FACET = '0x1111111111111111111111111111111111111111'

/** `pinned-target-state.ts`'s own `blank`, which seven statuses are pushed from. */
const BLANK: Partial<ITargetStateFinding> = {
  facetAddress: null,
  contractName: null,
  proposedVersion: null,
  mainVersion: null,
  crossFleetCount: null,
}

/**
 * The field shape `evaluateTargetStateIntent` actually emits for each status.
 *
 * Mirrored from `pinned-target-state.ts:260-440` rather than defaulted
 * uniformly, because the uniform version was unfalsifiable: it gave every
 * status a `contractName`, so the `contractName ?? facetAddress ?? 'unnamed
 * element'` fallback in `describe` was never exercised even though seven of the
 * thirteen statuses are pushed from `blank` and really do carry a null name —
 * and it gave `not-previously-targeted` a `mainVersion`, which is the one thing
 * that branch's `if (!mainVersion)` guarantees it cannot have.
 */
const EMITTED_SHAPE: Record<TargetStateStatus, Partial<ITargetStateFinding>> = {
  // Pushed from `blank`: no address either, since there is no cut element, and
  // neither version, since nothing was looked up.
  'no-diamond-cut': BLANK,
  'calldata-not-readable': BLANK,
  // Pushed from `blank` with the cut's address, before anything is resolved.
  removal: { ...BLANK, facetAddress: FACET },
  'unrecognised-cut-action': { ...BLANK, facetAddress: FACET },
  'pinned-state-unavailable': { ...BLANK, facetAddress: FACET },
  'deployment-record-ambiguous': { ...BLANK, facetAddress: FACET },
  // Resolved to an address but never to a name, so `main`'s version is never
  // read — there is no name to read it by. The record's own version does reach
  // this finding, when the record carries a version under a blank name.
  'contract-unidentified': {
    ...BLANK,
    facetAddress: FACET,
    proposedVersion: '9.9.9',
  },
  // `origin/main` declared nothing — the only status carrying a fleet count.
  'not-previously-targeted': { mainVersion: null, crossFleetCount: 3 },
  // The record carried no version to compare against main's.
  'proposed-version-unresolved': { proposedVersion: null },
  // Both versions resolved; `shared` never carries a fleet count.
  'matches-main': {},
  'ahead-of-main': {},
  downgrade: {},
  'version-not-comparable': {},
  // A pin grades equality, but it resolves both versions the same way an
  // ordering does.
  'matches-pin': {},
  'pinned-mismatch': {},
  // The network follows the repo and the repo's version could not be read, so
  // there is no expectation to compare the record's version against.
  'expected-version-unresolved': { mainVersion: null },
}

const finding = (
  status: TargetStateStatus,
  overrides: Partial<ITargetStateFinding> = {}
): ITargetStateFinding => ({
  status,
  facetAddress: FACET,
  contractName: 'AcrossFacet',
  proposedVersion: '1.0.0',
  mainVersion: '1.0.0',
  crossFleetCount: null,
  detail: `detail for ${status}`,
  ...EMITTED_SHAPE[status],
  ...overrides,
})

/**
 * Every status the graded verdict can carry, so none escapes the mapping.
 *
 * Keyed rather than listed: a `TargetStateStatus[]` accepts a short list, so a
 * status added later would leave the exhaustiveness tests below silently not
 * covering it. As a `Record` the omission is a compile error.
 */
const STATUS_KEYS: Record<TargetStateStatus, true> = {
  'no-diamond-cut': true,
  removal: true,
  'not-previously-targeted': true,
  'matches-main': true,
  'ahead-of-main': true,
  downgrade: true,
  'version-not-comparable': true,
  'proposed-version-unresolved': true,
  'contract-unidentified': true,
  'deployment-record-ambiguous': true,
  'unrecognised-cut-action': true,
  'calldata-not-readable': true,
  'pinned-state-unavailable': true,
  'matches-pin': true,
  'pinned-mismatch': true,
  'expected-version-unresolved': true,
}

const ALL_STATUSES = Object.keys(STATUS_KEYS) as TargetStateStatus[]

/**
 * Builds a verdict the way `evaluateTargetStateIntent` does — against the real
 * cleared set, never a copy of it. A restated copy only proves it agrees with
 * itself, and stays green while the two drift.
 */
const verdictOf = (findings: ITargetStateFinding[]): ITargetStateVerdict => ({
  findings,
  cleared: findings.every((entry) =>
    STATUSES_CLEARED_TO_PROCEED.has(entry.status)
  ),
})

const ledgerWith = (networks: string[] = ['mainnet']) =>
  createCheckLedger({
    expectedNetworks: networks,
    checks: [...CONFIRM_CHECK_DEFINITIONS],
  })

/**
 * A ledger registering only the check under test.
 *
 * For assertions that read the rolled-up verdict rather than the stored row:
 * every registered check that reports nothing counts as a missing row, so a
 * whole-registry ledger reports `BLOCKED` on the checks the test never touched
 * and the assertion stops being about the one it does.
 */
const targetStateLedger = () =>
  createCheckLedger({
    expectedNetworks: ['mainnet'],
    checks: [TARGET_STATE_CHECK],
  })

const ESC = String.fromCharCode(27)
/** The closing verdict, however many lines it folded onto. */
const closingVerdict = (lines: string[]): string => {
  const fromEnd = [...lines]
    .reverse()
    .findIndex((line) => stripColor(line).startsWith('VERDICT:'))
  return lines.slice(lines.length - 1 - fromEnd).join(' ')
}

const stripColor = (line: string): string =>
  line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

describe('targetStateCheckResult', () => {
  it('maps every status without falling through', () => {
    for (const status of ALL_STATUSES) {
      const result = targetStateCheckResult(
        verdictOf([finding(status)]),
        'mainnet'
      )
      expect(result.status).toBeDefined()
      expect(result.anchor).toBeDefined()
    }
  })

  it('grades a downgrade as a failure', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('downgrade')]),
      'mainnet'
    )

    expect(result.status).toBe('fail')
    expect(result.anchor).toBe('A-MONGO')
  })

  // All three are reached only after the deployment record supplied the
  // proposed version, so none rests on `origin/main` alone and none may wear
  // `A-MAIN`. `not-previously-targeted` is the sharpest: `origin/main` declared
  // nothing at all, and it is the common path, since the target-state PR merges
  // only after execution.
  it('never claims origin/main for a version the deployment record supplied', () => {
    for (const status of [
      'matches-main',
      'ahead-of-main',
      'not-previously-targeted',
    ] as TargetStateStatus[]) {
      const result = targetStateCheckResult(
        verdictOf([finding(status)]),
        'mainnet'
      )

      expect(result.anchor).toBe('A-MONGO')
      expect(result.status).toBe('needs-ack')
    }
  })

  // The rule above holds for every status, not only the three that ask for an
  // acknowledgement: each comparison this check makes has the proposed version on one
  // side, and that side comes from the record. A status reintroducing `A-MAIN` would be
  // claiming evidence the row never had.
  it('leaves A-MAIN unused across every status', () => {
    const anchors = ALL_STATUSES.map(
      (status) =>
        targetStateCheckResult(verdictOf([finding(status)]), 'mainnet').anchor
    )

    expect(anchors).not.toContain('A-MAIN')
    // Not vacuous: the statuses do reach several different anchors.
    expect(new Set(anchors).size).toBeGreaterThan(1)
  })

  // A matched pin is an acknowledgement, never a silent green, and it is anchored on the
  // record rather than on main: the proposed side it compared the pin against comes from
  // the proposer-written deployment record. Without this, downgrading `matches-pin` to a
  // `pass` on `A-LOCAL` passes the whole suite.
  it('grades a matched pin as an acknowledgement anchored on the deployment record', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('matches-pin')]),
      'mainnet'
    )

    expect(result.status).toBe('needs-ack')
    expect(result.anchor).toBe('A-MONGO')
  })

  it('grades a contradicted pin as a failure anchored on the record', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('pinned-mismatch')]),
      'mainnet'
    )

    expect(result.status).toBe('fail')
    expect(result.anchor).toBe('A-MONGO')
  })

  // `latest` with an unreadable source version compared nothing, so it must not be
  // reported as agreement with main.
  it('grades an unresolved expected version as an error', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('expected-version-unresolved')]),
      'mainnet'
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
  })

  it('grades a removal against nothing, because it reads no anchor', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('removal')]),
      'mainnet'
    )

    expect(result.status).toBe('not-applicable')
    expect(result.anchor).toBe('A-LOCAL')
    expect(result.actual).toBe(NOTHING_INSTALLED_TO_COMPARE)
  })

  // The seed `targetStateCheckResult` starts at is the weakest status, so a
  // finding that installs nothing cannot outrank one that does. Without this a
  // cut pairing a removal with an upgrade reduced to the removal's row and the
  // upgrade was never reported.
  it('lets an installing element outrank a removal in the same cut', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('removal'), finding('not-previously-targeted')]),
      'mainnet'
    )

    expect(result.status).toBe('needs-ack')
    expect(result.actual).not.toBe(NOTHING_INSTALLED_TO_COMPARE)
  })

  it('reduces to a mismatch when a removal is paired with a downgrade', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('removal'), finding('downgrade')]),
      'mainnet'
    )

    expect(result.status).toBe('fail')
    expect(result.anchor).toBe('A-MONGO')
  })

  // The whole point of the anchor column: a status derived from the deployment
  // record must not be able to reach the ledger as a green row.
  it('never claims a decidable anchor for a record-derived verdict', () => {
    for (const status of [
      'version-not-comparable',
      'proposed-version-unresolved',
      'contract-unidentified',
      'deployment-record-ambiguous',
    ] as TargetStateStatus[]) {
      const result = targetStateCheckResult(
        verdictOf([finding(status)]),
        'mainnet'
      )

      expect(result.anchor).toBe('A-MONGO')
      expect(result.status).not.toBe('pass')
    }
  })

  /**
   * The statuses that reach the ledger with both versions resolved, and so
   * print the pair instead of a sentence.
   *
   * Their row is asserted separately below, against versions that differ, so
   * the two sides cannot be swapped without a failure.
   */
  const VERSION_PAIR = Symbol('the two versions, not a sentence')

  /**
   * The exact sentence each status must put in `expected`.
   *
   * Asserted against the module's own constants rather than restated copies,
   * and keyed so a status added later is a compile error here too. Full
   * sentences rather than a substring: matching only on "at or ahead of" could
   * not tell the two non-comparing sentences apart, so swapping them stayed
   * green.
   */
  const EXPECTED_SENTENCE: Record<
    TargetStateStatus,
    string | typeof VERSION_PAIR
  > = {
    'matches-main': VERSION_PAIR,
    'ahead-of-main': VERSION_PAIR,
    downgrade: VERSION_PAIR,
    // Carries both versions, but they were never ordered, so the row keeps the
    // status name rather than a pair that would read as a comparison.
    'version-not-comparable': ORDERING_HOLDS,
    // `origin/main` declared nothing, so there is no second version to print.
    'not-previously-targeted': ORDERING_HOLDS,
    removal: NOTHING_TO_COMPARE,
    'no-diamond-cut': NOTHING_TO_COMPARE,
    'proposed-version-unresolved': EVERY_ELEMENT_COMPARED,
    'contract-unidentified': EVERY_ELEMENT_COMPARED,
    'deployment-record-ambiguous': EVERY_ELEMENT_COMPARED,
    'unrecognised-cut-action': EVERY_ELEMENT_COMPARED,
    'calldata-not-readable': EVERY_ELEMENT_COMPARED,
    'pinned-state-unavailable': EVERY_ELEMENT_COMPARED,
    // A pin is graded as equality, so the row states that requirement rather
    // than the ordering sentence the unpinned statuses carry.
    'matches-pin': VERSION_MATCHES_PIN,
    'pinned-mismatch': VERSION_MATCHES_PIN,
    'expected-version-unresolved': EVERY_ELEMENT_COMPARED,
  }

  it('states a requirement for every status, not a diagnosis', () => {
    for (const status of ALL_STATUSES) {
      const sentence = EXPECTED_SENTENCE[status]
      if (sentence === VERSION_PAIR) continue

      const { expected } = targetStateCheckResult(
        verdictOf([finding(status)]),
        'mainnet'
      )

      expect({ status, expected }).toEqual({ status, expected: sentence })
    }
  })

  // The gate's whole question is which of two versions is newer, so the row a
  // signer reads has to carry both of them — a requirement sentence under
  // "expected" and a status name under "observed" leave them to hunt for the
  // numbers in the detail line.
  //
  // Each side names where it was read, spelled out here rather than imported:
  // an assertion built from the constant it checks moves with any edit to it,
  // and the one thing this row must never do is let the two provenances swap.
  it('prints the two versions for a row that compared one element', () => {
    for (const status of ALL_STATUSES) {
      if (EXPECTED_SENTENCE[status] !== VERSION_PAIR) continue

      const result = targetStateCheckResult(
        verdictOf([
          finding(status, { mainVersion: '1.0.1', proposedVersion: '1.0.0' }),
        ]),
        'mainnet'
      )

      // Asserted as a pair, and keyed by the finding's status so a failure names
      // it: asserting only `expected` stays green when both sides print what
      // `origin/main` declares.
      expect({
        status,
        expected: result.expected,
        actual: result.actual,
      }).toEqual({
        status,
        expected: 'v1.0.1 (from the target state on origin/main)',
        actual: 'v1.0.0 (from the deployment record)',
      })

      // The pair displaced the element's name from `actual`, so the row's own
      // detail has to carry it: the run-wide ledger and the proposal card print
      // a row without its findings beside it.
      expect(result.detail).toContain('AcrossFacet')
    }
  })

  // One row covers the whole network, so a version printed on it is a claim
  // about every element the cut installs. Two facets cannot share one.
  it('falls back to the requirement when a second element was graded', () => {
    const result = targetStateCheckResult(
      verdictOf([
        finding('downgrade', {
          mainVersion: '1.0.1',
          proposedVersion: '1.0.0',
        }),
        finding('contract-unidentified'),
      ]),
      'mainnet'
    )

    expect(result.expected).toBe(ORDERING_HOLDS)
    expect(result.actual).toContain('CONTRACT UNIDENTIFIED')
    expect(result.actual).not.toMatch(/: [a-z]+-[a-z]+/u)
    expect(result.actual).toContain('DOWNGRADE')
  })

  // The allow-list, not the two fields: a finding pushed from `blank` carries no
  // version today, so only a row that never compared but arrives carrying one
  // can tell whether the pair is gated on the comparison or on the fields.
  it('prints no pair for a status that never reached the comparison', () => {
    const { expected, actual } = targetStateCheckResult(
      verdictOf([
        finding('deployment-record-ambiguous', {
          mainVersion: '1.0.1',
          proposedVersion: '1.0.0',
        }),
      ]),
      'mainnet'
    )

    expect(expected).toBe(EVERY_ELEMENT_COMPARED)
    expect(actual).toContain('DEPLOYMENT RECORD AMBIGUOUS')
  })

  // Both versions resolved, so the field test alone would print them — but they
  // were never ordered, and two versions side by side read as a comparison.
  it('keeps the status name when the two versions were not ordered', () => {
    const { expected, actual } = targetStateCheckResult(
      verdictOf([
        finding('version-not-comparable', {
          mainVersion: '1.0.0',
          proposedVersion: '1.0',
        }),
      ]),
      'mainnet'
    )

    expect(expected).toBe(ORDERING_HOLDS)
    expect(actual).toContain('UNEXPECTED VERSION')
  })

  // The version the record carries is the one side the proposer writes. A row
  // that has only that side has compared nothing, and printing it under
  // "expected" would dress the proposer's own number as the anchor's.
  it('states the requirement when only one side resolved', () => {
    const { expected, actual } = targetStateCheckResult(
      verdictOf([
        finding('not-previously-targeted', { proposedVersion: '1.0.0' }),
      ]),
      'mainnet'
    )

    expect(expected).toBe(ORDERING_HOLDS)
    expect(actual).toContain('NOT PREVIOUSLY TARGETED')
  })

  // The canonical rollout cut: add a new facet and replace a live one in the
  // same proposal. Both are `needs-ack`, so they tie and the reduction keeps
  // whichever calldata listed first — the row must read the same either way,
  // or its truth depends on element order.
  it('reads the same whichever tied finding calldata listed first', () => {
    const newFirst = targetStateCheckResult(
      verdictOf([finding('not-previously-targeted'), finding('matches-main')]),
      'mainnet'
    )
    const newSecond = targetStateCheckResult(
      verdictOf([finding('matches-main'), finding('not-previously-targeted')]),
      'mainnet'
    )

    expect(newFirst.expected).toBe(ORDERING_HOLDS)
    expect(newSecond.expected).toBe(ORDERING_HOLDS)
  })

  it('moves expected with the finding that decided the row', () => {
    // `removal` alone claims nothing to compare; the downgrade outranks it and
    // the row must then stand on the ordering that actually failed. A removal
    // graded nothing, so it does not cost the row its version pair either.
    const { expected, actual } = targetStateCheckResult(
      verdictOf([
        finding('removal'),
        finding('downgrade', {
          mainVersion: '1.0.1',
          proposedVersion: '1.0.0',
        }),
      ]),
      'mainnet'
    )

    expect(expected).toBe('v1.0.1 (from the target state on origin/main)')
    expect(actual).toBe('v1.0.0 (from the deployment record)')
  })

  it('lets the worst finding decide the row, and reports its anchor', () => {
    const result = targetStateCheckResult(
      verdictOf([
        finding('removal'),
        finding('downgrade', { contractName: 'GenericSwapFacetV3' }),
        finding('contract-unidentified'),
      ]),
      'mainnet'
    )

    expect(result.status).toBe('fail')
    expect(result.anchor).toBe('A-MONGO')
    expect(result.actual).toContain('GenericSwapFacetV3')
    // A passing finding must not pad the row into looking mostly fine.
    expect(result.actual).not.toContain('removal')
  })

  // An acknowledgement has a human path and an unverified check has none, so a
  // row reduced from both must carry the one nobody can wave through: ranking
  // them the other way lets the common path mask an error.
  it('lets an unverifiable finding outrank one awaiting acknowledgement', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('matches-main'), finding('contract-unidentified')]),
      'mainnet'
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-MONGO')
  })

  // Seven of the thirteen statuses are pushed from `blank` and carry no name,
  // so the row has to fall back to the address — and for the two that have
  // neither, to a placeholder. An `actual` reading `null: calldata-not-readable`
  // is what this catches.
  it('names an unnamed element by address, and a nameless one at all', () => {
    const byAddress = targetStateCheckResult(
      verdictOf([finding('deployment-record-ambiguous')]),
      'mainnet'
    )
    expect(byAddress.actual).toContain(FACET)
    expect(byAddress.actual).not.toContain('null')

    const nameless = targetStateCheckResult(
      verdictOf([finding('calldata-not-readable')]),
      'mainnet'
    )
    expect(nameless.actual).toContain('unnamed element')
    expect(nameless.actual).not.toContain('null')
  })

  it('refuses to call an empty verdict a pass', () => {
    const result = targetStateCheckResult(
      { findings: [], cleared: true },
      'mainnet'
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
  })

  // Cross-checks this mapping against the module that produced the verdict: the
  // two encode "may proceed" separately, and a drift between them would either
  // block a clean proposal or, worse, green a blocked one.
  it('agrees with the verdict’s own cleared flag on every status', () => {
    for (const status of ALL_STATUSES) {
      const verdict = verdictOf([finding(status)])
      const result = targetStateCheckResult(verdict, 'mainnet')

      // A cleared proposal may still be unproven — the record-derived statuses
      // ask for an acknowledgement rather than claiming an anchor they do not
      // have — but nothing about it may block.
      if (verdict.cleared)
        expect(['pass', 'needs-ack', 'not-applicable']).toContain(result.status)
      // …and one that did not clear must never arrive as something a signer can
      // wave through, or as a pass.
      else expect(['fail', 'error']).toContain(result.status)
    }
  })
})

describe('worstResultPerCheck', () => {
  const resultWith = (
    status: 'pass' | 'fail' | 'error' | 'needs-ack' | 'not-applicable',
    anchor: 'A-LOCAL' | 'A-MAIN' | 'A-MONGO' = 'A-LOCAL'
  ) => ({
    checkId: TARGET_STATE_CHECK_ID,
    network: 'optimism',
    status,
    expected: 'expected',
    actual: `actual for ${status}`,
    anchor,
  })

  // Two proposals on one network are not a retry of each other, but
  // `rollUpChecks` cannot tell them apart, so the caller has to reduce them
  // before recording.
  it('keeps an earlier refusal that a later clean proposal would supersede', () => {
    const reduced = worstResultPerCheck([
      resultWith('error', 'A-MONGO'),
      resultWith('pass'),
    ])

    expect(reduced).toHaveLength(1)
    expect(reduced[0]?.status).toBe('error')
  })

  it('keeps a mismatch ahead of an acknowledgement and of a pass', () => {
    expect(
      worstResultPerCheck([
        resultWith('needs-ack', 'A-MONGO'),
        resultWith('fail', 'A-MAIN'),
        resultWith('pass'),
      ])[0]?.status
    ).toBe('fail')
  })

  it('reduces each check independently rather than across them', () => {
    const other = { ...resultWith('pass'), checkId: 'some-other-check' }
    const reduced = worstResultPerCheck([resultWith('error', 'A-MONGO'), other])

    expect(reduced).toHaveLength(2)
    expect(reduced.find((r) => r.checkId === 'some-other-check')?.status).toBe(
      'pass'
    )
  })

  // The tie-break the reducer's comment documents. Without it the *last*
  // equally-bad proposal wins, so the row the signer was shown silently swaps
  // for a different one carrying different text.
  it('keeps the earlier of two equally bad proposals', () => {
    const reduced = worstResultPerCheck([
      { ...resultWith('error', 'A-MONGO'), actual: 'first proposal' },
      { ...resultWith('error', 'A-MONGO'), actual: 'second proposal' },
    ])

    expect(reduced).toHaveLength(1)
    expect(reduced[0]?.actual).toBe('first proposal')
  })

  // The row the signer sees is one proposal's finding standing for the whole
  // network, so it has to keep saying which proposal that was.
  it('keeps the nonce of the proposal whose finding won', () => {
    const reduced = worstResultPerCheck([
      { ...resultWith('pass'), proposalNonce: '37' },
      { ...resultWith('error', 'A-MONGO'), proposalNonce: '38' },
    ])

    expect(reduced).toHaveLength(1)
    expect(reduced[0]?.proposalNonce).toBe('38')
  })

  it('returns nothing for a network that graded nothing', () => {
    expect(worstResultPerCheck([])).toEqual([])
  })

  // A status `SEVERITY` does not list gets -1 from `indexOf`, which ranks it
  // ahead of `fail` — so dropping the entry is a silent inversion, not a type
  // error. Both orders, because the reducer keeps the row it already holds on a
  // tie and a one-sided case passes against the inverted ranking.
  it('never lets a proposal with nothing to grade displace a finding', () => {
    const skipped = resultWith('not-applicable')

    expect(
      worstResultPerCheck([resultWith('fail', 'A-MAIN'), skipped])[0]?.status
    ).toBe('fail')
    expect(
      worstResultPerCheck([skipped, resultWith('fail', 'A-MAIN')])[0]?.status
    ).toBe('fail')
    expect(
      worstResultPerCheck([skipped, resultWith('error', 'A-MONGO')])[0]?.status
    ).toBe('error')
    // Paired present: with nothing beside it, the skipped row is still the row.
    expect(worstResultPerCheck([skipped])[0]?.status).toBe('not-applicable')
  })
})

describe('the registry is usable by the ledger it feeds', () => {
  it('registers and records without the ledger rejecting a row', () => {
    const stored = recordCheck(
      ledgerWith(['mainnet', 'arbitrum']),
      targetStateCheckResult(verdictOf([finding('removal')]), 'mainnet')
    )

    expect(stored.checkId).toBe(TARGET_STATE_CHECK_ID)
    // Not a pass: a removal installs nothing, so no version was compared and
    // the row must not reach the verified numerator.
    expect(stored.status).toBe('not-applicable')
    expect(stored.actual).toBe(NOTHING_INSTALLED_TO_COMPARE)
  })

  // recordCheck coerces a pass on a reporting-only anchor to error. Proven
  // here rather than assumed, because it is the backstop the mapping leans on.
  it('has its reporting-only rows coerced by the ledger, not by itself', () => {
    const stored = recordCheck(ledgerWith(), {
      ...targetStateCheckResult(verdictOf([finding('removal')]), 'mainnet'),
      anchor: 'A-MONGO',
      status: 'pass',
    })

    expect(stored.status).toBe('error')
  })

  // The target-state check is registered `semantic`, so the ledger leaves an
  // acknowledgement standing. Under `integrity` it would coerce to `fail`, and
  // every first deployment would hard-block.
  it('keeps an acknowledgement acknowledgeable rather than coercing it', () => {
    const stored = recordCheck(
      ledgerWith(),
      targetStateCheckResult(
        verdictOf([finding('not-previously-targeted', { mainVersion: null })]),
        'mainnet'
      )
    )

    expect(stored.status).toBe('needs-ack')
    expect(stored.anchor).toBe('A-MONGO')
  })

  // End of the escalated finding: a first deployment must never reduce to a
  // verified run on an anchor that decided nothing. Asserted through the
  // renderer, which EXSC-994 decides whether to put in front of a signer.
  it('does not render a first deployment as a verified run', () => {
    const ledger = targetStateLedger()
    recordCheck(
      ledger,
      targetStateCheckResult(
        verdictOf([finding('not-previously-targeted')]),
        'mainnet'
      )
    )

    const verdict = stripColor(closingVerdict(renderCheckLedger(ledger)))

    expect(verdict).toContain('ACKNOWLEDGEMENT REQUIRED')
    expect(verdict).not.toContain('ALL CHECKS GREEN')
  })
})

describe('storageAuthorityCheckResult', () => {
  const DIAMOND = '0x0000000000000000000000000000000000000d1a'
  const TIMELOCK = '0x00000000000000000000000000000000000000a1'
  const PAUSER = '0x00000000000000000000000000000000000000b2'
  const ATTACKER = '0x00000000000000000000000000000000000000ee'

  const entry = (
    overrides: Partial<IPreBroadcastAuthority> = {}
  ): IPreBroadcastAuthority => ({
    label: 'LiFiDiamond.pauserWallet()',
    contractAddress: DIAMOND,
    liveValue: PAUSER,
    expectedValue: PAUSER,
    expectationSource: 'globalConfig',
    readError: undefined,
    ...overrides,
  })

  const resultFor = (entries: IPreBroadcastAuthority[]) =>
    storageAuthorityCheckResult(
      entries,
      'mainnet',
      authorityExpectationAnchors(entries)
    )

  it('passes on A-LOCAL when the expectation comes from a repo file', () => {
    const result = resultFor([entry()])
    expect(result.status).toBe('pass')
    expect(result.anchor).toBe('A-LOCAL')
    expect(result.checkId).toBe(STORAGE_AUTHORITY_CHECK_ID)
  })

  it('fails when the live value is not what main declares', () => {
    const result = resultFor([entry({ liveValue: ATTACKER })])
    expect(result.status).toBe('fail')
    expect(result.actual).toContain(ATTACKER)
    expect(result.actual).toContain(PAUSER)
  })

  it('errors, rather than passing, on a value it could not read', () => {
    const result = resultFor([
      entry({ liveValue: undefined, readError: 'node unreachable' }),
    ])
    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
    expect(result.actual).toContain('NOT READ')
  })

  it('errors when main declares nothing to judge the live value against', () => {
    const result = resultFor([entry({ expectedValue: undefined })])
    expect(result.status).toBe('error')
  })

  describe('an expectation the proposer writes may report but not decide', () => {
    it('anchors a deployment-record expectation on A-MONGO even when it matches', () => {
      const result = resultFor([
        entry({
          label: 'LiFiDiamond.owner()',
          liveValue: TIMELOCK,
          expectedValue: TIMELOCK,
          expectationSource: 'deployments',
        }),
      ])
      // A match the proposer supplied one side of is something the signer
      // answers, not something the run may claim: every diamond cut carries
      // `LiFiDiamond.owner`, so grading this a refusal would block every honest
      // proposal and grading it a pass would verify the proposer's own word.
      expect(result.status).toBe('needs-ack')
      expect(result.anchor).toBe('A-MONGO')
    })

    it('takes the weaker anchor when one of two expectations is proposer-written', () => {
      const result = resultFor([
        entry(),
        entry({
          label: 'LiFiDiamond.owner()',
          liveValue: TIMELOCK,
          expectedValue: TIMELOCK,
          expectationSource: 'deployments',
        }),
      ])
      expect(result.anchor).toBe('A-MONGO')
    })

    it('is coerced away from a green by the ledger itself', () => {
      // The point of the anchor: recordCheck refuses a pass claimed on an
      // anchor the proposer controls, so this row cannot grade the run green
      // on a value the proposer supplied one side of.
      const ledger = createCheckLedger({
        checks: [...CONFIRM_CHECK_DEFINITIONS],
        expectedNetworks: ['mainnet'],
      })
      recordCheck(
        ledger,
        resultFor([
          entry({
            label: 'LiFiDiamond.owner()',
            liveValue: TIMELOCK,
            expectedValue: TIMELOCK,
            expectationSource: 'deployments',
          }),
        ])
      )
      const rendered = renderCheckLedger(ledger)
      expect(JSON.stringify(rendered)).not.toContain('"status":"pass"')
    })
  })

  // A proposal that installs nothing — a cut that only removes, a setter on a
  // contract already live — has no constructor-written storage to assert, which
  // is the only thing R2.6 put this gate here for. Not-applicable rather than a
  // pass: nothing was checked, so it must satisfy no verified counter.
  it('is not applicable when the proposal installs nothing', () => {
    const result = resultFor([])
    expect(result.status).toBe('not-applicable')
    expect(result.anchor).toBe('A-LOCAL')
    expect(result.actual).toContain('installs no contract')
  })

  it('does not block a run on a proposal that installs nothing', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({ storageAuthority: { entries: [], anchors: new Map() } })
    )

    const row = ledger.results.find(
      (result) => result.checkId === STORAGE_AUTHORITY_CHECK_ID
    )
    expect(row?.status).toBe('not-applicable')
    expect(summariseLedger(ledger).hardBlocked).toBe(false)
  })

  // The pairing that keeps the relaxation above honest: an empty set means
  // "installs nothing" only when the calldata was read all the way through.
  it('blocks when the calldata that says what is installed would not decode', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        storageAuthority: {
          entries: [],
          anchors: new Map(),
          scopeUnreadable: ['call[0]'],
        },
      })
    )

    const row = ledger.results.find(
      (result) => result.checkId === STORAGE_AUTHORITY_CHECK_ID
    )
    expect(row?.status).toBe('error')
    expect(row?.actual).toContain('call[0]')
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })

  it('lets a mismatch decide over a failed read in the same set', () => {
    const result = resultFor([
      entry({ liveValue: undefined, readError: 'node unreachable' }),
      entry({ label: 'LiFiDiamond.owner()', liveValue: ATTACKER }),
    ])
    expect(result.status).toBe('fail')
    // Both are still named, so the read failure is not hidden by the mismatch.
    expect(result.actual).toContain('NOT READ')
    expect(result.actual).toContain(ATTACKER)
  })
})

describe('authorityExpectationAnchors', () => {
  it('maps the global config to a deciding anchor and the record to a reporting one', () => {
    const anchors = authorityExpectationAnchors([
      {
        label: 'a',
        contractAddress: '0x0000000000000000000000000000000000000d1a',
        liveValue: '0x1',
        expectedValue: '0x1',
        expectationSource: 'globalConfig',
        readError: undefined,
      },
      {
        label: 'b',
        contractAddress: '0x0000000000000000000000000000000000000d1a',
        liveValue: '0x1',
        expectedValue: '0x1',
        expectationSource: 'deployments',
        readError: undefined,
      },
    ])
    expect(anchors.get('a')).toBe('A-LOCAL')
    expect(anchors.get('b')).toBe('A-MONGO')
  })
})

const NETWORK = 'arbitrum'

// `no-diamond-cut` rather than `matches-main`: a version that matches origin/main
// is graded from the deployment record and is an acknowledgement, so using it here
// would make every assertion about the gates this PR adds fail on someone else's row.
const cleanTargetState: ITargetStateVerdict = {
  findings: [finding('no-diamond-cut')],
} as ITargetStateVerdict

const executabilityVerdict = (
  overrides: Partial<IExecutabilityVerdict> = {}
): IExecutabilityVerdict => ({
  refuses: false,
  error: false,
  findings: [],
  errors: [],
  warnings: [],
  notSimulated: [],
  calls: [],
  reason: '',
  ...overrides,
})

const quorumVerdict = (
  overrides: Partial<IRpcQuorumVerdict> = {}
): IRpcQuorumVerdict => ({
  status: 'agreed',
  reachesQuorum: true,
  quorum: 2,
  agreeingProviders: 2,
  largestAgreeingGroup: 2,
  respondingProviders: 2,
  independentProviders: 2,
  endpointsConsulted: 2,
  transient: false,
  detail: 'two providers agreed',
  perProvider: [],
  ...overrides,
})

/**
 * An integrity run whose ledger already holds one row per always-on check.
 * Built through the real ledger so the mirrored rows are the coerced ones a
 * real run would carry, not hand-written approximations of them.
 */
const integrityRun = (
  options: {
    includeTimelockDelay?: boolean
    status?: CheckStatus
    /** Registered but never reported, i.e. an assertion that did not finish. */
    registerWithoutRecording?: string
  } = {}
): IIntegrityAssertRun => {
  const registered = [
    ...INTEGRITY_CHECKS_ALWAYS,
    ...(options.includeTimelockDelay ? [CHECK_TIMELOCK_DELAY] : []),
  ]
  const ledger = createCheckLedger({
    expectedNetworks: [NETWORK],
    checks: registered.map((checkId) => {
      const definition = INTEGRITY_CHECK_DEFINITIONS[checkId]
      if (!definition) throw new Error(`no definition for ${checkId}`)
      return definition
    }),
  })
  for (const checkId of registered)
    if (checkId !== options.registerWithoutRecording)
      recordCheck(ledger, {
        checkId,
        network: NETWORK,
        status: options.status ?? 'pass',
        expected: 'the anchor value',
        actual: 'the observed value',
        anchor: 'A-CHAIN',
      })

  return {
    ledger,
    verdict: summariseLedger(ledger),
    registered,
    gradedKey: 'graded-key',
  }
}

const runLedger = () =>
  createCheckLedger({
    expectedNetworks: [NETWORK],
    checks: [...CONFIRM_CHECK_DEFINITIONS],
  })

/**
 * A storage-authority read that matched, sourced from `config/global.json`.
 *
 * Named `A-LOCAL` rather than left to default: a repo file the proposer's
 * branch cannot change without review is the only anchor gate G may pass on,
 * so a fixture anchored anywhere else would grade these tests on a weaker
 * expectation than the CLI uses.
 */
const cleanAuthorities = (): {
  entries: readonly ISignedAuthorityEntry[]
  anchors: ReadonlyMap<string, ICheckResult['anchor']>
} => ({
  entries: [
    {
      label: 'LiFiDiamond.pauserWallet()',
      liveValue: '0x00000000000000000000000000000000000000b2',
      expectedValue: '0x00000000000000000000000000000000000000b2',
      readError: undefined,
    },
  ],
  anchors: new Map([['LiFiDiamond.pauserWallet()', 'A-LOCAL' as const]]),
})

/**
 * A codehash gate that judged one installed address and found it attested.
 *
 * The default is a gate that *graded* something, so a test that does not
 * mention gate K still exercises the branch where it reports a real
 * comparison. A fixture defaulting to "nothing to check" would make every one
 * of these cases agree with a gate that had been skipped entirely.
 */
const codehashGate = (
  overrides: Partial<ICodehashSignGate> = {}
): ICodehashSignGate => ({
  blocksSigning: false,
  evaluated: true,
  refusals: [],
  targets: [
    {
      address: '0x00000000000000000000000000000000000000f1',
      verdict: 'MATCH',
      reason: 'bytecode reproduced from an attested build',
      matchedLineages: ['lineage-1'],
      excludedByteCount: 0,
      pricedByteCount: 0,
      immutables: { status: 'none', detail: 'declares no immutables' },
    },
  ],
  summary: 'every target matched',
  ...overrides,
})

const verdicts = (
  overrides: Partial<IProposalCheckVerdicts> = {}
): IProposalCheckVerdicts => ({
  network: NETWORK,
  integrity: integrityRun({ includeTimelockDelay: true }),
  codehash: codehashGate(),
  targetState: cleanTargetState,
  executability: executabilityVerdict(),
  rpcQuorum: quorumVerdict(),
  storageAuthority: cleanAuthorities(),
  ...overrides,
})

/**
 * Records one network's rows the way the CLI does: produce per proposal, reduce
 * worst-first across the network's proposals, then record. Going through the
 * same reducer keeps these tests honest about the shape the call site uses.
 */
const recordInto = (
  ledger: ICheckLedger,
  ...proposals: IProposalCheckVerdicts[]
): void => {
  const rows = proposals.flatMap((verdict) => proposalCheckResults(verdict))
  for (const row of worstResultPerCheck(rows)) recordCheck(ledger, row)
}

describe('authorityExpectationAnchors', () => {
  const row = (
    label: string,
    expectationSource: IPreBroadcastAuthority['expectationSource']
  ): IPreBroadcastAuthority => ({
    label,
    contractAddress: '0x00000000000000000000000000000000000000aa',
    liveValue: undefined,
    expectedValue: undefined,
    expectationSource,
    readError: undefined,
  })

  it('separates the sources that may decide from the one that may only report', () => {
    const anchors = authorityExpectationAnchors([
      row('FeeCollector.owner', 'globalConfig'),
      row('FeeCollector.pendingOwner', 'zeroAddress'),
      row('LiFiDiamond.owner', 'deployments'),
    ])

    expect(anchors.get('FeeCollector.owner')).toBe('A-LOCAL')
    expect(anchors.get('FeeCollector.pendingOwner')).toBe('A-LOCAL')
    expect(anchors.get('LiFiDiamond.owner')).toBe('A-MONGO')
  })
})

describe('proposalCheckResults', () => {
  it('records every registered check, so none is counted missing', () => {
    const ledger = runLedger()
    recordInto(ledger, verdicts())

    const recorded = new Set(ledger.results.map((result) => result.checkId))
    for (const definition of CONFIRM_CHECK_DEFINITIONS)
      expect(recorded).toContain(definition.checkId)

    expect(summariseLedger(ledger).totals.missing).toBe(0)
  })

  // The report's order is the order the rows were recorded in, so it is pinned
  // here against the recorded sequence rather than against where the calls sit
  // in the CLI's source.
  it('records the checks in the order a signer reads them', () => {
    const ledger = runLedger()
    recordInto(ledger, verdicts())

    expect(ledger.results.map((result) => result.checkId)).toEqual([
      ...INTEGRITY_CHECKS_ALWAYS,
      CHECK_TIMELOCK_DELAY,
      CODEHASH_CHECK_ID,
      IMMUTABLES_CHECK_ID,
      STORAGE_AUTHORITY_CHECK_ID,
      TARGET_STATE_CHECK_ID,
      EXECUTABILITY_CHECK_ID,
      RPC_QUORUM_CHECK_ID,
    ])
  })

  // The bundle `confirm-safe-tx.ts` falls back to when a proposal's chain reads
  // throw — the background prefetch's failure path included. Every verdict
  // absent, and the codehash gate blocking with the reason on it.
  it('a proposal whose reads all failed owes every row, and blocks', () => {
    const ledger = runLedger()
    const why = 'the proposal’s chain reads could not be made — rpc exploded'
    recordInto(
      ledger,
      verdicts({
        integrity: undefined,
        codehash: {
          ...codehashGate(),
          evaluated: true,
          blocksSigning: true,
          refusals: [why],
          summary: why,
        },
        executability: undefined,
        rpcQuorum: undefined,
        storageAuthority: undefined,
      })
    )

    const recorded = new Set(ledger.results.map((result) => result.checkId))
    for (const definition of CONFIRM_CHECK_DEFINITIONS)
      expect(recorded).toContain(definition.checkId)

    // The point of the fallback: a read that failed is a row that could not be
    // made, never a row nobody asked for. An absent row rolls up as a check the
    // run was never owed, which is how a failed prefetch would go unnoticed.
    const verdict = summariseLedger(ledger)
    expect(verdict.totals.missing).toBe(0)
    expect(verdict.hardBlocked).toBe(true)
  })

  it('a clean proposal clears the ledger', () => {
    const ledger = runLedger()
    recordInto(ledger, verdicts())

    const verdict = summariseLedger(ledger)
    expect(verdict.hardBlocked).toBe(false)
    expect(verdict.requiresAcknowledgement).toHaveLength(0)
  })
})

describe('integrity verdicts reaching the run-level ledger', () => {
  it('a failing integrity assertion hard-blocks the run ledger', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        integrity: integrityRun({
          includeTimelockDelay: true,
          status: 'fail',
        }),
      })
    )

    const verdict = summariseLedger(ledger)
    expect(verdict.hardBlocked).toBe(true)
    // Integrity has no acknowledgement path, so the row must block rather than
    // land in the acknowledgeable pile.
    expect(
      verdict.blocking.some(
        (entry) => entry.checkId === INTEGRITY_CHECKS_ALWAYS[0]
      )
    ).toBe(true)
  })

  it('assertions that never ran are unverified, never absent', () => {
    const ledger = runLedger()
    recordInto(ledger, verdicts({ integrity: undefined }))

    const verdict = summariseLedger(ledger)
    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.totals.missing).toBe(0)
    for (const checkId of INTEGRITY_CHECKS_ALWAYS)
      expect(
        ledger.results.find((result) => result.checkId === checkId)?.status
      ).toBe('error')
  })

  // A check with nothing to judge that *read* its evidence stands down on the
  // anchor it read; one that could not open the envelope errors. The delay
  // check is the former, and `run.registered` is the only thing that says
  // which it is.
  it('a proposal carrying no schedule makes the delay check not applicable', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({ integrity: integrityRun({ includeTimelockDelay: false }) })
    )

    const row = ledger.results.find(
      (result) => result.checkId === CHECK_TIMELOCK_DELAY
    )
    expect(row?.status).toBe('not-applicable')
    expect(row?.anchor).toBe('A-LOCAL')
    expect(row?.actual).toBe(NO_TIMELOCK_SCHEDULE)
    expect(summariseLedger(ledger).hardBlocked).toBe(false)

    // Paired present: standing down must cost the verified count, or it is a
    // pass wearing a different word.
    const rollup = rollUpChecks(ledger).find(
      (entry) => entry.checkId === CHECK_TIMELOCK_DELAY
    )
    expect(rollup?.graded).toBe(0)
    expect(rollup?.passed).toBe(0)
    expect(rollup?.green).toBe(false)
  })

  it('a registered delay check that never reported errors instead', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        integrity: integrityRun({
          includeTimelockDelay: true,
          registerWithoutRecording: CHECK_TIMELOCK_DELAY,
        }),
      })
    )

    const row = ledger.results.find(
      (result) => result.checkId === CHECK_TIMELOCK_DELAY
    )
    expect(row?.status).toBe('error')
    expect(row?.anchor).toBe('A-UNRESOLVED')
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })
})

describe('executabilityCheckResult', () => {
  it('grades a clean simulation a pass on the chain it read', () => {
    const result = executabilityCheckResult(executabilityVerdict(), NETWORK)
    expect(result.status).toBe('pass')
    expect(result.anchor).toBe('A-CHAIN')
  })

  it('passes a payload with no revert model that simulated clean, and says so', () => {
    // The model predicts a revert from the calldata; it is not what establishes
    // one. This payload's target was read for code and its eth_call came back
    // clean from the account that will send it, which is the whole question
    // this gate asks — so it passes, on a row that still says what it rested on.
    const result = executabilityCheckResult(
      executabilityVerdict({ notSimulated: ['call[0].scheduled[0]'] }),
      NETWORK
    )

    expect(result.status).toBe('pass')
    expect(result.anchor).toBe('A-CHAIN')
    expect(result.actual).toContain('a clean eth_call alone')
  })

  // The other direction of the same change: relaxing the grade must not turn a
  // payload nothing observed into a pass. Each of these arrives with an empty
  // `notSimulated`, so none of them is caught by the branch above.
  it.each([
    [
      'an eth_call that was never attempted',
      ['No payload in this proposal was simulated with eth_call'],
    ],
    [
      'a payload with no eth_call result',
      ['call[0].scheduled[1] has no eth_call result'],
    ],
    [
      'a call that could not be read through',
      ['call[0] could not be read all the way through'],
    ],
  ])('still refuses to pass %s', (_case, errors) => {
    const result = executabilityCheckResult(
      executabilityVerdict({ error: true, errors }),
      NETWORK
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
  })

  it('still refuses a target that holds no code, model or not', () => {
    const result = executabilityCheckResult(
      executabilityVerdict({
        refuses: true,
        notSimulated: ['call[0].scheduled[0]'],
        reason: 'call[0].scheduled[0] targets 0xbeef, which holds no code',
      }),
      NETWORK
    )

    expect(result.status).toBe('fail')
  })

  it('grades a proposal that would revert a mismatch', () => {
    const result = executabilityCheckResult(
      executabilityVerdict({ refuses: true, reason: 'FunctionAlreadyExists' }),
      NETWORK
    )
    expect(result.status).toBe('fail')
    expect(result.anchor).toBe('A-CHAIN')
  })

  // A simulation that could not be made has not established that the proposal
  // reverts, so it must not reach the ledger wearing a mismatch.
  it('grades a simulation that could not be made unverified, not a mismatch', () => {
    const result = executabilityCheckResult(
      executabilityVerdict({
        error: true,
        refuses: true,
        errors: ['chain state could not be read'],
      }),
      NETWORK
    )
    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
  })

  it('an unverified simulation blocks the run', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        executability: executabilityVerdict({
          error: true,
          errors: ['no payload was simulated with eth_call'],
        }),
      })
    )
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })

  it('a simulation that was never attempted is unverified', () => {
    const ledger = runLedger()
    recordInto(ledger, verdicts({ executability: undefined }))

    const row = ledger.results.find(
      (result) => result.checkId === EXECUTABILITY_CHECK_ID
    )
    expect(row?.status).toBe('error')
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })
})

describe('rpcQuorumCheckResult', () => {
  it('grades agreement across independent providers a pass on A-CHAIN', () => {
    const result = rpcQuorumCheckResult(quorumVerdict(), NETWORK)
    expect(result.status).toBe('pass')
    expect(result.anchor).toBe('A-CHAIN')
  })

  // Report-only: the fleet still has single-endpoint production chains, and
  // enforcing the quorum there would turn missing redundancy into a refusal.
  it('never records a mismatch, whatever the shortfall', () => {
    const shortfalls: TQuorumStatus[] = [
      'agreed-absent',
      'disagreement',
      'fork-divergence',
      'heights-not-aligned',
      'insufficient-providers',
      'insufficient-responses',
      'no-responses',
      'provider-identity-unverifiable',
      'quorum-misconfigured',
    ]

    for (const status of shortfalls) {
      const result = rpcQuorumCheckResult(
        quorumVerdict({ status, reachesQuorum: false, agreeingProviders: 0 }),
        NETWORK
      )
      expect(result.status).toBe('needs-ack')
      expect(result.status).not.toBe('fail')
    }
  })

  it('a single-endpoint network is acknowledgeable, never a hard block', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        rpcQuorum: quorumVerdict({
          status: 'insufficient-providers',
          reachesQuorum: false,
          agreeingProviders: 0,
          independentProviders: 1,
        }),
      })
    )

    const verdict = summariseLedger(ledger)
    expect(verdict.hardBlocked).toBe(false)
    expect(
      verdict.requiresAcknowledgement.map((result) => result.checkId)
    ).toContain(RPC_QUORUM_CHECK_ID)
  })

  it('an unmade quorum read is acknowledgeable, never a hard block', () => {
    const ledger = runLedger()
    recordInto(ledger, verdicts({ rpcQuorum: undefined }))

    expect(summariseLedger(ledger).hardBlocked).toBe(false)
  })
})

describe('a chain the simulator does not cover', () => {
  // The Tron path. Distinct from a simulation that failed on a chain the
  // simulator does cover: a declared limit is acknowledgeable, an unmade read
  // is not, and grading them the same way would either block every Tron
  // rollout or let a failed EVM read pass as reviewed.
  it('is acknowledgeable rather than unverified', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        executability: undefined,
        executabilityOutOfScope: 'tron runs through its own chain executor',
      })
    )

    const row = ledger.results.find(
      (result) => result.checkId === EXECUTABILITY_CHECK_ID
    )
    expect(row?.status).toBe('needs-ack')
    expect(row?.actual).toContain('tron')

    const verdict = summariseLedger(ledger)
    expect(verdict.hardBlocked).toBe(false)
    expect(
      verdict.requiresAcknowledgement.map((result) => result.checkId)
    ).toContain(EXECUTABILITY_CHECK_ID)
  })

  // The scope note must never rescue a simulation that genuinely ran and
  // could not decide — that one is unverified and blocks.
  it('does not soften a simulation that ran and errored', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        executability: executabilityVerdict({
          error: true,
          errors: ['chain state could not be read'],
        }),
        executabilityOutOfScope: 'tron runs through its own chain executor',
      })
    )

    expect(
      ledger.results.find((result) => result.checkId === EXECUTABILITY_CHECK_ID)
        ?.status
    ).toBe('error')
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })
})

describe('gate G when no storage-authority read was made', () => {
  const rowOf = (ledger: ICheckLedger) =>
    ledger.results.find(
      (result) => result.checkId === STORAGE_AUTHORITY_CHECK_ID
    )

  // The Tron path: a chain the gate was never written to read is a declared
  // limit the signer acknowledges, not an infrastructure failure that blocks.
  it('acknowledges a chain outside its coverage, naming it', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        storageAuthority: undefined,
        storageAuthorityAbsence: {
          kind: 'out-of-scope',
          reason:
            'tron is read through TronWeb, which this gate does not carry',
          installs: true,
        },
      })
    )

    const row = rowOf(ledger)
    expect(row?.status).toBe('needs-ack')
    expect(row?.anchor).toBe('A-DOCUMENTED')
    expect(row?.actual).toContain('tron')

    const verdict = summariseLedger(ledger)
    expect(verdict.hardBlocked).toBe(false)
    expect(
      verdict.requiresAcknowledgement.map((result) => result.checkId)
    ).toContain(STORAGE_AUTHORITY_CHECK_ID)
  })

  // A removal-only or otherwise non-installing proposal on an uncovered chain
  // has no authority to read, on that chain or any other.
  it('is not applicable on an uncovered chain when the proposal installs nothing', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        storageAuthority: undefined,
        storageAuthorityAbsence: {
          kind: 'out-of-scope',
          reason: 'tron is not read',
          installs: false,
        },
      })
    )
    const row = rowOf(ledger)
    expect(row?.status).toBe('not-applicable')
    expect(row?.actual).toContain('installs no contract')
  })

  // A read that should have happened and did not is unverified and blocks,
  // and the row says what failed rather than that nothing was attempted.
  it('blocks on a failed read, carrying the failure', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        storageAuthority: undefined,
        storageAuthorityAbsence: {
          kind: 'read-failed',
          reason: 'node unreachable at block 12',
        },
      })
    )

    const row = rowOf(ledger)
    expect(row?.status).toBe('error')
    expect(row?.actual).toContain('could not be read')
    expect(row?.actual).toContain('node unreachable at block 12')
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })

  // Calldata that schedules no timelock batch gives this gate nothing to
  // read — but only when the codehash gate, which read the same calldata,
  // found nothing installed either. Otherwise something is installed outside
  // the envelope this gate observes, and that is unverified.
  it('is not applicable when the proposal schedules nothing and installs nothing', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        storageAuthority: undefined,
        storageAuthorityAbsence: { kind: 'not-scheduled' },
        codehash: codehashGate({ targets: [], madeNoClaim: true }),
      })
    )

    const row = rowOf(ledger)
    expect(row?.status).toBe('not-applicable')
    expect(row?.actual).toContain('schedules no timelock batch')
    expect(summariseLedger(ledger).hardBlocked).toBe(false)
  })

  it('blocks when the proposal installs code outside a timelock schedule', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        storageAuthority: undefined,
        storageAuthorityAbsence: { kind: 'not-scheduled' },
      })
    )

    const row = rowOf(ledger)
    expect(row?.status).toBe('error')
    expect(row?.actual).toContain('outside a timelock schedule')
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })

  // Empty calldata never reaches the codehash decoder, and a cut it refused was
  // never read to the end: neither says the proposal installs nothing, so
  // neither may stand down.
  it('blocks an unscheduled proposal whose install set the codehash gate never established', () => {
    const rows = [
      codehashGate({ evaluated: false, targets: [] }),
      codehashGate({
        targets: [],
        refusals: ['the cut could not be decoded'],
        blocksSigning: true,
      }),
      codehashGate({ targets: [], madeNoClaim: true, unopened: ['call[0]'] }),
    ].map((codehash) => {
      const ledger = runLedger()
      recordInto(
        ledger,
        verdicts({
          storageAuthority: undefined,
          storageAuthorityAbsence: { kind: 'not-scheduled' },
          codehash,
        })
      )
      return rowOf(ledger)
    })
    for (const row of rows) {
      expect(row?.status).toBe('error')
      expect(row?.actual).toContain('could not be established')
    }
  })

  // The three absences must stay distinguishable from one another and from
  // the silent absence, which keeps its blocking text.
  it('grades the three absences and the silent one as four different rows', () => {
    const rows = [
      {
        kind: 'out-of-scope' as const,
        reason: 'tron is not read',
        installs: true,
      },
      { kind: 'read-failed' as const, reason: 'timeout' },
      { kind: 'not-scheduled' as const },
      undefined,
    ].map((absence) => {
      const ledger = runLedger()
      recordInto(
        ledger,
        verdicts({
          storageAuthority: undefined,
          ...(absence ? { storageAuthorityAbsence: absence } : {}),
          codehash: codehashGate({ targets: [], madeNoClaim: true }),
        })
      )
      const row = rowOf(ledger)
      return `${row?.status}|${row?.actual}`
    })
    expect(new Set(rows).size).toBe(4)
    expect(rows[3]).toContain('no storage-authority read was made')
  })

  // An absence note never overrides a read that was actually made.
  it('does not replace an observation that exists', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        storageAuthorityAbsence: {
          kind: 'out-of-scope',
          reason: 'tron is not read',
          installs: true,
        },
      })
    )
    expect(rowOf(ledger)?.status).toBe('pass')
  })
})

describe('an integrity check the run registered but never reported', () => {
  // A registered check with no row is counted missing and blocks, so the
  // recorder answers for it — as unverified, never as a pass.
  it('is recorded unverified rather than left absent', () => {
    const run = integrityRun({ includeTimelockDelay: true })
    const dropped = INTEGRITY_CHECKS_ALWAYS[1] as string
    const thinned = {
      ...run,
      ledger: {
        ...run.ledger,
        results: run.ledger.results.filter(
          (result) => result.checkId !== dropped
        ),
      },
    }

    const ledger = runLedger()
    recordInto(ledger, verdicts({ integrity: thinned }))

    const row = ledger.results.find((result) => result.checkId === dropped)
    expect(row?.status).toBe('error')
    expect(row?.anchor).toBe('A-UNRESOLVED')
    expect(summariseLedger(ledger).totals.missing).toBe(0)
  })
})

describe('a shortfall the signer can act on', () => {
  // Amber on its own teaches signers to click through. A row that names the
  // command that fixes it is one they can clear instead.
  it('names the remedy when the network has too few endpoints', () => {
    const result = rpcQuorumCheckResult(
      quorumVerdict({
        status: 'insufficient-providers',
        reachesQuorum: false,
        agreeingProviders: 0,
        independentProviders: 1,
        endpointsConsulted: 3,
      }),
      NETWORK
    )

    expect(result.detail).toContain('bun fetch-rpcs')
    // Providers and endpoints are different counts, and the line must not
    // report one as the other: three endpoints behind one provider is still a
    // shortfall, and calling that "1 endpoint" sends the operator nowhere.
    expect(result.detail).toContain('1 independent provider(s)')
    expect(result.detail).toContain('3 configured endpoint(s)')
    expect(result.detail).not.toMatch(/only 1 endpoint\(s\) are configured/u)
    // The action leads and the command follows as its own sentence; the
    // verdict's diagnosis is not repeated ahead of either.
    expect(result.detail).toMatch(/^add a second independent RPC provider/u)
    expect(result.detail).not.toContain('an unopposed answer')
  })

  // A status code is a name for the reader of the source. On the screen the
  // same fact has to be a sentence, or the signer has to go and look it up.
  it('states the shortfall in words, never as a status code', () => {
    const statuses: TQuorumStatus[] = [
      'agreed-absent',
      'disagreement',
      'fork-divergence',
      'heights-not-aligned',
      'insufficient-providers',
      'insufficient-responses',
      'no-responses',
      'provider-identity-unverifiable',
      'quorum-misconfigured',
    ]

    for (const status of statuses) {
      const result = rpcQuorumCheckResult(
        quorumVerdict({
          status,
          reachesQuorum: false,
          agreeingProviders: 0,
          independentProviders: 2,
        }),
        NETWORK
      )

      expect(result.actual).toStartWith('0 of 2 agreed — ')
      expect(result.actual).not.toContain(status)
      expect(result.actual).not.toMatch(/\([a-z-]+\)/u)
    }

    expect(
      rpcQuorumCheckResult(
        quorumVerdict({
          status: 'provider-identity-unverifiable',
          reachesQuorum: false,
          agreeingProviders: 0,
          independentProviders: 0,
        }),
        NETWORK
      ).actual
    ).toBe('0 of 0 agreed — the providers could not be told apart')
  })

  // A disagreement between providers that are all present is a different
  // problem, and pointing it at the endpoint list would misdirect.
  it('does not blame the endpoint list when enough providers answered', () => {
    const result = rpcQuorumCheckResult(
      quorumVerdict({
        status: 'disagreement',
        reachesQuorum: false,
        agreeingProviders: 0,
        independentProviders: 3,
      }),
      NETWORK
    )

    expect(result.detail).not.toContain('bun fetch-rpcs')
  })
})

describe('the verdict the run now closes on', () => {
  // Why the render was withheld: with target-state as the only row, every real
  // Add/Replace cut graded `needs-ack`, so a correct rollout closed
  // `0/N verified` while a run that graded nothing closed green. The rows this
  // registry adds are what make the denominator mean something again.
  it('a clean proposal closes with most rows verified, not none', () => {
    const ledger = runLedger()
    recordInto(ledger, verdicts())

    const rollups = rollUpChecks(ledger)
    const passed = rollups.reduce((sum, rollup) => sum + rollup.passed, 0)

    expect(passed).toBeGreaterThan(rollups.length / 2)
    // Anchored on the whole count, not on `not.toContain('0/N …')`: once N
    // reaches two digits that substring is inside the correct answer, so the
    // assertion would fail on `10/10` — the greenest line it can render. The
    // denominator is the applicable rows, not every registered check: a gate
    // that stood down is not a result the run failed to verify.
    const applicable = rollups.filter((rollup) => rollup.graded > 0)
    const closing = stripColor(closingVerdict(renderCheckLedger(ledger)))
    expect(closing).toContain(
      `${passed}/${applicable.length} network results verified`
    )
  })

  // The other half of that asymmetry: a run that graded nothing must not close
  // greener than one that graded a real cut.
  it('a run whose checks could not be made does not close green', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({ integrity: undefined, executability: undefined })
    )

    const verdict = stripColor(closingVerdict(renderCheckLedger(ledger)))
    expect(verdict).toContain('BLOCKED')
    expect(verdict).not.toContain('ALL CHECKS GREEN')
  })
})

describe('the primitive that makes an unmade check blocking', () => {
  // `unresolved` backs every "this was never established" path. Nothing else
  // pins its status, so flipping it to `pass` — a check nobody made counting as
  // verified — used to leave the whole suite green. Each path is asserted on
  // its own row, so a regression names which one broke.
  const unresolvedPaths: {
    what: string
    verdict: Partial<IProposalCheckVerdicts>
    checkId: string
  }[] = [
    {
      what: 'the integrity assertions never ran',
      verdict: { integrity: undefined },
      checkId: INTEGRITY_CHECKS_ALWAYS[0] as string,
    },
    {
      what: 'the simulation was never attempted',
      verdict: { executability: undefined },
      checkId: EXECUTABILITY_CHECK_ID,
    },
  ]

  for (const { what, verdict, checkId } of unresolvedPaths)
    it(`records ${what} as unverified, and it blocks`, () => {
      const ledger = runLedger()
      recordInto(ledger, verdicts(verdict))

      const row = ledger.results.find((result) => result.checkId === checkId)
      expect(row?.status).toBe('error')
      expect(row?.status).not.toBe('pass')
      expect(row?.anchor).toBe('A-UNRESOLVED')

      // Asserted per row rather than on the run: with several unresolved rows
      // at once, one of them regressing to `pass` leaves the run blocked by the
      // others and the regression invisible.
      const blocking = summariseLedger(ledger).blocking.filter(
        (entry) => entry.checkId === checkId
      )
      expect(blocking).toHaveLength(1)
      expect(blocking[0]?.status).toBe('error')
    })

  // A registered check that reported nothing is the third path, and it is the
  // one a delay assertion that died mid-run takes.
  it('records a registered check that never reported as unverified', () => {
    const run = integrityRun({ includeTimelockDelay: true })
    const thinned = {
      ...run,
      ledger: {
        ...run.ledger,
        results: run.ledger.results.filter(
          (result) => result.checkId !== CHECK_TIMELOCK_DELAY
        ),
      },
    }

    const ledger = runLedger()
    recordInto(ledger, verdicts({ integrity: thinned }))

    const row = ledger.results.find(
      (result) => result.checkId === CHECK_TIMELOCK_DELAY
    )
    expect(row?.status).toBe('error')
    expect(
      summariseLedger(ledger).blocking.some(
        (entry) => entry.checkId === CHECK_TIMELOCK_DELAY
      )
    ).toBe(true)
  })
})

describe('codehashCheckResult', () => {
  const gate = (
    overrides: Partial<ICodehashSignGate> = {}
  ): ICodehashSignGate => codehashGate(overrides)

  it('passes on the attested set when every installed address matched', () => {
    const result = codehashCheckResult(gate(), NETWORK)

    expect(result.status).toBe('pass')
    expect(result.anchor).toBe('A-AUDIT')
  })

  // The two halves of `madeNoClaim`, which is the whole reason `unopened` is
  // carried structurally. Read off the summary sentence instead, and a payload
  // nobody could open renders as a gate with nothing to do.
  it('stands down when a fully-read payload installs no code', () => {
    const result = codehashCheckResult(
      gate({ madeNoClaim: true, targets: [], unopened: [] }),
      NETWORK
    )

    expect(result.status).toBe('not-applicable')
    expect(result.actual).toBe(NOTHING_INSTALLED_TO_HASH)
    expect(result.anchor).toBe('A-LOCAL')
  })

  it('refuses, never stands down, when a frame would not open', () => {
    const result = codehashCheckResult(
      gate({
        madeNoClaim: true,
        targets: [],
        unopened: ['0xdeadbeef (a cut entry could not be read)'],
      }),
      NETWORK
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
    expect(result.actual).toContain('0xdeadbeef')
  })

  it('stands down on a known non-installing call, naming the function', () => {
    for (const fn of ['updateDelay', 'changeThreshold']) {
      const result = codehashCheckResult(
        gate({
          madeNoClaim: true,
          targets: [],
          unopened: [],
          knownCalls: [fn],
        }),
        NETWORK
      )

      expect(result.status).toBe('not-applicable')
      expect(result.anchor).toBe('A-LOCAL')
      expect(result.actual).toContain(fn)
      expect(result.actual).toContain('no bytecode to compare')
      expect(result.actual).not.toMatch(/could not open/)
    }
  })

  it('reports a target the gate compared and found different as a mismatch', () => {
    const result = codehashCheckResult(
      gate({
        blocksSigning: true,
        targets: [
          {
            address: '0x00000000000000000000000000000000000000f1',
            verdict: 'MISMATCH',
            reason: 'bytecode is not from any attested build',
            matchedLineages: [],
            excludedByteCount: 0,
            pricedByteCount: 0,
            immutables: { status: 'none', detail: 'declares no immutables' },
          },
        ],
      }),
      NETWORK
    )

    expect(result.status).toBe('fail')
    expect(result.anchor).toBe('A-AUDIT')
    expect(result.actual).toContain('MISMATCH')
  })

  // A status name under "observed" sends the signer to the detail line for the
  // sentence that says what is wrong. One refused target can state it in place;
  // the address it belongs to is the thing that moves out.
  it('states why a single refusal refused, and leaves its address to the detail', () => {
    const address = '0x00000000000000000000000000000000000000f1'
    const result = codehashCheckResult(
      gate({
        blocksSigning: true,
        summary: 'This cut will not be signed. It is UNVERIFIABLE.',
        targets: [
          {
            address,
            verdict: 'UNVERIFIABLE',
            reason:
              'no attested build is available for this contract, so nothing can be compared',
            matchedLineages: [],
            excludedByteCount: 0,
            pricedByteCount: 0,
            immutables: { status: 'none', detail: 'declares no immutables' },
          },
        ],
      }),
      NETWORK
    )

    expect(result.actual).toBe(
      'UNVERIFIABLE — no attested build is available for this contract, so nothing can be compared'
    )
    expect(result.actual).not.toContain(address)
    expect(result.detail).toContain(address)
    // The gate's own summary would state the same sentence a second time.
    expect(result.detail).not.toContain('will not be signed')
  })

  // Two reasons cannot both be stated in one value without being false about
  // one of them, so the pair keeps the per-address list — and each keeps its own
  // verdict word, which a summed one would lose.
  it('lists each address when more than one target was refused', () => {
    const result = codehashCheckResult(
      gate({
        blocksSigning: true,
        summary: 'This cut will not be signed. Two addresses refused.',
        targets: [
          {
            address: '0x00000000000000000000000000000000000000f1',
            verdict: 'UNVERIFIABLE',
            reason: 'no attested build is available',
            matchedLineages: [],
            excludedByteCount: 0,
            pricedByteCount: 0,
            immutables: { status: 'none', detail: 'declares no immutables' },
          },
          {
            address: '0x00000000000000000000000000000000000000f2',
            verdict: 'MISMATCH',
            reason: 'bytecode is not from any attested build',
            matchedLineages: [],
            excludedByteCount: 0,
            pricedByteCount: 0,
            immutables: { status: 'none', detail: 'declares no immutables' },
          },
        ],
      }),
      NETWORK
    )

    expect(result.actual).toBe(
      '0x00000000000000000000000000000000000000f1: UNVERIFIABLE; 0x00000000000000000000000000000000000000f2: MISMATCH'
    )
    expect(result.detail).toBe(
      'This cut will not be signed. Two addresses refused.'
    )
  })

  // A refusal is not a codehash disagreement: the cut was malformed or the gate
  // could not judge it. Filing it as a mismatch would put a disagreement on the
  // ledger that nothing observed.
  it('reports a refusal as unverified rather than as a mismatch', () => {
    const result = codehashCheckResult(
      gate({
        blocksSigning: true,
        refusals: ['the cut is malformed'],
        targets: [],
      }),
      NETWORK
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
  })

  it('refuses a gate that never reached a verdict at all', () => {
    const result = codehashCheckResult(
      gate({ evaluated: false, targets: [], summary: '' }),
      NETWORK
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
  })

  // A removal cut carries a `diamondCut`, so `madeNoClaim` is false, and it
  // installs no bytecode, so the gate compares nothing. Graded as a pass that
  // read "0 installed address(es) match an attested build" — a green row for a
  // gate that vouched for nothing, beside a detail block saying NO CLAIM.
  it('stands down when a cut it did open installs no code', () => {
    const result = codehashCheckResult(gate({ targets: [] }), NETWORK)

    expect(result.status).toBe('not-applicable')
    expect(result.actual).toBe(NOTHING_INSTALLED_TO_HASH)
    expect(result.anchor).toBe('A-LOCAL')
  })
})

describe("the target-state block's heading and scope", () => {
  it('is the same label the manifest lists the gate under', () => {
    expect(TARGET_STATE_GATE_HEADING).toBe(gateLabel(TARGET_STATE_CHECK))
  })

  // The block stands down on exactly the statuses the ledger stands the gate
  // down on. Drift either way is a page that contradicts itself: a detail block
  // over a row saying there was nothing to grade, or a graded row with no
  // detail under it.
  it('stands down on exactly the statuses the ledger grades as not-applicable', () => {
    const notApplicable = Object.entries(STATUS_MAPPING)
      .filter(([, mapping]) => mapping.status === 'not-applicable')
      .map(([status]) => status)

    expect(new Set(notApplicable)).toEqual(
      new Set(STATUSES_THAT_CONSULTED_NOTHING)
    )
  })
})

describe("the codehash block's heading", () => {
  // Two declarations of one string, because the registry imports the gate and
  // the gate must not import the registry back. A block headed anything else
  // names a gate the manifest above it does not list.
  it('is the same label the manifest lists the gate under', () => {
    expect(CODEHASH_GATE_HEADING).toBe(gateLabel(CODEHASH_CHECK))
  })
})

describe('the codehash gate on the run-level ledger', () => {
  it('is on the roster, so the run accounts for twelve gates in one book', () => {
    expect(
      CONFIRM_CHECK_DEFINITIONS.map((definition) => definition.checkId)
    ).toContain(CODEHASH_CHECK_ID)
    expect(CONFIRM_CHECK_DEFINITIONS).toHaveLength(12)
  })

  it('costs the verified count when it stands down', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        codehash: codehashGate({
          madeNoClaim: true,
          targets: [],
          unopened: [],
        }),
      })
    )

    const rollup = rollUpChecks(ledger).find(
      (entry) => entry.checkId === CODEHASH_CHECK_ID
    )
    expect(rollup?.graded).toBe(0)
    expect(rollup?.passed).toBe(0)
    expect(rollup?.green).toBe(false)
    // Paired present: standing down must not block either, or a Remove would
    // be unsignable.
    expect(summariseLedger(ledger).hardBlocked).toBe(false)
  })

  it('hard-blocks the run when the gate could not open the payload', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        codehash: codehashGate({
          madeNoClaim: true,
          targets: [],
          unopened: ['call[0]'],
        }),
      })
    )

    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })

  // The refusal this gate drives lives outside the ledger, so a run whose only
  // disagreement is a codehash mismatch is the case where the ledger is the
  // signer's sole warning before the choice. A row the run does not count
  // leaves the closing verdict free to read green over a proposal that will be
  // refused the moment Sign is pressed.
  it('hard-blocks the run on a target it compared and found different', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({
        codehash: codehashGate({
          blocksSigning: true,
          targets: [
            {
              address: '0x00000000000000000000000000000000000000f1',
              verdict: 'MISMATCH',
              reason: 'bytecode is not from any attested build',
              matchedLineages: [],
              excludedByteCount: 0,
              pricedByteCount: 0,
              immutables: { status: 'none', detail: 'declares no immutables' },
            },
          ],
        }),
      })
    )

    const rollup = rollUpChecks(ledger).find(
      (entry) => entry.checkId === CODEHASH_CHECK_ID
    )
    expect(rollup?.green).toBe(false)
    expect(summariseLedger(ledger).hardBlocked).toBe(true)
  })
})

describe('authorityExpectationAnchors', () => {
  it('maps the global config to a deciding anchor and the record to a reporting one', () => {
    const anchors = authorityExpectationAnchors([
      {
        label: 'a',
        contractAddress: '0x00000000000000000000000000000000000000a1',
        liveValue: '0x1',
        expectedValue: '0x1',
        expectationSource: 'globalConfig',
        readError: undefined,
      },
      {
        label: 'b',
        contractAddress: '0x00000000000000000000000000000000000000b2',
        liveValue: '0x1',
        expectedValue: '0x1',
        expectationSource: 'deployments',
        readError: undefined,
      },
    ])
    expect(anchors.get('a')).toBe('A-LOCAL')
    expect(anchors.get('b')).toBe('A-MONGO')
  })
})

describe('the row a reverting simulation writes to the ledger', () => {
  const reverting = (path: string): IExecutabilityCall => ({
    path,
    description: 'diamondCut',
    target: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    modelled: true,
    simulation: 'reverted',
    findings: [],
    outcome: 'would-revert',
  })

  it('names the calls rather than carrying the whole finding list', () => {
    const result = executabilityCheckResult(
      executabilityVerdict({
        refuses: true,
        reason: `blocking — eth_call reverted. Raw Call Arguments: data: 0x${'0'.repeat(
          600
        )}`,
        calls: [
          reverting('call[0].schedule'),
          { ...reverting('call[1]'), outcome: 'would-execute' },
        ],
      }),
      NETWORK
    )

    expect(result.actual).toContain('1 of 2 call(s) would revert')
    expect(result.actual).toContain('call[0].schedule')
    expect(result.actual).not.toContain('Raw Call Arguments')
    expect(result.actual.length).toBeLessThan(120)
  })

  it('falls back to the full reason when no call was marked reverting', () => {
    // A refusal can come from a nonce or funding finding, which belongs to the
    // proposal rather than to any call — summarising those as "0 calls" would
    // report a blocked proposal as having nothing wrong with it.
    const result = executabilityCheckResult(
      executabilityVerdict({
        refuses: true,
        reason: 'another pending proposal sits at nonce 31',
        calls: [{ ...reverting('call[0]'), outcome: 'would-execute' }],
      }),
      NETWORK
    )

    expect(result.actual).toBe('another pending proposal sits at nonce 31')
  })
})

describe('gate letters', () => {
  // Over every gate the repo names, not just the registered ones: a gate that
  // never reaches a ledger still reaches a screen, and a letter it shares with
  // a registered gate is read by a signer as the same gate.
  it('are one uppercase letter, unique across every named gate', () => {
    const letters = ALL_GATE_DEFINITIONS.map((definition) => definition.gate)

    expect(letters.length).toBeGreaterThan(CONFIRM_CHECK_DEFINITIONS.length - 1)
    for (const letter of letters) expect(letter).toMatch(/^[A-Z]$/u)
    expect(new Set(letters).size).toBe(letters.length)
  })

  it('read as the assertion the column header promises', () => {
    // The column is headed "WHAT IT ASSERTS", so a title has to be a claim that
    // is true when the gate passes. The four shapes refused here are the ones
    // the roster actually drifted into — a parenthetical qualifier, a
    // comma-spliced pair of noun phrases, an alternation, and the conditional
    // mood — and each leaves the reader with something that is not an assertion.
    //
    // No regex decides that a sentence is a well-formed clause, and this does
    // not claim to: it pins the shapes a reviewer has had to catch by eye, so a
    // new title can still be poorly worded in a way nothing here sees.
    for (const { gate, title } of ALL_GATE_DEFINITIONS) {
      expect(title, `gate ${gate}`).toMatch(/^[A-Z]/u)
      expect(title, `gate ${gate}`).not.toMatch(/[(),]|\s\/\s/u)
      expect(title, `gate ${gate}`).not.toMatch(
        /\b(?:would|should|must|can)\b/u
      )
    }
  })

  it('fit the column they are printed in, beside the write-up links', () => {
    // Measured against the real links, not against the bare table: they take
    // their columns from the title's, so a title that fits without them can
    // still collapse the dot leader on the view a signer actually reads.
    const width = manifestTitleWidth(
      Math.max(...[...CHECK_DOCS.values()].map((url) => url.length))
    )

    for (const definition of ALL_GATE_DEFINITIONS)
      expect(definition.title.length).toBeLessThanOrEqual(width)
  })

  it('covers every registered gate, and the ones that block elsewhere', () => {
    const named = new Set(ALL_GATE_DEFINITIONS.map((one) => one.checkId))

    for (const definition of CONFIRM_CHECK_DEFINITIONS)
      expect(named).toContain(definition.checkId)
    // Pinned by name as well as through the roster loop: this gate's refusal
    // lives outside the ledger, so a run that dropped its row would still
    // block signing and no other test would notice the name was gone.
    expect(named).toContain(CODEHASH_CHECK_ID)
  })
})

describe('section headings', () => {
  // `renderCheckLedger` groups on the exact string, so two headings a signer
  // reads as the same subject render as two adjacent near-identical lines with
  // nothing to tell them apart. A name containing another is the shape that
  // produced it: `Integrity` alongside `proposal integrity`.
  it('are distinct, and none contains another', () => {
    const sections = [
      ...new Set(
        ALL_GATE_DEFINITIONS.map((definition) =>
          definition.section.trim().toLowerCase()
        )
      ),
    ]

    expect(sections.length).toBeGreaterThan(1)
    for (const section of sections) {
      expect(section).not.toBe('')
      for (const other of sections)
        if (other !== section) expect(other).not.toContain(section)
    }
  })
})

describe('gate blocks share one column', () => {
  // Three modules draw a gate's name: the bucket rows, and the two blocks that
  // print their own per-finding detail. Each one spelled its own indent, and
  // zone 2 shipped with the target state and the codehash verdicts two columns
  // left of every row they sit among.
  it('puts every gate name and every gate body at the same indent', () => {
    const nameColumn = (line: string): number =>
      /^ */u.exec(stripColor(line))?.[0].length ?? 0

    const bucketRow = renderCheckGroups([
      {
        result: {
          checkId: TARGET_STATE_CHECK_ID,
          network: 'mainnet',
          status: 'not-applicable',
          expected: '',
          actual: 'this proposal installs nothing this gate grades',
          anchor: 'A-CI',
        },
        definition: TARGET_STATE_CHECK,
      },
    ])
    const rowTitle = bucketRow.find((line) =>
      stripColor(line).includes(gateLabel(TARGET_STATE_CHECK))
    )
    const rowBody = bucketRow.find((line) =>
      stripColor(line).includes('installs nothing')
    )

    const targetState = formatTargetStateLines(
      verdictOf([finding('ahead-of-main')])
    )
    const codehash = renderCodehashSignGate(codehashGate())

    // The glyph, not the name, is what a bucket row puts in the two columns the
    // other blocks leave blank — so the names line up and the bodies do too.
    expect(nameColumn(rowTitle ?? '')).toBe(GATE_TITLE_INDENT.length - 2)
    expect(
      stripColor(rowTitle ?? '').indexOf(gateLabel(TARGET_STATE_CHECK))
    ).toBe(GATE_TITLE_INDENT.length)
    for (const line of [
      targetState.find((one) => one.includes(TARGET_STATE_GATE_HEADING)),
      codehash.find((one) => one.includes(CODEHASH_GATE_HEADING)),
    ])
      expect(nameColumn(line ?? '')).toBe(GATE_TITLE_INDENT.length)

    for (const line of [
      rowBody,
      targetState.find((one) => stripColor(one).includes('read from')),
      codehash.find((one) => stripColor(one).includes('MATCH')),
    ])
      expect(nameColumn(line ?? '')).toBe(GATE_BODY_INDENT.length)
  })
})

/**
 * Gate L, which answers for the half a codehash comparison cannot reach.
 *
 * The split exists so a chain that cannot decide the value question does not
 * lose the bytecode question with it — so the tests that matter most are the
 * two ends: an assumed mapping is acknowledgeable, and a disagreeing value is
 * not, on any chain.
 */
describe('immutablesCheckResult', () => {
  const target = (
    immutables: ITargetVerdict['immutables']
  ): ICodehashSignGate =>
    codehashGate({
      targets: [
        {
          address: '0x00000000000000000000000000000000000000f1',
          verdict: 'MATCH',
          reason: 'bytecode reproduced from an attested build',
          matchedLineages: ['lineage-1'],
          excludedByteCount: 0,
          pricedByteCount: 0,
          immutables,
        },
      ],
    })

  it('passes on this checkout when every value matched what config declares', () => {
    const result = immutablesCheckResult(
      target({ status: 'verified', detail: 'gasZipRouter holds 0x22…' }),
      NETWORK
    )

    expect(result.status).toBe('pass')
    expect(result.anchor).toBe('A-LOCAL')
  })

  it('stands down when nothing installed declares an immutable', () => {
    const result = immutablesCheckResult(
      target({ status: 'none', detail: 'declares no immutables' }),
      NETWORK
    )

    expect(result.status).toBe('not-applicable')
  })

  it('stands down on a known non-installing call, naming the function', () => {
    for (const fn of ['updateDelay', 'changeThreshold']) {
      const result = immutablesCheckResult(
        codehashGate({
          madeNoClaim: true,
          targets: [],
          unopened: [],
          knownCalls: [fn],
        }),
        NETWORK
      )

      expect(result.status).toBe('not-applicable')
      expect(result.anchor).toBe('A-LOCAL')
      expect(result.actual).toContain(fn)
      expect(result.actual).toContain('no immutables to read')
    }
  })

  it('refuses, never stands down, when a frame would not open', () => {
    const result = immutablesCheckResult(
      codehashGate({
        madeNoClaim: true,
        targets: [],
        unopened: ['0xdeadbeef'],
      }),
      NETWORK
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
    expect(result.actual).toMatch(/could not open 0xdeadbeef/)
  })

  it('asks for an acknowledgement when only the slot mapping is assumed', () => {
    const result = immutablesCheckResult(
      target({ status: 'assumed', detail: 'slot 0 gasZipRouter: …' }),
      NETWORK
    )

    expect(result.status).toBe('needs-ack')
    expect(result.anchor).toBe('A-ASSUMED')
    expect(result.detail).toContain('slot 0 gasZipRouter')
  })

  it('asks for an acknowledgement when the only gap is one the registry states', () => {
    const result = immutablesCheckResult(
      target({
        status: 'documented',
        detail: 'LIFI_DIAMOND: read from the deployment log — unchecked',
      }),
      NETWORK
    )

    expect(result.status).toBe('needs-ack')
    expect(result.anchor).toBe('A-DOCUMENTED')
    expect(isAcknowledgeable(IMMUTABLES_CHECK, result)).toBe(true)
    // The signer is taking on a stated reason, so it must reach the row.
    expect(result.detail).toContain('deployment log')
  })

  it('keeps a slot nobody declared blocking, even beside a stated gap', () => {
    const result = immutablesCheckResult(
      codehashGate({
        targets: [
          {
            address: '0x00000000000000000000000000000000000000f1',
            verdict: 'MATCH',
            reason: 'ok',
            matchedLineages: ['lineage-1'],
            excludedByteCount: 0,
            pricedByteCount: 0,
            immutables: { status: 'documented', detail: 'a stated gap' },
          },
          {
            address: '0x00000000000000000000000000000000000000f2',
            verdict: 'MATCH',
            reason: 'ok',
            matchedLineages: ['lineage-1'],
            excludedByteCount: 0,
            pricedByteCount: 0,
            immutables: { status: 'unpriced', detail: 'EXECUTOR: no entry' },
          },
        ],
      }),
      NETWORK
    )

    expect(result.status).toBe('error')
    expect(isAcknowledgeable(IMMUTABLES_CHECK, result)).toBe(false)
  })

  it('fails on a disagreeing value, which has no acknowledgement path', () => {
    const result = immutablesCheckResult(
      target({ status: 'disagrees', detail: 'gasZipRouter holds 0x33…' }),
      NETWORK
    )

    expect(result.status).toBe('fail')
    expect(isAcknowledgeable(IMMUTABLES_CHECK, result)).toBe(false)
  })

  it('records a value nobody established as an error, not a failure', () => {
    // "we could not check" and "we checked and it disagrees" are two different
    // remedies, and both block.
    const result = immutablesCheckResult(
      target({ status: 'unreadable', detail: 'the simulator was unreachable' }),
      NETWORK
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
  })

  it('reports the least-established address, not the best one', () => {
    const gate = codehashGate({
      targets: [
        {
          address: '0x00000000000000000000000000000000000000f1',
          verdict: 'MATCH',
          reason: 'ok',
          matchedLineages: ['lineage-1'],
          excludedByteCount: 0,
          pricedByteCount: 0,
          immutables: { status: 'verified', detail: 'all good' },
        },
        {
          address: '0x00000000000000000000000000000000000000f2',
          verdict: 'MATCH',
          reason: 'ok',
          matchedLineages: ['lineage-1'],
          excludedByteCount: 0,
          pricedByteCount: 0,
          immutables: { status: 'disagrees', detail: 'holds another value' },
        },
      ],
    })

    expect(immutablesCheckResult(gate, NETWORK).status).toBe('fail')
  })

  it('refuses when the gate never ran, rather than standing down', () => {
    const result = immutablesCheckResult(
      codehashGate({ evaluated: false, summary: 'the gate did not run' }),
      NETWORK
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
  })

  it('opts into the acknowledgement path for the assumed mapping only', () => {
    expect(IMMUTABLES_CHECK.checkClass).toBe('integrity')
    expect(IMMUTABLES_CHECK.undecidableIsAcknowledgeable).toBe(true)
    expect(
      isAcknowledgeable(IMMUTABLES_CHECK, {
        status: 'needs-ack',
        anchor: 'A-ASSUMED',
      })
    ).toBe(true)
    // A `needs-ack` claimed on an anchor that answered nothing still blocks.
    expect(
      isAcknowledgeable(IMMUTABLES_CHECK, {
        status: 'needs-ack',
        anchor: 'A-UNRESOLVED',
      })
    ).toBe(false)
  })
})
