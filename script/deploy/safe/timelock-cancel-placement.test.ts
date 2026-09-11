/**
 * Tests for where the timelock cancel matrix sits in the executor.
 *
 * The matrix itself is covered by `timelock-cancel-decision.test.ts`; these pin
 * the placement's safety properties — that an unread leg never reaches the
 * matrix as an affirmative one, that nothing this module builds can reach the
 * destructive verdict, and that the executor evaluates it where the question is
 * live without letting it drive the action.
 *
 * `execute-pending-timelock-tx.ts` calls `runMain` at module scope and its
 * reverting path needs a chain, a Safe and MongoDB, so the call site is
 * asserted on the source — deleting it otherwise leaves the whole suite green.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

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

const EXECUTOR = readFileSync(
  join(import.meta.dir, 'execute-pending-timelock-tx.ts'),
  'utf8'
)

const OP_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const signals = (
  overrides: Partial<ITimelockCancelSignals> = {}
): ITimelockCancelSignals => ({
  scheduledOperationId: OP_ID,
  recomputedOperationId: OP_ID,
  operationState: 'ready',
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
    const records: ITimelockCancelSignals['deploymentRecord'][] = [
      'present',
      'missing',
      'error',
    ]
    const recomputed = [OP_ID, `0x${'b'.repeat(64)}`, undefined]

    for (const operationState of states)
      for (const deploymentRecord of records)
        for (const recomputedOperationId of recomputed) {
          const decision = decideRevertedOperation(
            signals({
              operationState,
              deploymentRecord,
              recomputedOperationId,
            })
          )
          expect(decision.action).not.toBe('cancel')
        }
  })

  it('a mismatched id is blocked rather than cancelled, being unproven', () => {
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

  // With the integrity leg unsupported, this is what a row still on the
  // schedule reports — which is exactly why the verdict is printed, not
  // enforced.
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
    const decision = decideRevertedOperation(signals())
    const line = renderCancelRecommendation(decision, OP_ID)

    expect(line).toContain('recommends')
    expect(line).toContain(decision.action)
    expect(line).toContain(OP_ID)
    // The intent, asserted rather than left to the wording: nothing in the line
    // may read as an action already carried out.
    expect(line).not.toMatch(/\b(cancelled|canceled|executed|blocked|held)\b/u)
  })
})

describe('what the executor can never reach', () => {
  // The report is worth printing only because it can never authorise the two
  // actions that change anything. `cancel` is covered above; `execute` is the
  // other one, and no combination the executor assembles produces it.
  it('never reaches execute either, on any combination', () => {
    const states: ITimelockCancelSignals['operationState'][] = [
      'ready',
      'pending',
      'done',
      'unset',
    ]
    const recomputed = [OP_ID, `0x${'b'.repeat(64)}`, undefined]

    for (const operationState of states)
      for (const recomputedOperationId of recomputed)
        expect(
          decideRevertedOperation(
            signals({
              operationState,
              recomputedOperationId,
              // As the executor hardcodes them.
              deploymentRecord: 'error',
              signTimeVerdictRecord: 'missing',
            })
          ).action
        ).not.toBe('execute')
  })
})

describe('where the executor evaluates the matrix', () => {
  it('evaluates it on the reverting path, after the revert is recorded', () => {
    const recorded = EXECUTOR.indexOf('recordTimelockOpRevert(')
    const decided = EXECUTOR.indexOf('decideRevertedOperation({')

    expect(recorded).toBeGreaterThan(-1)
    expect(decided).toBeGreaterThan(recorded)

    // `revertAttempts` is the count the row now carries, so the matrix has to
    // be asked after the write. Asked before it, the matrix grades the previous
    // attempt and the threshold leg is off by one for the life of the queue.
    expect(EXECUTOR).toContain('revertAttempts: revertCount')
  })

  it('reports the recommendation before the executor decides what to do', () => {
    const rendered = EXECUTOR.indexOf('renderCancelRecommendation(decision')
    const blocked = EXECUTOR.indexOf('shouldBlockAfterRevert(revertCount)')

    expect(rendered).toBeGreaterThan(-1)
    expect(blocked).toBeGreaterThan(rendered)
  })

  it('reports an unreadable operation state instead of grading one', () => {
    // Every member of the state union is a state the controller can really be
    // in, and the matrix renders each as an observed fact, so a failed read has
    // no value it can honestly return. The one leg that does have one is
    // asserted above by `buildCancelDecisionInput`.
    const start = EXECUTOR.indexOf('readOperationState: async ()')
    expect(start).toBeGreaterThan(-1)
    const leg = EXECUTOR.slice(
      start,
      EXECUTOR.indexOf('\n            }\n', start)
    )

    expect(leg).toContain('checkOperationStatus(')
    expect(leg).toMatch(
      /catch[\s\S]*?throw new Error\(\s*`the operation's on-chain state could not be read/u
    )
    // The paired absence: no branch of the catch may hand back a state.
    expect(leg.slice(leg.indexOf('} catch'))).not.toMatch(
      /return '(ready|pending|done|unset)'/u
    )
  })

  it('reads the decision only to report it, never to act on it', () => {
    // The one property that makes a report-only placement safe. The `integrity`
    // leg is hardcoded `unsupported` because no execute-time re-derivation of
    // the attested build exists, so every verdict the executor can assemble
    // short-circuits to hold; branching on it would hold and page every
    // operation on every pass.
    //
    // Counted over every occurrence of the bare identifier rather than over
    // `decision.` reads: `const { action } = decision` carries the verdict out
    // under a new name, and a property-access match cannot see that. Each use
    // must be one of the three permitted ones, so a fourth fails whatever it
    // spells.
    // Both ends are checked before slicing. An unfound `indexOf` returns -1,
    // and a -1 *end* widens the window to the rest of the file, which is the
    // one failure direction that lets an added use go unseen.
    const from = EXECUTOR.indexOf('const decision = decideRevertedOperation({')
    const to = EXECUTOR.indexOf('if (!shouldBlockAfterRevert(revertCount)) {')

    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)

    const block = EXECUTOR.slice(from, to)
    const uses = block.match(/(?<![$\w])decision(?![$\w])/gu) ?? []
    const permitted =
      block.match(
        /const decision = decideRevertedOperation\(\{|renderCancelRecommendation\(decision,|(?<![$\w])decision\.notes(?![$\w])/gu
      ) ?? []

    expect(block).toContain('const decision = decideRevertedOperation({')
    expect(uses.length).toBe(3)
    expect(permitted.length).toBe(uses.length)
  })
})
