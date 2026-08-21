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

/**
 * Possible lifecycle states for a queue row.
 *
 * `blocked` and `failed` both mean "the runner refused to execute", but they are
 * not interchangeable: a `blocked` op is still live on-chain and becomes
 * executable again once an operator clears the cause, so it stays visible and
 * re-drivable (`requeue-timelock-op.ts`). `failed` is reserved for ops that can
 * never run as stored — a tampered row, or an on-chain revert.
 */
export type TimelockQueueStatus =
  | 'queued'
  | 'executed'
  | 'cancelled'
  | 'blocked'
  | 'failed'

/** Every lifecycle state, for CLI argument validation. */
export const TIMELOCK_QUEUE_STATUSES = [
  'queued',
  'executed',
  'cancelled',
  'blocked',
  'failed',
] as const

/**
 * How long the runner waits before re-alerting on the same blocked op. Blocked
 * rows persist until an operator acts, so alerting is level-triggered with this
 * interval rather than edge-triggered — a single notification at the moment of
 * blocking is what let EXSC-816 sit unnoticed.
 */
export const BLOCKED_ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000

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
  /** Set when status flips to `blocked`. */
  blockedAt?: Date
  /** Human-readable reason when status is `blocked`. */
  blockedReason?: string
  /** Last time a blocked-op alert was sent for this row; throttles re-alerting. */
  blockedAlertedAt?: Date
  /** Set when an operator re-drove the row back to `queued`. */
  requeuedAt?: Date
  /** How many times this row has been re-driven. */
  requeueCount?: number
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
 * Extracts the MongoDB server error code from an unknown thrown value, or
 * `undefined` when the value is not an `Error` carrying a numeric `code`.
 *
 * @param error - The value thrown by a driver call.
 * @returns The numeric server code, or `undefined`.
 */
function getMongoErrorCode(error: unknown): number | undefined {
  return error instanceof Error && 'code' in error
    ? (error as { code: number }).code
    : undefined
}

/**
 * True when `error` is a MongoDB authorization failure — the connected role lacks
 * the `createIndex` action on the `timelock-operations` DB (server code 13,
 * `Unauthorized`). Matched by code with a message fallback, mirroring
 * `parked-tasks.ts`: the queue runs on the un-gated `MONGODB_URI` cluster so it
 * stays reachable from readWrite-only, non-interactive consumers (the execution
 * runner, list/backfill scripts) without a tunnel.
 *
 * @param error - The error thrown by `createIndex`.
 * @returns Whether the error is a MongoDB `Unauthorized` (code 13) failure.
 */
function isUnauthorizedError(error: unknown): boolean {
  return (
    getMongoErrorCode(error) === 13 ||
    (error instanceof Error && /not authorized/i.test(error.message))
  )
}

/**
 * Ensures the indexes the queue depends on. Idempotent — an exact-match
 * re-creation is a Mongo no-op. Index-definition *conflicts* (codes 85/86) and
 * authorization failures (code 13) are handled per-index by {@link safeCreateIndex}.
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
    return
  } catch (error: unknown) {
    // Codes 85 (IndexOptionsConflict) and 86 (IndexKeySpecsConflict) only fire
    // when an index with the same name already exists with a *different*
    // definition. Exact-match re-creation is a no-op and does not throw, so
    // hitting these codes means the deployed index has drifted from the spec
    // we want — surfacing it forces an operator to reconcile rather than
    // letting the runner proceed against an unintended index.
    const code = getMongoErrorCode(error)
    if (code === 85 || code === 86)
      throw new Error(
        `Index conflict for "${options.name}" on ${
          collection.collectionName
        } (spec=${JSON.stringify(
          spec
        )}). Existing index has a different definition; drop or reconcile it before retrying.`,
        { cause: error }
      )
    if (!isUnauthorizedError(error)) throw error

    // Authorization failure (code 13): the connected role has `readWrite` but not
    // `createIndex` on `timelock-operations`. Every consumer connects through
    // getTimelockQueueCollection() → here, so a hard throw would take the entire
    // un-gated queue (runner, list, backfill) down. Degrade instead: if an admin
    // already created this index (`listIndexes`, a read-role action), it is intact
    // and we proceed silently; if not, warn and still proceed so reads/enqueue work.
    let indexPresent = false
    try {
      const indexes = await collection.listIndexes().toArray()
      indexPresent = indexes.some((index) => index.name === options.name)
    } catch (listError: unknown) {
      consola.warn(
        `Cannot create or verify the "${options.name}" index on ` +
          `${collection.collectionName}: the MONGODB_URI role lacks createIndex on ` +
          `the timelock-operations DB, and listIndexes also failed. Proceeding without ` +
          `index verification — enqueue dedup may be unenforced.`,
        listError
      )
      return
    }

    if (indexPresent) {
      consola.debug(
        `"${options.name}" already exists on ${collection.collectionName}; the ` +
          `current MONGODB_URI role cannot create indexes but this index is present, ` +
          `so the queue is fully functional.`
      )
      return
    }

    consola.warn(
      `The "${options.name}" index is MISSING on ${collection.collectionName} and ` +
        `the current MONGODB_URI role lacks createIndex on the timelock-operations DB. ` +
        (options.unique
          ? `Reads/enqueue/execute will work, but enqueue DEDUP IS NOT ENFORCED — ` +
            `duplicate queue rows can be inserted for the same (network, operationId). `
          : `Reads/enqueue/execute will work, but this query index is absent, so ` +
            `network+status lookups fall back to collection scans. `) +
        `Have an admin create the index once (readWrite + createIndex on ` +
        `timelock-operations), then this warning clears.`
    )
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
 * Flips a queue row to `blocked` — the runner refused to execute it for a reason
 * an operator can clear, and the op is still live on-chain.
 *
 * Distinct from `failed`: blocked rows are surfaced by `list-timelock-queue`,
 * re-alerted by the runner while they stay executable, and can be re-driven with
 * `requeue-timelock-op.ts`.
 *
 * @param timelockQueue - The queue collection.
 * @param network - Network slug of the row.
 * @param operationId - Operation id of the row.
 * @param reason - Human-readable cause, shown in alerts and the lister.
 */
export async function markTimelockOpBlocked(
  timelockQueue: Collection<ITimelockQueueDoc>,
  network: string,
  operationId: Hex,
  reason: string
): Promise<void> {
  const now = new Date()
  await timelockQueue.updateOne(byOperationId(network, operationId), {
    $set: {
      status: 'blocked',
      blockedReason: reason,
      blockedAt: now,
      updatedAt: now,
    },
    // Drop any previous alert stamp so the new block alerts on the next run
    // instead of inheriting an old row's throttle window.
    $unset: { blockedAlertedAt: '' },
  })
}

/**
 * Flips a queue row to `failed` — the op can never run as stored (tampered row,
 * or an on-chain revert). Terminal; `requeue-timelock-op.ts` refuses these
 * without `--force`.
 *
 * @param timelockQueue - The queue collection.
 * @param network - Network slug of the row.
 * @param operationId - Operation id of the row.
 * @param reason - Human-readable cause.
 */
export async function markTimelockOpFailedInQueue(
  timelockQueue: Collection<ITimelockQueueDoc>,
  network: string,
  operationId: Hex,
  reason: string
): Promise<void> {
  await timelockQueue.updateOne(byOperationId(network, operationId), {
    $set: {
      status: 'failed',
      failureReason: reason,
      updatedAt: new Date(),
    },
  })
}

/**
 * Returns the reason text for whichever non-executed status a row carries, so
 * callers do not have to know which of the two reason fields applies.
 *
 * @param doc - Queue row.
 * @returns The blocked or failure reason, or `undefined` when neither applies.
 */
export function queueStatusReason(
  doc: Pick<ITimelockQueueDoc, 'status' | 'blockedReason' | 'failureReason'>
): string | undefined {
  if (doc.status === 'blocked') return doc.blockedReason
  if (doc.status === 'failed') return doc.failureReason
  return undefined
}

/**
 * Classifies a `blocked` row from its freshly-read on-chain state.
 *
 * - `done` — the controller executed it; reconcile the row to `executed`.
 * - `gone` — the controller holds no timestamp for the id, so it was cancelled
 *   (or never scheduled); reconcile the row to `cancelled`. Cancelling is the
 *   documented remediation for a blocked op, so this is the common path, and
 *   without it following that advice leaves a permanently misleading row.
 * - `pending` — still a live operation; a candidate for the ready-check alert.
 *
 * Only a fully negative read counts as `gone`: a contradictory combination (from
 * a mid-block RPC race, say) stays `pending` rather than being silently
 * cancelled.
 *
 * @param state - On-chain flags for the operation.
 * @returns Which reconciliation, if any, the row needs.
 */
export function classifyBlockedRow(state: {
  isDone: boolean
  isPending: boolean
  isReady: boolean
  isOperation: boolean
}): 'done' | 'gone' | 'pending' {
  if (state.isDone) return 'done'
  if (!state.isPending && !state.isReady && !state.isOperation) return 'gone'
  return 'pending'
}

/** A blocked row paired with its freshly-read on-chain readiness. */
export interface IBlockedOpCandidate {
  doc: ITimelockQueueDoc
  /** `isOperationReady` result; `null` when the RPC check failed. */
  onChainReady: boolean | null
}

/**
 * Picks the blocked rows that warrant an alert on this run: still executable
 * on-chain, and either never alerted or last alerted longer ago than
 * `throttleMs`.
 *
 * Rows whose readiness check failed are deliberately excluded — a transient RPC
 * error must not manufacture an alert about an op we could not read.
 *
 * @param candidates - Blocked rows with their on-chain readiness.
 * @param now - Current time (injected for testability).
 * @param throttleMs - Minimum gap between alerts for the same row.
 * @returns The rows to alert on.
 */
export function selectBlockedNeedingAlert(
  candidates: IBlockedOpCandidate[],
  now: Date,
  throttleMs: number = BLOCKED_ALERT_INTERVAL_MS
): ITimelockQueueDoc[] {
  return candidates
    .filter(({ doc, onChainReady }) => {
      if (doc.status !== 'blocked' || onChainReady !== true) return false
      const lastAlert = doc.blockedAlertedAt
      if (!lastAlert) return true
      return now.getTime() - lastAlert.getTime() >= throttleMs
    })
    .map(({ doc }) => doc)
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
          // Re-enqueueing an existing row resets it to `queued`; clear any
          // previous block bookkeeping so the row does not carry a reason that
          // no longer describes its status.
          $unset: {
            blockedReason: '',
            blockedAt: '',
            blockedAlertedAt: '',
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
