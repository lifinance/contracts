// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  createCheckLedger,
  recordCheck,
  summariseLedger,
  type CheckStatus,
} from './check-ledger'
import {
  CONFIRM_CHECK_DEFINITIONS,
  EXECUTABILITY_CHECK_ID,
  RPC_QUORUM_CHECK_ID,
  TARGET_STATE_CHECK_ID,
  executabilityCheckResult,
  recordProposalChecks,
  rpcQuorumCheckResult,
  targetStateCheckResult,
  type IProposalCheckVerdicts,
} from './confirm-check-registry'
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
import type { IRpcQuorumVerdict, TQuorumStatus } from './rpc-quorum'

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

const NETWORK = 'arbitrum'

const cleanTargetState: ITargetStateVerdict = {
  findings: [finding('matches-main')],
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
  options: { includeTimelockDelay?: boolean; status?: CheckStatus } = {}
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

describe('recordProposalChecks', () => {
  it('records every registered check, so none is counted missing', () => {
    const ledger = runLedger()
    recordProposalChecks(ledger, verdicts())

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
    recordProposalChecks(ledger, verdicts())

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
    recordProposalChecks(ledger, verdicts())

    const verdict = summariseLedger(ledger)
    expect(verdict.hardBlocked).toBe(false)
    expect(verdict.requiresAcknowledgement).toHaveLength(0)
  })
})

describe('integrity verdicts reaching the run-level ledger', () => {
  it('a failing integrity assertion hard-blocks the run ledger', () => {
    const ledger = runLedger()
    recordProposalChecks(
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
    recordProposalChecks(ledger, verdicts({ integrity: undefined }))

    const verdict = summariseLedger(ledger)
    expect(verdict.hardBlocked).toBe(true)
    expect(verdict.totals.missing).toBe(0)
    for (const checkId of INTEGRITY_CHECKS_ALWAYS)
      expect(
        ledger.results.find((result) => result.checkId === checkId)?.status
      ).toBe('error')
  })

  // The distinction the ticket turns on: a check with nothing to judge that
  // *read* its evidence passes on the anchor it read, while one that could not
  // open the envelope errors. The delay check is the former.
  it('a proposal carrying no schedule passes the delay check on A-LOCAL', () => {
    const ledger = runLedger()
    recordProposalChecks(
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
})

describe('executabilityCheckResult', () => {
  it('grades a clean simulation a pass on the chain it read', () => {
    const result = executabilityCheckResult(executabilityVerdict(), NETWORK)
    expect(result.status).toBe('pass')
    expect(result.anchor).toBe('A-CHAIN')
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
    recordProposalChecks(
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
    recordProposalChecks(ledger, verdicts({ executability: undefined }))

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
    recordProposalChecks(
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
    recordProposalChecks(ledger, verdicts({ rpcQuorum: undefined }))

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
    recordProposalChecks(
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
    recordProposalChecks(
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
    recordProposalChecks(ledger, verdicts({ integrity: thinned }))

    const row = ledger.results.find((result) => result.checkId === dropped)
    expect(row?.status).toBe('error')
    expect(row?.anchor).toBe('A-UNRESOLVED')
    expect(summariseLedger(ledger).totals.missing).toBe(0)
  })
})
