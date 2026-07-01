/**
 * Tests for the pending-proposal deletion helper. The whole point of this
 * script is a safety guard: it must never delete a proposal that already
 * carries more than the proposer's own signature (signatureCount > 1) unless
 * --force is passed. Signatures round-trip through BSON as a plain object even
 * though they are typed as a Map, so the count must be correct for both shapes
 * — an undercount would silently bypass the guard and destroy a signed tx.
 *
 * MongoDB is replaced by a tiny in-memory fake that matches only the slice of
 * the API this helper uses (findOne + deleteOne); no real I/O is performed.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type Collection } from 'mongodb'

import {
  countSignatures,
  deletePendingProposals,
  parseHashes,
} from './delete-pending-proposals'
import { type ISafeSignature, type ISafeTxDocument } from './safe-utils'

const NETWORK = 'fuse'

function sig(signer: string): ISafeSignature {
  return { signer: signer as `0x${string}`, data: '0x' as `0x${string}` }
}

function makeDoc(
  safeTxHash: string,
  signatures: unknown,
  overrides: Partial<ISafeTxDocument> = {}
): ISafeTxDocument {
  return {
    safeAddress: '0xsafe',
    network: NETWORK,
    chainId: 122,
    safeTx: {
      data: {
        to: '0xto' as `0x${string}`,
        value: 0n,
        data: '0x' as `0x${string}`,
        operation: 0,
        nonce: 7n,
      },
      // real code tolerates both Map and BSON-object shapes here
      signatures: signatures as ISafeTxDocument['safeTx']['signatures'],
    },
    safeTxHash,
    proposer: '0xproposer',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    status: 'pending',
    ...overrides,
  }
}

function createFakeCollection(
  initial: ISafeTxDocument[] = []
): Collection<ISafeTxDocument> & {
  rows: ISafeTxDocument[]
  deleteCalls: Record<string, unknown>[]
} {
  const rows: ISafeTxDocument[] = [...initial]
  const deleteCalls: Record<string, unknown>[] = []
  const matches = (
    r: ISafeTxDocument,
    filter: Record<string, unknown>
  ): boolean =>
    Object.entries(filter).every(
      ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v
    )
  const api = {
    rows,
    deleteCalls,
    async findOne(
      filter: Record<string, unknown>
    ): Promise<ISafeTxDocument | null> {
      return rows.find((r) => matches(r, filter)) ?? null
    },
    async deleteOne(
      filter: Record<string, unknown>
    ): Promise<{ deletedCount: number }> {
      deleteCalls.push(filter)
      const idx = rows.findIndex((r) => matches(r, filter))
      if (idx === -1) return { deletedCount: 0 }
      rows.splice(idx, 1)
      return { deletedCount: 1 }
    },
  }
  return api as unknown as Collection<ISafeTxDocument> & {
    rows: ISafeTxDocument[]
    deleteCalls: Record<string, unknown>[]
  }
}

describe('parseHashes', () => {
  it('splits a comma-separated list', () => {
    expect(parseHashes('0xaaa,0xbbb')).toEqual(['0xaaa', '0xbbb'])
  })

  it('trims whitespace and drops empty entries', () => {
    expect(parseHashes(' 0xaaa , , 0xbbb ,')).toEqual(['0xaaa', '0xbbb'])
  })

  it('returns an empty list for a blank string', () => {
    expect(parseHashes('   ')).toEqual([])
    expect(parseHashes('')).toEqual([])
  })
})

describe('countSignatures', () => {
  it('counts a Map by its size', () => {
    const m = new Map<string, ISafeSignature>([
      ['0x1', sig('0x1')],
      ['0x2', sig('0x2')],
    ])
    expect(countSignatures(m)).toBe(2)
  })

  it('counts a BSON plain-object shape by its keys', () => {
    expect(countSignatures({ '0x1': sig('0x1'), '0x2': sig('0x2') })).toBe(2)
  })

  it('treats undefined / null as zero', () => {
    expect(countSignatures(undefined)).toBe(0)
    expect(countSignatures(null)).toBe(0)
  })

  it('treats an empty object as zero', () => {
    expect(countSignatures({})).toBe(0)
  })
})

describe('deletePendingProposals', () => {
  it('deletes an unsigned proposal', async () => {
    const col = createFakeCollection([makeDoc('0xaaa', {})])
    const results = await deletePendingProposals(col, {
      network: NETWORK,
      hashes: ['0xaaa'],
      force: false,
    })
    expect(results).toEqual([
      { hash: '0xaaa', outcome: 'deleted', sigCount: 0 },
    ])
    expect(col.rows).toHaveLength(0)
    expect(col.deleteCalls).toHaveLength(1)
  })

  it('deletes a proposal carrying only the proposer signature (sigCount 1)', async () => {
    const col = createFakeCollection([makeDoc('0xaaa', { '0x1': sig('0x1') })])
    const results = await deletePendingProposals(col, {
      network: NETWORK,
      hashes: ['0xaaa'],
      force: false,
    })
    expect(results[0]?.outcome).toBe('deleted')
    expect(col.rows).toHaveLength(0)
  })

  it('REFUSES to delete a partially-signed proposal without --force', async () => {
    const col = createFakeCollection([
      makeDoc('0xaaa', { '0x1': sig('0x1'), '0x2': sig('0x2') }),
    ])
    const results = await deletePendingProposals(col, {
      network: NETWORK,
      hashes: ['0xaaa'],
      force: false,
    })
    expect(results).toEqual([
      { hash: '0xaaa', outcome: 'skipped-signed', sigCount: 2 },
    ])
    expect(col.rows).toHaveLength(1)
    expect(col.deleteCalls).toHaveLength(0)
  })

  it('also refuses when signatures arrive as a BSON plain object (not a Map)', async () => {
    // regression guard: an object-shaped count must not read as 0 and slip past
    const col = createFakeCollection([
      makeDoc(
        '0xaaa',
        new Map<string, ISafeSignature>([
          ['0x1', sig('0x1')],
          ['0x2', sig('0x2')],
        ])
      ),
    ])
    const results = await deletePendingProposals(col, {
      network: NETWORK,
      hashes: ['0xaaa'],
      force: false,
    })
    expect(results[0]?.outcome).toBe('skipped-signed')
    expect(col.rows).toHaveLength(1)
  })

  it('deletes a partially-signed proposal when --force is given', async () => {
    const col = createFakeCollection([
      makeDoc('0xaaa', { '0x1': sig('0x1'), '0x2': sig('0x2') }),
    ])
    const results = await deletePendingProposals(col, {
      network: NETWORK,
      hashes: ['0xaaa'],
      force: true,
    })
    expect(results[0]?.outcome).toBe('deleted')
    expect(col.rows).toHaveLength(0)
    expect(col.deleteCalls).toHaveLength(1)
  })

  it('skips a hash that is not found without touching the collection', async () => {
    const col = createFakeCollection([makeDoc('0xaaa', {})])
    const results = await deletePendingProposals(col, {
      network: NETWORK,
      hashes: ['0xmissing'],
      force: false,
    })
    expect(results).toEqual([
      { hash: '0xmissing', outcome: 'not-found', sigCount: 0 },
    ])
    expect(col.rows).toHaveLength(1)
    expect(col.deleteCalls).toHaveLength(0)
  })

  it('does not match a proposal on a different network', async () => {
    const col = createFakeCollection([
      makeDoc('0xaaa', {}, { network: 'polygon' }),
    ])
    const results = await deletePendingProposals(col, {
      network: NETWORK,
      hashes: ['0xaaa'],
      force: false,
    })
    expect(results[0]?.outcome).toBe('not-found')
    expect(col.rows).toHaveLength(1)
  })

  it('processes each hash independently in a mixed batch', async () => {
    const col = createFakeCollection([
      makeDoc('0xaaa', {}),
      makeDoc('0xbbb', { '0x1': sig('0x1'), '0x2': sig('0x2') }),
    ])
    const results = await deletePendingProposals(col, {
      network: NETWORK,
      hashes: ['0xaaa', '0xbbb', '0xccc'],
      force: false,
    })
    expect(results.map((r) => r.outcome)).toEqual([
      'deleted',
      'skipped-signed',
      'not-found',
    ])
    // only the unsigned 0xaaa was removed
    expect(col.rows.map((r) => r.safeTxHash)).toEqual(['0xbbb'])
  })
})
