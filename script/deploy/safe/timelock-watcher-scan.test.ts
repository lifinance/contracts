/**
 * Tests for the timelock watcher's log discovery: the scanned interval stays
 * contiguous, every block between the floor and the head is read exactly once
 * the history completes, and a refused range narrows instead of being skipped.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { pad, type Address, type Hex } from 'viem'

import {
  MAX_LOG_SPAN,
  MIN_LOG_SPAN,
  REORG_MARGIN_BLOCKS,
  LogRangeBehindError,
  advanceScan,
  bisectCreationBlock,
  initialScanState,
  isProvenCancelled,
  mergeScheduledLogs,
  type ICallSaltLog,
  type ICancelledLog,
  type IScanDependencies,
  type IScannedOperation,
  type IScheduledCallLog,
} from './timelock-watcher-scan'

const TIMELOCK: Address = '0x5604A94A3438C3074EFFF803fab14B7244fe4E29'
const TARGET: Address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const ZERO32: Hex = `0x${'0'.repeat(64)}`
const id = (n: number): Hex => pad(`0x${n.toString(16)}`, { size: 32 })

const logsOf = (
  scheduled: IScheduledCallLog[],
  salts: ICallSaltLog[] = [],
  cancels: ICancelledLog[] = []
) => ({ scheduled, salts, cancels })

const scheduledAt = (
  blockNumber: bigint,
  opId: Hex,
  index = 0n
): IScheduledCallLog => ({
  id: opId,
  index,
  target: TARGET,
  value: 0n,
  data: '0x12345678',
  predecessor: ZERO32,
  delay: 10_800n,
  blockNumber,
})

/**
 * A chain whose endpoint refuses ranges wider than `maxSpan`, recording every
 * range it served.
 */
const chain = (options: {
  head: bigint
  floor: bigint
  logs: IScheduledCallLog[]
  salts?: (ICallSaltLog & { blockNumber: bigint })[]
  cancels?: ICancelledLog[]
  maxSpan?: bigint
}): IScanDependencies & { served: [bigint, bigint][]; refused: number } => {
  const served: [bigint, bigint][] = []
  const deps = {
    served,
    refused: 0,
    head: async () => options.head,
    floor: async () => options.floor,
    getLogs: async (from: bigint, to: bigint) => {
      if (options.maxSpan !== undefined && to - from + 1n > options.maxSpan) {
        deps.refused++
        throw new Error('range too wide')
      }
      served.push([from, to])
      return {
        scheduled: options.logs.filter(
          (l) => l.blockNumber >= from && l.blockNumber <= to
        ),
        salts: (options.salts ?? []).filter(
          (s) => s.blockNumber >= from && s.blockNumber <= to
        ),
        cancels: (options.cancels ?? []).filter(
          (c) => c.blockNumber >= from && c.blockNumber <= to
        ),
      }
    },
  }
  return deps
}

/** Whether the served ranges cover `[from, to]` with no gap. */
const covers = (
  served: readonly [bigint, bigint][],
  from: bigint,
  to: bigint
): boolean => {
  const sorted = [...served].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  let next = from
  for (const [start, end] of sorted) {
    if (start > next) return false
    if (end + 1n > next) next = end + 1n
  }
  return next > to
}

describe('initialScanState', () => {
  it('keeps the previous state for the same timelock, in any casing', () => {
    const previous = { timelock: TIMELOCK, high: '5', operations: {} }
    expect(initialScanState(previous, TIMELOCK.toLowerCase() as Address)).toBe(
      previous
    )
  })

  it('starts afresh when the timelock changed', () => {
    const previous = { timelock: TARGET, high: '5', operations: {} }
    expect(initialScanState(previous, TIMELOCK)).toEqual({
      timelock: TIMELOCK,
      operations: {},
    })
  })

  it('starts afresh with no previous state', () => {
    expect(initialScanState(undefined, TIMELOCK).operations).toEqual({})
  })
})

const opIn = (
  ops: Record<string, IScannedOperation>,
  key: string
): IScannedOperation => {
  const op = ops[key]
  if (!op) throw new Error(`no operation ${key}`)
  return op
}

describe('mergeScheduledLogs', () => {
  it('groups calls by id in index order, with the salt of its CallSalt', () => {
    const salt = pad('0x77', { size: 32 })
    const merged = mergeScheduledLogs(
      {},
      logsOf(
        [scheduledAt(10n, id(1), 1n), scheduledAt(10n, id(1), 0n)],
        [{ id: id(1), salt }]
      )
    )
    const op = merged[id(1)]
    expect(op?.calls.map((c) => c.index)).toEqual([0, 1])
    expect(op?.salt).toBe(salt)
    expect(op?.delay).toBe('10800')
  })

  it('leaves the salt zero when no CallSalt was logged', () => {
    const merged = mergeScheduledLogs({}, logsOf([scheduledAt(10n, id(2))]))
    expect(merged[id(2)]?.salt).toBe(ZERO32)
  })

  it('does not duplicate a call read twice, and keeps the latest block', () => {
    const once = mergeScheduledLogs({}, logsOf([scheduledAt(10n, id(3))]))
    const twice = mergeScheduledLogs(once, logsOf([scheduledAt(12n, id(3))]))
    expect(twice[id(3)]?.calls).toHaveLength(1)
    expect(twice[id(3)]?.blockNumber).toBe('12')
    const older = mergeScheduledLogs(twice, logsOf([scheduledAt(9n, id(3))]))
    expect(older[id(3)]?.blockNumber).toBe('12')
  })

  it('keeps the delay of the newest schedule, whichever order the logs arrive in', async () => {
    const old = { ...scheduledAt(10n, id(5)), delay: 604_800n }
    const rescheduled = { ...scheduledAt(20n, id(5)), delay: 60n }
    const newestFirst = mergeScheduledLogs(
      mergeScheduledLogs({}, logsOf([rescheduled])),
      logsOf([old])
    )
    const oldestFirst = mergeScheduledLogs(
      mergeScheduledLogs({}, logsOf([old])),
      logsOf([rescheduled])
    )
    expect(newestFirst[id(5)]?.delay).toBe('60')
    expect(oldestFirst[id(5)]?.delay).toBe('60')
  })

  it('proves a cancel only when it follows the latest schedule', () => {
    const cancelled = mergeScheduledLogs(
      {},
      logsOf([scheduledAt(10n, id(6))], [], [{ id: id(6), blockNumber: 15n }])
    )
    expect(isProvenCancelled(opIn(cancelled, id(6)))).toBe(true)
    const rescheduled = mergeScheduledLogs(
      cancelled,
      logsOf([scheduledAt(20n, id(6))])
    )
    expect(isProvenCancelled(opIn(rescheduled, id(6)))).toBe(false)
    const never = mergeScheduledLogs({}, logsOf([scheduledAt(10n, id(7))]))
    expect(isProvenCancelled(opIn(never, id(7)))).toBe(false)
  })

  it('proves a cancel read in an earlier run than its schedule', async () => {
    const deps = chain({
      head: 10_000n,
      floor: 0n,
      maxSpan: 1_000n,
      logs: [scheduledAt(500n, id(3))],
      cancels: [{ id: id(3), blockNumber: 9_500n }],
    })
    const start = {
      ...initialScanState(undefined, TIMELOCK),
      floor: '0',
      low: '10000',
      high: '10000',
      span: '1000',
    }
    const first = await advanceScan(start, deps, 2)
    expect(first.state.operations[id(3)]).toBeUndefined()
    const second = await advanceScan(first.state, deps, 100)
    const op = opIn(second.state.operations, id(3))
    expect(isProvenCancelled(op)).toBe(false)
    expect(isProvenCancelled(op, second.state.cancels)).toBe(true)
  })

  it('keeps the latest cancel, and ignores one for an unknown id', () => {
    const merged = mergeScheduledLogs(
      {},
      logsOf(
        [scheduledAt(10n, id(8))],
        [],
        [
          { id: id(8), blockNumber: 30n },
          { id: id(8), blockNumber: 12n },
          { id: id(9), blockNumber: 40n },
        ]
      )
    )
    expect(merged[id(8)]?.cancelledInBlock).toBe('30')
    expect(merged[id(9)]).toBeUndefined()
  })

  it('ignores a CallSalt for an id it has no schedule for', () => {
    const merged = mergeScheduledLogs(
      {},
      logsOf([], [{ id: id(4), salt: ZERO32 }])
    )
    expect(merged).toEqual({})
  })
})

describe('advanceScan', () => {
  it('reads the whole history in one run when the budget allows', async () => {
    const deps = chain({
      head: 1_000n,
      floor: 100n,
      logs: [scheduledAt(150n, id(1)), scheduledAt(999n, id(2))],
    })
    const outcome = await advanceScan(
      initialScanState(undefined, TIMELOCK),
      deps,
      10
    )
    expect(outcome.historyComplete).toBe(true)
    expect(Object.keys(outcome.state.operations).sort()).toEqual(
      [id(1), id(2)].sort()
    )
    expect(covers(deps.served, 100n, 1_000n)).toBe(true)
    expect(outcome.scheduledLogs).toBe(2)
  })

  it('does not look below the floor', async () => {
    const deps = chain({
      head: 1_000n,
      floor: 100n,
      logs: [scheduledAt(50n, id(9))],
    })
    const outcome = await advanceScan(
      initialScanState(undefined, TIMELOCK),
      deps,
      10
    )
    expect(outcome.state.operations).toEqual({})
    expect(deps.served.every(([from]) => from >= 100n)).toBe(true)
  })

  it('narrows a refused range instead of skipping it', async () => {
    const deps = chain({
      head: 100_000n,
      floor: 0n,
      maxSpan: 1_000n,
      logs: [scheduledAt(12_345n, id(1))],
    })
    const outcome = await advanceScan(
      initialScanState(undefined, TIMELOCK),
      deps,
      500
    )
    expect(deps.refused).toBeGreaterThan(0)
    expect(outcome.historyComplete).toBe(true)
    expect(outcome.state.operations[id(1)]).toBeDefined()
    expect(covers(deps.served, 0n, 100_000n)).toBe(true)
    expect(BigInt(outcome.state.span ?? '0')).toBeLessThanOrEqual(1_000n)
  })

  it('reports a history range no endpoint serves as incomplete, not covered', async () => {
    const deps = chain({
      head: 100_000n,
      floor: 0n,
      maxSpan: MIN_LOG_SPAN - 1n,
      logs: [],
    })
    const outcome = await advanceScan(
      initialScanState(undefined, TIMELOCK),
      deps,
      50
    )
    expect(outcome.historyComplete).toBe(false)
    expect(outcome.historyError).toContain('range too wide')
    expect(outcome.state.low).toBe('100000')
  })

  it('throws when the forward leg cannot be read, rather than skipping new blocks', async () => {
    const deps = chain({
      head: 100_000n,
      floor: 0n,
      maxSpan: MIN_LOG_SPAN - 1n,
      logs: [],
    })
    let thrown: unknown
    try {
      await advanceScan(
        {
          ...initialScanState(undefined, TIMELOCK),
          floor: '0',
          low: '0',
          high: '99000',
        },
        deps,
        50
      )
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('range too wide')
  })

  it('stops history at the budget, keeps the interval contiguous, and resumes', async () => {
    const logs = [scheduledAt(5_500n, id(1)), scheduledAt(500n, id(2))]
    const deps = chain({ head: 10_000n, floor: 0n, maxSpan: 1_000n, logs })
    const first = await advanceScan(
      initialScanState(undefined, TIMELOCK),
      deps,
      6
    )
    expect(first.historyComplete).toBe(false)
    expect(first.state.operations[id(2)]).toBeUndefined()
    const low = BigInt(first.state.low ?? '0')
    expect(covers(deps.served, low, 10_000n)).toBe(true)

    const second = await advanceScan(first.state, deps, 100)
    expect(second.historyComplete).toBe(true)
    expect(second.state.operations[id(1)]).toBeDefined()
    expect(second.state.operations[id(2)]).toBeDefined()
    expect(covers(deps.served, 0n, 10_000n)).toBe(true)
  })

  it('stops history at the deadline, and not before it', async () => {
    const deps = chain({ head: 10_000n, floor: 0n, maxSpan: 1_000n, logs: [] })
    const expired = await advanceScan(
      initialScanState(undefined, TIMELOCK),
      deps,
      1_000,
      { until: 10, now: () => 11 }
    )
    expect(expired.historyComplete).toBe(false)
    const open = await advanceScan(
      initialScanState(undefined, TIMELOCK),
      deps,
      1_000,
      { until: 10, now: () => 9 }
    )
    expect(open.historyComplete).toBe(true)
  })

  it('reads history ranges in parallel and keeps only the contiguous answered run', async () => {
    const logs = [scheduledAt(2_500n, id(7)), scheduledAt(500n, id(8))]
    const deps = chain({ head: 10_000n, floor: 0n, maxSpan: 1_000n, logs })
    const flaky = deps.getLogs
    let failedOnce = false
    deps.getLogs = async (from, to) => {
      if (!failedOnce && from <= 5_000n && to >= 5_000n) {
        failedOnce = true
        throw new Error('transient')
      }
      return flaky(from, to)
    }
    const outcome = await advanceScan(
      {
        ...initialScanState(undefined, TIMELOCK),
        floor: '0',
        low: '10000',
        high: '10000',
        span: '1000',
      },
      deps,
      1_000,
      { parallel: 4 }
    )
    expect(failedOnce).toBe(true)
    expect(outcome.historyComplete).toBe(true)
    expect(outcome.state.operations[id(7)]).toBeDefined()
    expect(outcome.state.operations[id(8)]).toBeDefined()
    expect(covers(deps.served, 0n, 10_000n)).toBe(true)
  })

  it('never reports history below a range that failed as covered', async () => {
    const deps = chain({ head: 10_000n, floor: 0n, maxSpan: 1_000n, logs: [] })
    const real = deps.getLogs
    deps.getLogs = async (from, to) => {
      if (from <= 7_000n && to >= 7_000n) throw new Error('hole')
      return real(from, to)
    }
    const outcome = await advanceScan(
      {
        ...initialScanState(undefined, TIMELOCK),
        floor: '0',
        low: '10000',
        high: '10000',
        span: '1000',
      },
      deps,
      1_000,
      { parallel: 4 }
    )
    expect(outcome.historyError).toContain('hole')
    expect(outcome.historyComplete).toBe(false)
    expect(BigInt(outcome.state.low ?? '0')).toBeGreaterThan(7_000n)
  })

  it('stops a parallel window at the budget', async () => {
    // One call goes on the widened span the endpoint refuses, three on 1000-block ranges.
    const deps = chain({ head: 10_000n, floor: 0n, maxSpan: 1_000n, logs: [] })
    const outcome = await advanceScan(
      {
        ...initialScanState(undefined, TIMELOCK),
        floor: '0',
        low: '10000',
        high: '10000',
        span: '1000',
      },
      deps,
      4,
      { parallel: 8 }
    )
    expect(outcome.state.low).toBe('7000')
    expect(outcome.historyComplete).toBe(false)
  })

  it('always runs the forward leg to the head, whatever the history budget', async () => {
    const deps = chain({
      head: 20_000n,
      floor: 0n,
      maxSpan: 1_000n,
      logs: [scheduledAt(19_500n, id(5))],
    })
    const previous = {
      ...initialScanState(undefined, TIMELOCK),
      floor: '0',
      low: '0',
      high: '10000',
      span: '1000',
    }
    const outcome = await advanceScan(previous, deps, 0)
    expect(outcome.state.high).toBe('20000')
    expect(outcome.state.operations[id(5)]).toBeDefined()
  })

  it('stops the forward leg at the deadline and keeps what it read, so a long gap is caught up over runs', async () => {
    const deps = chain({
      head: 20_000n,
      floor: 0n,
      maxSpan: 1_000n,
      logs: [scheduledAt(19_500n, id(5))],
    })
    const previous = {
      ...initialScanState(undefined, TIMELOCK),
      floor: '0',
      low: '0',
      high: '10000',
      span: '1000',
    }
    let calls = 0
    const outcome = await advanceScan(previous, deps, 0, {
      until: 4,
      now: () => calls++,
    })
    expect(BigInt(outcome.state.high ?? 0)).toBeGreaterThan(10_000n)
    expect(BigInt(outcome.state.high ?? 0)).toBeLessThan(20_000n)
    expect(outcome.forwardLag).toBe(20_000n - BigInt(outcome.state.high ?? 0))
    expect(covers(deps.served, 9_744n, BigInt(outcome.state.high ?? 0))).toBe(
      true
    )

    const next = await advanceScan(outcome.state, deps, 0)
    expect(next.state.high).toBe('20000')
    expect(next.forwardLag).toBe(0n)
    expect(next.state.operations[id(5)]).toBeDefined()
  })

  it('stops, without narrowing the span, where no endpoint has reached the range yet', async () => {
    const base = chain({ head: 20_000n, floor: 0n, logs: [] })
    const deps = {
      ...base,
      getLogs: async (from: bigint, to: bigint) => {
        if (to > 19_990n) throw new LogRangeBehindError('behind')
        return base.getLogs(from, to)
      },
    }
    const outcome = await advanceScan(
      {
        ...initialScanState(undefined, TIMELOCK),
        floor: '0',
        low: '0',
        high: '10000',
        span: '100000',
      },
      deps,
      0
    )
    expect(outcome.state.high).toBe('10000')
    expect(outcome.state.span).toBe('1000000')
    expect(outcome.forwardLag).toBe(10_000n)
  })

  it('does not save a creation block it could not resolve, so the next run retries it', async () => {
    let asked = 0
    const deps = {
      ...chain({ head: 1_000n, floor: 0n, logs: [] }),
      floor: async () => {
        asked++
        return undefined
      },
    }
    const first = await advanceScan(
      initialScanState(undefined, TIMELOCK),
      deps,
      10
    )
    expect(first.state.floor).toBeUndefined()
    await advanceScan(first.state, deps, 10)
    expect(asked).toBe(2)
  })

  it('re-reads the reorg margin below the previous head', async () => {
    const reorged = 10_000n - REORG_MARGIN_BLOCKS / 2n
    const deps = chain({
      head: 10_100n,
      floor: 0n,
      logs: [scheduledAt(reorged, id(6))],
    })
    const previous = {
      ...initialScanState(undefined, TIMELOCK),
      floor: '0',
      low: '0',
      high: '10000',
    }
    const outcome = await advanceScan(previous, deps, 0)
    expect(outcome.state.operations[id(6)]).toBeDefined()
    expect(deps.served[0]?.[0]).toBe(10_000n - REORG_MARGIN_BLOCKS)
  })

  it('starts at the widest span and reuses the span that worked', async () => {
    const deps = chain({ head: 10n, floor: 0n, logs: [] })
    const outcome = await advanceScan(
      initialScanState(undefined, TIMELOCK),
      deps,
      5
    )
    expect(outcome.state.span).toBe(MAX_LOG_SPAN.toString())
  })

  it('tries one step wider than the stored span, and settles back when refused', async () => {
    const refusing = chain({
      head: 20_000n,
      floor: 0n,
      maxSpan: 1_000n,
      logs: [],
    })
    const narrow = await advanceScan(
      {
        ...initialScanState(undefined, TIMELOCK),
        floor: '0',
        low: '0',
        high: '10000',
        span: '1000',
      },
      refusing,
      10
    )
    expect(refusing.refused).toBe(1)
    expect(narrow.state.span).toBe('1000')

    const accepting = chain({ head: 20_000n, floor: 0n, logs: [] })
    const wide = await advanceScan(
      {
        ...initialScanState(undefined, TIMELOCK),
        floor: '0',
        low: '0',
        high: '10000',
        span: '100',
      },
      accepting,
      10
    )
    expect(wide.state.span).toBe('1000')
  })

  it('reuses a stored floor rather than resolving it again', async () => {
    let resolved = 0
    const deps = chain({ head: 10n, floor: 0n, logs: [] })
    deps.floor = async () => {
      resolved++
      return 0n
    }
    await advanceScan(
      { ...initialScanState(undefined, TIMELOCK), floor: '3' },
      deps,
      5
    )
    expect(resolved).toBe(0)
  })
})

describe('bisectCreationBlock', () => {
  it('finds the first block with code', async () => {
    expect(await bisectCreationBlock(1_000n, async (b) => b >= 777n)).toBe(777n)
    expect(await bisectCreationBlock(1_000n, async () => true)).toBe(0n)
    expect(await bisectCreationBlock(1_000n, async (b) => b >= 1_000n)).toBe(
      1_000n
    )
  })

  it('throws when there is no code at the head', async () => {
    let thrown: unknown
    try {
      await bisectCreationBlock(1_000n, async () => false)
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('no code')
  })
})
