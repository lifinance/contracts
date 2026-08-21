import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Address, Hex } from 'viem'

import {
  buildQueueFilter,
  classifyMongoError,
  filterByPayloadContains,
  filterBySafeTxHashes,
  parseCsvArg,
  parseStatusArg,
  statusKey,
  needsAttention,
  toDisplayRow,
} from './list-timelock-queue'
import type { ITimelockQueueDoc } from './timelock-queue'

const ZERO_BYTES32 =
  // pre-commit-checker: not a secret — zero bytes32 sentinel used as test fixture
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

function buildDoc(
  overrides: Partial<ITimelockQueueDoc> = {}
): ITimelockQueueDoc {
  return {
    operationId: `0x${'ab'.repeat(32)}` as Hex,
    network: '0g',
    chainId: 16661,
    timelockAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address,
    targets: ['0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' as Address],
    values: ['0'],
    payloads: ['0xdeadbeef' as Hex],
    predecessor: ZERO_BYTES32,
    salt: ZERO_BYTES32,
    delay: '10800',
    safeTxHash: `0x${'cd'.repeat(32)}`,
    status: 'executed',
    createdAt: new Date('2026-07-03T12:00:00Z'),
    updatedAt: new Date('2026-07-06T01:30:00Z'),
    ...overrides,
  }
}

describe('parseStatusArg', () => {
  it('defaults to all when omitted', () => {
    expect(parseStatusArg(undefined)).toBe('all')
  })

  it('accepts each known status and all', () => {
    for (const status of [
      'queued',
      'executed',
      'cancelled',
      'failed',
      'all',
    ] as const)
      expect(parseStatusArg(status)).toBe(status)
  })

  it('is case-insensitive', () => {
    expect(parseStatusArg('Executed')).toBe('executed')
  })

  it('throws on unknown status', () => {
    expect(() => parseStatusArg('done')).toThrow(/invalid --status/i)
  })
})

describe('parseCsvArg', () => {
  it('returns undefined for missing or blank input', () => {
    expect(parseCsvArg(undefined)).toBeUndefined()
    expect(parseCsvArg('  ')).toBeUndefined()
  })

  it('splits, trims, lowercases and drops empty entries', () => {
    expect(parseCsvArg(' Base, ARBITRUM ,,0g ')).toEqual([
      'base',
      'arbitrum',
      '0g',
    ])
  })
})

describe('buildQueueFilter', () => {
  it('is empty for no networks and status all', () => {
    expect(buildQueueFilter(undefined, 'all')).toEqual({})
  })

  it('wraps networks in $in and status in $eq', () => {
    expect(buildQueueFilter(['0g', 'base'], 'executed')).toEqual({
      network: { $in: ['0g', 'base'] },
      status: { $eq: 'executed' },
    })
  })
})

describe('filterBySafeTxHashes', () => {
  const docA = buildDoc({ safeTxHash: '0xAAA1' })
  const docB = buildDoc({ safeTxHash: '0xbbb2' })

  it('passes everything through when no hashes given', () => {
    expect(filterBySafeTxHashes([docA, docB], undefined)).toEqual([docA, docB])
  })

  it('matches case-insensitively', () => {
    expect(filterBySafeTxHashes([docA, docB], ['0xaaa1'])).toEqual([docA])
  })

  it('returns empty when nothing matches', () => {
    expect(filterBySafeTxHashes([docA, docB], ['0xffff'])).toEqual([])
  })
})

describe('filterByPayloadContains', () => {
  const facetAddress = '0x38e58E617BF14D9224e4Aa4E4fF9d3A9c04c0AE7'
  const docWithAddress = buildDoc({
    payloads: [
      '0xdeadbeef' as Hex,
      `0x1234${facetAddress.slice(2).toLowerCase()}5678` as Hex,
    ],
  })
  const docWithout = buildDoc({ payloads: ['0xcafebabe' as Hex] })

  it('passes everything through when no needles given', () => {
    expect(
      filterByPayloadContains([docWithAddress, docWithout], undefined)
    ).toEqual([docWithAddress, docWithout])
  })

  it('matches a needle inside any payload case-insensitively', () => {
    expect(
      filterByPayloadContains([docWithAddress, docWithout], [facetAddress])
    ).toEqual([docWithAddress])
  })

  it('accepts needles without 0x prefix', () => {
    expect(
      filterByPayloadContains(
        [docWithAddress, docWithout],
        [facetAddress.slice(2).toUpperCase()]
      )
    ).toEqual([docWithAddress])
  })

  it('returns empty when nothing matches', () => {
    expect(
      filterByPayloadContains(
        [docWithAddress, docWithout],
        [`0x${'99'.repeat(20)}`]
      )
    ).toEqual([])
  })

  it('ignores empty needles (bare 0x) instead of matching everything', () => {
    expect(
      filterByPayloadContains([docWithAddress, docWithout], ['0x'])
    ).toEqual([docWithAddress, docWithout])
    expect(
      filterByPayloadContains(
        [docWithAddress, docWithout],
        ['0x', facetAddress]
      )
    ).toEqual([docWithAddress])
  })
})

describe('classifyMongoError', () => {
  it('flags missing env var as misconfig', () => {
    expect(classifyMongoError(new Error('MONGODB_URI is not defined'))).toBe(
      'misconfig'
    )
  })

  it('flags server-selection and connection failures as misconfig', () => {
    const selectionError = new Error('connection refused')
    selectionError.name = 'MongoServerSelectionError'
    expect(classifyMongoError(selectionError)).toBe('misconfig')
    expect(
      classifyMongoError(new Error('connect ECONNREFUSED 10.0.0.1:27017'))
    ).toBe('misconfig')
    expect(classifyMongoError(new Error('getaddrinfo ETIMEDOUT cluster'))).toBe(
      'misconfig'
    )
  })

  it('treats everything else as a real error', () => {
    expect(classifyMongoError(new Error('duplicate key'))).toBe('error')
    expect(classifyMongoError('boom')).toBe('error')
  })
})

describe('statusKey', () => {
  it('scopes operationId by network to avoid cross-chain collisions', () => {
    const operationId = `0x${'ab'.repeat(32)}`
    expect(statusKey('0g', operationId)).toBe(`0g:${operationId}`)
    expect(statusKey('base', operationId)).not.toBe(
      statusKey('0g', operationId)
    )
  })
})

describe('toDisplayRow', () => {
  it('maps queue doc fields and serializes dates to ISO strings', () => {
    const doc = buildDoc({
      executionTxHash: `0x${'ee'.repeat(32)}`,
      executedAt: new Date('2026-07-06T01:30:00Z'),
    })
    expect(toDisplayRow(doc, true)).toEqual({
      network: '0g',
      operationId: doc.operationId,
      status: 'executed',
      safeTxHash: doc.safeTxHash,
      executionTxHash: doc.executionTxHash,
      createdAt: '2026-07-03T12:00:00.000Z',
      executedAt: '2026-07-06T01:30:00.000Z',
      onChainDone: true,
    })
  })

  it('marks a failed on-chain check as null', () => {
    expect(toDisplayRow(buildDoc(), null).onChainDone).toBeNull()
  })

  it('includes onChainReady for unexecuted rows when provided', () => {
    const row = toDisplayRow(buildDoc({ status: 'queued' }), false, true)
    expect(row.onChainDone).toBe(false)
    expect(row.onChainReady).toBe(true)
  })

  it('marks a failed ready check as null and omits it when not provided', () => {
    expect(toDisplayRow(buildDoc(), false, null).onChainReady).toBeNull()
    expect(toDisplayRow(buildDoc(), true).onChainReady).toBeUndefined()
  })

  it('omits optional fields and onChainDone when not checked', () => {
    const row = toDisplayRow(buildDoc(), undefined)
    expect(row.executionTxHash).toBeUndefined()
    expect(row.executedAt).toBeUndefined()
    expect(row.onChainDone).toBeUndefined()
  })
})

describe('toDisplayRow status reason', () => {
  it('surfaces blockedReason and blockedAt for a blocked row', () => {
    const row = toDisplayRow(
      buildDoc({
        status: 'blocked',
        blockedReason: 'obsolete folded removals',
        blockedAt: new Date('2026-08-21T03:00:00Z'),
      }),
      false,
      true
    )
    expect(row.statusReason).toBe('obsolete folded removals')
    expect(row.blockedAt).toBe('2026-08-21T03:00:00.000Z')
  })

  it('surfaces failureReason for a failed row', () => {
    const row = toDisplayRow(
      buildDoc({ status: 'failed', failureReason: 'operationId mismatch' }),
      false,
      false
    )
    expect(row.statusReason).toBe('operationId mismatch')
  })

  it('omits the reason for statuses that carry none', () => {
    expect(
      toDisplayRow(buildDoc({ status: 'queued' })).statusReason
    ).toBeUndefined()
  })
})

describe('needsAttention', () => {
  // The EXSC-816 row: blocked, delay elapsed, still not executed — invisible to
  // the runner and indistinguishable from a dead row in a flat listing.
  it('flags a blocked row that is ready on-chain', () => {
    const row = toDisplayRow(
      buildDoc({ status: 'blocked', blockedReason: 'stale removals' }),
      false,
      true
    )
    expect(needsAttention(row)).toBe(true)
  })

  it('flags a failed row that is ready on-chain', () => {
    const row = toDisplayRow(buildDoc({ status: 'failed' }), false, true)
    expect(needsAttention(row)).toBe(true)
  })

  it('does not flag a queued row — the runner already picks those up', () => {
    const row = toDisplayRow(buildDoc({ status: 'queued' }), false, true)
    expect(needsAttention(row)).toBe(false)
  })

  it('does not flag a blocked row that is not ready yet', () => {
    const row = toDisplayRow(buildDoc({ status: 'blocked' }), false, false)
    expect(needsAttention(row)).toBe(false)
  })

  it('does not flag a row that is already done on-chain', () => {
    const row = toDisplayRow(buildDoc({ status: 'blocked' }), true, true)
    expect(needsAttention(row)).toBe(false)
  })

  it('does not flag a row whose on-chain checks were not run or failed', () => {
    expect(needsAttention(toDisplayRow(buildDoc({ status: 'blocked' })))).toBe(
      false
    )
    expect(
      needsAttention(toDisplayRow(buildDoc({ status: 'blocked' }), null, null))
    ).toBe(false)
  })
})
