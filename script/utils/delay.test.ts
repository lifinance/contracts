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

describe('sleep', () => {
  const originalSetTimeout = globalThis.setTimeout
  let requestedDelays: Array<number | undefined>

  beforeEach(() => {
    requestedDelays = []
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      requestedDelays.push(ms)
      return originalSetTimeout(handler, 0)
    }) as typeof setTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it('schedules exactly the requested duration', async () => {
    await sleep(1234)
    expect(requestedDelays).toEqual([1234])
  })

  it('defaults to INTER_CALL_DELAY when called without an argument', async () => {
    await sleep()
    expect(requestedDelays).toEqual([INTER_CALL_DELAY])
  })

  it('treats an explicit undefined as the default', async () => {
    await sleep(undefined)
    expect(requestedDelays).toEqual([INTER_CALL_DELAY])
  })

  it('resolves with undefined', async () => {
    const result = await sleep(0)
    expect(result).toBeUndefined()
  })

  it.each([0, -50, Number.NaN])(
    'resolves instead of rejecting for degenerate duration %p',
    async (ms) => {
      await sleep(ms)
      expect(requestedDelays).toHaveLength(1)
      expect(requestedDelays[0]).toBe(ms)
    }
  )

  it('returns a pending promise that only settles once the timer fires', async () => {
    let fireTimer: (() => void) | undefined
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      requestedDelays.push(ms)
      fireTimer = handler
      return 0
    }) as unknown as typeof setTimeout

    let settled = false
    const pending = sleep(40).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(requestedDelays).toEqual([40])

    fireTimer?.()
    await pending
    expect(settled).toBe(true)
  })

  it('actually waits at least the requested duration', async () => {
    globalThis.setTimeout = originalSetTimeout
    const start = performance.now()
    await sleep(30)
    // Timer granularity can fire a millisecond early on some platforms
    expect(performance.now() - start).toBeGreaterThanOrEqual(29)
  })
})
