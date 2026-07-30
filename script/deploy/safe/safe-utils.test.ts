/**
 * Tests for the duplicate-proposal protection in safe-utils (EXSC-117).
 *
 * `storeTransactionInMongoDB` persists an `intentHash` on every proposal and
 * MongoDB enforces a partial unique index (`unique_pending_intent_hash`) on
 * `{ intentHash }` filtered by `{ status: 'pending' }`. The suite covers the
 * hash derivation (determinism, nonce exclusion, field sensitivity) and the
 * store behavior against an in-memory collection fake that mirrors the
 * partial-unique-index semantics: duplicate PENDING rejected (E11000 -> null,
 * no throw), re-create after EXECUTED/REVERTED allowed, and non-duplicate
 * errors propagated.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type Collection, type InsertOneResult, type ObjectId } from 'mongodb'
import { type Address, type Hex } from 'viem'

import {
  computeProposalIntentHash,
  getSelector,
  getSigners,
  mongoSafeTxRowFilter,
  safeTxStatusConsumedNonce,
  serializeSafeTxForMongo,
  storeTransactionInMongoDB,
  summarizeProposalDoc,
  OperationTypeEnum,
  type ISafeTransaction,
  type ISafeTxDocument,
} from './safe-utils'

const SAFE_ADDR = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x2222222222222222222222222222222222222222' as Address
const PROPOSER = '0x3333333333333333333333333333333333333333' as Address
const NETWORK = 'mainnet'
const CHAIN_ID = 1

function buildSafeTx(
  overrides: Partial<{
    to: Address
    value: bigint
    data: Hex
    operation: OperationTypeEnum
    nonce: bigint
  }> = {}
): ISafeTransaction {
  return {
    data: {
      to: TARGET,
      value: 0n,
      data: '0xdeadbeef' as Hex,
      operation: OperationTypeEnum.Call,
      nonce: 0n,
      ...overrides,
    },
    signatures: new Map(),
  }
}

class FakeDuplicateKeyError extends Error {
  public code = 11000
  public constructor() {
    super(
      'E11000 duplicate key error collection: sc_private.pendingTransactions index: unique_pending_intent_hash'
    )
  }
}

/**
 * In-memory stand-in for the `pendingTransactions` collection that replicates
 * the `unique_pending_intent_hash` partial unique index: inserting a doc whose
 * `intentHash` already exists on a row with `status: 'pending'` throws a
 * duplicate-key error with code 11000, exactly like MongoDB would.
 */
function createFakeCollection(
  initial: ISafeTxDocument[] = [],
  options: { insertError?: Error } = {}
): Collection<ISafeTxDocument> & { rows: ISafeTxDocument[] } {
  const rows: ISafeTxDocument[] = initial.map((r) => ({ ...r }))
  const api = {
    rows,
    async insertOne(doc: ISafeTxDocument): Promise<InsertOneResult> {
      if (options.insertError) throw options.insertError
      const duplicate = rows.some(
        (r) =>
          r.status === 'pending' &&
          r.intentHash !== undefined &&
          r.intentHash === doc.intentHash
      )
      if (duplicate) throw new FakeDuplicateKeyError()
      rows.push({ ...doc })
      return {
        acknowledged: true,
        insertedId: rows.length,
      } as unknown as InsertOneResult
    },
  }
  return api as unknown as Collection<ISafeTxDocument> & {
    rows: ISafeTxDocument[]
  }
}

async function store(
  collection: Collection<ISafeTxDocument>,
  safeTx: ISafeTransaction
): Promise<InsertOneResult<ISafeTxDocument> | null> {
  return storeTransactionInMongoDB(
    collection,
    SAFE_ADDR,
    NETWORK,
    CHAIN_ID,
    safeTx,
    ('0x' + 'ab'.repeat(32)) as Hex,
    PROPOSER
  )
}

describe('computeProposalIntentHash', () => {
  const hash = (
    overrides: Partial<{
      network: string
      chainId: number
      safeAddress: Address
      to: Address
      value: bigint
      data: Hex
      operation: OperationTypeEnum
    }> = {}
  ) =>
    computeProposalIntentHash(
      overrides.network ?? NETWORK,
      overrides.chainId ?? CHAIN_ID,
      overrides.safeAddress ?? SAFE_ADDR,
      overrides.to ?? TARGET,
      overrides.value ?? 0n,
      overrides.data ?? ('0xdeadbeef' as Hex),
      overrides.operation ?? OperationTypeEnum.Call
    )

  it('is deterministic for identical inputs', () => {
    expect(hash()).toEqual(hash())
  })

  it('normalizes network casing so MAINNET and mainnet collide', () => {
    expect(hash({ network: 'MAINNET' })).toEqual(hash({ network: 'mainnet' }))
  })

  it('changes when any identity field changes', () => {
    const base = hash()
    expect(hash({ network: 'arbitrum' })).not.toEqual(base)
    expect(hash({ chainId: 42161 })).not.toEqual(base)
    expect(hash({ safeAddress: PROPOSER })).not.toEqual(base)
    expect(hash({ to: PROPOSER })).not.toEqual(base)
    expect(hash({ value: 1n })).not.toEqual(base)
    expect(hash({ data: '0xcafe' as Hex })).not.toEqual(base)
    expect(hash({ operation: OperationTypeEnum.DelegateCall })).not.toEqual(
      base
    )
  })
})

describe('storeTransactionInMongoDB — duplicate-PENDING protection', () => {
  it('stores a new proposal with intentHash and status pending', async () => {
    const collection = createFakeCollection()

    const result = await store(collection, buildSafeTx())

    expect(result).not.toBeNull()
    expect(result?.acknowledged).toBe(true)
    expect(collection.rows).toHaveLength(1)
    const doc = collection.rows[0]
    expect(doc?.status).toEqual('pending')
    expect(doc?.intentHash).toEqual(
      computeProposalIntentHash(
        NETWORK,
        CHAIN_ID,
        SAFE_ADDR,
        TARGET,
        0n,
        '0xdeadbeef' as Hex,
        OperationTypeEnum.Call
      )
    )
  })

  it('rejects a duplicate PENDING proposal: returns null, no second doc, no throw', async () => {
    const collection = createFakeCollection()

    const first = await store(collection, buildSafeTx())
    const second = await store(collection, buildSafeTx())

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(collection.rows).toHaveLength(1)
  })

  it('treats proposals differing only in nonce as duplicates', async () => {
    const collection = createFakeCollection()

    const first = await store(collection, buildSafeTx({ nonce: 5n }))
    const second = await store(collection, buildSafeTx({ nonce: 6n }))

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(collection.rows).toHaveLength(1)
  })

  it('allows repeated idempotent pushes in one run without failing', async () => {
    const collection = createFakeCollection()

    for (let i = 0; i < 3; i++) await store(collection, buildSafeTx())

    expect(collection.rows).toHaveLength(1)
  })

  it('accepts a proposal whose hash matches only an EXECUTED proposal', async () => {
    const collection = createFakeCollection()
    const first = await store(collection, buildSafeTx())
    expect(first).not.toBeNull()
    const executedDoc = collection.rows[0]
    if (!executedDoc) throw new Error('expected stored doc')
    executedDoc.status = 'executed'

    const recreated = await store(collection, buildSafeTx())

    expect(recreated).not.toBeNull()
    expect(recreated?.acknowledged).toBe(true)
    expect(collection.rows).toHaveLength(2)
    expect(collection.rows.map((r) => r.status).sort()).toEqual([
      'executed',
      'pending',
    ])
  })

  it('accepts a proposal whose hash matches only a REVERTED proposal', async () => {
    const collection = createFakeCollection()
    const first = await store(collection, buildSafeTx())
    expect(first).not.toBeNull()
    const revertedDoc = collection.rows[0]
    if (!revertedDoc) throw new Error('expected stored doc')
    revertedDoc.status = 'reverted'

    const recreated = await store(collection, buildSafeTx())

    expect(recreated).not.toBeNull()
    expect(collection.rows).toHaveLength(2)
  })

  it('different proposals coexist as pending', async () => {
    const collection = createFakeCollection()

    const first = await store(collection, buildSafeTx())
    const second = await store(
      collection,
      buildSafeTx({ data: '0xcafe' as Hex })
    )

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(collection.rows).toHaveLength(2)
  })

  it('propagates non-duplicate insert errors instead of swallowing them', async () => {
    const collection = createFakeCollection([], {
      insertError: new Error('connection reset'),
    })

    let thrown: unknown
    try {
      await store(collection, buildSafeTx())
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toEqual('connection reset')
    expect(collection.rows).toHaveLength(0)
  })
})

/**
 * Tests for the proposal-summary helpers (getSigners / getSelector /
 * summarizeProposalDoc). They normalize raw MongoDB Safe tx documents
 * (object- or Map-shaped signatures, bigint/number nonces, Date/string
 * timestamps), so these cover each input shape and the malformed-document
 * edge cases.
 */

const SUMMARY_SIGNER_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SUMMARY_SIGNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function buildSummaryDoc(
  overrides: Partial<ISafeTxDocument> = {}
): ISafeTxDocument {
  return {
    safeAddress: '0x1111111111111111111111111111111111111111',
    network: 'arbitrum',
    chainId: 42161,
    safeTx: {
      data: {
        to: '0x2222222222222222222222222222222222222222' as Address,
        value: 0n,
        data: '0x1f931c1c0000000000000000000000000000000000000000000000000000000000000060' as Hex,
        operation: 0,
        nonce: 99n,
      },
      signatures: {
        [SUMMARY_SIGNER_A.toLowerCase()]: {
          signer: SUMMARY_SIGNER_A,
          data: '0xsig1',
        },
      },
    } as unknown as ISafeTxDocument['safeTx'],
    safeTxHash: '0xhash',
    proposer: '0x3333333333333333333333333333333333333333',
    timestamp: new Date('2026-06-12T10:00:00.000Z'),
    status: 'pending',
    ...overrides,
  }
}

describe('getSigners', () => {
  it('reads object-shaped signatures and lowercases signer addresses', () => {
    expect(getSigners(buildSummaryDoc())).toEqual([
      SUMMARY_SIGNER_A.toLowerCase(),
    ])
  })

  it('reads Map-shaped signatures (in-memory shape)', () => {
    const doc = buildSummaryDoc()
    doc.safeTx.signatures = new Map([
      [
        SUMMARY_SIGNER_A.toLowerCase(),
        { signer: SUMMARY_SIGNER_A, data: '0xsig1' },
      ],
      [SUMMARY_SIGNER_B, { signer: SUMMARY_SIGNER_B, data: '0xsig2' }],
    ]) as unknown as ISafeTxDocument['safeTx']['signatures']
    expect(getSigners(doc)).toEqual([
      SUMMARY_SIGNER_A.toLowerCase(),
      SUMMARY_SIGNER_B,
    ])
  })

  it('returns empty for missing signatures', () => {
    const doc = buildSummaryDoc()
    delete (doc.safeTx as unknown as Record<string, unknown>).signatures
    expect(getSigners(doc)).toEqual([])
  })

  it('returns empty for empty signatures object', () => {
    const doc = buildSummaryDoc()
    doc.safeTx.signatures =
      {} as unknown as ISafeTxDocument['safeTx']['signatures']
    expect(getSigners(doc)).toEqual([])
  })

  it('skips malformed signature entries', () => {
    const doc = buildSummaryDoc()
    doc.safeTx.signatures = {
      a: null,
      b: 'not-an-object',
      c: { data: '0xsig' },
      d: { signer: 12345, data: '0xsig' },
      e: { signer: SUMMARY_SIGNER_B, data: '0xsig2' },
    } as unknown as ISafeTxDocument['safeTx']['signatures']
    expect(getSigners(doc)).toEqual([SUMMARY_SIGNER_B])
  })
})

describe('getSelector', () => {
  it('extracts the 4-byte selector', () => {
    expect(
      getSelector('0x1f931c1c0000000000000000000000000000000000000060')
    ).toBe('0x1f931c1c')
  })

  it('returns 0x for empty calldata', () => {
    expect(getSelector('0x')).toBe('0x')
  })

  it('returns 0x for short calldata', () => {
    expect(getSelector('0x1f93')).toBe('0x')
  })

  it('returns 0x for non-string input', () => {
    expect(getSelector(undefined)).toBe('0x')
    expect(getSelector(42)).toBe('0x')
  })

  it('returns 0x for non-hex strings', () => {
    expect(getSelector('1f931c1c00000000')).toBe('0x')
  })

  it('returns 0x for 0x-prefixed non-hex characters', () => {
    expect(getSelector('0xzzzzzzzz00000000')).toBe('0x')
  })
})

describe('summarizeProposalDoc', () => {
  it('summarizes a well-formed pending proposal', () => {
    expect(summarizeProposalDoc(buildSummaryDoc())).toEqual({
      network: 'arbitrum',
      chainId: 42161,
      safeAddress: '0x1111111111111111111111111111111111111111',
      nonce: 99,
      to: '0x2222222222222222222222222222222222222222',
      selector: '0x1f931c1c',
      status: 'pending',
      signatureCount: 1,
      signers: [SUMMARY_SIGNER_A.toLowerCase()],
      proposer: '0x3333333333333333333333333333333333333333',
      safeTxHash: '0xhash',
      timestamp: '2026-06-12T10:00:00.000Z',
    })
  })

  it('includes executionHash when present', () => {
    const summary = summarizeProposalDoc(
      buildSummaryDoc({ status: 'executed', executionHash: '0xexec' })
    )
    expect(summary.status).toBe('executed')
    expect(summary.executionHash).toBe('0xexec')
  })

  it('carries parkedTaskRefs through to the summary when present', () => {
    const refs = [
      { facet: 'GenericSwapFacet', prUrl: 'https://gh/pull/2046' },
      { facet: 'AcrossFacetV3', prUrl: 'https://gh/pull/2048' },
    ]
    const summary = summarizeProposalDoc(
      buildSummaryDoc({ parkedTaskRefs: refs })
    )
    expect(summary.parkedTaskRefs).toEqual(refs)
  })

  it('omits parkedTaskRefs when the document has none', () => {
    const summary = summarizeProposalDoc(buildSummaryDoc())
    expect(summary.parkedTaskRefs).toBeUndefined()
  })

  it('handles string timestamps and numeric nonces from raw documents', () => {
    const doc = buildSummaryDoc({
      timestamp: '2026-06-12T11:00:00.000Z' as unknown as Date,
    })
    ;(doc.safeTx.data as unknown as Record<string, unknown>).nonce = 7
    const summary = summarizeProposalDoc(doc)
    expect(summary.timestamp).toBe('2026-06-12T11:00:00.000Z')
    expect(summary.nonce).toBe(7)
  })

  it('defaults missing nested fields without throwing', () => {
    const doc = buildSummaryDoc({ timestamp: undefined as unknown as Date })
    ;(doc as unknown as Record<string, unknown>).safeTx = {}
    const summary = summarizeProposalDoc(doc)
    expect(summary.nonce).toBe(0)
    expect(summary.to).toBe('')
    expect(summary.selector).toBe('0x')
    expect(summary.signatureCount).toBe(0)
    expect(summary.timestamp).toBe('')
  })
})

describe('mongoSafeTxRowFilter', () => {
  it('prefers _id when present', () => {
    const id = { toString: () => 'abc' } as ObjectId
    expect(
      mongoSafeTxRowFilter(
        {
          _id: id,
          safeAddress: SAFE_ADDR,
          network: NETWORK,
          chainId: CHAIN_ID,
          safeTx: buildSafeTx(),
          safeTxHash: '0xhash',
          proposer: PROPOSER,
          timestamp: new Date(),
          status: 'pending',
        },
        NETWORK,
        CHAIN_ID
      )
    ).toEqual({ _id: { $eq: id } })
  })

  it('falls back to pending identity fields without _id', () => {
    expect(
      mongoSafeTxRowFilter(
        {
          safeAddress: SAFE_ADDR,
          network: NETWORK,
          chainId: CHAIN_ID,
          safeTx: buildSafeTx(),
          safeTxHash: '0xhash',
          proposer: PROPOSER,
          timestamp: new Date(),
          status: 'pending',
        },
        NETWORK,
        CHAIN_ID
      )
    ).toEqual({
      status: { $eq: 'pending' },
      safeTxHash: { $eq: '0xhash' },
      network: { $eq: NETWORK },
      chainId: { $eq: CHAIN_ID },
    })
  })
})

describe('serializeSafeTxForMongo', () => {
  it('converts signature Map to plain object', () => {
    const safeTx = buildSafeTx()
    safeTx.signatures.set(PROPOSER.toLowerCase(), {
      signer: PROPOSER,
      data: ('0x' + '11'.repeat(65)) as Hex,
    })
    const stored = serializeSafeTxForMongo(safeTx)
    expect(stored.signatures[PROPOSER.toLowerCase()]?.signer).toEqual(PROPOSER)
    expect(Object.keys(stored.signatures)).toHaveLength(1)
  })
})

describe('safeTxStatusConsumedNonce', () => {
  it('returns true only for executed', () => {
    expect(safeTxStatusConsumedNonce('executed')).toBe(true)
  })

  it('returns false for reverted — a reverted execTransaction rolls back the nonce', () => {
    expect(safeTxStatusConsumedNonce('reverted')).toBe(false)
  })

  it('returns false for submitted (unknown outcome) and pending', () => {
    expect(safeTxStatusConsumedNonce('submitted')).toBe(false)
    expect(safeTxStatusConsumedNonce('pending')).toBe(false)
  })
})

describe('decodeDiamondCut selector resolution', () => {
  it('resolves all unknown selectors in a single batched 4byte request', async () => {
    const { decodeDiamondCut } = await import('./safe-utils')
    const originalCachePath = process.env.SELECTOR_SIGNATURE_CACHE_PATH
    const testCachePath = `${
      process.env.TMPDIR ?? '/tmp'
    }/selector-cache-test-${Date.now()}.json`
    process.env.SELECTOR_SIGNATURE_CACHE_PATH = testCachePath
    const originalFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            function: {
              '0xdeadbe01': [{ name: 'unknownFn1()' }],
              '0xdeadbe02': [{ name: 'unknownFn2()' }],
              '0xdeadbe03': [{ name: 'unknownFn3()' }],
            },
            event: {},
          },
        })
      )
    }) as unknown as typeof fetch
    try {
      await decodeDiamondCut(
        {
          functionName: 'diamondCut',
          args: [
            [
              [
                '0x0000000000000000000000000000000000000000',
                2, // Remove
                ['0xdeadbe01', '0xdeadbe02', '0xdeadbe03'],
              ],
            ],
            '0x0000000000000000000000000000000000000000',
            '0x',
          ],
        },
        1
      )
      expect(fetchCalls).toBeLessThanOrEqual(1)
    } finally {
      globalThis.fetch = originalFetch
      if (originalCachePath === undefined)
        delete process.env.SELECTOR_SIGNATURE_CACHE_PATH
      else process.env.SELECTOR_SIGNATURE_CACHE_PATH = originalCachePath
      const { unlinkSync } = await import('fs')
      try {
        unlinkSync(testCachePath)
      } catch {
        // never written — nothing to clean up
      }
    }
  })
})

describe('safeClientPoolKey', () => {
  it('derives the address from a private key — no key material in the key', async () => {
    const { safeClientPoolKey } = await import('./safe-utils')
    // Well-known anvil test key #0 (public), address 0xf39F...2266
    const anvilKey =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // pre-commit-checker: not a secret — public anvil dev key
    const key = safeClientPoolKey(
      'mainnet',
      '0x0000000000000000000000000000000000000abc' as Address,
      undefined,
      anvilKey
    )
    expect(key).toContain('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
    expect(key).not.toContain(anvilKey.slice(2, 10))
  })

  it('prefers the account address and lowercases all parts', async () => {
    const { safeClientPoolKey } = await import('./safe-utils')
    const key = safeClientPoolKey(
      'MAINNET',
      '0x0000000000000000000000000000000000000ABC' as Address,
      { address: '0x1111111111111111111111111111111111111111' } as never,
      undefined
    )
    expect(key).toBe(
      'mainnet:0x0000000000000000000000000000000000000abc:0x1111111111111111111111111111111111111111'
    )
  })

  it('falls back to a ledger marker without key material', async () => {
    const { safeClientPoolKey } = await import('./safe-utils')
    const key = safeClientPoolKey(
      'mainnet',
      '0x0000000000000000000000000000000000000abc' as Address,
      undefined,
      undefined
    )
    expect(key.endsWith(':ledger')).toBe(true)
  })
})

describe('getOrCreatePooledPromise', () => {
  it('dedups concurrent callers onto the same promise', async () => {
    const { getOrCreatePooledPromise } = await import('./safe-utils')
    const pool = new Map<string, Promise<string>>()
    let factoryCalls = 0
    const factory = async () => {
      factoryCalls++
      return 'client'
    }
    const p1 = getOrCreatePooledPromise(pool, 'k', factory)
    const p2 = getOrCreatePooledPromise(pool, 'k', factory)
    expect(p1).toBe(p2)
    expect(await p1).toBe('client')
    expect(factoryCalls).toBe(1)
  })

  it('evicts a rejected promise so the next call retries', async () => {
    const { getOrCreatePooledPromise } = await import('./safe-utils')
    const pool = new Map<string, Promise<string>>()
    let factoryCalls = 0
    const factory = async () => {
      factoryCalls++
      if (factoryCalls === 1) throw new Error('transient RPC blip')
      return 'client'
    }
    let firstError: unknown
    try {
      await getOrCreatePooledPromise(pool, 'k', factory)
    } catch (error) {
      firstError = error
    }
    expect((firstError as Error).message).toBe('transient RPC blip')
    expect(pool.has('k')).toBe(false)
    expect(await getOrCreatePooledPromise(pool, 'k', factory)).toBe('client')
    expect(factoryCalls).toBe(2)
  })

  it('does not evict a newer replacement entry on stale rejection', async () => {
    const { getOrCreatePooledPromise } = await import('./safe-utils')
    const pool = new Map<string, Promise<string>>()
    let rejectFirst: ((e: Error) => void) | undefined
    const first = getOrCreatePooledPromise(
      pool,
      'k',
      () =>
        new Promise<string>((_, reject) => {
          rejectFirst = reject
        })
    )
    // Simulate an out-of-band replacement (e.g. manual eviction + re-init)
    const replacement = Promise.resolve('replacement')
    pool.set('k', replacement)
    rejectFirst?.(new Error('stale failure'))
    let staleError: unknown
    try {
      await first
    } catch (error) {
      staleError = error
    }
    expect((staleError as Error).message).toBe('stale failure')
    expect(pool.get('k')).toBe(replacement)
  })
})

describe('releaseAllPooledSafeClients', () => {
  it('cleans up every pooled client, tolerates failures, and clears the pool', async () => {
    const { releaseAllPooledSafeClients } = await import('./safe-utils')
    const cleaned: string[] = []
    const makeBundle = (name: string, failCleanup = false) =>
      Promise.resolve({
        safe: {
          cleanup: async () => {
            if (failCleanup) throw new Error(`cleanup failed for ${name}`)
            cleaned.push(name)
          },
        },
        chain: undefined,
        safeAddress: '0x0' as Address,
      }) as never
    const pool = new Map([
      ['a', makeBundle('a')],
      ['b', makeBundle('b', true)],
      ['c', makeBundle('c')],
    ])
    await releaseAllPooledSafeClients(pool as never)
    expect(cleaned.sort()).toEqual(['a', 'c'])
    expect(pool.size).toBe(0)
  })

  it('does not hang on a never-settling in-flight client and still clears the pool', async () => {
    const { releaseAllPooledSafeClients } = await import('./safe-utils')
    // A pooled promise that never resolves (e.g. a prefetch init against a hung
    // RPC) must not stall shutdown past the timeout.
    const pool = new Map([['stuck', new Promise(() => undefined)]])
    const startedAt = Date.now()
    await releaseAllPooledSafeClients(pool as never, 20) // 20ms deadline
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(pool.size).toBe(0)
  })
})

describe('SafeClient.signTransaction chain id source', () => {
  const makeClient = async (knownChainId?: number) => {
    const { SafeClient } = await import('./safe-utils')
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(
      '0x0000000000000000000000000000000000000000000000000000000000000001'
    )
    let rpcChainIdCalls = 0
    const domains: { chainId: number }[] = []
    const publicClient = {
      getChainId: async () => {
        rpcChainIdCalls++
        return 999
      },
    }
    const walletClient = {
      signTypedData: async (params: { domain: { chainId: number } }) => {
        domains.push(params.domain)
        return `0x${'ab'.repeat(65)}`
      },
    }
    const client = new SafeClient(
      publicClient as never,
      walletClient as never,
      SAFE_ADDR,
      account,
      undefined,
      knownChainId
    )
    return {
      client,
      domains,
      rpcChainIdCalls: () => rpcChainIdCalls,
    }
  }

  it('uses the config-resolved chain id without an RPC round trip', async () => {
    const { client, domains, rpcChainIdCalls } = await makeClient(42161)
    const signed = await client.signTransaction(buildSafeTx())
    expect(rpcChainIdCalls()).toBe(0)
    expect(domains[0]?.chainId).toBe(42161)
    expect(signed.signatures.size).toBe(1)
  })

  it('falls back to the RPC chain id when no config id is known', async () => {
    const { client, domains, rpcChainIdCalls } = await makeClient(undefined)
    await client.signTransaction(buildSafeTx())
    expect(rpcChainIdCalls()).toBe(1)
    expect(domains[0]?.chainId).toBe(999)
  })
})
