/**
 * Tests for where the timelock cancel matrix sits in the executor.
 *
 * The matrix itself is covered by `timelock-cancel-decision.test.ts`; these pin
 * the placement's two safety properties — that an unread leg never reaches the
 * matrix as an affirmative one, and that nothing this module builds can reach
 * the destructive verdict.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  buildCancelDecisionInput,
  decideRevertedOperation,
  gradeOperationIdentity,
  renderCancelRecommendation,
  type ITimelockCancelSignals,
} from './timelock-cancel-placement'

const OP_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const signals = (
  overrides: Partial<ITimelockCancelSignals> = {}
): ITimelockCancelSignals => ({
  scheduledOperationId: OP_ID,
  recomputedOperationId: OP_ID,
  operationState: 'ready',
  cancellerAuthority: 'held',
  deploymentRecord: 'present',
  signTimeVerdictRecord: 'present',
  revertAttempts: 3,
  revertBlockThreshold: 3,
  ...overrides,
})

describe('gradeOperationIdentity', () => {
  it('matching ids agree, whatever their case', () => {
    expect(
      gradeOperationIdentity({
        scheduledOperationId: OP_ID.toUpperCase().replace('0X', '0x'),
        recomputedOperationId: OP_ID,
      })
    ).toBe('match')
  })

  it('differing ids are a mismatch', () => {
    expect(
      gradeOperationIdentity({
        scheduledOperationId: OP_ID,
        recomputedOperationId: `0x${'b'.repeat(64)}`,
      })
    ).toBe('mismatch')
  })

  // Two ids failing to be compared is not the two ids agreeing. `match` is one
  // of the affirmative legs a clean execution needs, so an unread recomputation
  // must never wear it.
  it('an unread recomputation is an error, never a match', () => {
    expect(
      gradeOperationIdentity({
        scheduledOperationId: OP_ID,
        recomputedOperationId: undefined,
      })
    ).toBe('error')
  })
})

describe('buildCancelDecisionInput', () => {
  // No execute-time re-derivation of the attested build exists, so the leg is
  // declared absent rather than reported as a passing comparison.
  it('declares the integrity leg unsupported rather than passing it', () => {
    expect(buildCancelDecisionInput(signals()).integrity).toBe('unsupported')
  })

  it('never claims an anchored provenance the executor did not produce', () => {
    const input = buildCancelDecisionInput(signals())
    expect(input.verdictProvenance).toBe('unknown')
    expect(input.agreeingProviders).toBe(0)
  })

  it('reports the observed revert rather than a predicted one', () => {
    expect(buildCancelDecisionInput(signals()).executability).toBe(
      'would-revert'
    )
  })
})

describe('decideRevertedOperation', () => {
  // The safety property of this placement: the executor holds no anchored
  // divergence verdict, so nothing it can assemble may reach a cancel.
  it('never reaches the destructive verdict, on any combination', () => {
    const states: ITimelockCancelSignals['operationState'][] = [
      'ready',
      'pending',
      'done',
      'unset',
    ]
    const authorities: ITimelockCancelSignals['cancellerAuthority'][] = [
      'held',
      'absent',
      'unknown',
    ]
    const records: ITimelockCancelSignals['deploymentRecord'][] = [
      'present',
      'missing',
      'error',
    ]
    const recomputed = [OP_ID, `0x${'b'.repeat(64)}`, undefined]

    for (const operationState of states)
      for (const cancellerAuthority of authorities)
        for (const deploymentRecord of records)
          for (const recomputedOperationId of recomputed) {
            const decision = decideRevertedOperation(
              signals({
                operationState,
                cancellerAuthority,
                deploymentRecord,
                recomputedOperationId,
              })
            )
            expect(decision.action).not.toBe('cancel')
          }
  })

  it('a mismatched id is held rather than cancelled, being unproven', () => {
    const decision = decideRevertedOperation(
      signals({ recomputedOperationId: `0x${'b'.repeat(64)}` })
    )

    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('divergence-not-proven')
    expect(decision.alert).toBe('page')
  })

  it('an operation no longer schedulable is neither executed nor cancelled', () => {
    const decision = decideRevertedOperation(
      signals({ operationState: 'done' })
    )

    expect(decision.action).toBe('block')
    expect(decision.reason).toBe('op-not-schedulable')
  })

  // With the integrity leg unsupported, this is what every clean row reports —
  // which is exactly why the verdict is printed and not enforced.
  it('an agreeing row still holds, because integrity was never verified', () => {
    const decision = decideRevertedOperation(signals())

    expect(decision.action).toBe('hold')
    expect(decision.reason).toBe('op-form-unsupported')
  })

  it('a missing sign-time record is a note, not a change of action', () => {
    const withRecord = decideRevertedOperation(signals())
    const without = decideRevertedOperation(
      signals({ signTimeVerdictRecord: 'missing' })
    )

    expect(without.action).toBe(withRecord.action)
    expect(without.notes.length).toBeGreaterThan(0)
  })
})

describe('renderCancelRecommendation', () => {
  // The executor does not act on this verdict, so the line must not read as an
  // action taken — an operator would otherwise look for a cancel that never
  // happened.
  it('names the verdict as a recommendation', () => {
    const line = renderCancelRecommendation(
      decideRevertedOperation(signals()),
      OP_ID
    )

    expect(line).toContain('would')
    expect(line).toContain(OP_ID)
  })
})
