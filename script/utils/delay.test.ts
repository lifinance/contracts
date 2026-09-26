import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { INTER_CALL_DELAY } from '../deploy/shared/constants'

import { sleep } from './delay'

const originalSetTimeout = globalThis.setTimeout

describe('sleep', () => {
  let scheduled: { callback: () => void; delay: number | undefined }[]

  beforeEach(() => {
    scheduled = []
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      scheduled.push({ callback, delay })
      return 0
    }) as unknown as typeof globalThis.setTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it('defaults to INTER_CALL_DELAY when called without an argument', () => {
    void sleep()
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.delay).toBe(INTER_CALL_DELAY)
  })

  it('schedules exactly the requested duration', () => {
    void sleep(1_234)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.delay).toBe(1_234)
  })

  it('falls back to the default when passed undefined explicitly', () => {
    void sleep(undefined)
    expect(scheduled[0]?.delay).toBe(INTER_CALL_DELAY)
  })

  it('does not resolve before the timer fires', async () => {
    let resolved = false
    const pending = sleep(100).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    scheduled[0]?.callback()
    await pending
    expect(resolved).toBe(true)
  })

  it('resolves with undefined', async () => {
    const pending = sleep(10)
    scheduled[0]?.callback()
    expect(await pending).toBeUndefined()
  })

  it.each([0, -1, Number.NaN])(
    'passes the edge-case duration %p through without throwing',
    async (ms) => {
      const pending = sleep(ms)
      expect(scheduled).toHaveLength(1)
      expect(scheduled[0]?.delay).toBe(ms)
      scheduled[0]?.callback()
      expect(await pending).toBeUndefined()
    }
  )

  it('resolves after a real timer elapses', async () => {
    globalThis.setTimeout = originalSetTimeout
    const start = performance.now()
    await sleep(20)
    expect(performance.now() - start).toBeGreaterThanOrEqual(15)
  })
})
