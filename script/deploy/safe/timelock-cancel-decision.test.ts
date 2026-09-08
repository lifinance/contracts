import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  assertDecisionPermitsExecution,
  evaluateCancelDecision,
  evaluateCancelPass,
  evaluateExecutorPosture,
  MAX_CANCELS_PER_PASS,
  MIN_AGREEING_PROVIDERS_FOR_CANCEL,
  parseDeployScriptExecutorPosture,
  renderCancelDecision,
  renderCancelPass,
  type ICancelDecisionInput,
  type IIdentifiedCancelDecision,
} from './timelock-cancel-decision'

const REPO_ROOT = join(import.meta.dir, '../../..')

const EVM_TIMELOCK_DEPLOY_SCRIPT = join(
  REPO_ROOT,
  'script/deploy/facets/DeployLiFiTimelockController.s.sol'
)

const ZKSYNC_TIMELOCK_DEPLOY_SCRIPT = join(
  REPO_ROOT,
  'script/deploy/zksync/DeployLiFiTimelockController.zksync.s.sol'
)

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`

const verified: ICancelDecisionInput = {
  integrity: 'match',
  opIdentity: 'match',
  verdictProvenance: 'anchors',
  agreeingProviders: 2,
  executability: 'ok',
  deploymentRecord: 'present',
  signTimeVerdictRecord: 'present',
  operationState: 'ready',
  cancellerAuthority: 'held',
  revertAttempts: 0,
  revertBlockThreshold: 3,
}

const withInput = (
  overrides: Partial<ICancelDecisionInput>
): ICancelDecisionInput => ({ ...verified, ...overrides })

const identified = (
  overrides: Partial<ICancelDecisionInput>,
  index = 0
): IIdentifiedCancelDecision => ({
  operationId: `0xop${index}`,
  network: `network${index}`,
  decision: evaluateCancelDecision(withInput(overrides)),
})

const provenIntegrityDivergence: Partial<ICancelDecisionInput> = {
  integrity: 'mismatch',
}

describe('evaluateCancelDecision — the four matrix paths', () => {
  it('PASS executes', () => {
    const decision = evaluateCancelDecision(verified)

    expect(decision.action).toBe('execute')
    expect(decision.reason).toBe('integrity-and-identity-verified')
    expect(decision.alert).toBe('none')
    expect(decision.notes).toEqual([])
  })

  it('a proven integrity divergence cancels', () => {
    const decision = evaluateCancelDecision(
      withInput(provenIntegrityDivergence)
    )

    expect(decision.action).toBe('cancel')
    expect(decision.reason).toBe('proven-integrity-divergence')
    expect(decision.alert).toBe('page')
  })

  it('a proven operation-id divergence cancels', () => {
    const decision = evaluateCancelDecision(
      withInput({ opIdentity: 'mismatch' })
    )

    expect(decision.action).toBe('cancel')
    expect(decision.reason).toBe('proven-identity-divergence')
  })

  it('would-revert holds below the revert threshold and never cancels', () => {
    const decision = evaluateCancelDecision(
      withInput({ executability: 'would-revert', revertAttempts: 1 })
    )

    expect(decision.action).toBe('hold')
    expect(decision.reason).toBe('would-revert')
    expect(decision.retry).toBe(true)
  })

  it('would-revert blocks once the revert threshold is reached', () => {
    const decision = evaluateCancelDecision(
      withInput({ executability: 'would-revert', revertAttempts: 3 })
    )

    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('would-revert')
    expect(decision.retry).toBe(false)
  })

  it.each([
    ['integrity', { integrity: 'error' }],
    ['opIdentity', { opIdentity: 'error' }],
    ['deploymentRecord', { deploymentRecord: 'error' }],
    ['executability', { executability: 'error' }],
  ] as [string, Partial<ICancelDecisionInput>][])(
    'an ERROR on %s holds and retries, never cancels',
    (_leg, overrides) => {
      const decision = evaluateCancelDecision(withInput(overrides))

      expect(decision.action).toBe('hold')
      expect(decision.reason).toBe('verification-error')
      expect(decision.retry).toBe(true)
    }
  )

  it('an ERROR alongside a proven divergence still cancels, because the proof stands on its own leg', () => {
    const decision = evaluateCancelDecision(
      withInput({ integrity: 'mismatch', executability: 'error' })
    )

    expect(decision.action).toBe('cancel')
  })
})

describe('evaluateCancelDecision — what the input can lie about', () => {
  it('a divergence derived from a stored value does not cancel', () => {
    const decision = evaluateCancelDecision(
      withInput({ integrity: 'mismatch', verdictProvenance: 'stored' })
    )

    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('divergence-not-proven')
    expect(decision.detail).toContain('not an authoritative anchor')
  })

  it('a divergence of unknown provenance does not cancel', () => {
    const decision = evaluateCancelDecision(
      withInput({ integrity: 'mismatch', verdictProvenance: 'unknown' })
    )

    expect(decision.reason).toBe('divergence-not-proven')
  })

  it('a divergence below the provider quorum does not cancel', () => {
    const decision = evaluateCancelDecision(
      withInput({
        integrity: 'mismatch',
        agreeingProviders: MIN_AGREEING_PROVIDERS_FOR_CANCEL - 1,
      })
    )

    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('divergence-not-proven')
    expect(decision.detail).toContain('below the quorum')
  })

  it('the same divergence at quorum does cancel, so the quorum check is not a blanket refusal', () => {
    const decision = evaluateCancelDecision(
      withInput({
        integrity: 'mismatch',
        agreeingProviders: MIN_AGREEING_PROVIDERS_FOR_CANCEL,
      })
    )

    expect(decision.action).toBe('cancel')
  })

  it('an operation shape the re-derivation cannot handle holds and pages, never executes', () => {
    const decision = evaluateCancelDecision(
      withInput({ opIdentity: 'unsupported' })
    )

    expect(decision.action).toBe('hold')
    expect(decision.reason).toBe('op-form-unsupported')
    expect(decision.alert).toBe('page')
  })

  it('an unsupported integrity leg holds too', () => {
    expect(
      evaluateCancelDecision(withInput({ integrity: 'unsupported' })).reason
    ).toBe('op-form-unsupported')
  })

  it.each(['done', 'unset'] as const)(
    'an operation that is %s on-chain is neither executed nor cancelled',
    (operationState) => {
      const decision = evaluateCancelDecision(
        withInput({ ...provenIntegrityDivergence, operationState })
      )

      expect(decision.action).toBe('block')
      expect(decision.reason).toBe('op-not-schedulable')
    }
  )

  it('a pending operation is still cancellable', () => {
    const decision = evaluateCancelDecision(
      withInput({ ...provenIntegrityDivergence, operationState: 'pending' })
    )

    expect(decision.action).toBe('cancel')
  })

  it.each(['absent', 'unknown'] as const)(
    'a proven divergence with canceller authority %s blocks instead of pretending to cancel',
    (cancellerAuthority) => {
      const decision = evaluateCancelDecision(
        withInput({ ...provenIntegrityDivergence, cancellerAuthority })
      )

      expect(decision.action).toBe('block')
      expect(decision.reason).toBe('canceller-authority-missing')
      expect(decision.alert).toBe('page')
    }
  )

  it.each([
    'integrity',
    'opIdentity',
    'deploymentRecord',
    'executability',
  ] as const)(
    'an unrecognised %s value blocks rather than falling through to execute',
    (field) => {
      const decision = evaluateCancelDecision({
        ...verified,
        [field]: 'partially-verified',
      } as unknown as ICancelDecisionInput)

      expect(decision.action).toBe('block')
      expect(decision.reason).toBe('unclassified-signals')
    }
  )
})

describe('evaluateCancelDecision — the two records are not the same record', () => {
  it('a missing deployment record blocks', () => {
    const decision = evaluateCancelDecision(
      withInput({ deploymentRecord: 'missing' })
    )

    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('deployment-record-missing')
    expect(decision.alert).toBe('page')
  })

  it('a missing sign-time verdict record alerts only and still executes', () => {
    const decision = evaluateCancelDecision(
      withInput({ signTimeVerdictRecord: 'missing' })
    )

    expect(decision.action).toBe('execute')
    expect(decision.alert).toBe('notice')
    expect(decision.notes).toHaveLength(1)
    expect(decision.notes[0]).toContain('no sign-time verdict record')
  })

  it('a missing verdict record does not soften an action that was already paging', () => {
    const decision = evaluateCancelDecision(
      withInput({
        ...provenIntegrityDivergence,
        signTimeVerdictRecord: 'missing',
      })
    )

    expect(decision.action).toBe('cancel')
    expect(decision.alert).toBe('page')
    expect(decision.notes).toHaveLength(1)
  })
})

describe('evaluateCancelPass — the circuit-breaker', () => {
  const cancels = (count: number): IIdentifiedCancelDecision[] =>
    Array.from({ length: count }, (_unused, index) =>
      identified(provenIntegrityDivergence, index)
    )

  it('lets cancels through at the limit', () => {
    const verdict = evaluateCancelPass(
      cancels(MAX_CANCELS_PER_PASS),
      'restricted'
    )

    expect(verdict.circuitBreakerTripped).toBe(false)
    expect(verdict.cancels).toBe(MAX_CANCELS_PER_PASS)
    expect(verdict.cancelsWithheld).toBe(0)
  })

  it('withholds every cancel above the limit once the executor role is restricted', () => {
    const verdict = evaluateCancelPass(
      cancels(MAX_CANCELS_PER_PASS + 1),
      'restricted'
    )

    expect(verdict.circuitBreakerTripped).toBe(true)
    expect(verdict.cancels).toBe(0)
    expect(verdict.cancelsWithheld).toBe(MAX_CANCELS_PER_PASS + 1)
    expect(verdict.alert).toBe('page')
    for (const entry of verdict.decisions) {
      expect(entry.decision.action).toBe('block')
      expect(entry.decision.reason).toBe('cancel-circuit-breaker')
    }
  })

  it.each(['open', 'unknown'] as const)(
    'still cancels above the limit while the executor role is %s, because declining to execute is not a control there',
    (posture) => {
      const verdict = evaluateCancelPass(
        cancels(MAX_CANCELS_PER_PASS + 1),
        posture
      )

      expect(verdict.circuitBreakerTripped).toBe(true)
      expect(verdict.cancels).toBe(MAX_CANCELS_PER_PASS + 1)
      expect(verdict.cancelsWithheld).toBe(0)
      expect(verdict.alert).toBe('page')
      expect(verdict.detail).toContain(posture)
    }
  )

  it('leaves non-cancel decisions untouched when it trips', () => {
    const decisions = [
      ...cancels(MAX_CANCELS_PER_PASS + 1),
      identified({ executability: 'would-revert', revertAttempts: 0 }, 99),
    ]
    const verdict = evaluateCancelPass(decisions, 'restricted')

    expect(verdict.decisions.at(-1)?.decision.action).toBe('hold')
    expect(verdict.decisions.at(-1)?.decision.reason).toBe('would-revert')
  })

  it('reports the worst per-operation alert when it does not trip', () => {
    expect(evaluateCancelPass([identified({})], 'restricted').alert).toBe(
      'none'
    )
    expect(
      evaluateCancelPass(
        [identified({}), identified({ deploymentRecord: 'missing' }, 1)],
        'restricted'
      ).alert
    ).toBe('page')
  })

  it('takes an explicit threshold', () => {
    expect(
      evaluateCancelPass(cancels(2), 'restricted', 1).circuitBreakerTripped
    ).toBe(true)
  })
})

describe('assertDecisionPermitsExecution', () => {
  it('lets an execute decision through', () => {
    expect(() =>
      assertDecisionPermitsExecution(
        evaluateCancelDecision(verified),
        'mainnet 0xop'
      )
    ).not.toThrow()
  })

  it.each([
    ['cancel', provenIntegrityDivergence],
    ['hold', { integrity: 'error' }],
    ['block', { deploymentRecord: 'missing' }],
  ] as [string, Partial<ICancelDecisionInput>][])(
    'refuses a %s decision, naming the reason',
    (_action, overrides) => {
      const decision = evaluateCancelDecision(withInput(overrides))

      expect(() =>
        assertDecisionPermitsExecution(decision, 'mainnet 0xop')
      ).toThrow(new RegExp(`mainnet 0xop.*${decision.reason}`))
    }
  )
})

describe('renderers', () => {
  it('prints the action, reason and notes of one decision', () => {
    const rendered = renderCancelDecision(
      evaluateCancelDecision(
        withInput({ integrity: 'error', signTimeVerdictRecord: 'missing' })
      )
    )

    expect(rendered).toContain('action : HOLD')
    expect(rendered).toContain('reason : verification-error')
    expect(rendered).toContain('(retried next pass)')
    expect(rendered).toContain('note   : no sign-time verdict record')
  })

  it('prints the breaker state and one row per operation', () => {
    const rendered = renderCancelPass(
      evaluateCancelPass(
        [
          identified(provenIntegrityDivergence, 1),
          identified(provenIntegrityDivergence, 2),
          identified(provenIntegrityDivergence, 3),
        ],
        'restricted'
      )
    )

    expect(rendered).toContain('breaker: TRIPPED (3 cancel(s) withheld)')
    expect(rendered).toContain(
      'network1 0xop1 → BLOCK (cancel-circuit-breaker)'
    )
  })

  it('prints a not-tripped pass', () => {
    expect(
      renderCancelPass(evaluateCancelPass([identified({})], 'open'))
    ).toContain('breaker: not tripped')
  })
})

describe('evaluateExecutorPosture', () => {
  it('reads the zero address as open, whatever its case or padding', () => {
    expect(evaluateExecutorPosture([ZERO_ADDRESS])).toBe('open')
    expect(evaluateExecutorPosture([` ${ZERO_ADDRESS.toUpperCase()} `])).toBe(
      'open'
    )
  })

  it('reads a named holder as restricted', () => {
    expect(evaluateExecutorPosture([`0x${'ab'.repeat(20)}`])).toBe('restricted')
  })

  it('reads the zero address as open even alongside a named holder', () => {
    expect(
      evaluateExecutorPosture([`0x${'ab'.repeat(20)}`, ZERO_ADDRESS])
    ).toBe('open')
  })

  it('reads no holder at all as unknown, not restricted', () => {
    expect(evaluateExecutorPosture([])).toBe('unknown')
  })
})

describe('parseDeployScriptExecutorPosture — against the real deploy scripts', () => {
  it.each([
    ['EVM', EVM_TIMELOCK_DEPLOY_SCRIPT],
    ['zkSync', ZKSYNC_TIMELOCK_DEPLOY_SCRIPT],
  ])(
    'the committed %s timelock deploy script still grants the executor role to the zero address',
    (_label, path) => {
      expect(parseDeployScriptExecutorPosture(readFileSync(path, 'utf8'))).toBe(
        'open'
      )
    }
  )

  it('reads the same script as restricted once the grant names a wallet', () => {
    const restricted = readFileSync(EVM_TIMELOCK_DEPLOY_SCRIPT, 'utf8').replace(
      'executors[0] = address(0);',
      'executors[0] = deployerWallet;'
    )

    expect(restricted).not.toContain('executors[0] = address(0);')
    expect(parseDeployScriptExecutorPosture(restricted)).toBe('restricted')
  })

  it('reads a script with no executor assignment as unknown', () => {
    expect(parseDeployScriptExecutorPosture('contract X {}')).toBe('unknown')
  })

  it('reads a multi-slot grant as open when any slot is the zero address', () => {
    expect(
      parseDeployScriptExecutorPosture(
        'executors[0] = deployerWallet;\nexecutors[1] = address( 0 );'
      )
    ).toBe('open')
  })
})
