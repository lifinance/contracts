import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type Collection } from 'mongodb'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { TIMELOCK_SCHEDULE_BATCH_ABI } from './timelock-abi'
import {
  BLOCKED_ALERT_INTERVAL_MS,
  classifyBlockedRow,
  byOperationId,
  computeOperationIdBatch,
  decodeScheduleBatch,
  deserializeScheduleParams,
  ensureTimelockQueueIndexes,
  isScheduleBatchCalldata,
  queueStatusReason,
  selectBlockedNeedingAlert,
  serializeScheduleParams,
  TIMELOCK_QUEUE_STATUSES,
  type IBlockedOpCandidate,
  type IScheduleBatchParams,
  type ITimelockQueueDoc,
} from './timelock-queue'

async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp | string
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  if (match instanceof RegExp) expect(error?.message).toMatch(match)
  else expect(error?.message).toContain(match)
}

interface IFakeIndexOptions {
  /** When set, every `createIndex` call rejects with this error. */
  createIndexError?: Error
  /** Index descriptors `listIndexes().toArray()` returns (default: none). */
  existingIndexes?: { name: string }[]
  /** When set, `listIndexes().toArray()` rejects with this error. */
  listIndexesError?: Error
}

type IFakeIndexCollection = Collection<ITimelockQueueDoc> & {
  createIndexCalls: { spec: unknown; options: unknown }[]
}

/**
 * In-memory stand-in for the queue collection exercising the index path only:
 * records every `createIndex` call and lets a test inject a `createIndex`
 * failure, the `listIndexes` result, or a `listIndexes` failure — the three
 * inputs `safeCreateIndex`'s authorization-degradation branch reads.
 */
function createFakeIndexCollection(
  options: IFakeIndexOptions = {}
): IFakeIndexCollection {
  const createIndexCalls: { spec: unknown; options: unknown }[] = []
  const api = {
    collectionName: 'queue',
    createIndexCalls,
    async createIndex(spec: unknown, opts: unknown): Promise<string> {
      createIndexCalls.push({ spec, options: opts })
      if (options.createIndexError) throw options.createIndexError
      return (opts as { name: string }).name
    },
    listIndexes() {
      return {
        async toArray(): Promise<{ name: string }[]> {
          if (options.listIndexesError) throw options.listIndexesError
          return options.existingIndexes ?? []
        },
      }
    },
  }
  return api as unknown as IFakeIndexCollection
}

const ZERO_BYTES32 =
  // pre-commit-checker: not a secret — zero bytes32 sentinel used as test fixture
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

const SAMPLE_TARGET = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address
const SAMPLE_PAYLOAD = '0xdeadbeef' as Hex

function buildScheduleBatchCalldata(params: IScheduleBatchParams): Hex {
  return encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      params.targets as Address[],
      params.values as bigint[],
      params.payloads as Hex[],
      params.predecessor,
      params.salt,
      params.delay,
    ],
  })
}

describe('isScheduleBatchCalldata', () => {
  it('returns true for known scheduleBatch selector', () => {
    const data = buildScheduleBatchCalldata({
      targets: [SAMPLE_TARGET],
      values: [0n],
      payloads: [SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: ZERO_BYTES32,
      delay: 3600n,
    })
    expect(isScheduleBatchCalldata(data)).toBe(true)
  })

  it('is case-insensitive on the selector', () => {
    const data = buildScheduleBatchCalldata({
      targets: [SAMPLE_TARGET],
      values: [0n],
      payloads: [SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: ZERO_BYTES32,
      delay: 3600n,
    })
    const upper = (data.slice(0, 2) +
      data.slice(2).toUpperCase()) as unknown as Hex
    expect(isScheduleBatchCalldata(upper)).toBe(true)
  })

  it('returns false for non-scheduleBatch selector', () => {
    expect(isScheduleBatchCalldata('0xdeadbeef')).toBe(false)
  })

  it('returns false for short or missing input', () => {
    expect(isScheduleBatchCalldata(undefined)).toBe(false)
    expect(isScheduleBatchCalldata('')).toBe(false)
    expect(isScheduleBatchCalldata('0x12')).toBe(false)
  })
})

describe('decodeScheduleBatch', () => {
  it('round-trips encoded scheduleBatch params', () => {
    const expected: IScheduleBatchParams = {
      targets: [SAMPLE_TARGET, '0x000000000000000000000000000000000000bEEF'],
      values: [0n, 1n],
      payloads: ['0x' as Hex, SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: `0x${'1'.repeat(64)}` as Hex,
      delay: 86_400n,
    }
    const data = buildScheduleBatchCalldata(expected)
    const decoded = decodeScheduleBatch(data)
    expect(decoded.targets).toEqual(expected.targets)
    expect(decoded.values).toEqual(expected.values)
    expect(decoded.payloads).toEqual(expected.payloads)
    expect(decoded.predecessor).toBe(expected.predecessor)
    expect(decoded.salt).toBe(expected.salt)
    expect(decoded.delay).toBe(expected.delay)
  })

  it('throws for non-scheduleBatch calldata', () => {
    expect(() => decodeScheduleBatch('0xdeadbeef' as Hex)).toThrow()
  })
})

describe('computeOperationIdBatch', () => {
  it('is deterministic for identical inputs', () => {
    const id1 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    const id2 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    expect(id1).toBe(id2)
  })

  it('changes when salt changes', () => {
    const id1 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    const id2 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      `0x${'a'.repeat(64)}` as Hex
    )
    expect(id1).not.toBe(id2)
  })

  it('changes when payload bytes change', () => {
    const id1 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      ['0x01' as Hex],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    const id2 = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      ['0x02' as Hex],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    expect(id1).not.toBe(id2)
  })

  it('returns a 32-byte hex string', () => {
    const id = computeOperationIdBatch(
      [SAMPLE_TARGET],
      [0n],
      [SAMPLE_PAYLOAD],
      ZERO_BYTES32,
      ZERO_BYTES32
    )
    expect(id).toMatch(/^0x[0-9a-fA-F]{64}$/)
  })
})

describe('byOperationId', () => {
  const sampleId = `0x${'a'.repeat(64)}` as Hex

  it('wraps both fields of the natural key in $eq operators', () => {
    expect(byOperationId('arbitrum', sampleId)).toEqual({
      network: { $eq: 'arbitrum' },
      operationId: { $eq: sampleId },
    })
  })

  it('lowercases the network slug to match the stored value', () => {
    expect(byOperationId('Arbitrum', sampleId)).toEqual({
      network: { $eq: 'arbitrum' },
      operationId: { $eq: sampleId },
    })
  })

  it('returns a filter with exactly the (network, operationId) keys', () => {
    expect(Object.keys(byOperationId('mainnet', sampleId)).sort()).toEqual([
      'network',
      'operationId',
    ])
  })

  it('preserves the exact operationId value (no normalization)', () => {
    const mixedCase = `0x${'A'.repeat(32)}${'b'.repeat(32)}` as Hex
    const filter = byOperationId('mainnet', mixedCase)
    expect((filter.operationId as { $eq: Hex }).$eq).toBe(mixedCase)
  })
})

describe('serialize/deserialize round-trip', () => {
  const maxUint256 = 2n ** 256n - 1n

  it('preserves max uint256 values across serialize/deserialize', () => {
    const params: IScheduleBatchParams = {
      targets: [SAMPLE_TARGET],
      values: [maxUint256],
      payloads: [SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: ZERO_BYTES32,
      delay: maxUint256,
    }
    const serialized = serializeScheduleParams(params)
    expect(serialized.values).toEqual([maxUint256.toString()])
    expect(serialized.delay).toBe(maxUint256.toString())

    const restored = deserializeScheduleParams(serialized)
    expect(restored.values).toEqual([maxUint256])
    expect(restored.delay).toBe(maxUint256)
  })

  it('round-trips multiple values and preserves array order', () => {
    const params: IScheduleBatchParams = {
      targets: [
        SAMPLE_TARGET,
        '0x000000000000000000000000000000000000bEEF' as Address,
      ],
      values: [0n, 12345n],
      payloads: ['0x' as Hex, SAMPLE_PAYLOAD],
      predecessor: ZERO_BYTES32,
      salt: `0x${'9'.repeat(64)}` as Hex,
      delay: 86_400n,
    }
    const restored = deserializeScheduleParams(serializeScheduleParams(params))
    expect(restored.targets).toEqual(params.targets)
    expect(restored.values).toEqual(params.values)
    expect(restored.payloads).toEqual(params.payloads)
    expect(restored.predecessor).toBe(params.predecessor)
    expect(restored.salt).toBe(params.salt)
    expect(restored.delay).toBe(params.delay)
  })
})

describe('ensureTimelockQueueIndexes', () => {
  it('creates the unique and query indexes with expected specs', async () => {
    const coll = createFakeIndexCollection()
    await ensureTimelockQueueIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(2)
    expect(coll.createIndexCalls[0]).toEqual({
      spec: { network: 1, operationId: 1 },
      options: { unique: true, name: 'unique_network_operation_id' },
    })
    expect(coll.createIndexCalls[1]).toEqual({
      spec: { network: 1, status: 1 },
      options: { name: 'network_status' },
    })
  })

  it.each([85, 86])(
    'surfaces an index conflict (code %i) as a clear error',
    async (code) => {
      const err = Object.assign(new Error('conflict'), { code })
      const coll = createFakeIndexCollection({ createIndexError: err })
      await expectRejects(ensureTimelockQueueIndexes(coll), /Index conflict/)
    }
  )

  it('rethrows any other createIndex error unchanged', async () => {
    const err = Object.assign(new Error('network down'), { code: 6 })
    const coll = createFakeIndexCollection({ createIndexError: err })
    await expectRejects(ensureTimelockQueueIndexes(coll), 'network down')
  })

  it('tolerates a not-authorized createIndex (code 13) when the indexes already exist', async () => {
    const err = Object.assign(
      new Error('not authorized on timelock-operations to execute command'),
      { code: 13 }
    )
    const coll = createFakeIndexCollection({
      createIndexError: err,
      existingIndexes: [
        { name: '_id_' },
        { name: 'unique_network_operation_id' },
        { name: 'network_status' },
      ],
    })
    await ensureTimelockQueueIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(2)
  })

  it('tolerates a not-authorized createIndex matched by message when code is absent', async () => {
    const err = new Error(
      'not authorized on timelock-operations to execute command { createIndexes: ... }'
    )
    const coll = createFakeIndexCollection({
      createIndexError: err,
      existingIndexes: [
        { name: 'unique_network_operation_id' },
        { name: 'network_status' },
      ],
    })
    await ensureTimelockQueueIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(2)
  })

  it('proceeds non-fatally when not authorized and the indexes are missing', async () => {
    const err = Object.assign(
      new Error('not authorized on timelock-operations'),
      { code: 13 }
    )
    const coll = createFakeIndexCollection({
      createIndexError: err,
      existingIndexes: [{ name: '_id_' }],
    })
    await ensureTimelockQueueIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(2)
  })

  it('proceeds non-fatally when not authorized and listIndexes also fails', async () => {
    const err = Object.assign(
      new Error('not authorized on timelock-operations'),
      { code: 13 }
    )
    const listErr = Object.assign(new Error('not authorized to listIndexes'), {
      code: 13,
    })
    const coll = createFakeIndexCollection({
      createIndexError: err,
      listIndexesError: listErr,
    })
    await ensureTimelockQueueIndexes(coll)
    expect(coll.createIndexCalls).toHaveLength(2)
  })
})

describe('TIMELOCK_QUEUE_STATUSES', () => {
  it('includes blocked as a distinct state from failed', () => {
    expect(TIMELOCK_QUEUE_STATUSES).toContain('blocked')
    expect(TIMELOCK_QUEUE_STATUSES).toContain('failed')
  })
})

describe('queueStatusReason', () => {
  it('reads blockedReason for a blocked row', () => {
    expect(
      queueStatusReason({
        status: 'blocked',
        blockedReason: 'obsolete folded removals',
        failureReason: 'stale',
      })
    ).toBe('obsolete folded removals')
  })

  it('reads failureReason for a failed row', () => {
    expect(
      queueStatusReason({
        status: 'failed',
        blockedReason: 'obsolete folded removals',
        failureReason: 'operationId mismatch',
      })
    ).toBe('operationId mismatch')
  })

  it('returns undefined for statuses that carry no reason', () => {
    expect(
      queueStatusReason({ status: 'queued', blockedReason: 'ignored' })
    ).toBeUndefined()
    expect(queueStatusReason({ status: 'executed' })).toBeUndefined()
  })
})

describe('selectBlockedNeedingAlert', () => {
  const now = new Date('2026-08-21T12:00:00Z')

  const blocked = (
    overrides: Partial<ITimelockQueueDoc> = {}
  ): ITimelockQueueDoc =>
    ({
      operationId: '0xabc' as Hex,
      network: 'mode',
      chainId: 34443,
      status: 'blocked',
      blockedReason: 'obsolete folded removals',
      safeTxHash: '0xdead',
      ...overrides,
    } as ITimelockQueueDoc)

  it('alerts on a ready blocked op that has never been alerted', () => {
    const out = selectBlockedNeedingAlert(
      [{ doc: blocked(), onChainReady: true }],
      now
    )
    expect(out).toHaveLength(1)
  })

  it('stays silent while inside the throttle window', () => {
    const doc = blocked({
      blockedAlertedAt: new Date(now.getTime() - 60 * 60 * 1000),
    })
    expect(
      selectBlockedNeedingAlert([{ doc, onChainReady: true }], now)
    ).toHaveLength(0)
  })

  it('re-alerts once the throttle window has elapsed', () => {
    const doc = blocked({
      blockedAlertedAt: new Date(now.getTime() - BLOCKED_ALERT_INTERVAL_MS),
    })
    expect(
      selectBlockedNeedingAlert([{ doc, onChainReady: true }], now)
    ).toHaveLength(1)
  })

  it('does not alert on an op that is not ready on-chain', () => {
    expect(
      selectBlockedNeedingAlert([{ doc: blocked(), onChainReady: false }], now)
    ).toHaveLength(0)
  })

  // A failed readiness read must not manufacture an alert about an op we could
  // not actually observe.
  it('does not alert when the readiness check failed', () => {
    expect(
      selectBlockedNeedingAlert([{ doc: blocked(), onChainReady: null }], now)
    ).toHaveLength(0)
  })

  it('ignores rows that are not blocked', () => {
    const candidates: IBlockedOpCandidate[] = [
      { doc: blocked({ status: 'queued' }), onChainReady: true },
      { doc: blocked({ status: 'failed' }), onChainReady: true },
      { doc: blocked({ status: 'executed' }), onChainReady: true },
    ]
    expect(selectBlockedNeedingAlert(candidates, now)).toHaveLength(0)
  })

  it('selects only the rows that qualify out of a mixed batch', () => {
    const fresh = blocked({ operationId: '0xfresh' as Hex })
    const throttled = blocked({
      operationId: '0xthrottled' as Hex,
      blockedAlertedAt: new Date(now.getTime() - 1000),
    })
    const notReady = blocked({ operationId: '0xnotready' as Hex })
    const out = selectBlockedNeedingAlert(
      [
        { doc: fresh, onChainReady: true },
        { doc: throttled, onChainReady: true },
        { doc: notReady, onChainReady: false },
      ],
      now
    )
    expect(out.map((d) => d.operationId)).toEqual(['0xfresh'])
  })
})

describe('classifyBlockedRow', () => {
  it('reconciles a blocked op the controller already executed', () => {
    expect(
      classifyBlockedRow({
        isDone: true,
        isPending: false,
        isReady: false,
        isOperation: true,
      })
    ).toBe('done')
  })

  // The worldchain shape observed in production: the operator followed the
  // guard's "cancel and re-propose" advice, so the controller dropped the
  // timestamp and isOperation went false — but the queue row never moved.
  it('reconciles a blocked op the controller no longer knows about', () => {
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: false,
        isReady: false,
        isOperation: false,
      })
    ).toBe('gone')
  })

  // The EXSC-816 shape: delay elapsed, still scheduled, still un-executed.
  it('keeps a ready op as a live candidate for alerting', () => {
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: true,
        isReady: true,
        isOperation: true,
      })
    ).toBe('pending')
  })

  it('keeps an op still inside its delay as a live candidate', () => {
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: true,
        isReady: false,
        isOperation: true,
      })
    ).toBe('pending')
  })

  // Guard against a contradictory read (e.g. a mid-block RPC race) being
  // classified as gone and silently marked cancelled.
  it('does not treat a contradictory read as gone', () => {
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: false,
        isReady: true,
        isOperation: false,
      })
    ).toBe('pending')
    expect(
      classifyBlockedRow({
        isDone: false,
        isPending: true,
        isReady: false,
        isOperation: false,
      })
    ).toBe('pending')
  })

  it('prefers done over every other signal', () => {
    expect(
      classifyBlockedRow({
        isDone: true,
        isPending: true,
        isReady: true,
        isOperation: false,
      })
    ).toBe('done')
  })
})
