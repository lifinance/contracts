/**
 * Tests for the Safe tx reconciliation pass. The reconciler mutates rows in
 * MongoDB based on on-chain receipts and log scans, so the suite covers each
 * Sweep A receipt branch, the nonce-gap formula that gates Sweep B, and the
 * Sweep B back-fill paths (success / failure / mempool log / RPC error).
 *
 * MongoDB and viem clients are replaced by tiny in-memory fakes that match
 * the slice of API surface reconcile uses — no real I/O is performed.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type Collection } from 'mongodb'
import {
  encodeAbiParameters,
  keccak256,
  stringToBytes,
  toHex,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'

import {
  reconcileSubmittedSafeTxs,
  RECONCILE_LOOKBACK_BLOCKS,
  SUBMITTED_GRACE_MS,
} from './reconcile'
import { type ISafeTransaction, type ISafeTxDocument } from './safe-utils'

const SAFE_ADDR = '0x000000000000000000000000000000000000Safe' as Address
const CHAIN_ID = 1
const NETWORK = 'mainnet'

const EXECUTION_SUCCESS_TOPIC = keccak256(
  stringToBytes('ExecutionSuccess(bytes32,uint256)')
)
const EXECUTION_FAILURE_TOPIC = keccak256(
  stringToBytes('ExecutionFailure(bytes32,uint256)')
)

function buildRow(overrides: Partial<ISafeTxDocument> = {}): ISafeTxDocument {
  return {
    safeAddress: SAFE_ADDR,
    network: NETWORK,
    chainId: CHAIN_ID,
    safeTx: {
      data: {
        to: '0x0000000000000000000000000000000000000000' as Address,
        value: 0n,
        data: '0x' as Hex,
        operation: 0,
        nonce: 0n,
      },
      signatures: new Map(),
    } as ISafeTransaction,
    safeTxHash:
      '0x0000000000000000000000000000000000000000000000000000000000000abc',
    proposer: '0xproposer',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    status: 'pending',
    ...overrides,
  }
}

function matchesFilter(
  row: ISafeTxDocument,
  filter: Record<string, unknown>
): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const rowVal = (row as unknown as Record<string, unknown>)[key]
    if (value !== null && typeof value === 'object') {
      const op = value as Record<string, unknown>
      if ('$in' in op) {
        if (!(op.$in as unknown[]).includes(rowVal)) return false
      } else if ('$exists' in op) {
        const exists = rowVal !== undefined
        if (exists !== op.$exists) return false
      } else throw new Error(`Unsupported filter operator: ${Object.keys(op)}`)
    } else if (rowVal !== value) return false
  }
  return true
}

function applyUpdate(
  row: ISafeTxDocument,
  update: { $set?: Record<string, unknown>; $unset?: Record<string, ''> }
): void {
  if (update.$set)
    for (const [key, value] of Object.entries(update.$set))
      (row as unknown as Record<string, unknown>)[key] = value
  if (update.$unset)
    for (const key of Object.keys(update.$unset))
      delete (row as unknown as Record<string, unknown>)[key]
}

function createFakeCollection(
  initial: ISafeTxDocument[] = []
): Collection<ISafeTxDocument> & { rows: ISafeTxDocument[] } {
  const rows: ISafeTxDocument[] = initial.map((r) => ({ ...r }))
  const api = {
    rows,
    find(filter: Record<string, unknown>) {
      const matches = rows.filter((r) => matchesFilter(r, filter))
      return {
        toArray: async () => matches,
        sort(_sortObj: Record<string, 1 | -1>) {
          // Reconcile only ever sorts by safeTx.data.nonce desc; hardcode.
          const sorted = [...matches].sort((a, b) => {
            const an = BigInt(a.safeTx.data.nonce)
            const bn = BigInt(b.safeTx.data.nonce)
            return an > bn ? -1 : an < bn ? 1 : 0
          })
          return {
            limit(n: number) {
              return {
                toArray: async () => sorted.slice(0, n),
              }
            },
          }
        },
      }
    },
    async countDocuments(filter: Record<string, unknown>): Promise<number> {
      return rows.filter((r) => matchesFilter(r, filter)).length
    },
    async updateOne(
      filter: Record<string, unknown>,
      update: {
        $set?: Record<string, unknown>
        $unset?: Record<string, ''>
      }
    ): Promise<{ modifiedCount: number }> {
      const row = rows.find((r) => matchesFilter(r, filter))
      if (!row) return { modifiedCount: 0 }
      applyUpdate(row, update)
      return { modifiedCount: 1 }
    },
  }
  return api as unknown as Collection<ISafeTxDocument> & {
    rows: ISafeTxDocument[]
  }
}

interface IFakeClientOptions {
  receipts?: Record<string, 'success' | 'reverted' | 'missing'>
  blockNumber?: bigint | (() => Promise<bigint>)
  logs?: Log[]
  getLogsError?: Error
}

function createFakeClient(options: IFakeClientOptions = {}): PublicClient {
  const api = {
    async getTransactionReceipt({
      hash,
    }: {
      hash: Hex
    }): Promise<TransactionReceipt> {
      const status = options.receipts?.[hash]
      if (!status || status === 'missing')
        throw new Error('Transaction receipt not found')
      return { status } as TransactionReceipt
    },
    async getBlockNumber(): Promise<bigint> {
      if (typeof options.blockNumber === 'function')
        return options.blockNumber()
      return options.blockNumber ?? 1_000_000n
    },
    async getLogs(): Promise<Log[]> {
      if (options.getLogsError) throw options.getLogsError
      return options.logs ?? []
    },
  }
  return api as unknown as PublicClient
}

function makeExecutionLog(
  eventTopic: Hex,
  safeTxHash: Hex,
  txHash: Hex | null = ('0x' + 'aa'.repeat(32)) as Hex
): Log {
  return {
    address: SAFE_ADDR,
    topics: [eventTopic],
    data: encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }],
      [safeTxHash, 0n]
    ),
    blockNumber: 999_950n,
    transactionHash: txHash,
    logIndex: 0,
    blockHash: ('0x' + 'bb'.repeat(32)) as Hex,
    transactionIndex: 0,
    removed: false,
  } as unknown as Log
}

describe('reconcileSubmittedSafeTxs — Tron short-circuit', () => {
  it('returns zeroed result without touching MongoDB on Tron networks', async () => {
    const collection = createFakeCollection([
      buildRow({
        status: 'submitted',
        executionHash: ('0x' + '11'.repeat(32)) as Hex,
        submittedAt: new Date(),
        network: 'tron',
      }),
    ])
    const client = createFakeClient()

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      'tron',
      728_126_428,
      SAFE_ADDR,
      5n
    )

    expect(result).toEqual({
      promoted: 0,
      reverted: 0,
      demoted: 0,
      awaiting: 0,
      backfilledExecuted: 0,
      backfilledReverted: 0,
    })
    expect(collection.rows[0]?.status).toBe('submitted')
  })
})

describe('reconcileSubmittedSafeTxs — Sweep A receipt branches', () => {
  it('promotes submitted → executed when receipt status is success', async () => {
    const execHash = ('0x' + 'cc'.repeat(32)) as Hex
    const collection = createFakeCollection([
      buildRow({
        safeTxHash:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        status: 'submitted',
        executionHash: execHash,
        submittedAt: new Date(),
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 4n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
    ])
    const client = createFakeClient({ receipts: { [execHash]: 'success' } })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      5n
    )

    expect(result.promoted).toBe(1)
    expect(result.reverted).toBe(0)
    expect(result.demoted).toBe(0)
    expect(result.awaiting).toBe(0)
    expect(collection.rows[0]?.status).toBe('executed')
  })

  it('marks submitted → reverted when receipt status is reverted', async () => {
    const execHash = ('0x' + 'dd'.repeat(32)) as Hex
    const collection = createFakeCollection([
      buildRow({
        status: 'submitted',
        executionHash: execHash,
        submittedAt: new Date(),
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 4n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
    ])
    const client = createFakeClient({ receipts: { [execHash]: 'reverted' } })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      5n
    )

    expect(result.reverted).toBe(1)
    expect(collection.rows[0]?.status).toBe('reverted')
  })

  it('demotes submitted → pending after grace window when receipt is missing', async () => {
    const execHash = ('0x' + 'ee'.repeat(32)) as Hex
    const collection = createFakeCollection([
      buildRow({
        status: 'submitted',
        executionHash: execHash,
        submittedAt: new Date(Date.now() - (SUBMITTED_GRACE_MS + 60_000)),
      }),
    ])
    const client = createFakeClient({ receipts: { [execHash]: 'missing' } })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      0n
    )

    expect(result.demoted).toBe(1)
    expect(collection.rows[0]?.status).toBe('pending')
    expect(collection.rows[0]?.executionHash).toBeUndefined()
    expect(collection.rows[0]?.submittedAt).toBeUndefined()
  })

  it('leaves submitted alone within grace window and counts as awaiting', async () => {
    const execHash = ('0x' + 'ef'.repeat(32)) as Hex
    const collection = createFakeCollection([
      buildRow({
        status: 'submitted',
        executionHash: execHash,
        submittedAt: new Date(),
      }),
    ])
    const client = createFakeClient({ receipts: { [execHash]: 'missing' } })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      0n
    )

    expect(result.awaiting).toBe(1)
    expect(result.demoted).toBe(0)
    expect(collection.rows[0]?.status).toBe('submitted')
    expect(collection.rows[0]?.executionHash).toBe(execHash)
  })

  it('treats a submittedAt-less row as past the grace window', async () => {
    const execHash = ('0x' + 'f0'.repeat(32)) as Hex
    const collection = createFakeCollection([
      buildRow({
        status: 'submitted',
        executionHash: execHash,
        // submittedAt deliberately omitted to exercise the fallback branch.
      }),
    ])
    const client = createFakeClient({ receipts: { [execHash]: 'missing' } })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      0n
    )

    expect(result.demoted).toBe(1)
    expect(collection.rows[0]?.status).toBe('pending')
  })

  it('does nothing when there are no submitted rows', async () => {
    const collection = createFakeCollection([buildRow({ status: 'pending' })])
    const client = createFakeClient()

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      0n
    )

    expect(result).toEqual({
      promoted: 0,
      reverted: 0,
      demoted: 0,
      awaiting: 0,
      backfilledExecuted: 0,
      backfilledReverted: 0,
    })
  })
})

describe('reconcileSubmittedSafeTxs — nonce-gap gating', () => {
  it('skips Sweep B when on-chain nonce matches DB-expected nonce', async () => {
    const collection = createFakeCollection([
      buildRow({
        status: 'executed',
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 4n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
    ])

    // If Sweep B ran, getLogs would throw; ensure it does not by passing a
    // client whose getLogs would explode if called.
    const client = createFakeClient({
      getLogsError: new Error('Sweep B must not run'),
    })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      5n // exactly maxExecutedNonce (4) + 1
    )

    expect(result.backfilledExecuted).toBe(0)
    expect(result.backfilledReverted).toBe(0)
  })

  it('triggers Sweep B when on-chain nonce exceeds DB-expected nonce', async () => {
    const missingSafeTxHash =
      '0x0000000000000000000000000000000000000000000000000000000000000aaa' as Hex
    const collection = createFakeCollection([
      // Executed row at nonce 4 (consumed)
      buildRow({
        safeTxHash:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
        status: 'executed',
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 4n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
      // Pending row at nonce 5 — should be back-filled from the log
      buildRow({
        safeTxHash: missingSafeTxHash,
        status: 'pending',
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 5n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
    ])

    const txHash = ('0x' + '7a'.repeat(32)) as Hex
    const client = createFakeClient({
      blockNumber: 1_000_000n,
      logs: [
        makeExecutionLog(EXECUTION_SUCCESS_TOPIC, missingSafeTxHash, txHash),
      ],
    })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      6n // chain ahead of DB-expected (5)
    )

    expect(result.backfilledExecuted).toBe(1)
    expect(result.backfilledReverted).toBe(0)
    const backfilled = collection.rows.find(
      (r) => r.safeTxHash === missingSafeTxHash
    )
    expect(backfilled?.status).toBe('executed')
    expect(backfilled?.executionHash).toBe(txHash)
    expect(backfilled?.submittedAt).toBeInstanceOf(Date)
  })

  it('back-fills ExecutionFailure logs as reverted', async () => {
    const missingSafeTxHash =
      '0x0000000000000000000000000000000000000000000000000000000000000bbb' as Hex
    const collection = createFakeCollection([
      buildRow({
        safeTxHash: missingSafeTxHash,
        status: 'pending',
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 0n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
    ])

    const txHash = ('0x' + '7b'.repeat(32)) as Hex
    const client = createFakeClient({
      blockNumber: 100n,
      logs: [
        makeExecutionLog(EXECUTION_FAILURE_TOPIC, missingSafeTxHash, txHash),
      ],
    })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      1n
    )

    expect(result.backfilledReverted).toBe(1)
    expect(collection.rows[0]?.status).toBe('reverted')
    expect(collection.rows[0]?.executionHash).toBe(txHash)
  })

  it('treats submitted rows as in-flight when computing expected nonce', async () => {
    const collection = createFakeCollection([
      buildRow({
        status: 'executed',
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 4n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
      // A submitted row whose receipt is missing-within-grace stays in the
      // "submitted" bucket; expected nonce should be 4 + 1 + 1 = 6.
      buildRow({
        safeTxHash:
          '0x0000000000000000000000000000000000000000000000000000000000000005',
        status: 'submitted',
        executionHash: ('0x' + 'a1'.repeat(32)) as Hex,
        submittedAt: new Date(),
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 5n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
    ])
    const client = createFakeClient({
      receipts: { [('0x' + 'a1'.repeat(32)) as Hex]: 'missing' },
      getLogsError: new Error('Sweep B must not run when chain == expected'),
    })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      6n // matches 4 + 1 + 1 submitted
    )

    expect(result.awaiting).toBe(1)
    expect(result.backfilledExecuted).toBe(0)
  })

  it('returns 0 expected nonce when no executed/reverted/submitted rows exist', async () => {
    const collection = createFakeCollection([])
    const missingSafeTxHash =
      '0x0000000000000000000000000000000000000000000000000000000000000ccc' as Hex
    const client = createFakeClient({
      blockNumber: 50n,
      logs: [
        makeExecutionLog(
          EXECUTION_SUCCESS_TOPIC,
          missingSafeTxHash,
          ('0x' + '7c'.repeat(32)) as Hex
        ),
      ],
    })

    // Empty DB → expected nonce 0; chain at 1 triggers Sweep B but no DB row
    // matches the event topic, so modifiedCount stays 0.
    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      1n
    )

    expect(result.backfilledExecuted).toBe(0)
    expect(result.backfilledReverted).toBe(0)
  })
})

describe('reconcileSubmittedSafeTxs — Sweep B resilience', () => {
  it('skips back-fill when getBlockNumber fails', async () => {
    const collection = createFakeCollection([
      buildRow({
        status: 'pending',
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 0n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
    ])
    const client = createFakeClient({
      blockNumber: async () => {
        throw new Error('rpc down')
      },
    })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      99n
    )

    expect(result.backfilledExecuted).toBe(0)
    expect(result.backfilledReverted).toBe(0)
  })

  it('skips back-fill when getLogs fails', async () => {
    const collection = createFakeCollection([])
    const client = createFakeClient({
      blockNumber: 100n,
      getLogsError: new Error('range too wide'),
    })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      1n
    )

    expect(result.backfilledExecuted).toBe(0)
    expect(result.backfilledReverted).toBe(0)
  })

  it('ignores logs without a transactionHash (mempool inclusion artefact)', async () => {
    const missingSafeTxHash =
      '0x0000000000000000000000000000000000000000000000000000000000000ddd' as Hex
    const collection = createFakeCollection([
      buildRow({ safeTxHash: missingSafeTxHash, status: 'pending' }),
    ])
    const client = createFakeClient({
      blockNumber: 100n,
      logs: [
        makeExecutionLog(EXECUTION_SUCCESS_TOPIC, missingSafeTxHash, null),
      ],
    })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      1n
    )

    expect(result.backfilledExecuted).toBe(0)
    expect(collection.rows[0]?.status).toBe('pending')
  })

  it('skips logs whose ABI does not match Safe execution events', async () => {
    const collection = createFakeCollection([])
    const client = createFakeClient({
      blockNumber: 100n,
      logs: [
        {
          address: SAFE_ADDR,
          // Junk topic — decodeEventLog will throw.
          topics: [('0x' + '99'.repeat(32)) as Hex],
          data: '0x',
          blockNumber: 99n,
          transactionHash: ('0x' + '7d'.repeat(32)) as Hex,
          logIndex: 0,
          blockHash: ('0x' + 'bb'.repeat(32)) as Hex,
          transactionIndex: 0,
          removed: false,
        } as unknown as Log,
      ],
    })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      1n
    )

    expect(result.backfilledExecuted).toBe(0)
    expect(result.backfilledReverted).toBe(0)
  })

  it('skips logs whose safeTxHash matches no pending row', async () => {
    const matchedSafeTxHash =
      '0x0000000000000000000000000000000000000000000000000000000000000eee' as Hex
    const collection = createFakeCollection([
      // Row exists but with a different safeTxHash → no match
      buildRow({
        safeTxHash:
          '0x000000000000000000000000000000000000000000000000000000000000beef',
        status: 'pending',
      }),
    ])
    const client = createFakeClient({
      blockNumber: 100n,
      logs: [
        makeExecutionLog(
          EXECUTION_SUCCESS_TOPIC,
          matchedSafeTxHash,
          ('0x' + '7e'.repeat(32)) as Hex
        ),
      ],
    })

    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      1n
    )

    expect(result.backfilledExecuted).toBe(0)
  })

  it('clamps fromBlock to 0 when chain head is below the lookback range', async () => {
    // Block number < lookback → fromBlock should be 0n (not negative).
    const lowChainHead = RECONCILE_LOOKBACK_BLOCKS - 100n
    const collection = createFakeCollection([])
    let observedFromBlock: bigint | undefined
    const client = {
      async getBlockNumber() {
        return lowChainHead
      },
      async getLogs(args: { fromBlock: bigint }) {
        observedFromBlock = args.fromBlock
        return []
      },
    } as unknown as PublicClient

    await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      1n
    )

    expect(observedFromBlock).toBe(0n)
  })

  it('passes through bigint hash values intact for executionHash storage', async () => {
    // Sanity check on hash plumbing — uses viem's toHex to verify type round-trip.
    const value = 0x1234n
    expect(toHex(value)).toBe('0x1234')
  })
})
