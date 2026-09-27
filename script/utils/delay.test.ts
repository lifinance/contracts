import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { INTER_CALL_DELAY } from '../deploy/shared/constants'

import { sleep } from './delay'

const originalSetTimeout = globalThis.setTimeout

async function expectRejects(
  promise: Promise<unknown>,
  match: string
): Promise<void> {
  try {
    await promise
  } catch (error) {
    expect((error as Error).message).toContain(match)
    return
  }
  throw new Error(`Expected rejection matching "${match}"`)
}

function captureTimeouts(): {
  delays: Array<number | undefined>
  fire: () => void
} {
  const delays: Array<number | undefined> = []
  const callbacks: Array<() => void> = []
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    delays.push(ms)
    callbacks.push(callback)
    return 0
  }) as unknown as typeof globalThis.setTimeout
  return {
    delays,
    fire: () => callbacks.splice(0).forEach((callback) => callback()),
  }
}

describe('sleep', () => {
  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it('defaults to INTER_CALL_DELAY when called without an argument', async () => {
    const timers = captureTimeouts()
    const pending = sleep()
    expect(timers.delays).toEqual([INTER_CALL_DELAY])
    timers.fire()
    await pending
  })

  it('passes an explicit duration through to setTimeout', async () => {
    const timers = captureTimeouts()
    const pending = sleep(1234)
    expect(timers.delays).toEqual([1234])
    timers.fire()
    await pending
  })

  it('uses the default when undefined is passed explicitly', async () => {
    const timers = captureTimeouts()
    const pending = sleep(undefined)
    expect(timers.delays).toEqual([INTER_CALL_DELAY])
    timers.fire()
    await pending
  })

  it('stays pending until the timer fires', async () => {
    const timers = captureTimeouts()
    let settled = false
    const pending = sleep(1000).then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    timers.fire()
    await pending
    expect(settled).toBe(true)
  })

  it('resolves with undefined', async () => {
    expect(await sleep(0)).toBeUndefined()
  })

  it('waits at least roughly the requested duration with real timers', async () => {
    const start = performance.now()
    await sleep(50)
    expect(performance.now() - start).toBeGreaterThanOrEqual(40)
  })

  it('resolves promptly for zero, negative and NaN durations', async () => {
    const start = performance.now()
    await Promise.all([sleep(0), sleep(-100), sleep(Number.NaN)])
    expect(performance.now() - start).toBeLessThan(100)
  })

  it('rejects when scheduling the timer throws', async () => {
    globalThis.setTimeout = (() => {
      throw new Error('timer unavailable')
    }) as unknown as typeof globalThis.setTimeout
    await expectRejects(sleep(10), 'timer unavailable')
  })
})
