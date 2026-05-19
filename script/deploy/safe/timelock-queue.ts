/**
 * Timelock execution queue helpers.
 *
 * Backs the auto-execution runner with a write-once queue stored in the
 * non-sensitive `MONGODB_URI` cluster (DB `timelock-operations`, collection
 * `queue`). Producers (`confirm-safe-tx.ts`) upsert a row when a Safe tx
 * scheduling a timelock op is mined; the consumer (`execute-pending-timelock-tx.ts`)
 * reads ready rows, re-verifies them on-chain, and flips status after
 * successful execution.
 *
 */

import { consola } from 'consola'
import {
  MongoClient,
  type Collection,
  type Filter,
  type ObjectId,
} from 'mongodb'
import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from 'viem'

import { getEnvVar } from '../../utils/utils'

import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_SCHEDULE_BATCH_SELECTOR,
} from './timelock-abi'

/** Database name for timelock execution queue inside the `MONGODB_URI` cluster. */
const TIMELOCK_QUEUE_DB_NAME = 'timelock-operations'

/** Collection name for timelock execution queue. */
const TIMELOCK_QUEUE_COLLECTION_NAME = 'queue'

/** Possible lifecycle states for a queue row. */
type TimelockQueueStatus = 'queued' | 'executed' | 'cancelled' | 'failed'

/**
 * Schedule parameters as decoded from a `scheduleBatch` Safe tx (BigInts).
 * Used internally before serialization for Mongo storage.
 */
export interface IScheduleBatchParams {
  targets: readonly Address[]
  values: readonly bigint[]
  payloads: readonly Hex[]
  predecessor: Hex
  salt: Hex
  delay: bigint
}

/**
 * MongoDB-stored representation of a queued timelock operation.
 *
 * BigInt fields (`values[]`, `delay`) are serialized as decimal strings
 * because BSON has no native bigint type.
 */
export interface ITimelockQueueDoc {
  _id?: ObjectId
  /** Unique identifier of the timelock op (deterministic over schedule params). */
  operationId: Hex
  /** Lowercase network name (matches `networks.json` keys). */
  network: string
  /** Numeric chain id. */
  chainId: number
  /** Address of the `LiFiTimelockController` for this network. */
  timelockAddress: Address
  /** Inner call targets passed to `scheduleBatch`. */
  targets: Address[]
  /** Inner call values, decimal strings (BigInt-safe). */
  values: string[]
  /** Inner call payloads. */
  payloads: Hex[]
  /** Predecessor operation id (`bytes32(0)` if none). */
  predecessor: Hex
  /** Salt used for the schedule (`bytes32`). */
  salt: Hex
  /** Configured timelock delay in seconds, decimal string. */
  delay: string
  /** Hash of the originating Safe tx (used for traceability). */
  safeTxHash: string
  /** On-chain hash of the Safe tx that scheduled this op. */
  executionHash?: string
  /** On-chain hash of the runner's `executeBatch` (set when status flips to executed). */
  executionTxHash?: string
  /** Lifecycle status; `queued` rows are picked up by the runner. */
  status: TimelockQueueStatus
  /** Timestamp the row was first inserted. */
  createdAt: Date
  /** Timestamp of the last status change. */
  updatedAt: Date
  /** Set when status flips to `executed`. */
  executedAt?: Date
  /** Set when status flips to `cancelled`. */
  cancelledAt?: Date
  /** Optional human-readable reason when status is `failed`. */
  failureReason?: string
}

/**
 * Opens a short-lived MongoDB client and returns the queue collection.
 *
 * Mirrors the lifecycle of `getSafeMongoCollection()` in `safe-utils.ts`
 * but targets the non-sensitive `MONGODB_URI` cluster.
 *
 * @returns The connected client (caller must `close()`) and the queue collection.
 * @throws Error if `MONGODB_URI` is not set.
 */
export async function getTimelockQueueCollection(): Promise<{
  client: MongoClient
  timelockQueue: Collection<ITimelockQueueDoc>
}> {
  const client = new MongoClient(getEnvVar('MONGODB_URI'))
  const db = client.db(TIMELOCK_QUEUE_DB_NAME)
  const timelockQueue = db.collection<ITimelockQueueDoc>(
    TIMELOCK_QUEUE_COLLECTION_NAME
  )
  try {
    await ensureTimelockQueueIndexes(timelockQueue)
    return { client, timelockQueue }
  } catch (error) {
    await client.close()
    throw error
  }
}

/**
 * Ensures the indexes the queue depends on. Idempotent — duplicate-index
 * errors (Mongo error code 85/86) are swallowed.
 *
 * @param timelockQueue - The collection to index.
 */
export async function ensureTimelockQueueIndexes(
  timelockQueue: Collection<ITimelockQueueDoc>
): Promise<void> {
  // (network, operationId) is the natural primary key — `operationId` is
  // computed via OpenZeppelin's `hashOperationBatch`, which does not include
  // chain id or contract address, so structurally identical batches scheduled
  // on two chains can share an `operationId`. Scoping the unique index by
  // network keeps queue rows isolated per chain.
  await safeCreateIndex(
    timelockQueue,
    { network: 1, operationId: 1 },
    {
      unique: true,
      name: 'unique_network_operation_id',
    }
  )
  // Executor query: find queued rows for a given network.
  await safeCreateIndex(
    timelockQueue,
    { network: 1, status: 1 },
    {
      name: 'network_status',
    }
  )
}

async function safeCreateIndex(
  collection: Collection<ITimelockQueueDoc>,
  spec: Record<string, 1 | -1>,
  options: { unique?: boolean; name: string }
): Promise<void> {
  try {
    await collection.createIndex(spec, options)
  } catch (error: unknown) {
    // Codes 85 (IndexOptionsConflict) and 86 (IndexKeySpecsConflict) only fire
    // when an index with the same name already exists with a *different*
    // definition. Exact-match re-creation is a no-op and does not throw, so
    // hitting these codes means the deployed index has drifted from the spec
    // we want — surfacing it forces an operator to reconcile rather than
    // letting the runner proceed against an unintended index.
    if (
      error instanceof Error &&
      'code' in error &&
      ((error as { code: number }).code === 85 ||
        (error as { code: number }).code === 86)
    )
      throw new Error(
        `Index conflict for "${options.name}" on ${
          collection.collectionName
        } (spec=${JSON.stringify(
          spec
        )}). Existing index has a different definition; drop or reconcile it before retrying.`,
        { cause: error }
      )
    throw error
  }
}

/**
 * Builds a Mongo filter selecting a queue row by its natural primary key
 * `(network, operationId)`. `network` is normalised to lowercase to match the
 * stored value. Both fields use `$eq` so object-typed values cannot be
 * interpreted as Mongo operator expressions.
 *
 * @param network - Network slug (matches `networks.json` keys).
 * @param operationId - The operation id to match (32-byte hex).
 * @returns A filter selecting the queue row with this `(network, operationId)`.
 */
export function byOperationId(
  network: string,
  operationId: Hex
): Filter<ITimelockQueueDoc> {
  return {
    network: { $eq: network.toLowerCase() },
    operationId: { $eq: operationId },
  }
}

/**
 * Computes the operation id for a `scheduleBatch` call. Mirrors
 * Solidity's `TimelockController.hashOperationBatch`.
 *
 * @param targets - Inner call targets.
 * @param values - Inner call values (wei).
 * @param payloads - Inner call payloads.
 * @param predecessor - Predecessor op id (`bytes32(0)` if none).
 * @param salt - Schedule salt (`bytes32`).
 * @returns Deterministic 32-byte operation id.
 */
export function computeOperationIdBatch(
  targets: readonly Address[],
  values: readonly bigint[],
  payloads: readonly Hex[],
  predecessor: Hex,
  salt: Hex
): Hex {
  const encoded = encodeAbiParameters(
    [
      { name: 'targets', type: 'address[]' },
      { name: 'values', type: 'uint256[]' },
      { name: 'payloads', type: 'bytes[]' },
      { name: 'predecessor', type: 'bytes32' },
      { name: 'salt', type: 'bytes32' },
    ],
    [
      targets as Address[],
      values as bigint[],
      payloads as Hex[],
      predecessor,
      salt,
    ]
  )
  return keccak256(encoded)
}

/**
 * Returns true if the given calldata starts with the `scheduleBatch` selector.
 *
 * @param data - Raw Safe tx calldata.
 * @returns Whether the call targets `LiFiTimelockController.scheduleBatch`.
 */
export function isScheduleBatchCalldata(
  data: Hex | string | undefined
): boolean {
  if (!data || typeof data !== 'string' || data.length < 10) return false
  return (
    data.slice(0, 10).toLowerCase() ===
    TIMELOCK_SCHEDULE_BATCH_SELECTOR.toLowerCase()
  )
}

/**
 * Decodes a `scheduleBatch` Safe tx calldata into its constituent params.
 *
 * @param data - Raw calldata, must start with the `scheduleBatch` selector.
 * @returns Decoded `(targets, values, payloads, predecessor, salt, delay)`.
 * @throws Error if the calldata cannot be decoded against the known ABI.
 */
export function decodeScheduleBatch(data: Hex): IScheduleBatchParams {
  const decoded = decodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    data,
  })
  const [targets, values, payloads, predecessor, salt, delay] =
    decoded.args as [
      readonly Address[],
      readonly bigint[],
      readonly Hex[],
      Hex,
      Hex,
      bigint
    ]
  return { targets, values, payloads, predecessor, salt, delay }
}

/**
 * Serializes decoded schedule params into BSON-safe shapes (BigInt → string).
 *
 * @param params - Decoded `scheduleBatch` params with BigInt fields.
 * @returns Same shape with `values[]` and `delay` as decimal strings.
 */
export function serializeScheduleParams(
  params: IScheduleBatchParams
): Pick<
  ITimelockQueueDoc,
  'targets' | 'values' | 'payloads' | 'predecessor' | 'salt' | 'delay'
> {
  return {
    targets: [...params.targets],
    values: params.values.map((v) => v.toString()),
    payloads: [...params.payloads],
    predecessor: params.predecessor,
    salt: params.salt,
    delay: params.delay.toString(),
  }
}

/**
 * Reverses {@link serializeScheduleParams} for runner-side consumption.
 *
 * @param doc - Stored queue row.
 * @returns Schedule params with BigInt fields restored.
 */
export function deserializeScheduleParams(
  doc: Pick<
    ITimelockQueueDoc,
    'targets' | 'values' | 'payloads' | 'predecessor' | 'salt' | 'delay'
  >
): IScheduleBatchParams {
  return {
    targets: doc.targets,
    values: doc.values.map((v) => BigInt(v)),
    payloads: doc.payloads,
    predecessor: doc.predecessor,
    salt: doc.salt,
    delay: BigInt(doc.delay),
  }
}

/**
 * Upserts a row into the timelock execution queue when the just-executed Safe
 * tx scheduled a timelock op. No-op for any other Safe tx.
 *
 * Called from two paths: the live execution path in `confirm-safe-tx`, and
 * the reconciliation pass in `reconcile.ts` when a previously `submitted`
 * row is promoted to `executed` (or a pending row is back-filled from
 * on-chain logs). The upsert is keyed by `(network, operationId)` so it is
 * idempotent across both call sites.
 *
 * Errors are logged as warnings only — the Safe tx is already mined and is
 * the authoritative record. A missed enqueue can be repaired via the
 * backfill script.
 *
 * @param callData - The Safe tx calldata (must be a `scheduleBatch` call to enqueue).
 * @param to - The target of the Safe tx (the timelock address when applicable).
 * @param safeTxHash - Safe-side hash of the tx (for traceability).
 * @param executionHash - On-chain hash of the Safe execution tx.
 * @param chainId - Numeric chain id of the network.
 * @param networkName - Network name (lowercased before storage).
 */
export async function enqueueTimelockOpIfApplicable(
  callData: Hex,
  to: Address,
  safeTxHash: string,
  executionHash: string,
  chainId: number,
  networkName: string
): Promise<void> {
  if (!isScheduleBatchCalldata(callData)) return

  try {
    const params = decodeScheduleBatch(callData)
    const operationId = computeOperationIdBatch(
      params.targets,
      params.values,
      params.payloads,
      params.predecessor,
      params.salt
    )
    const network = networkName.toLowerCase()
    const timelockAddress = getAddress(to)
    const serialized = serializeScheduleParams(params)
    const now = new Date()

    const { client, timelockQueue } = await getTimelockQueueCollection()
    try {
      // Filter inlined (not via byOperationId) so static analyzers can see
      // the $eq wrap directly. The helper is functionally identical and
      // used unchanged at every other call site.
      await timelockQueue.updateOne(
        {
          network: { $eq: network },
          operationId: { $eq: operationId },
        },
        {
          $setOnInsert: {
            operationId,
            network,
            chainId,
            timelockAddress,
            ...serialized,
            createdAt: now,
          },
          $set: {
            status: 'queued',
            safeTxHash,
            executionHash,
            updatedAt: now,
          },
        },
        { upsert: true }
      )
      consola.success(
        `Enqueued timelock op ${operationId} for auto-execution on ${network}`
      )
    } finally {
      await client.close()
    }
  } catch (error) {
    consola.warn(
      'Failed to enqueue timelock op (Safe tx already on-chain; can be re-enqueued via backfill):',
      error
    )
  }
}
