// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { createCheckLedger, recordCheck } from './check-ledger'
import {
  CONFIRM_CHECK_DEFINITIONS,
  TARGET_STATE_CHECK_ID,
  targetStateCheckResult,
} from './confirm-check-registry'
import type {
  ITargetStateFinding,
  ITargetStateVerdict,
  TargetStateStatus,
} from './pinned-target-state'

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

/** Every status the graded verdict can carry, so none escapes the mapping. */
const ALL_STATUSES: TargetStateStatus[] = [
  'no-diamond-cut',
  'removal',
  'not-previously-targeted',
  'matches-main',
  'ahead-of-main',
  'downgrade',
  'version-not-comparable',
  'proposed-version-unresolved',
  'contract-unidentified',
  'deployment-record-ambiguous',
  'unrecognised-cut-action',
  'calldata-not-readable',
  'pinned-state-unavailable',
]

const verdictOf = (findings: ITargetStateFinding[]): ITargetStateVerdict => ({
  findings,
  cleared: findings.every((entry) =>
    [
      'no-diamond-cut',
      'removal',
      'not-previously-targeted',
      'matches-main',
      'ahead-of-main',
    ].includes(entry.status)
  ),
})

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

  it('grades a matching version as a pass against origin/main', () => {
    const result = targetStateCheckResult(
      verdictOf([finding('matches-main')]),
      'mainnet'
    )

    expect(result.status).toBe('pass')
    expect(result.anchor).toBe('A-MAIN')
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
        finding('matches-main'),
        finding('downgrade', { contractName: 'GenericSwapFacetV3' }),
        finding('contract-unidentified'),
      ]),
      'mainnet'
    )

    expect(result.status).toBe('fail')
    expect(result.anchor).toBe('A-MAIN')
    expect(result.actual).toContain('GenericSwapFacetV3')
    // A passing finding must not pad the row into looking mostly fine.
    expect(result.actual).not.toContain('matches-main')
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

      if (verdict.cleared) expect(result.status).toBe('pass')
      else expect(result.status).not.toBe('pass')
    }
  })
})

describe('the registry is usable by the ledger it feeds', () => {
  it('registers and records without the ledger rejecting a row', () => {
    const ledger = createCheckLedger({
      expectedNetworks: ['mainnet', 'arbitrum'],
      checks: [...CONFIRM_CHECK_DEFINITIONS],
    })

    const stored = recordCheck(
      ledger,
      targetStateCheckResult(verdictOf([finding('matches-main')]), 'mainnet')
    )

    expect(stored.checkId).toBe(TARGET_STATE_CHECK_ID)
    expect(stored.status).toBe('pass')
  })

  // recordCheck coerces a pass on a reporting-only anchor to error. Proven
  // here rather than assumed, because it is the backstop the mapping leans on.
  it('has its reporting-only rows coerced by the ledger, not by itself', () => {
    const ledger = createCheckLedger({
      expectedNetworks: ['mainnet'],
      checks: [...CONFIRM_CHECK_DEFINITIONS],
    })

    const stored = recordCheck(ledger, {
      ...targetStateCheckResult(
        verdictOf([finding('matches-main')]),
        'mainnet'
      ),
      anchor: 'A-MONGO',
      status: 'pass',
    })

    expect(stored.status).toBe('error')
  })
})
