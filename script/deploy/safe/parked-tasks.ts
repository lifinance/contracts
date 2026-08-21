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
 * The drain (out of scope here) sets `safeTxHash` on a claimed record via
 * {@link setSafeTxHash} to link it to the primary `pendingTransactions` proposal
 * its removal was folded into (spec §6).
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
import { getAddress, type Address } from 'viem'

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
export const OPEN_STATUSES: ParkedTaskStatus[] = ['queued', 'proposed']

/** Name of the partial unique index the dedup guarantees depend on. */
const OPEN_TASK_KEY_INDEX_NAME = 'unique_open_task_key'

/**
 * A deferred diamond-maintenance task, parked until the network is next touched.
 * One record per (kind, network, environment, facetAddress) — the finest grain
 * (spec §4). Selectors are intentionally NOT stored: they are resolved from the
 * live loupe at drain time, so a stored list can never go stale.
 */
export interface IParkedTask {
  _id?: ObjectId
  /** Dedup key `${kind}|${network}|${environment}|${facetAddress}` (see {@link computeTaskKey}). */
  taskKey: string
  kind: ParkedTaskKind
  /** Lowercased network name, matching the `pendingTransactions` convention. */
  network: string
  /** `production` in v1 — the queue is a production-mainnet construct (spec §12). */
  environment: EnvironmentEnum
  /** Human-readable label for the parked facet. NOT the identity — see `facetAddress`. */
  facetName: string
  /** Diamond address snapshot from the deploy log at enqueue (sanity/fallback). */
  diamondAddress: Address
  /** The task identity: the exact facet to remove. Selectors are re-resolved from the loupe at drain. */
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
  environment?: EnvironmentEnum
  prUrl?: string
  /** One status, or several (matched with `$in` — e.g. {@link OPEN_STATUSES}). */
  status?: ParkedTaskStatus | ParkedTaskStatus[]
}

/**
 * Normalises a facet address for use as a {@link computeTaskKey} segment.
 *
 * EVM addresses are case-insensitive, so lowercasing lets a checksummed and an
 * all-lower spelling of the same facet dedup against each other. A non-`0x`
 * string is kept verbatim so the key stays a pure string function of a row's
 * stored fields, whatever a legacy row holds — {@link enqueueParkedTask} refuses
 * to create such rows.
 */
function normaliseAddressForKey(facetAddress: string): string {
  const trimmed = facetAddress.trim()
  return trimmed.startsWith('0x') ? trimmed.toLowerCase() : trimmed
}

/**
 * Canonical stored spelling of a facet address: a checksummed EVM address.
 *
 * The stored value and {@link computeTaskKey} must never disagree about identity —
 * otherwise an address parked in one capitalisation and re-parked in another
 * would carry two spellings for one key.
 *
 * EVM-only by design: every consumer of the queue (the drain via the EVM Safe
 * propose path, the reconcile via viem loupe reads) can only process EVM
 * addresses, so accepting anything else would mint rows nothing can ever drain
 * or verify. Tron parking becomes representable when a Tron-capable consumer
 * exists.
 *
 * @param facetAddress - Address as supplied by the caller.
 * @returns The canonical checksummed form to store.
 * @throws If the value is not a valid `0x` EVM address.
 */
function canonicaliseFacetAddress(facetAddress: string): string {
  const trimmed = facetAddress.trim()
  if (!trimmed.startsWith('0x'))
    throw new Error(
      `facetAddress must be a 0x EVM address (got "${trimmed}") — the queue is EVM-only: no consumer can drain or reconcile a non-EVM address`
    )
  return getAddress(trimmed)
}

/**
 * Computes the dedup key for a parked task: `${kind}|${network}|${environment}|${facetAddress}`.
 * The network segment is lowercased to match the stored `network` value, the
 * address per {@link normaliseAddressForKey}.
 *
 * Keyed by ADDRESS rather than name: two versions of one facet are routinely
 * co-registered on the same diamond (SymbiosisFacet v1.0.0 alongside v2.0.0 on 35
 * production chains, EXSC-750), and a name-keyed queue can neither represent them
 * separately nor target one without the other.
 *
 * @param kind - Task kind (`facet-removal` in v1).
 * @param network - Network slug (matches `networks.json` keys).
 * @param environment - Deployment environment.
 * @param facetAddress - Address being parked for removal — the task identity.
 * @returns The pipe-joined task key.
 */
export function computeTaskKey(
  kind: ParkedTaskKind,
  network: string,
  environment: EnvironmentEnum,
  facetAddress: string
): string {
  return `${kind}|${network.toLowerCase()}|${environment}|${normaliseAddressForKey(
    facetAddress
  )}`
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
 * caller — CLI, `/deprecate-contract`, the drain — dedups consistently:
 * `network`/`facetName`/`facetAddress`/`prUrl` are trimmed, because `taskKey` is
 * built from `network`+`facetAddress` and a stray space would silently mint a
 * distinct, undeduplicated task for the same facet.
 *
 * @param parkedTasks - The queue collection.
 * @param input - Task identity + snapshots + required `prUrl` + enqueuer.
 * @returns The insert result, or `null` if a duplicate open task already exists.
 * @throws Error if `prUrl`, `facetAddress` or `facetName` is missing or blank
 *   (prUrl is the PR-link requirement, spec §6; facetAddress is the task
 *   identity; facetName is its label, required so queue reports stay readable),
 *   or if `facetAddress` is not a valid `0x` EVM address (the queue is
 *   EVM-only — see {@link canonicaliseFacetAddress}).
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
  if (!input.facetAddress || input.facetAddress.trim() === '')
    throw new Error(
      'facetAddress is required to park a facet-removal task (it is the task identity)'
    )

  const network = input.network.trim().toLowerCase()
  const facetName = input.facetName.trim()
  const facetAddress = canonicaliseFacetAddress(input.facetAddress) as Address
  const doc: IParkedTask = {
    ...input,
    network,
    facetName,
    facetAddress,
    prUrl: input.prUrl.trim(),
    taskKey: computeTaskKey(
      input.kind,
      network,
      input.environment,
      facetAddress
    ),
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
 * Reads parked tasks, optionally filtered by network / environment / prUrl / status.
 *
 * Sorted by `taskKey` so the drain claims (and therefore appends Remove cuts) in
 * the same order {@link listParkedTasksBySafeTxHash} later replays them in. That
 * read tie-breaks on `taskKey` when `proposedAt` collides, which it can for claims
 * landing in the same millisecond — without a deterministic read order here the
 * two disagree and the execute-time zip mislabels a cut.
 *
 * @param parkedTasks - The queue collection.
 * @param filter - Optional network (lowercased), environment, prUrl, and status filters.
 * @returns The matching tasks, ordered by `taskKey`.
 */
export async function listParkedTasks(
  parkedTasks: Collection<IParkedTask>,
  filter: IListParkedTasksFilter
): Promise<WithId<IParkedTask>[]> {
  const query: Filter<IParkedTask> = {}
  if (filter.network) query.network = { $eq: filter.network.toLowerCase() }
  if (filter.environment) query.environment = { $eq: filter.environment }
  if (filter.prUrl) query.prUrl = { $eq: filter.prUrl }
  if (filter.status)
    query.status = Array.isArray(filter.status)
      ? { $in: filter.status }
      : { $eq: filter.status }
  return parkedTasks.find(query).sort({ taskKey: 1 }).toArray()
}

/**
 * Lists parked tasks linked to a Safe proposal via {@link setSafeTxHash}.
 * Sorted by `proposedAt` ascending so order matches the drain's claim/append
 * order (folded Remove cuts are the trailing N payloads of the timelock batch).
 *
 * @param parkedTasks - The queue collection.
 * @param safeTxHash - The primary proposal's Safe transaction hash.
 * @returns Matching tasks (may be empty when the proposal had no folded removals).
 */
export async function listParkedTasksBySafeTxHash(
  parkedTasks: Collection<IParkedTask>,
  safeTxHash: string
): Promise<WithId<IParkedTask>[]> {
  return parkedTasks
    .find({ safeTxHash: { $eq: safeTxHash } })
    .sort({ proposedAt: 1, taskKey: 1 })
    .toArray()
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
  unset?: Partial<Record<keyof IParkedTask, ''>>,
  expectedSafeTxHash?: string
): Promise<WithId<IParkedTask> | null> {
  const update: UpdateFilter<IParkedTask> = { $set: set }
  if (unset) update.$unset = unset
  // Every value is operator-wrapped and the filter is built field by field, so
  // no caller can widen the match or override the taskKey/status gate.
  const filter: Filter<IParkedTask> = {
    taskKey: { $eq: taskKey },
    status: { $in: allowedFrom },
  }
  if (expectedSafeTxHash) filter.safeTxHash = { $eq: expectedSafeTxHash }
  return parkedTasks.findOneAndUpdate(filter, update, {
    returnDocument: 'after',
  })
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
 * Links a claimed (`proposed`) task to the primary `pendingTransactions` proposal
 * its removal was folded into, by stamping its `safeTxHash` (spec §6). Restricted
 * to `proposed`: the task must have been claimed via {@link claimForProposal}
 * before a proposal exists to link. A later reconcile reads this hash to resolve
 * the task once the proposal executes.
 *
 * @param parkedTasks - The queue collection.
 * @param taskKey - The claimed task to link.
 * @param safeTxHash - The linked primary proposal's Safe transaction hash.
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
 * Reopens a task that was resolved as done (`executed`/`superseded`) but whose
 * facet is demonstrably still routed — the removal never actually landed. Sends it
 * back to `queued` and clears the stale proposal linkage and resolution stamp so
 * the next drain re-proposes it from scratch.
 *
 * `cancelled` is deliberately NOT reopenable: that state records an operator
 * explicitly abandoning the intent, and re-queueing it would fight that decision.
 *
 * Reopening re-enters the *open* statuses the partial unique index covers, so it
 * collides (E11000) when a fresh open task already exists for the same `taskKey`.
 * That is a benign race — the facet is already tracked — so it returns `null`
 * rather than throwing, mirroring {@link enqueueParkedTask}.
 *
 * Addressed by `_id`, not `taskKey`: the partial unique index covers only the open
 * statuses, so one `taskKey` can own several *terminal* rows (parked → executed →
 * re-parked → executed). Matching by key would let Mongo pick any of them, and the
 * caller would then report a document it did not modify.
 *
 * @param parkedTasks - The queue collection.
 * @param id - `_id` of the terminal task to reopen.
 * @returns The reopened task, `null` if it was not `executed`/`superseded`, or
 *   `null` if an open task for the same `taskKey` already exists.
 */
export async function reopenResolvedTask(
  parkedTasks: Collection<IParkedTask>,
  id: ObjectId
): Promise<WithId<IParkedTask> | null> {
  // Recompute the key from the row's own fields before re-entering the open
  // index: a legacy row still carrying a name-based key would otherwise reopen
  // under a key no fresh enqueue can collide with, silently disabling the
  // E11000 duplicate-open protection this function documents.
  const current = await parkedTasks.findOne({ _id: { $eq: id } })
  if (!current) return null
  const taskKey = computeTaskKey(
    current.kind,
    current.network,
    current.environment,
    current.facetAddress
  )
  // The unique index only catches same-KEY duplicates; an open legacy-keyed row
  // for the same address would not collide, so check by address first. Not
  // atomic, but the drain's own duplicate-address guard backstops the race.
  const openRows = await parkedTasks
    .find({
      kind: { $eq: current.kind },
      network: { $eq: current.network },
      environment: { $eq: current.environment },
      status: { $in: OPEN_STATUSES },
    })
    .toArray()
  // Case-insensitive only for 0x addresses: a legacy non-EVM value is
  // case-sensitive, so folding it could merge two distinct accounts.
  const sameAddress = (a: string, b: string): boolean =>
    a.startsWith('0x') && b.startsWith('0x')
      ? a.toLowerCase() === b.toLowerCase()
      : a === b
  const duplicate = openRows.find(
    (row) =>
      !row._id.equals(id) && sameAddress(row.facetAddress, current.facetAddress)
  )
  if (duplicate) {
    consola.warn(
      `Cannot reopen resolved task - an open task already tracks it.\n  Task id: ${id.toString()}`
    )
    return null
  }
  try {
    return await parkedTasks.findOneAndUpdate(
      { _id: { $eq: id }, status: { $in: ['executed', 'superseded'] } },
      {
        $set: { status: 'queued', taskKey },
        $unset: { proposedAt: '', safeTxHash: '', resolvedAt: '' },
      },
      { returnDocument: 'after' }
    )
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code: number }).code === 11000
    ) {
      consola.warn(
        `Cannot reopen resolved task - an open task already tracks it.\n  Task id: ${id.toString()}`
      )
      return null
    }
    throw error
  }
}

/**
 * Reverts a claimed (`proposed`) task back to `queued` when no stored proposal
 * carries its removal (preparation failure, primary-proposal failure, or duplicate
 * primary), clearing the stale `proposedAt`/`safeTxHash` so the next drain
 * re-folds cleanly.
 *
 * @param parkedTasks - The queue collection.
 * @param taskKey - The task to re-open.
 * @param expectedSafeTxHash - When given, the revert only applies while the task
 * still carries this hash, so a claim re-proposed by a concurrent drain between
 * the caller's read and this write keeps its newer `safeTxHash`.
 * @returns The reverted task, or `null` if it was not `proposed` (or moved on).
 */
export async function revertToQueued(
  parkedTasks: Collection<IParkedTask>,
  taskKey: string,
  expectedSafeTxHash?: string
): Promise<WithId<IParkedTask> | null> {
  return transition(
    parkedTasks,
    taskKey,
    ['proposed'],
    { status: 'queued' },
    { proposedAt: '', safeTxHash: '' },
    expectedSafeTxHash
  )
}
