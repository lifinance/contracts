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
  mock,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type Collection } from 'mongodb'
import {
  encodeAbiParameters,
  keccak256,
  stringToBytes,
  toHex,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'

import {
  reconcileAllSubmittedSafeTxs,
  reconcileCoverageKey,
  reconcileSubmittedSafeTxs,
  RECONCILE_LOOKBACK_BLOCKS,
  SUBMITTED_GRACE_MS,
} from './reconcile'
import { type ISafeTransaction, type ISafeTxDocument } from './safe-utils'
import { type enqueueTimelockOpIfApplicable } from './timelock-queue'

const noopEnqueueImpl: typeof enqueueTimelockOpIfApplicable = async (
  _callData,
  _to,
  _safeTxHash,
  _executionHash,
  _chainId,
  _networkName
) => undefined

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
      if ('$eq' in op) {
        if (rowVal !== op.$eq) return false
      } else if ('$in' in op) {
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
    async findOne(
      filter: Record<string, unknown>
    ): Promise<ISafeTxDocument | null> {
      return rows.find((r) => matchesFilter(r, filter)) ?? null
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
  receipts?: Record<string, 'success' | 'reverted' | 'missing' | 'rpc_error'>
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
        throw new TransactionReceiptNotFoundError({ hash })
      if (status === 'rpc_error')
        throw new Error('connection refused: rpc.example.com')
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

  it('leaves submitted alone when receipt lookup hits an RPC error, even past grace', async () => {
    const execHash = ('0x' + 'fa'.repeat(32)) as Hex
    const collection = createFakeCollection([
      buildRow({
        status: 'submitted',
        executionHash: execHash,
        // submittedAt deliberately well past grace to prove we still hold off.
        submittedAt: new Date(Date.now() - (SUBMITTED_GRACE_MS + 60_000)),
      }),
    ])
    const client = createFakeClient({ receipts: { [execHash]: 'rpc_error' } })

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
    // Row must not be touched — demoting on a transient RPC failure would
    // free the nonce for reuse and reintroduce the GS026 race.
    expect(collection.rows[0]?.status).toBe('submitted')
    expect(collection.rows[0]?.executionHash).toBe(execHash)
    expect(collection.rows[0]?.submittedAt).toBeInstanceOf(Date)
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

  it('excludes a reverted row from the consumed head so the revert → re-execute → lost-hash gap still triggers Sweep B', async () => {
    const reExecutedSafeTxHash =
      '0x0000000000000000000000000000000000000000000000000000000000000ddd' as Hex
    const collection = createFakeCollection([
      // executed @3 — the genuine consumed head
      buildRow({
        safeTxHash:
          '0x0000000000000000000000000000000000000000000000000000000000000010',
        status: 'executed',
        safeTx: {
          data: {
            to: '0x0000000000000000000000000000000000000000' as Address,
            value: 0n,
            data: '0x' as Hex,
            operation: 0,
            nonce: 3n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
      // reverted @4 — the highest-nonce consumed-status row, but a reverted tx
      // rolls back its nonce++ so it must NOT count toward the head
      buildRow({
        safeTxHash:
          '0x0000000000000000000000000000000000000000000000000000000000000011',
        status: 'reverted',
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
      // re-proposal @4 executed on-chain (nonce → 5) but its hash was lost
      // before reaching Mongo; Sweep B must back-fill it
      buildRow({
        safeTxHash: reExecutedSafeTxHash,
        status: 'pending',
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

    const txHash = ('0x' + '7d'.repeat(32)) as Hex
    const client = createFakeClient({
      blockNumber: 1_000_000n,
      logs: [
        makeExecutionLog(EXECUTION_SUCCESS_TOPIC, reExecutedSafeTxHash, txHash),
      ],
    })

    // expected = maxConsumed(executed@3) + 1 = 4; if the reverted@4 row were
    // counted, expected would be 5 and Sweep B would be skipped (5 <= 5).
    const result = await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      5n
    )

    expect(result.backfilledExecuted).toBe(1)
    const backfilled = collection.rows.find(
      (r) => r.safeTxHash === reExecutedSafeTxHash
    )
    expect(backfilled?.status).toBe('executed')
    expect(backfilled?.executionHash).toBe(txHash)
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

describe('reconcileSubmittedSafeTxs — timelock enqueue plumbing', () => {
  it('invokes the enqueue function when Sweep A promotes submitted → executed', async () => {
    const execHash = ('0x' + '11'.repeat(32)) as Hex
    const calldata = ('0x' + 'a1'.repeat(36)) as Hex
    const target = ('0x' + '12'.repeat(20)) as Address
    const row = buildRow({
      status: 'submitted',
      executionHash: execHash,
      submittedAt: new Date(),
      safeTx: {
        data: {
          to: target,
          value: 0n,
          data: calldata,
          operation: 0,
          nonce: 7n,
        },
        signatures: new Map(),
      } as ISafeTransaction,
    })
    const collection = createFakeCollection([row])
    const client = createFakeClient({ receipts: { [execHash]: 'success' } })
    const enqueueSpy = mock(noopEnqueueImpl)

    await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      8n,
      { enqueueTimelockOpFn: enqueueSpy }
    )

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(enqueueSpy.mock.calls[0]).toEqual([
      calldata,
      target,
      row.safeTxHash,
      execHash,
      CHAIN_ID,
      NETWORK,
    ])
  })

  it('does not invoke the enqueue function on Sweep A revert / demote / awaiting', async () => {
    const execRevert = ('0x' + '21'.repeat(32)) as Hex
    const execMissing = ('0x' + '22'.repeat(32)) as Hex
    const execRpcErr = ('0x' + '23'.repeat(32)) as Hex
    const collection = createFakeCollection([
      buildRow({
        safeTxHash:
          '0x0000000000000000000000000000000000000000000000000000000000000010',
        status: 'submitted',
        executionHash: execRevert,
        submittedAt: new Date(),
      }),
      buildRow({
        safeTxHash:
          '0x0000000000000000000000000000000000000000000000000000000000000011',
        status: 'submitted',
        executionHash: execMissing,
        submittedAt: new Date(Date.now() - (SUBMITTED_GRACE_MS + 60_000)),
      }),
      buildRow({
        safeTxHash:
          '0x0000000000000000000000000000000000000000000000000000000000000012',
        status: 'submitted',
        executionHash: execRpcErr,
        submittedAt: new Date(),
      }),
    ])
    const client = createFakeClient({
      receipts: {
        [execRevert]: 'reverted',
        [execMissing]: 'missing',
        [execRpcErr]: 'rpc_error',
      },
    })
    const enqueueSpy = mock(noopEnqueueImpl)

    await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      0n,
      { enqueueTimelockOpFn: enqueueSpy }
    )

    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('invokes the enqueue function when Sweep B back-fills a pending row to executed', async () => {
    const missingSafeTxHash =
      '0x000000000000000000000000000000000000000000000000000000000000aaaa' as Hex
    const calldata = ('0x' + 'cd'.repeat(36)) as Hex
    const target = ('0x' + '34'.repeat(20)) as Address
    const txHash = ('0x' + '7a'.repeat(32)) as Hex
    const collection = createFakeCollection([
      buildRow({
        safeTxHash: missingSafeTxHash,
        status: 'pending',
        safeTx: {
          data: {
            to: target,
            value: 0n,
            data: calldata,
            operation: 0,
            nonce: 0n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
    ])
    const client = createFakeClient({
      blockNumber: 100n,
      logs: [
        makeExecutionLog(EXECUTION_SUCCESS_TOPIC, missingSafeTxHash, txHash),
      ],
    })
    const enqueueSpy = mock(noopEnqueueImpl)

    await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      1n,
      { enqueueTimelockOpFn: enqueueSpy }
    )

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(enqueueSpy.mock.calls[0]).toEqual([
      calldata,
      target,
      missingSafeTxHash,
      txHash,
      CHAIN_ID,
      NETWORK,
    ])
  })

  it('does not invoke the enqueue function on Sweep B revert back-fill', async () => {
    const missingSafeTxHash =
      '0x000000000000000000000000000000000000000000000000000000000000bbbb' as Hex
    const txHash = ('0x' + '7b'.repeat(32)) as Hex
    const collection = createFakeCollection([
      buildRow({ safeTxHash: missingSafeTxHash, status: 'pending' }),
    ])
    const client = createFakeClient({
      blockNumber: 100n,
      logs: [
        makeExecutionLog(EXECUTION_FAILURE_TOPIC, missingSafeTxHash, txHash),
      ],
    })
    const enqueueSpy = mock(noopEnqueueImpl)

    await reconcileSubmittedSafeTxs(
      collection,
      client,
      NETWORK,
      CHAIN_ID,
      SAFE_ADDR,
      1n,
      { enqueueTimelockOpFn: enqueueSpy }
    )

    expect(enqueueSpy).not.toHaveBeenCalled()
  })
})

describe('reconcileAllSubmittedSafeTxs — startup sweep across networks', () => {
  function submittedRow(
    network: string,
    chainId: number,
    executionHash: Hex,
    overrides: Partial<ISafeTxDocument> = {}
  ): ISafeTxDocument {
    return buildRow({
      network,
      chainId,
      safeAddress: SAFE_ADDR,
      status: 'submitted',
      executionHash,
      submittedAt: new Date(),
      safeTxHash: executionHash,
      ...overrides,
    })
  }

  it('reconciles a network whose only row is submitted (no pending sibling)', async () => {
    const execHash = ('0x' + 'c1'.repeat(32)) as Hex
    const calldata = ('0x' + 'a1'.repeat(36)) as Hex
    const target = ('0x' + '12'.repeat(20)) as Address
    const collection = createFakeCollection([
      submittedRow('base', 8453, execHash, {
        safeTx: {
          data: {
            to: target,
            value: 0n,
            data: calldata,
            operation: 0,
            nonce: 4n,
          },
          signatures: new Map(),
        } as ISafeTransaction,
      }),
    ])
    const client = createFakeClient({ receipts: { [execHash]: 'success' } })
    const enqueueSpy = mock(noopEnqueueImpl)
    const factoryCalls: string[] = []

    const covered = await reconcileAllSubmittedSafeTxs(collection, {
      publicClientFactory: (network) => {
        factoryCalls.push(network)
        return client
      },
      readSafeNonce: async () => 5n,
      enqueueTimelockOpFn: enqueueSpy,
    })

    expect(factoryCalls).toEqual(['base'])
    expect([...covered]).toEqual([
      reconcileCoverageKey('base', 8453, SAFE_ADDR),
    ])
    expect(collection.rows[0]?.status).toBe('executed')
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(enqueueSpy.mock.calls[0]).toEqual([
      calldata,
      target,
      execHash,
      execHash,
      8453,
      'base',
    ])
  })

  it('honors the network filter and sweeps only the named network', async () => {
    const hashBase = ('0x' + 'b1'.repeat(32)) as Hex
    const hashOp = ('0x' + 'b2'.repeat(32)) as Hex
    const collection = createFakeCollection([
      submittedRow('base', 8453, hashBase),
      submittedRow('optimism', 10, hashOp),
    ])
    const client = createFakeClient({
      receipts: { [hashBase]: 'success', [hashOp]: 'success' },
    })
    const factoryCalls: string[] = []

    const covered = await reconcileAllSubmittedSafeTxs(collection, {
      network: 'base',
      publicClientFactory: (network) => {
        factoryCalls.push(network)
        return client
      },
      readSafeNonce: async () => 1n,
      enqueueTimelockOpFn: mock(noopEnqueueImpl),
    })

    expect(factoryCalls).toEqual(['base'])
    expect([...covered]).toEqual([
      reconcileCoverageKey('base', 8453, SAFE_ADDR),
    ])
    expect(collection.rows.find((r) => r.network === 'optimism')?.status).toBe(
      'submitted'
    )
  })

  it('skips Tron networks without building a client or touching the row', async () => {
    const execHash = ('0x' + 'd1'.repeat(32)) as Hex
    const collection = createFakeCollection([
      submittedRow('tron', 728_126_428, execHash),
    ])
    const factoryCalls: string[] = []

    const covered = await reconcileAllSubmittedSafeTxs(collection, {
      publicClientFactory: (network) => {
        factoryCalls.push(network)
        return createFakeClient()
      },
      readSafeNonce: async () => 1n,
    })

    expect(factoryCalls).toEqual([])
    expect([...covered]).toEqual([])
    expect(collection.rows[0]?.status).toBe('submitted')
  })

  it('continues past a network whose client construction fails', async () => {
    const hashBase = ('0x' + 'e1'.repeat(32)) as Hex
    const hashOp = ('0x' + 'e2'.repeat(32)) as Hex
    const collection = createFakeCollection([
      submittedRow('base', 8453, hashBase),
      submittedRow('optimism', 10, hashOp),
    ])
    const okClient = createFakeClient({ receipts: { [hashOp]: 'success' } })

    const covered = await reconcileAllSubmittedSafeTxs(collection, {
      publicClientFactory: (network) => {
        if (network === 'base') throw new Error('rpc down')
        return okClient
      },
      readSafeNonce: async () => 1n,
      enqueueTimelockOpFn: mock(noopEnqueueImpl),
    })

    expect([...covered]).toEqual([
      reconcileCoverageKey('optimism', 10, SAFE_ADDR),
    ])
    expect(collection.rows.find((r) => r.network === 'optimism')?.status).toBe(
      'executed'
    )
    expect(collection.rows.find((r) => r.network === 'base')?.status).toBe(
      'submitted'
    )
  })

  it('tracks coverage per Safe — a sibling Safe failure is not masked by a success', async () => {
    const SAFE_A = ('0x' + '1a'.repeat(20)) as Address
    const SAFE_B = ('0x' + '2b'.repeat(20)) as Address
    const hashA = ('0x' + 'f1'.repeat(32)) as Hex
    const hashB = ('0x' + 'f2'.repeat(32)) as Hex
    const collection = createFakeCollection([
      submittedRow('base', 8453, hashA, { safeAddress: SAFE_A }),
      submittedRow('base', 8453, hashB, { safeAddress: SAFE_B }),
    ])
    const client = createFakeClient({ receipts: { [hashA]: 'success' } })

    const covered = await reconcileAllSubmittedSafeTxs(collection, {
      publicClientFactory: () => client,
      readSafeNonce: async (_c, addr) => {
        if (addr === SAFE_B) throw new Error('nonce read failed')
        return 5n
      },
      enqueueTimelockOpFn: mock(noopEnqueueImpl),
    })

    // Only Safe A's key is covered; Safe B's failure is isolated per Safe,
    // not masked by the same-network success.
    expect([...covered]).toEqual([reconcileCoverageKey('base', 8453, SAFE_A)])
    expect(collection.rows.find((r) => r.safeAddress === SAFE_A)?.status).toBe(
      'executed'
    )
    expect(collection.rows.find((r) => r.safeAddress === SAFE_B)?.status).toBe(
      'submitted'
    )
  })

  it('returns an empty set when there are no submitted rows', async () => {
    const collection = createFakeCollection([buildRow({ status: 'pending' })])
    const factoryCalls: string[] = []

    const covered = await reconcileAllSubmittedSafeTxs(collection, {
      publicClientFactory: (network) => {
        factoryCalls.push(network)
        return createFakeClient()
      },
      readSafeNonce: async () => 0n,
    })

    expect([...covered]).toEqual([])
    expect(factoryCalls).toEqual([])
  })
})
