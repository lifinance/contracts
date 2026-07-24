/**
 * Deferred diamond-cleanup queue — store layer.
 *
 * Backs the "park a facet removal now, drain it opportunistically later" model
 * (design: docs/DeferredDiamondCleanupQueue.md, PR #2049) with a durable queue on
 * the non-sensitive `MONGODB_URI` cluster (DB `deferred-cleanup`, collection
 * `parkedTasks`) — the same plumbing the timelock execution queue already runs on
 * (`timelock-operations/queue`, timelock-queue.ts), rather than introducing a new
 * store type. Nothing parked is secret (public facet names, on-chain addresses,
 * PR URLs) and the security boundary is on-chain (calldata verification, timelock
 * delay, Safe quorum), so the queue is intentionally un-gated — which also lets
 * non-interactive consumers (CI backlog reports, reconcile/TTL jobs, agent-driven
 * `/deprecate-contract`) reach it without a tunnel.
 *
 * This module is the *persistence* layer only — it does not mint Safe proposals,
 * resolve selectors from the loupe, or hook the drain chokepoint (those depend on
 * the #2047 removal engine and land separately). Every helper takes an injected
 * `Collection<IParkedTask>` so the logic is unit-testable against an in-memory
 * fake without a live cluster; only `getParkedTasksCollection()` touches Mongo.
 *
 * Dedup is enforced at the queue layer via a partial unique index on `taskKey`
 * filtered to the *open* statuses {queued, proposed} — mirroring
 * `unique_pending_intent_hash` — and the atomic `queued → proposed` flip in
 * {@link claimForProposal}. The time-derived timelock salt makes the proposal
 * `intentHash` non-deterministic, so it cannot dedup a re-proposed removal
 * (spec Fact 9); the queue-layer flip is the guarantee instead.
 *
 * The drain (out of scope here) sets `safeTxHash` on a claimed record to link it
 * to the minted `pendingTransactions` proposal (spec §6.3 step 4); that setter
 * lands with the drain PR, so no `safeTxHash` writer is exposed yet by design.
 */

import { consola } from 'consola'
import {
  MongoClient,
  type Collection,
  type Filter,
  type InsertOneResult,
  type ObjectId,
  type UpdateFilter,
  type WithId,
} from 'mongodb'
import { type Address } from 'viem'

import { type EnvironmentEnum } from '../../common/types'
import { getEnvVar } from '../../utils/utils'

/** Database for the deferred diamond-cleanup queue inside the non-sensitive `MONGODB_URI` cluster. */
const PARKED_TASKS_DB_NAME = 'deferred-cleanup'

/** New collection holding the deferred diamond-cleanup queue. */
const PARKED_TASKS_COLLECTION_NAME = 'parkedTasks'

/** Kind of deferred diamond-maintenance task. Only `facet-removal` in v1 (spec §3). */
export type ParkedTaskKind = 'facet-removal'

/**
 * Lifecycle states (spec §7). `queued`/`proposed` are the *open* states the dedup
 * index covers; `executed`/`cancelled`/`superseded` are terminal.
 */
export type ParkedTaskStatus =
  | 'queued'
  | 'proposed'
  | 'executed'
  | 'cancelled'
  | 'superseded'

/** Statuses under which a `taskKey` is still active and must stay unique. */
const OPEN_STATUSES: ParkedTaskStatus[] = ['queued', 'proposed']

/** Name of the partial unique index the dedup guarantees depend on. */
const OPEN_TASK_KEY_INDEX_NAME = 'unique_open_task_key'

/**
 * A deferred diamond-maintenance task, parked until the network is next touched.
 * One record per (kind, network, environment, facetName) — the finest grain
 * (spec §4). Selectors are intentionally NOT stored: they are resolved from the
 * live loupe at drain time, so a stored list can never go stale.
 */
export interface IParkedTask {
  _id?: ObjectId
  /** Dedup key `${kind}|${network}|${environment}|${facetName}` (see {@link computeTaskKey}). */
  taskKey: string
  kind: ParkedTaskKind
  /** Lowercased network name, matching the `pendingTransactions` convention. */
  network: string
  /** `production` in v1 — the queue is a production-mainnet construct (spec §12). */
  environment: EnvironmentEnum
  /** The facet identity; selectors are re-resolved from the loupe at drain. */
  facetName: string
  /** Diamond address snapshot from the deploy log at enqueue (sanity/fallback). */
  diamondAddress: Address
  /** Facet address snapshot; re-verified against the loupe at drain. */
  facetAddress: Address
  /** Originating deprecation PR — REQUIRED and first-class (spec §6). */
  prUrl: string
  status: ParkedTaskStatus
  /** git user.email / actor that enqueued, for audit. */
  enqueuer: string
  createdAt: Date
  /** Set when the drain claims the task (`queued → proposed`). */
  proposedAt?: Date
  /** Set at drain → links to the minted `pendingTransactions` proposal. */
  safeTxHash?: string
  /** Set on a terminal transition (executed / cancelled / superseded). */
  resolvedAt?: Date
  notes?: string
}

/**
 * Fields a caller supplies to enqueue a task. `taskKey`, `status`, `createdAt`
 * and the drain/resolution timestamps are derived by {@link enqueueParkedTask}.
 */
export type IParkedTaskInput = Omit<
  IParkedTask,
  | '_id'
  | 'taskKey'
  | 'status'
  | 'createdAt'
  | 'proposedAt'
  | 'safeTxHash'
  | 'resolvedAt'
>

/** Filters accepted by {@link listParkedTasks}. */
export interface IListParkedTasksFilter {
  network?: string
  prUrl?: string
  status?: ParkedTaskStatus
}

/**
 * Computes the dedup key for a parked task: `${kind}|${network}|${environment}|${facetName}`.
 * Only the network segment is lowercased, matching the stored `network` value.
 *
 * @param kind - Task kind (`facet-removal` in v1).
 * @param network - Network slug (matches `networks.json` keys).
 * @param environment - Deployment environment.
 * @param facetName - The facet identity being parked for removal.
 * @returns The pipe-joined task key.
 */
export function computeTaskKey(
  kind: ParkedTaskKind,
  network: string,
  environment: EnvironmentEnum,
  facetName: string
): string {
  return `${kind}|${network.toLowerCase()}|${environment}|${facetName}`
}

/**
 * True when `error` is a MongoDB authorization failure — the connected role lacks
 * the `createIndex` action on the `deferred-cleanup` DB (server code 13,
 * `Unauthorized`). Matched by code with a message fallback, since the queue's
 * whole reason to exist on the un-gated `MONGODB_URI` cluster is to be reachable
 * from readWrite-only, non-interactive consumers (CI, rollouts, reconcile jobs).
 */
function isUnauthorizedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (('code' in error && (error as { code: number }).code === 13) ||
      /not authorized/i.test(error.message))
  )
}

/**
 * Ensures the partial unique index the queue depends on.
 *
 * Idempotent for an exact-match re-creation (Mongo no-ops). Two failure modes are
 * handled so the shared adapter never takes the whole subsystem down:
 *
 * - **Index conflict** (codes 85/86 — a same-named index with a *different*
 *   definition) is surfaced as a clear error so an operator reconciles the drifted
 *   index rather than the queue proceeding against an unintended one.
 * - **Authorization failure** (code 13) — the connected role has `readWrite` but
 *   not `createIndex` on `deferred-cleanup`. Because every consumer (read, list,
 *   enqueue, claim, drain, reconcile) connects through {@link getParkedTasksCollection}
 *   → here, a hard throw would make the entire un-gated queue unusable from the
 *   standard rollout / CI credential. Instead this degrades: if an admin already
 *   created the index (`listIndexes`, a `read`-role action), dedup is intact and we
 *   proceed silently; if not, we warn loudly (dedup is unenforced until an admin
 *   creates it) but still proceed so reads/enqueue/claim work.
 *
 * The index is unique on `taskKey` but only over the *open* statuses, so a facet
 * can be re-parked once a prior task retires (executed/cancelled/superseded).
 * `$in` in a partial filter requires MongoDB server ≥ 6.0.
 *
 * @param parkedTasks - The collection to index.
 * @throws Error on an index definition conflict, or any non-authorization
 *   createIndex error.
 */
export async function ensureParkedTasksIndexes(
  parkedTasks: Collection<IParkedTask>
): Promise<void> {
  try {
    await parkedTasks.createIndex(
      { taskKey: 1 },
      {
        unique: true,
        partialFilterExpression: { status: { $in: OPEN_STATUSES } },
        name: OPEN_TASK_KEY_INDEX_NAME,
      }
    )
    return
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      ((error as { code: number }).code === 85 ||
        (error as { code: number }).code === 86)
    )
      throw new Error(
        `Index conflict for "${OPEN_TASK_KEY_INDEX_NAME}" on ${parkedTasks.collectionName}. ` +
          `Existing index has a different definition; drop or reconcile it before retrying.`,
        { cause: error }
      )
    if (!isUnauthorizedError(error)) throw error

    let indexPresent = false
    try {
      const indexes = await parkedTasks.listIndexes().toArray()
      indexPresent = indexes.some(
        (index) => index.name === OPEN_TASK_KEY_INDEX_NAME
      )
    } catch (listError: unknown) {
      consola.warn(
        `Cannot create or verify the "${OPEN_TASK_KEY_INDEX_NAME}" index on ` +
          `${parkedTasks.collectionName}: the MONGODB_URI role lacks createIndex on ` +
          `the deferred-cleanup DB, and listIndexes also failed. Proceeding without ` +
          `index verification — enqueue dedup may be unenforced.`,
        listError
      )
      return
    }

    if (indexPresent) {
      consola.debug(
        `"${OPEN_TASK_KEY_INDEX_NAME}" already exists on ${parkedTasks.collectionName}; ` +
          `the current MONGODB_URI role cannot create indexes but the dedup index is ` +
          `present, so the queue is fully functional.`
      )
      return
    }

    consola.warn(
      `The "${OPEN_TASK_KEY_INDEX_NAME}" index is MISSING on ${parkedTasks.collectionName} ` +
        `and the current MONGODB_URI role lacks createIndex on the deferred-cleanup DB. ` +
        `Reads/enqueue/claim will work, but enqueue DEDUP IS NOT ENFORCED — duplicate open ` +
        `parked tasks can be inserted. Have an admin create the index once (readWrite + ` +
        `createIndex on deferred-cleanup), then this warning clears. See ` +
        `docs/DeferredDiamondCleanupQueue.md §5.`
    )
  }
}

/**
 * Opens a MongoDB client and returns the `parkedTasks` collection, ensuring the
 * dedup index on connect. Mirrors `getTimelockQueueCollection()`: the same
 * non-sensitive `MONGODB_URI` cluster the timelock queue runs on, so no VPN /
 * tunnel gate. The caller owns the returned client and must `close()` it.
 *
 * @returns The connected client and the `parkedTasks` collection.
 * @throws Error if `MONGODB_URI` is not set.
 */
export async function getParkedTasksCollection(): Promise<{
  client: MongoClient
  parkedTasks: Collection<IParkedTask>
}> {
  const client = new MongoClient(getEnvVar('MONGODB_URI'))
  const parkedTasks = client
    .db(PARKED_TASKS_DB_NAME)
    .collection<IParkedTask>(PARKED_TASKS_COLLECTION_NAME)
  try {
    await ensureParkedTasksIndexes(parkedTasks)
    return { client, parkedTasks }
  } catch (error) {
    await client.close()
    throw error
  }
}

/**
 * Enqueues a parked task. Fills `taskKey`, `status: 'queued'` and `createdAt`,
 * then inserts. A duplicate open task (same `taskKey` while queued/proposed) hits
 * the partial unique index → E11000 → returns `null` (a repeat deprecation of the
 * same facet is a harmless no-op), mirroring `storeTransactionInMongoDB`.
 *
 * Identity fields are normalised here (the single enqueue chokepoint) so every
 * caller — CLI, `/deprecate-contract`, the future drain — dedups consistently:
 * `network`/`facetName`/`prUrl` are trimmed and a blank `facetName` is rejected,
 * because `taskKey` is built from `network`+`facetName` and a stray space would
 * silently mint a distinct, undeduplicated task for the same facet.
 *
 * @param parkedTasks - The queue collection.
 * @param input - Task identity + snapshots + required `prUrl` + enqueuer.
 * @returns The insert result, or `null` if a duplicate open task already exists.
 * @throws Error if `prUrl` or `facetName` is missing or blank (prUrl is the
 *   PR-link requirement, spec §6; facetName is the task identity).
 */
export async function enqueueParkedTask(
  parkedTasks: Collection<IParkedTask>,
  input: IParkedTaskInput
): Promise<InsertOneResult<IParkedTask> | null> {
  if (!input.prUrl || input.prUrl.trim() === '')
    throw new Error(
      'prUrl is required to park a facet-removal task (reviewer must see the originating PR at signing)'
    )
  if (!input.facetName || input.facetName.trim() === '')
    throw new Error('facetName is required to park a facet-removal task')

  const network = input.network.trim().toLowerCase()
  const facetName = input.facetName.trim()
  const doc: IParkedTask = {
    ...input,
    network,
    facetName,
    prUrl: input.prUrl.trim(),
    taskKey: computeTaskKey(input.kind, network, input.environment, facetName),
    status: 'queued',
    createdAt: new Date(),
  }

  try {
    return await parkedTasks.insertOne(doc)
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code: number }).code === 11000
    ) {
      consola.warn(
        `Duplicate parked task detected - skipping enqueue.\n  Task key: ${doc.taskKey}`
      )
      return null
    }
    throw error
  }
}

/**
 * Reads parked tasks, optionally filtered by network / prUrl / status.
 *
 * @param parkedTasks - The queue collection.
 * @param filter - Optional network (lowercased), prUrl, and status filters.
 * @returns The matching tasks.
 */
export async function listParkedTasks(
  parkedTasks: Collection<IParkedTask>,
  filter: IListParkedTasksFilter
): Promise<WithId<IParkedTask>[]> {
  const query: Filter<IParkedTask> = {}
  if (filter.network) query.network = { $eq: filter.network.toLowerCase() }
  if (filter.prUrl) query.prUrl = { $eq: filter.prUrl }
  if (filter.status) query.status = { $eq: filter.status }
  return parkedTasks.find(query).toArray()
}

/**
 * Atomically transitions the single task matching `taskKey` whose current status
 * is in `allowedFrom`, applying `set` (and optionally unsetting `unset` fields).
 * Returns the updated document, or `null` if no task was in an allowed state —
 * this is the dedup gate: only one caller can win a given flip.
 */
async function transition(
  parkedTasks: Collection<IParkedTask>,
  taskKey: string,
  allowedFrom: ParkedTaskStatus[],
  set: Partial<IParkedTask>,
  unset?: Partial<Record<keyof IParkedTask, ''>>
): Promise<WithId<IParkedTask> | null> {
  const update: UpdateFilter<IParkedTask> = { $set: set }
  if (unset) update.$unset = unset
  return parkedTasks.findOneAndUpdate(
    { taskKey: { $eq: taskKey }, status: { $in: allowedFrom } },
    update,
    { returnDocument: 'after' }
  )
}

/**
 * Atomically claims a `queued` task for proposal (`queued → proposed`, stamping
 * `proposedAt`). The `status: 'queued'` filter is the dedup gate: a concurrent
 * drain finds nothing queued and gets `null`, so a removal is never double-proposed
 * despite the non-deterministic timelock salt (spec Fact 9, §7).
 *
 * @param parkedTasks - The queue collection.
 * @param taskKey - The task to claim.
 * @returns The flipped task, or `null` if it was not `queued`.
 */
export async function claimForProposal(
  parkedTasks: Collection<IParkedTask>,
  taskKey: string
): Promise<WithId<IParkedTask> | null> {
  return transition(parkedTasks, taskKey, ['queued'], {
    status: 'proposed',
    proposedAt: new Date(),
  })
}

/**
 * Marks a `proposed` task `executed` (terminal, = done) — used once the linked
 * proposal is confirmed executed and the loupe shows the facet gone.
 *
 * @param parkedTasks - The queue collection.
 * @param taskKey - The task to resolve.
 * @returns The updated task, or `null` if it was not `proposed`.
 */
export async function markExecuted(
  parkedTasks: Collection<IParkedTask>,
  taskKey: string
): Promise<WithId<IParkedTask> | null> {
  return transition(parkedTasks, taskKey, ['proposed'], {
    status: 'executed',
    resolvedAt: new Date(),
  })
}

/**
 * Marks an open (`queued`/`proposed`) task `superseded` — the facet is already
 * absent on-chain (removed via another route); self-healing reconcile.
 *
 * @param parkedTasks - The queue collection.
 * @param taskKey - The task to resolve.
 * @returns The updated task, or `null` if it was not open.
 */
export async function markSuperseded(
  parkedTasks: Collection<IParkedTask>,
  taskKey: string
): Promise<WithId<IParkedTask> | null> {
  return transition(parkedTasks, taskKey, OPEN_STATUSES, {
    status: 'superseded',
    resolvedAt: new Date(),
  })
}

/**
 * Marks a `queued` task `cancelled` — an operator explicitly abandons the intent
 * (deprecation reverted, facet re-added, or a protected facet was queued in
 * error). Restricted to `queued`: a `proposed` task already has a live Safe
 * removal proposal, and cancelling its record directly would orphan that proposal
 * from its origin-PR linkage (the first-class requirement of spec §6). To abandon
 * a claimed task, {@link revertToQueued} it first (which clears the proposal
 * linkage), then cancel.
 *
 * @param parkedTasks - The queue collection.
 * @param taskKey - The task to resolve.
 * @returns The updated task, or `null` if it was not `queued`.
 */
export async function markCancelled(
  parkedTasks: Collection<IParkedTask>,
  taskKey: string
): Promise<WithId<IParkedTask> | null> {
  return transition(parkedTasks, taskKey, ['queued'], {
    status: 'cancelled',
    resolvedAt: new Date(),
  })
}

/**
 * Links a claimed (`proposed`) task to the `pendingTransactions` proposal the
 * drain just minted, by stamping its `safeTxHash` (spec §6.3 step 4). Restricted
 * to `proposed`: the task must have been claimed via {@link claimForProposal}
 * before a proposal exists to link. A later reconcile reads this hash to resolve
 * the task once the proposal executes.
 *
 * @param parkedTasks - The queue collection.
 * @param taskKey - The claimed task to link.
 * @param safeTxHash - The minted proposal's Safe transaction hash.
 * @returns The updated task, or `null` if it was not `proposed`.
 */
export async function setSafeTxHash(
  parkedTasks: Collection<IParkedTask>,
  taskKey: string,
  safeTxHash: string
): Promise<WithId<IParkedTask> | null> {
  return transition(parkedTasks, taskKey, ['proposed'], { safeTxHash })
}

/**
 * Reverts a claimed (`proposed`) task back to `queued` when its minted proposal
 * failed or was reverted, clearing the stale `proposedAt`/`safeTxHash` so the next
 * drain re-proposes cleanly.
 *
 * @param parkedTasks - The queue collection.
 * @param taskKey - The task to re-open.
 * @returns The reverted task, or `null` if it was not `proposed`.
 */
export async function revertToQueued(
  parkedTasks: Collection<IParkedTask>,
  taskKey: string
): Promise<WithId<IParkedTask> | null> {
  return transition(
    parkedTasks,
    taskKey,
    ['proposed'],
    { status: 'queued' },
    { proposedAt: '', safeTxHash: '' }
  )
}
