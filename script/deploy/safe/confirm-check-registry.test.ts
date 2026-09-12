// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  createCheckLedger,
  recordCheck,
  rollUpChecks,
  summariseLedger,
  type CheckStatus,
  type ICheckLedger,
} from './check-ledger'
import {
  ALL_GATE_DEFINITIONS,
  authorityExpectationAnchors,
  CODEHASH_CHECK_ID,
  CONFIRM_CHECK_DEFINITIONS,
  EVERY_ELEMENT_COMPARED,
  EXECUTABILITY_CHECK_ID,
  NOTHING_TO_COMPARE,
  ORDERING_HOLDS,
  RPC_QUORUM_CHECK_ID,
  STORAGE_AUTHORITY_CHECK_ID,
  storageAuthorityCheckResult,
  TARGET_STATE_CHECK,
  TARGET_STATE_CHECK_ID,
  executabilityCheckResult,
  proposalCheckResults,
  rpcQuorumCheckResult,
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
  STATUSES_CLEARED_TO_PROCEED,
  type ITargetStateFinding,
  type ITargetStateVerdict,
  type TargetStateStatus,
} from './pinned-target-state'
import type { IPreBroadcastAuthority } from './prebroadcast-authorities'
import { renderCheckLedger } from './render-check-ledger'
import type { IRpcQuorumVerdict, TQuorumStatus } from './rpc-quorum'

const FACET = '0x1111111111111111111111111111111111111111'

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
  // Pushed from `blank`: no address either, since there is no cut element.
  'no-diamond-cut': { facetAddress: null, contractName: null },
  'calldata-not-readable': { facetAddress: null, contractName: null },
  // Pushed from `blank` with the cut's address, before anything is resolved.
  removal: { contractName: null },
  'unrecognised-cut-action': { contractName: null },
  'pinned-state-unavailable': { contractName: null },
  'deployment-record-ambiguous': { contractName: null },
  // Resolved to an address but never to a name, so no version either.
  'contract-unidentified': { contractName: null, proposedVersion: null },
  // `origin/main` declared nothing — the only status carrying a fleet count.
  'not-previously-targeted': { mainVersion: null, crossFleetCount: 3 },
  // The record carried no version to compare against main's.
  'proposed-version-unresolved': { proposedVersion: null },
  // Both versions resolved; `shared` never carries a fleet count.
  'matches-main': {},
  'ahead-of-main': {},
  downgrade: {},
  'version-not-comparable': {},
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
    expect(result.anchor).toBe('A-MAIN')
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

  it('grades a removal against nothing, because it reads no anchor', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('removal')]),
      'mainnet'
    )

    expect(result.status).toBe('pass')
    expect(result.anchor).toBe('A-LOCAL')
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
   * The exact sentence each status must put in `expected`.
   *
   * Asserted against the module's own constants rather than restated copies,
   * and keyed so a status added later is a compile error here too. Full
   * sentences rather than a substring: matching only on "at or ahead of" could
   * not tell the two non-comparing sentences apart, so swapping them stayed
   * green.
   */
  const EXPECTED_SENTENCE: Record<TargetStateStatus, string> = {
    'matches-main': ORDERING_HOLDS,
    'ahead-of-main': ORDERING_HOLDS,
    'not-previously-targeted': ORDERING_HOLDS,
    downgrade: ORDERING_HOLDS,
    'version-not-comparable': ORDERING_HOLDS,
    removal: NOTHING_TO_COMPARE,
    'no-diamond-cut': NOTHING_TO_COMPARE,
    'proposed-version-unresolved': EVERY_ELEMENT_COMPARED,
    'contract-unidentified': EVERY_ELEMENT_COMPARED,
    'deployment-record-ambiguous': EVERY_ELEMENT_COMPARED,
    'unrecognised-cut-action': EVERY_ELEMENT_COMPARED,
    'calldata-not-readable': EVERY_ELEMENT_COMPARED,
    'pinned-state-unavailable': EVERY_ELEMENT_COMPARED,
  }

  it('states a requirement for every status, not a diagnosis', () => {
    for (const status of ALL_STATUSES) {
      const { expected } = targetStateCheckResult(
        verdictOf([finding(status)]),
        'mainnet'
      )

      expect({ status, expected }).toEqual({
        status,
        expected: EXPECTED_SENTENCE[status],
      })
    }
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
    // the row must then stand on the ordering that actually failed.
    const { expected } = targetStateCheckResult(
      verdictOf([finding('removal'), finding('downgrade')]),
      'mainnet'
    )

    expect(expected).toBe(ORDERING_HOLDS)
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
    expect(result.anchor).toBe('A-MAIN')
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
        expect(['pass', 'needs-ack']).toContain(result.status)
      // …and one that did not clear must never arrive as something a signer can
      // wave through, or as a pass.
      else expect(['fail', 'error']).toContain(result.status)
    }
  })
})

describe('worstResultPerCheck', () => {
  const resultWith = (
    status: 'pass' | 'fail' | 'error' | 'needs-ack',
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

  it('returns nothing for a network that graded nothing', () => {
    expect(worstResultPerCheck([])).toEqual([])
  })
})

describe('the registry is usable by the ledger it feeds', () => {
  it('registers and records without the ledger rejecting a row', () => {
    const stored = recordCheck(
      ledgerWith(['mainnet', 'arbitrum']),
      targetStateCheckResult(verdictOf([finding('removal')]), 'mainnet')
    )

    expect(stored.checkId).toBe(TARGET_STATE_CHECK_ID)
    expect(stored.status).toBe('pass')
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

    const verdict = stripColor(renderCheckLedger(ledger).at(-1) ?? '')

    expect(verdict).toContain('ACKNOWLEDGEMENT REQUIRED')
    expect(verdict).not.toContain('ALL CHECKS GREEN')
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

const verdicts = (
  overrides: Partial<IProposalCheckVerdicts> = {}
): IProposalCheckVerdicts => ({
  network: NETWORK,
  integrity: integrityRun({ includeTimelockDelay: true }),
  targetState: cleanTargetState,
  executability: executabilityVerdict(),
  rpcQuorum: quorumVerdict(),
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
      TARGET_STATE_CHECK_ID,
      EXECUTABILITY_CHECK_ID,
      RPC_QUORUM_CHECK_ID,
    ])
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

  // A check with nothing to judge that *read* its evidence passes on the anchor
  // it read; one that could not open the envelope errors. The delay check is
  // the former, and `run.registered` is the only thing that says which it is.
  it('a proposal carrying no schedule passes the delay check on A-LOCAL', () => {
    const ledger = runLedger()
    recordInto(
      ledger,
      verdicts({ integrity: integrityRun({ includeTimelockDelay: false }) })
    )

    const row = ledger.results.find(
      (result) => result.checkId === CHECK_TIMELOCK_DELAY
    )
    expect(row?.status).toBe('pass')
    expect(row?.anchor).toBe('A-LOCAL')
    expect(summariseLedger(ledger).hardBlocked).toBe(false)
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

  it('grades partial simulation coverage an acknowledgement, not a pass', () => {
    // The paired directions: a clean run with nothing left unsimulated is the
    // pass above, and one payload without a revert model is coverage the run
    // does not have, so it cannot share that row.
    const result = executabilityCheckResult(
      executabilityVerdict({ notSimulated: ['call[0].diamondCut[0]'] }),
      NETWORK
    )

    expect(result.status).toBe('needs-ack')
    expect(result.anchor).toBe('A-UNRESOLVED')
    expect(result.actual).toContain('judged on a live eth_call alone')
    // The row has to say what the acknowledgement is for: the screen shows
    // those calls with a succeeding eth_call beside them, so "nothing reverted"
    // on its own reads as a pass a signer is being asked to confirm twice.
    expect(result.detail).toContain('no revert model covers these payloads')
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
    expect(stripColor(renderCheckLedger(ledger).at(-1) ?? '')).not.toContain(
      `0/${rollups.length} network results verified`
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

    const verdict = stripColor(renderCheckLedger(ledger).at(-1) ?? '')
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

describe('storageAuthorityCheckResult', () => {
  const TIMELOCK = '0x00000000000000000000000000000000000000a1'
  const PAUSER = '0x00000000000000000000000000000000000000b2'
  const ATTACKER = '0x00000000000000000000000000000000000000ee'

  const entry = (
    overrides: Partial<IPreBroadcastAuthority> = {}
  ): IPreBroadcastAuthority => ({
    label: 'LiFiDiamond.pauserWallet()',
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
      expect(result.status).toBe('pass')
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

  it('errors on an empty set rather than passing on nothing', () => {
    const result = resultFor([])
    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-UNRESOLVED')
    expect(result.actual).toContain('no contract')
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
        liveValue: '0x1',
        expectedValue: '0x1',
        expectationSource: 'globalConfig',
        readError: undefined,
      },
      {
        label: 'b',
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

  it('name a subject rather than restate the assertion', () => {
    for (const definition of ALL_GATE_DEFINITIONS)
      expect(definition.title.split(/\s+/u).length).toBeLessThanOrEqual(3)
  })

  it('covers every registered gate, and the ones that block elsewhere', () => {
    const named = new Set(ALL_GATE_DEFINITIONS.map((one) => one.checkId))

    for (const definition of CONFIRM_CHECK_DEFINITIONS)
      expect(named).toContain(definition.checkId)
    // The codehash gate refuses inside the integrity asserts rather than
    // through a ledger row, so nothing else would notice it losing its name.
    expect(named).toContain(CODEHASH_CHECK_ID)
  })
})
