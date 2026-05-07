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

import {
  MongoClient,
  type Collection,
  type Filter,
  type ObjectId,
} from 'mongodb'
import {
  decodeFunctionData,
  encodeAbiParameters,
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
export const TIMELOCK_QUEUE_DB_NAME = 'timelock-operations'

/** Collection name for timelock execution queue. */
export const TIMELOCK_QUEUE_COLLECTION_NAME = 'queue'

/** Possible lifecycle states for a queue row. */
export type TimelockQueueStatus = 'queued' | 'executed' | 'cancelled' | 'failed'

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
  await ensureTimelockQueueIndexes(timelockQueue)
  return { client, timelockQueue }
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
  // operationId is the natural primary key for idempotent upserts.
  await safeCreateIndex(
    timelockQueue,
    { operationId: 1 },
    {
      unique: true,
      name: 'unique_operation_id',
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
    // 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict — both mean
    // the index already exists with compatible options.
    if (
      error instanceof Error &&
      'code' in error &&
      ((error as { code: number }).code === 85 ||
        (error as { code: number }).code === 86)
    )
      return
    throw error
  }
}

/**
 * Builds a Mongo filter that matches a queue row by its `operationId` using
 * `$eq`. Forces operator-typed comparison so an object value can never be
 * interpreted as an operator expression (defense-in-depth — all current
 * callers pass locally-derived `Hex` strings).
 *
 * @param operationId - The operation id to match (32-byte hex).
 * @returns A filter selecting the queue row with this `operationId`.
 */
export function byOperationId(operationId: Hex): Filter<ITimelockQueueDoc> {
  return { operationId: { $eq: operationId } }
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
