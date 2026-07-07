import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { confirmTimelockExecution } from './confirm-timelock-execution'

/** Builds an isOperationDone stub returning the given results in order (sticky last value). */
function isOperationDoneStub(results: Array<boolean | Error>): {
  isOperationDone: () => Promise<boolean>
  calls: () => number
} {
  let callCount = 0
  return {
    isOperationDone: async () => {
      const result =
        results[Math.min(callCount, results.length - 1)] ?? new Error('empty')
      callCount++
      if (result instanceof Error) throw result
      return result
    },
    calls: () => callCount,
  }
}

const FAST_POLL = { attempts: 3, delayMs: 1 }

describe('confirmTimelockExecution', () => {
  it('returns reverted for a reverted receipt without checking on-chain state', async () => {
    const stub = isOperationDoneStub([true])

    const result = await confirmTimelockExecution({
      receipt: { status: 'reverted' },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(result).toBe('reverted')
    expect(stub.calls()).toBe(0)
  })

  it('returns confirmed for a success receipt once isOperationDone is true', async () => {
    const stub = isOperationDoneStub([true])

    const result = await confirmTimelockExecution({
      receipt: { status: 'success' },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(result).toBe('confirmed')
    expect(stub.calls()).toBe(1)
  })

  it('returns unconfirmed for a success receipt when isOperationDone stays false', async () => {
    const stub = isOperationDoneStub([false])

    const result = await confirmTimelockExecution({
      receipt: { status: 'success' },
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(result).toBe('unconfirmed')
    expect(stub.calls()).toBe(3)
  })

  it('returns confirmed without a receipt when isOperationDone is true on first poll', async () => {
    const stub = isOperationDoneStub([true])

    const result = await confirmTimelockExecution({
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(result).toBe('confirmed')
    expect(stub.calls()).toBe(1)
  })

  it('keeps polling without a receipt until isOperationDone turns true', async () => {
    const stub = isOperationDoneStub([false, false, true])

    const result = await confirmTimelockExecution({
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(result).toBe('confirmed')
    expect(stub.calls()).toBe(3)
  })

  it('returns unconfirmed without a receipt after exhausting all attempts', async () => {
    const stub = isOperationDoneStub([false])

    const result = await confirmTimelockExecution({
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(result).toBe('unconfirmed')
    expect(stub.calls()).toBe(3)
  })

  it('tolerates transient isOperationDone errors and still confirms', async () => {
    const stub = isOperationDoneStub([new Error('rpc hiccup'), true])

    const result = await confirmTimelockExecution({
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(result).toBe('confirmed')
    expect(stub.calls()).toBe(2)
  })

  it('returns unconfirmed when every isOperationDone check throws', async () => {
    const stub = isOperationDoneStub([new Error('rpc down')])

    const result = await confirmTimelockExecution({
      isOperationDone: stub.isOperationDone,
      ...FAST_POLL,
    })

    expect(result).toBe('unconfirmed')
    expect(stub.calls()).toBe(3)
  })

  it('returns unconfirmed without polling when attempts is zero', async () => {
    const stub = isOperationDoneStub([true])

    const result = await confirmTimelockExecution({
      isOperationDone: stub.isOperationDone,
      attempts: 0,
      delayMs: 1,
    })

    expect(result).toBe('unconfirmed')
    expect(stub.calls()).toBe(0)
  })
})
