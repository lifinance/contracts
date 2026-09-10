/**
 * What the blessed proposal seam does, and in what order.
 *
 * `propose-funnel-fence.test.ts` covers whether anything else can reach the
 * storage function; this covers what happens once a caller comes through here.
 *
 * Every refusal case pairs its claim with a positive marker — a run that never
 * reached the signature must not be indistinguishable from a run that refused
 * before it.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Collection, InsertOneResult } from 'mongodb'
import type { Address, Hex } from 'viem'

import { proposeSafeTx, type ProposalPayload } from './propose-safe-tx'
import {
  OperationTypeEnum,
  type ISafeTransaction,
  type ISafeTxDocument,
  type SafeClient,
} from './safe-utils'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const STRANGER = '0x2222222222222222222222222222222222222222' as Address
const SAFE = '0x3333333333333333333333333333333333333333' as Address
const TARGET = '0x4444444444444444444444444444444444444444' as Address
const CALLDATA = '0xdeadbeef' as Hex
const HASH = `0x${'ab'.repeat(32)}` as Hex

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

interface ISafeStubCalls {
  created: unknown[]
  signed: ISafeTransaction[]
  hashed: ISafeTransaction[]
}

interface IStoreCall {
  safeTx: ISafeTransaction
  safeTxHash: Hex
  proposer: Address
  network: string
  chainId: number
  safeAddress: Address
  parkedTaskRefs: unknown
  provenance: unknown
}

const buildSafeStub = (
  owners: Address[],
  signer: Address = OWNER
): { safe: SafeClient; calls: ISafeStubCalls } => {
  const calls: ISafeStubCalls = { created: [], signed: [], hashed: [] }
  const safe = {
    account: { address: signer },
    getOwners: async (): Promise<Address[]> => owners,
    createTransaction: async (options: unknown): Promise<ISafeTransaction> => {
      calls.created.push(options)
      const tx = options as {
        transactions: {
          to: Address
          value: bigint
          data: Hex
          operation: OperationTypeEnum
          nonce: bigint
        }[]
      }
      const [first] = tx.transactions
      if (!first)
        throw new Error('createTransaction was called with no transaction')
      return {
        data: {
          to: first.to,
          value: first.value,
          data: first.data,
          operation: first.operation,
          nonce: first.nonce,
        },
        signatures: new Map(),
      }
    },
    signTransaction: async (
      tx: ISafeTransaction
    ): Promise<ISafeTransaction> => {
      calls.signed.push(tx)
      const signatures = new Map(tx.signatures)
      signatures.set(signer.toLowerCase(), { signer, data: '0xsig' as Hex })
      return { data: tx.data, signatures }
    },
    getTransactionHash: async (tx: ISafeTransaction): Promise<Hex> => {
      calls.hashed.push(tx)
      return HASH
    },
  }

  // The stub carries the members `proposeSafeTx` reaches for; the cast is what
  // lets the call sites below be typed as the real client rather than `any`.
  return { safe: safe as unknown as SafeClient, calls }
}

/**
 * Stands in for the proposal store. `insertResult` is what
 * `storeTransactionInMongoDB` is made to return, so the wrapper's own reading of
 * that result is what each case observes.
 */
const buildStore = (
  insertResult: InsertOneResult<ISafeTxDocument> | null
): { collection: Collection<ISafeTxDocument>; calls: IStoreCall[] } => {
  const calls: IStoreCall[] = []
  const collection = {
    insertOne: async (doc: ISafeTxDocument) => {
      calls.push({
        safeTx: doc.safeTx,
        safeTxHash: doc.safeTxHash as Hex,
        proposer: doc.proposer as Address,
        network: doc.network,
        chainId: doc.chainId,
        safeAddress: doc.safeAddress as Address,
        parkedTaskRefs: (doc as { parkedTaskRefs?: unknown }).parkedTaskRefs,
        provenance: (doc as { provenance?: unknown }).provenance,
      })
      if (insertResult === null) {
        const duplicate = Object.assign(
          new Error('E11000 duplicate key error'),
          { code: 11000, keyPattern: { intentHash: 1 } }
        )
        throw duplicate
      }
      return insertResult
    },
    createIndex: async (): Promise<string> => 'stub',
    findOne: async (): Promise<null> => null,
  } as unknown as Collection<ISafeTxDocument>

  return { collection, calls }
}

const acknowledged = {
  acknowledged: true,
  insertedId: 'id',
} as unknown as InsertOneResult<ISafeTxDocument>

const unacknowledged = {
  acknowledged: false,
  insertedId: 'id',
} as unknown as InsertOneResult<ISafeTxDocument>

const callPayload: ProposalPayload = {
  kind: 'call',
  to: TARGET,
  data: CALLDATA,
  nonce: 7n,
}

const run = async (
  safe: SafeClient,
  collection: Collection<ISafeTxDocument>,
  payload: ProposalPayload = callPayload
) =>
  proposeSafeTx({
    safe,
    network: 'mainnet',
    chainId: 1,
    safeAddress: SAFE,
    pendingTransactions: collection,
    payload,
    // Passed rather than set in the environment: the store hard-blocks a
    // proposal without one, and a suite that leans on `SAFE_PROPOSAL_TICKET`
    // would both depend on and disturb whatever else reads it.
    provenance: { ticket: 'EXSC-957' },
  })

describe('proposeSafeTx — the signer must be a Safe owner', () => {
  it('refuses a non-owner before it signs or stores anything', async () => {
    const { safe, calls } = buildSafeStub([STRANGER], OWNER)
    const { collection, calls: stored } = buildStore(acknowledged)

    await expectRejects(
      run(safe, collection),
      `Signer ${OWNER} is not an owner of Safe ${SAFE} on mainnet`
    )

    // The refusal message alone would also be satisfied by a run that failed
    // somewhere else and never reached the check.
    expect(calls.signed).toHaveLength(0)
    expect(stored).toHaveLength(0)
  })

  it('proposes for an owner, so the refusal above is not refusing everything', async () => {
    const { safe, calls } = buildSafeStub([STRANGER, OWNER], OWNER)
    const { collection, calls: stored } = buildStore(acknowledged)

    expect(await run(safe, collection)).toEqual({
      safeTxHash: HASH,
      stored: true,
    })
    expect(calls.signed).toHaveLength(1)
    expect(stored).toHaveLength(1)
  })
})

describe('proposeSafeTx — what reaches the store', () => {
  it('stores the signed transaction, the hash taken from it, and the signer as proposer', async () => {
    const { safe, calls } = buildSafeStub([OWNER], OWNER)
    const { collection, calls: stored } = buildStore(acknowledged)

    await run(safe, collection)

    // Hashed off the signed transaction, not the unsigned one: the stored hash
    // and the stored signature have to describe the same bytes.
    expect(calls.hashed).toHaveLength(1)
    expect(calls.hashed[0]?.signatures.size).toBe(1)

    const [row] = stored
    if (!row) throw new Error('nothing reached the store')
    expect(row.safeTxHash).toBe(HASH)
    expect(row.proposer).toBe(OWNER)
    expect(row.safeAddress).toBe(SAFE)
    expect(row.chainId).toBe(1)
    expect(row.safeTx.data).toEqual({
      to: TARGET,
      value: 0n,
      data: CALLDATA,
      operation: OperationTypeEnum.Call,
      nonce: 7n,
    })
    expect(row.safeTx.signatures.size).toBe(1)
  })

  it('honours an explicit value and operation instead of defaulting them', async () => {
    const { safe } = buildSafeStub([OWNER], OWNER)
    const { collection, calls: stored } = buildStore(acknowledged)

    await run(safe, collection, {
      kind: 'call',
      to: TARGET,
      value: 5n,
      data: CALLDATA,
      operation: OperationTypeEnum.DelegateCall,
      nonce: 9n,
    })

    expect(stored[0]?.safeTx.data.value).toBe(5n)
    expect(stored[0]?.safeTx.data.operation).toBe(
      OperationTypeEnum.DelegateCall
    )
    expect(stored[0]?.safeTx.data.nonce).toBe(9n)
  })

  it('passes the drain annotations through to the stored proposal', async () => {
    const { safe } = buildSafeStub([OWNER], OWNER)
    const { collection, calls: stored } = buildStore(acknowledged)
    const parkedTaskRefs = [
      { taskKey: 'mainnet:0xabc', prUrl: 'https://github.com/o/r/pull/1' },
    ]

    await proposeSafeTx({
      safe,
      network: 'mainnet',
      chainId: 1,
      safeAddress: SAFE,
      pendingTransactions: collection,
      payload: callPayload,
      parkedTaskRefs: parkedTaskRefs as never,
      provenance: { ticket: 'EXSC-957', reason: 'drained removals' },
    })

    // The removals a proposal drains are only traceable to their origin PR
    // through these, and the wrapper is the only thing carrying them now.
    expect(stored[0]?.parkedTaskRefs).toEqual(parkedTaskRefs)
  })

  it('signs a prebuilt transaction without rebuilding it', async () => {
    const { safe, calls } = buildSafeStub([OWNER], OWNER)
    const { collection, calls: stored } = buildStore(acknowledged)
    const prebuilt: ISafeTransaction = {
      data: {
        to: TARGET,
        value: 0n,
        data: '0xfeed' as Hex,
        operation: OperationTypeEnum.Call,
        nonce: 42n,
      },
      signatures: new Map(),
    }

    await run(safe, collection, { kind: 'prebuilt', safeTx: prebuilt })

    expect(calls.created).toHaveLength(0)
    expect(calls.signed[0]?.data).toEqual(prebuilt.data)
    expect(stored[0]?.safeTx.data.nonce).toBe(42n)
  })
})

describe('proposeSafeTx — how the store outcome is reported', () => {
  it('reports stored=false when a pending proposal with the same intent exists', async () => {
    const { safe } = buildSafeStub([OWNER], OWNER)
    const { collection } = buildStore(null)

    expect(await run(safe, collection)).toEqual({
      safeTxHash: HASH,
      stored: false,
    })
  })

  it('refuses an unacknowledged insert rather than reporting a proposal', async () => {
    const { safe } = buildSafeStub([OWNER], OWNER)
    const { collection } = buildStore(unacknowledged)

    await expectRejects(
      run(safe, collection),
      'MongoDB insert was not acknowledged'
    )
  })
})
