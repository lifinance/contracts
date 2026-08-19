/**
 * Deferred diamond-cleanup queue — orphaned-claim repair.
 *
 * A claim pointing at a DELETED proposal is unreachable: `reconcile-parked-tasks.ts`
 * only transitions on a linked proposal that `executed` or `reverted`, so it falls
 * through to `keep` and no future drain re-proposes the removal.
 *
 * This reverts exactly those claims to `queued`. A task is only touched when its
 * `safeTxHash` has no document in the shared proposal store, so a claim held by a
 * live proposal (possibly another operator's) is never stolen.
 *
 * Dry-run by default; pass `--yes` to apply.
 */
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { type Collection } from 'mongodb'

import 'dotenv/config'

import {
  getParkedTasksCollection,
  listParkedTasks,
  revertToQueued,
  type IParkedTask,
} from './parked-tasks'
import { getSafeMongoCollection, type ISafeTxDocument } from './safe-utils'

export interface IRepairResult {
  readonly orphans: number
  readonly repaired: number
  /** status=proposed tasks with no safeTxHash — cannot be judged, left untouched. */
  readonly unlinked: number
}

/**
 * Reverts every `proposed` task whose linked proposal is gone back to `queued`.
 * A task is an orphan only when its `safeTxHash` has no document in the proposal
 * store — a claim held by a live proposal is left alone.
 */
export async function repairOrphanedParkedTasks(
  parkedTasks: Collection<IParkedTask>,
  pendingTransactions: Collection<ISafeTxDocument>,
  { apply, network }: { apply: boolean; network?: string }
): Promise<IRepairResult> {
  const tasks = await listParkedTasks(parkedTasks, {
    status: 'proposed',
    ...(network ? { network } : {}),
  })
  consola.info(`${tasks.length} task(s) in status=proposed`)

  let unlinked = 0
  const linked: typeof tasks = []
  const orphanTasks: typeof tasks = []
  for (const task of tasks) {
    if (!task.safeTxHash) {
      unlinked++
      consola.warn(
        `[${task.network}] ${task.facetName}: status=proposed with no safeTxHash — leaving for manual review`
      )
      continue
    }
    linked.push(task)
    const proposal = await pendingTransactions.findOne({
      safeTxHash: { $eq: task.safeTxHash },
    })
    if (proposal) continue

    orphanTasks.push(task)
    consola.warn(
      `[${task.network}] ${task.facetName}: linked proposal ${task.safeTxHash} is GONE → queued`
    )
  }

  const orphans = orphanTasks.length
  // A store that answers every lookup with null is indistinguishable from one
  // where every proposal was deleted — except that the second is implausible.
  // Refuse rather than release claims that live proposals still carry.
  if (apply && orphans) {
    const storeSize = await pendingTransactions.countDocuments({})
    if (storeSize === 0)
      throw new Error(
        'proposal store is empty — refusing to repair (wrong SC_MONGODB_URI or a stale tunnel?)'
      )
    if (linked.length > 1 && orphans === linked.length)
      throw new Error(
        `all ${orphans} linked claim(s) look orphaned — refusing to repair; verify SC_MONGODB_URI points at the production proposal store (${storeSize} docs)`
      )
  }

  let repaired = 0
  for (const task of apply ? orphanTasks : []) {
    // one transient Mongo failure must not strand the remaining orphans
    try {
      // bind the revert to the hash we judged: a concurrent drain that re-proposed
      // this task in the meantime keeps its newer claim
      const updated = await revertToQueued(
        parkedTasks,
        task.taskKey,
        task.safeTxHash
      )
      if (updated) repaired++
      else
        consola.error(
          `[${task.network}] ${task.facetName}: transition failed (status or safeTxHash changed under us?)`
        )
    } catch (error) {
      consola.error(
        `[${task.network}] ${task.facetName}: transition threw — ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  return { orphans, repaired, unlinked }
}

const main = defineCommand({
  meta: {
    name: 'repair-orphaned-parked-tasks',
    description:
      'Revert parked tasks whose linked proposal no longer exists back to queued',
  },
  args: {
    network: {
      type: 'string',
      description: 'Only repair this network (default: all)',
      required: false,
    },
    yes: {
      type: 'boolean',
      description: 'Apply the transitions (default: dry-run)',
      required: false,
    },
  },
  async run({ args }) {
    const apply = args.yes ?? false
    if (!apply) consola.info('Dry-run — pass --yes to apply')

    if (!process.env.SC_MONGODB_URI)
      throw new Error(
        'SC_MONGODB_URI is required to tell a deleted proposal from a live one — start the lifi-connect tunnel'
      )

    const { client: safeClient, pendingTransactions } =
      await getSafeMongoCollection()

    let orphans = 0
    let repaired = 0
    let unlinked = 0
    try {
      const { client: tasksClient, parkedTasks } =
        await getParkedTasksCollection()
      try {
        ;({ orphans, repaired, unlinked } = await repairOrphanedParkedTasks(
          parkedTasks,
          pendingTransactions,
          { apply, ...(args.network ? { network: args.network } : {}) }
        ))
      } finally {
        await tasksClient.close()
      }
    } finally {
      await safeClient.close()
    }

    consola.info(
      apply
        ? `repaired ${repaired}/${orphans} orphaned claim(s)`
        : `${orphans} orphaned claim(s) would be reverted to queued`
    )
    if (unlinked)
      consola.warn(
        `${unlinked} proposed task(s) carry no safeTxHash and need manual review`
      )
    if (apply && repaired !== orphans) process.exit(1)
  },
})

if (import.meta.main) runMain(main)
