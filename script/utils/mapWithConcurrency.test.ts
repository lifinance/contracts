import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { mapWithConcurrency } from './mapWithConcurrency'

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms))
      return `${i}:${ms}`
    })
    expect(out).toEqual(['0:30', '1:10', '2:20'])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
      }
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('floors the limit at 1 for non-positive values', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight--
    })
    expect(peak).toBe(1)
  })

  it('passes through undefined item values instead of skipping them', async () => {
    const items = [1, undefined, 3] as (number | undefined)[]
    const seen: (number | undefined)[] = []
    const out = await mapWithConcurrency(items, 2, async (v, i) => {
      seen[i] = v
      return v
    })
    expect(out).toEqual([1, undefined, 3])
    expect(seen).toEqual([1, undefined, 3])
  })

  it('treats a NaN limit as a single worker and still fills every result', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapWithConcurrency([1, 2, 3], Number.NaN, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6])
    expect(peak).toBe(1)
  })

  it('returns an empty array for empty input without invoking the mapper', async () => {
    let called = false
    const out = await mapWithConcurrency([], 4, async () => {
      called = true
      return 1
    })
    expect(out).toEqual([])
    expect(called).toBe(false)
  })

  it('rejects when the mapper throws (Promise.all semantics)', async () => {
    // A real try/catch rather than `expect().rejects` so the awaited value is a
    // genuine Promise — `@typescript-eslint/await-thenable` rejects bun's matcher.
    let error: Error | undefined
    try {
      await mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      })
    } catch (caught) {
      error = caught as Error
    }
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe('boom')
  })
})
