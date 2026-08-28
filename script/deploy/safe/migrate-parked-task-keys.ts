#!/usr/bin/env bun

/**
 * One-shot migration of `deferred-cleanup.parkedTasks` task keys from the old
 * name-based form to the address-based form (EXSC-775).
 *
 * `taskKey` moved from `${kind}|${network}|${environment}|${facetName}` to
 * `${kind}|${network}|${environment}|${facetAddress}`. Rows are matched and
 * mutated by `taskKey`, so leaving stale keys in place does not break the drain
 * — but the partial unique index that dedups OPEN tasks is keyed on it, so an
 * un-migrated open row no longer collides with a re-enqueue of the same facet.
 * The queue would then hold two open tasks for one address and the drain would
 * fold two identical Remove calls into a single batch, the second of which
 * reverts on-chain.
 *
 * Recomputes every row's key from its own stored fields, so it is idempotent and
 * safe to re-run. Refuses to migrate a row whose new key would collide with
 * another OPEN row (two open tasks for one address — an operator must cancel one
 * first); those are reported and skipped rather than silently merged.
 *
 * Delete this script once every environment has been migrated.
 *
 *   bunx tsx ./script/deploy/safe/migrate-parked-task-keys.ts [--apply]
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import {
  computeTaskKey,
  getParkedTasksCollection,
  OPEN_STATUSES,
  type IParkedTask,
} from './parked-tasks'

const main = defineCommand({
  meta: {
    name: 'migrate-parked-task-keys',
    description:
      'Rewrite parked-task keys from the name-based to the address-based form (EXSC-775)',
  },
  args: {
    apply: {
      type: 'boolean',
      description: 'Write the changes (default: dry run)',
      default: false,
    },
  },
  async run({ args }) {
    let mongoClient
    let parkedTasks
    try {
      ;({ client: mongoClient, parkedTasks } = await getParkedTasksCollection())
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error(
        `Could not connect to the parked-tasks MongoDB: ${errorMsg}`
      )
      process.exit(errorMsg.includes('MONGODB_URI') ? 2 : 1)
    }

    try {
      const tasks = await parkedTasks.find({}).toArray()
      consola.info(
        `${tasks.length} parked task(s) in the queue${
          args.apply ? '' : ' [DRY RUN — pass --apply to write]'
        }`
      )

      // An open row already sitting on its correct key blocks any other row from
      // migrating onto that key, so seed the claimed set before proposing moves.
      const claimedOpenKeys = new Set(
        tasks
          .filter(
            (t) =>
              OPEN_STATUSES.includes(t.status) &&
              t.taskKey ===
                computeTaskKey(t.kind, t.network, t.environment, t.facetAddress)
          )
          .map((t) => t.taskKey)
      )

      let migrated = 0
      let alreadyCurrent = 0
      let writeFailures = 0
      const collisions: IParkedTask[] = []

      for (const task of tasks) {
        const newKey = computeTaskKey(
          task.kind,
          task.network,
          task.environment,
          task.facetAddress
        )
        if (task.taskKey === newKey) {
          alreadyCurrent++
          continue
        }

        const isOpen = OPEN_STATUSES.includes(task.status)
        if (isOpen && claimedOpenKeys.has(newKey)) {
          collisions.push(task)
          continue
        }

        consola.log(
          `  ${task.network}/${task.facetName} (${task.status}): ${task.taskKey} → ${newKey}`
        )
        if (args.apply)
          try {
            await parkedTasks.updateOne(
              { _id: task._id },
              { $set: { taskKey: newKey } }
            )
          } catch (error: unknown) {
            // The in-memory pre-check cannot see a concurrent enqueue; a write
            // the index rejects must not abort the remaining rows — every row
            // left un-migrated is a row without dedup protection. Only a real
            // duplicate-key rejection is a collision; anything else (a transient
            // tunnel error) just needs a re-run, and telling the operator to
            // cancel the row would drop a healthy removal.
            const isDuplicate =
              error instanceof Error &&
              'code' in error &&
              (error as { code: number }).code === 11000
            if (isDuplicate) collisions.push(task)
            else writeFailures++
            consola.error(
              `  write failed for ${task.network}/${task.facetName}${
                isDuplicate ? ' (open-key collision)' : ' — re-run to retry'
              }: ${error instanceof Error ? error.message : String(error)}`
            )
            continue
          }
        if (isOpen) claimedOpenKeys.add(newKey)
        migrated++
      }

      for (const task of collisions)
        consola.error(
          `COLLISION — ${task.network}/${task.facetName} @ ${task.facetAddress} (${task.status}) would take an open key another task already holds. ` +
            `Cancel the duplicate (bunx tsx script/deploy/safe/cancel-parked-task.ts --taskKey "${task.taskKey}" --yes), then re-run. Origin PR: ${task.prUrl}`
        )

      consola.success(
        `${migrated} ${
          args.apply ? 'migrated' : 'to migrate'
        }, ${alreadyCurrent} already current, ${
          collisions.length
        } collision(s), ${writeFailures} write failure(s)`
      )
      if (collisions.length > 0 || writeFailures > 0) process.exitCode = 1
    } catch (error: unknown) {
      consola.error(
        `Migration failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      process.exitCode = 1
    } finally {
      try {
        // Optional: a throw before the connection was opened (an unset MONGODB_URI)
        // leaves it undefined, and closing it would mask the real error.
        await mongoClient?.close(true)
      } catch (closeError: unknown) {
        consola.warn(
          `Failed to close MongoDB connection: ${
            closeError instanceof Error
              ? closeError.message
              : String(closeError)
          }`
        )
      }
    }
  },
})

runMain(main)
