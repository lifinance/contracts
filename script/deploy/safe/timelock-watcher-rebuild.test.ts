/**
 * Tests for the timelock watcher's gate K rebuild gate: the budget holds under
 * concurrency, one rebuild runs at a time, and a caller's deadline is kept.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  WatcherTimeoutError,
  createRebuildGate,
  withTimeout,
} from './timelock-watcher-rebuild'

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const far = (): number => Date.now() + 60_000

describe('withTimeout', () => {
  it('resolves with the value of work that finishes in time', async () => {
    expect(await withTimeout(Promise.resolve(7), 50, 'x')).toBe(7)
  })

  it('rejects with a WatcherTimeoutError on overrun, and passes other errors through', async () => {
    let overrun: unknown
    try {
      await withTimeout(wait(200), 10, 'slow')
    } catch (error) {
      overrun = error
    }
    expect(overrun).toBeInstanceOf(WatcherTimeoutError)

    let failure: unknown
    try {
      await withTimeout(Promise.reject(new Error('boom')), 50, 'x')
    } catch (error) {
      failure = error
    }
    expect(failure).not.toBeInstanceOf(WatcherTimeoutError)
    expect(String(failure)).toContain('boom')
  })
})

describe('createRebuildGate', () => {
  it('never starts more rebuilds than its budget, however many callers wait', async () => {
    const gate = createRebuildGate({
      budget: 3,
      timeoutMs: 1_000,
      describe: describeError,
      pollMs: 1,
    })
    let started = 0
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        gate.run(async () => {
          started++
          await wait(5)
          return started
        }, far())
      )
    )
    expect(started).toBe(3)
    expect(gate.left()).toBe(0)
    expect(outcomes.filter((o) => o.kind === 'done')).toHaveLength(3)
    expect(outcomes.filter((o) => o.kind === 'deferred')).toHaveLength(9)
  })

  it('runs one rebuild at a time', async () => {
    const gate = createRebuildGate({
      budget: 5,
      timeoutMs: 1_000,
      describe: describeError,
      pollMs: 1,
    })
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 5 }, () =>
        gate.run(async () => {
          active++
          peak = Math.max(peak, active)
          await wait(5)
          active--
        }, far())
      )
    )
    expect(peak).toBe(1)
  })

  it('keeps the slot while a timed-out rebuild still runs, and defers a caller whose deadline arrives', async () => {
    const gate = createRebuildGate({
      budget: 5,
      timeoutMs: 20,
      describe: describeError,
      pollMs: 1,
    })
    const overrunning = gate.run(() => wait(300), far())
    const first = await overrunning
    expect(first.kind).toBe('timed-out')

    let ran = false
    const next = await gate.run(async () => {
      ran = true
    }, Date.now() + 60)
    expect(next.kind).toBe('deferred')
    expect(ran).toBe(false)
  })

  it('defers rather than starting a rebuild that cannot finish before the deadline', async () => {
    const gate = createRebuildGate({
      budget: 5,
      timeoutMs: 1_000,
      describe: describeError,
    })
    let ran = false
    const outcome = await gate.run(async () => {
      ran = true
    }, Date.now() + 500)
    expect(outcome.kind).toBe('deferred')
    expect(ran).toBe(false)
    expect(gate.left()).toBe(5)
  })

  it('reports a failing rebuild as failed, not timed out, and frees the slot', async () => {
    const gate = createRebuildGate({
      budget: 5,
      timeoutMs: 1_000,
      describe: describeError,
      pollMs: 1,
    })
    const failed = await gate.run(async () => {
      throw new Error('forge exploded')
    }, far())
    expect(failed).toEqual({
      kind: 'failed',
      reason: 'gate K could not be evaluated: forge exploded',
    })
    const after = await gate.run(async () => 'ok', far())
    expect(after).toEqual({ kind: 'done', value: 'ok' })
  })
})
