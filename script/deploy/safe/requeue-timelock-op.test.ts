import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Hex } from 'viem'

import {
  validateRequeue,
  type IOnChainOpState,
  type RequeueVerdict,
} from './requeue-timelock-op'
import type { ITimelockQueueDoc } from './timelock-queue'

const OP_ID = `0x${'c4'.repeat(32)}` as Hex
const OTHER_OP_ID = `0x${'ab'.repeat(32)}` as Hex

/** The EXSC-816 state: still scheduled, delay elapsed, not executed. */
const READY: IOnChainOpState = {
  isOperation: true,
  isPending: true,
  isReady: true,
  isDone: false,
}

function row(
  overrides: Partial<ITimelockQueueDoc> = {}
): Pick<
  ITimelockQueueDoc,
  'status' | 'operationId' | 'blockedReason' | 'failureReason'
> {
  return {
    status: 'blocked',
    operationId: OP_ID,
    blockedReason: 'obsolete folded removals: AcrossFacetV3:0x28cc4316',
    ...overrides,
  } as Pick<
    ITimelockQueueDoc,
    'status' | 'operationId' | 'blockedReason' | 'failureReason'
  >
}

function reasonOf(verdict: RequeueVerdict): string {
  return verdict.ok ? '' : verdict.reason
}

describe('validateRequeue', () => {
  it('allows re-driving a blocked op that is ready on-chain', () => {
    const v = validateRequeue(row(), OP_ID, READY, false)
    expect(v.ok).toBe(true)
    expect(v.ok && v.warning).toBeUndefined()
  })

  it('allows a blocked op still inside its delay, with a warning', () => {
    const v = validateRequeue(row(), OP_ID, { ...READY, isReady: false }, false)
    expect(v.ok).toBe(true)
    expect(v.ok && v.warning).toMatch(/delay has not elapsed/)
  })

  // The one refusal --force must never override: re-driving a row whose stored
  // params do not hash to its stored id would act on an unverified operation.
  it('refuses an operationId mismatch even with --force', () => {
    for (const force of [false, true]) {
      const v = validateRequeue(row(), OTHER_OP_ID, READY, force)
      expect(v.ok).toBe(false)
      expect(reasonOf(v)).toMatch(/operationId mismatch/)
    }
  })

  it('refuses a row that is already queued', () => {
    const v = validateRequeue(row({ status: 'queued' }), OP_ID, READY, false)
    expect(v.ok).toBe(false)
    expect(reasonOf(v)).toMatch(/already queued/)
  })

  it('refuses an executed row', () => {
    const v = validateRequeue(row({ status: 'executed' }), OP_ID, READY, false)
    expect(v.ok).toBe(false)
    expect(reasonOf(v)).toMatch(/already executed/)
  })

  it('refuses a cancelled row and points at re-proposing', () => {
    const v = validateRequeue(row({ status: 'cancelled' }), OP_ID, READY, false)
    expect(v.ok).toBe(false)
    expect(reasonOf(v)).toMatch(/re-propose/)
  })

  it('refuses a failed row without --force, surfacing its reason', () => {
    const v = validateRequeue(
      row({
        status: 'failed',
        blockedReason: undefined,
        failureReason: 'operationId mismatch — possible tampered row',
      }),
      OP_ID,
      READY,
      false
    )
    expect(v.ok).toBe(false)
    expect(reasonOf(v)).toMatch(/--force/)
    expect(reasonOf(v)).toMatch(/possible tampered row/)
  })

  it('allows a failed row with --force once the on-chain checks pass', () => {
    const v = validateRequeue(
      row({ status: 'failed', failureReason: 'transient' }),
      OP_ID,
      READY,
      true
    )
    expect(v.ok).toBe(true)
  })

  it('refuses when the op does not exist on the controller', () => {
    const v = validateRequeue(
      row(),
      OP_ID,
      { isOperation: false, isPending: false, isReady: false, isDone: false },
      true
    )
    expect(v.ok).toBe(false)
    expect(reasonOf(v)).toMatch(/never scheduled/)
  })

  it('refuses an op already done on-chain', () => {
    const v = validateRequeue(
      row(),
      OP_ID,
      { isOperation: true, isPending: false, isReady: false, isDone: true },
      true
    )
    expect(v.ok).toBe(false)
    expect(reasonOf(v)).toMatch(/already done on-chain/)
  })

  it('refuses an op cancelled on the controller', () => {
    const v = validateRequeue(
      row(),
      OP_ID,
      { isOperation: true, isPending: false, isReady: false, isDone: false },
      true
    )
    expect(v.ok).toBe(false)
    expect(reasonOf(v)).toMatch(/not pending on-chain/)
  })

  // The executor's own trust check compares these with `!==`, so accepting a
  // case variant here would requeue a row the next executor pass immediately
  // marks `failed` as a tampered row.
  it('requires the stored operationId to match byte-for-byte', () => {
    const v = validateRequeue(
      row({ operationId: OP_ID.toUpperCase().replace('0X', '0x') as Hex }),
      OP_ID,
      READY,
      false
    )
    expect(v.ok).toBe(false)
    expect(reasonOf(v)).toMatch(/byte-for-byte/)
  })

  it('accepts an exactly matching operationId', () => {
    expect(validateRequeue(row(), OP_ID, READY, false).ok).toBe(true)
  })
})
