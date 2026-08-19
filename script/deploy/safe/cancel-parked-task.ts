#!/usr/bin/env bun

/**
 * Operator CLI to cancel ONE queued parked task (EXSC-715).
 *
 * `cancelled` records a human abandoning the removal intent (deprecation
 * reverted, wrong address parked, duplicate row), and is the terminal state the
 * unattended jobs deliberately never enter on their own. Restricted to `queued`:
 * a `proposed` task carries a live Safe removal proposal, and cancelling it would
 * orphan that proposal from its origin-PR linkage — it needs `revertToQueued`
 * first.
 *
 *   bunx tsx ./script/deploy/safe/cancel-parked-task.ts --taskKey "<key>" [--yes]
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { getParkedTasksCollection, markCancelled } from './parked-tasks'

const main = defineCommand({
  meta: {
    name: 'cancel-parked-task',
    description:
      'Cancel one queued deferred diamond-cleanup task (operator decision, terminal)',
  },
  args: {
    taskKey: {
      type: 'string',
      description:
        'The task key to cancel (shown in every queue alert and by list-parked-tasks.ts)',
      required: true,
    },
    yes: {
      type: 'boolean',
      description: 'Apply the cancellation (default: dry run)',
      default: false,
    },
  },
  async run({ args }) {
    const { client, parkedTasks } = await getParkedTasksCollection()
    try {
      // One key can own several rows (the open index covers only queued/proposed,
      // so terminal history accumulates under it) — target the queued one, since
      // that is the only row markCancelled can touch.
      const rows = await parkedTasks
        .find({ taskKey: { $eq: args.taskKey } })
        .toArray()
      if (rows.length === 0) {
        consola.error(`No parked task found for taskKey "${args.taskKey}"`)
        process.exitCode = 1
        return
      }
      const task = rows.find((row) => row.status === 'queued') ?? rows[0]
      if (!task) return
      consola.info(
        `${task.network}/${task.facetName} @ ${task.facetAddress} (${task.status}) — origin PR: ${task.prUrl}`
      )
      if (task.status !== 'queued') {
        consola.error(
          task.status === 'proposed'
            ? 'Task is `proposed` — it carries a live Safe removal proposal, and cancelling it would orphan that proposal from its origin-PR linkage. It needs revertToQueued first (no operator CLI yet, EXSC-715); escalate to the SC on-call.'
            : `Task is already terminal (${task.status}) — nothing to cancel.`
        )
        process.exitCode = 1
        return
      }
      if (!args.yes) {
        consola.info('Dry run — pass --yes to cancel this task.')
        return
      }
      // A concurrent drain can flip queued→proposed between the read above and
      // this write; markCancelled is filtered on `queued`, so it refuses then.
      if ((await markCancelled(parkedTasks, args.taskKey)) === null) {
        consola.error(
          'Task is no longer queued (a drain claimed it concurrently) — not cancelled.'
        )
        process.exitCode = 1
        return
      }
      consola.success(`Cancelled ${task.network}/${task.facetName}.`)
    } finally {
      await client.close()
    }
  },
})

runMain(main)
