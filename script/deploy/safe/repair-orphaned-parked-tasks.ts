/**
 * Deferred diamond-cleanup queue — orphaned-claim repair.
 *
 * `delete-pending-proposals.ts` removes a proposal without releasing the parked
 * tasks it claimed, and `reconcile-parked-tasks.ts` cannot detect that: its
 * decision table only transitions on a linked proposal that `executed` or
 * `reverted`, so a claim pointing at a DELETED proposal falls through to `keep`
 * and the removal is never re-proposed by any future drain.
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

  let orphans = 0
  let repaired = 0
  let unlinked = 0
  for (const task of tasks) {
    if (!task.safeTxHash) {
      unlinked++
      consola.warn(
        `[${task.network}] ${task.facetName}: status=proposed with no safeTxHash — leaving for manual review`
      )
      continue
    }
    const proposal = await pendingTransactions.findOne({
      safeTxHash: { $eq: task.safeTxHash },
    })
    if (proposal) continue

    orphans++
    consola.warn(
      `[${task.network}] ${task.facetName}: linked proposal ${task.safeTxHash} is GONE → queued`
    )
    if (!apply) continue

    const updated = await revertToQueued(parkedTasks, task.taskKey)
    if (updated) repaired++
    else
      consola.error(
        `[${task.network}] ${task.facetName}: transition failed (status changed under us?)`
      )
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
    const { client: tasksClient, parkedTasks } =
      await getParkedTasksCollection()

    let orphans = 0
    let repaired = 0
    try {
      ;({ orphans, repaired } = await repairOrphanedParkedTasks(
        parkedTasks,
        pendingTransactions,
        { apply, ...(args.network ? { network: args.network } : {}) }
      ))
    } finally {
      await safeClient.close()
      await tasksClient.close()
    }

    consola.info(
      apply
        ? `repaired ${repaired}/${orphans} orphaned claim(s)`
        : `${orphans} orphaned claim(s) would be reverted to queued`
    )
    if (apply && repaired !== orphans) process.exit(1)
  },
})

if (import.meta.main) runMain(main)
