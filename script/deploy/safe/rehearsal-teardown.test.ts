import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  findProposalsAtNonce,
  tearDownProposalsAtNonce,
} from './rehearsal-teardown'
import { getNextNonce } from './safe-utils'

/**
 * A collection that matches `safeAddress` case-sensitively until a collation is
 * applied, which is the one behaviour of the real store these tests turn on.
 *
 * Faithful to what the production store actually does: a `countDocuments` for
 * the checksummed spelling of the Tron Safe returns 0 uncollated and 34
 * collated (measured 2026-09-12).
 */
function fakeCollection(rows: Record<string, unknown>[]) {
  return {
    find(filter: Record<string, unknown>) {
      let collated = false
      const cursor = {
        collation() {
          collated = true
          return cursor
        },
        sort() {
          return cursor
        },
        limit() {
          return cursor
        },
        toArray() {
          return Promise.resolve(
            rows.filter((row) =>
              Object.entries(filter).every(([key, expected]) => {
                const actual = key
                  .split('.')
                  .reduce<unknown>(
                    (value, segment) =>
                      (value as Record<string, unknown> | undefined)?.[segment],
                    row
                  )
                if (
                  expected &&
                  typeof expected === 'object' &&
                  '$in' in expected
                )
                  return (expected as { $in: unknown[] }).$in.includes(actual)
                if (
                  collated &&
                  typeof actual === 'string' &&
                  typeof expected === 'string'
                )
                  return actual.toLowerCase() === expected.toLowerCase()
                return actual === expected
              })
            )
          )
        },
      }
      return cursor
    },
  }
}

const TRON_SAFE_LOWER = '0x43761f2fb70c8cabd94707cb34d0a012f5857936'
const TRON_SAFE_CHECKSUMMED = '0x43761F2fB70C8cAbD94707cb34D0a012f5857936'

const row = (nonce: number, safeAddress: string) => ({
  network: 'tron',
  chainId: 728126428,
  safeAddress,
  status: 'pending',
  safeTxHash: `0xhash${nonce}`,
  safeTx: { data: { nonce } },
})

describe('findProposalsAtNonce', () => {
  it('finds a row stored under a different spelling of the same Safe', async () => {
    const collection = fakeCollection([
      row(30, TRON_SAFE_LOWER),
      row(31, TRON_SAFE_LOWER),
    ])

    const found = await findProposalsAtNonce(collection as never, {
      network: 'tron',
      chainId: 728126428,
      safeAddress: TRON_SAFE_CHECKSUMMED,
      nonce: 31,
    })

    expect(found.map((doc) => doc.safeTxHash)).toEqual(['0xhash31'])
  })
})

describe('the nonce slot a dummy occupies', () => {
  it('is handed back to the next proposal once the row is deleted', async () => {
    const onChainNonce = 30n
    const dummy = row(30, TRON_SAFE_LOWER)
    const rows = [dummy]
    const collection = fakeCollection(rows)

    const whileHeld = await getNextNonce(
      collection as never,
      TRON_SAFE_LOWER,
      'tron',
      728126428,
      onChainNonce
    )
    expect(whileHeld).toBe(31n)

    rows.splice(0, rows.length)

    const afterTeardown = await getNextNonce(
      collection as never,
      TRON_SAFE_LOWER,
      'tron',
      728126428,
      onChainNonce
    )
    expect(afterTeardown).toBe(onChainNonce)
  })
})

describe('findProposalsAtNonce, when nothing holds the slot', () => {
  it('returns no rows rather than throwing', async () => {
    const found = await findProposalsAtNonce(
      fakeCollection([row(30, TRON_SAFE_LOWER)]) as never,
      {
        network: 'tron',
        chainId: 728126428,
        safeAddress: TRON_SAFE_CHECKSUMMED,
        nonce: 99,
      }
    )

    expect(found).toEqual([])
  })
})

describe('tearDownProposalsAtNonce', () => {
  it('deletes rows even when the operator typed the network in the wrong case', async () => {
    const rows = [row(31, TRON_SAFE_LOWER)]
    const deleted: string[] = []
    const collection = {
      ...fakeCollection(rows),
      findOne: (filter: Record<string, unknown>) =>
        Promise.resolve(
          rows.find(
            (candidate) =>
              candidate.network ===
                (filter.network as { $eq: string } | undefined)?.$eq &&
              candidate.safeTxHash ===
                (filter.safeTxHash as { $eq: string } | undefined)?.$eq
          ) ?? null
        ),
      deleteOne: (filter: Record<string, unknown>) => {
        const hash = (filter.safeTxHash as { $eq: string }).$eq
        deleted.push(hash)
        return Promise.resolve({ deletedCount: 1 })
      },
    }

    const results = await tearDownProposalsAtNonce(collection as never, {
      network: 'Tron',
      chainId: 728126428,
      safeAddress: TRON_SAFE_CHECKSUMMED,
      nonce: 31,
    })

    expect(deleted).toEqual(['0xhash31'])
    expect(results.map((result) => result.outcome)).toEqual(['deleted'])
  })
})
