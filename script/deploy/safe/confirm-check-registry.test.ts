// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { createCheckLedger, recordCheck } from './check-ledger'
import {
  CONFIRM_CHECK_DEFINITIONS,
  TARGET_STATE_CHECK_ID,
  targetStateCheckResult,
  worstResultPerCheck,
} from './confirm-check-registry'
import {
  STATUSES_CLEARED_TO_PROCEED,
  type ITargetStateFinding,
  type ITargetStateVerdict,
  type TargetStateStatus,
} from './pinned-target-state'
import { renderCheckLedger } from './render-check-ledger'

const finding = (
  status: TargetStateStatus,
  overrides: Partial<ITargetStateFinding> = {}
): ITargetStateFinding => ({
  status,
  facetAddress: '0x1111111111111111111111111111111111111111',
  contractName: 'AcrossFacet',
  proposedVersion: '1.0.0',
  mainVersion: '1.0.0',
  crossFleetCount: 3,
  detail: `detail for ${status}`,
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
        verdictOf([
          finding(
            status,
            status === 'not-previously-targeted' ? { mainVersion: null } : {}
          ),
        ]),
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
  // row reduced from both must carry the one nobody can wave through. Before the
  // deployment-record statuses became `needs-ack` this ordering was unreachable,
  // and ranking them the other way would have let the common path mask an error.
  it('lets an unverifiable finding outrank one awaiting acknowledgement', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('matches-main'), finding('contract-unidentified')]),
      'mainnet'
    )

    expect(result.status).toBe('error')
    expect(result.anchor).toBe('A-MONGO')
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

  // End of the escalated finding, at the surface the signer actually reads: a
  // first deployment used to print ALL CHECKS GREEN on an anchor that had
  // decided nothing.
  it('does not render a first deployment as a verified run', () => {
    const ledger = ledgerWith()
    recordCheck(
      ledger,
      targetStateCheckResult(
        verdictOf([finding('not-previously-targeted', { mainVersion: null })]),
        'mainnet'
      )
    )

    const verdict = stripColor(renderCheckLedger(ledger).at(-1) ?? '')

    expect(verdict).toContain('ACKNOWLEDGEMENT REQUIRED')
    expect(verdict).not.toContain('ALL CHECKS GREEN')
  })
})
