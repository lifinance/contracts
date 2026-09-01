/**
 * Read-only report of how many recent proposals stated a reason, and whether
 * the threshold for making `--reason` mandatory has been reached.
 *
 * Opens its own client, like `report-nonce-collisions.ts`, because
 * `getSafeMongoCollection` creates indexes on connect and a diagnostic must not
 * mutate the schema it reports on.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient } from 'mongodb'

import { REASON_FLIP_WINDOW, summarizeReasonAdoption } from './proposal-intent'

const DEFAULT_DB = 'sc_private'
const DEFAULT_COLLECTION = 'pendingTransactions'

const main = defineCommand({
  meta: {
    name: 'report-reason-adoption',
    description:
      "Reads OQ3's reason-adoption counter: how many recent proposals stated a reason (read-only)",
  },
  args: {
    window: {
      type: 'string',
      description: `How many recent proposals to read (default ${REASON_FLIP_WINDOW}, the flip-trigger window)`,
    },
  },
  async run({ args }) {
    if (!process.env.SC_MONGODB_URI)
      throw new Error('SC_MONGODB_URI environment variable is required')

    const requested = Number(args.window ?? REASON_FLIP_WINDOW)
    if (!Number.isInteger(requested) || requested < 1)
      throw new Error(
        `--window must be a positive integer, got '${String(args.window)}'`
      )

    const client = new MongoClient(process.env.SC_MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
    })

    try {
      await client.connect()
      const rows = await client
        .db(DEFAULT_DB)
        .collection<Record<string, unknown>>(DEFAULT_COLLECTION)
        // Newest first, which is the order summarizeReasonAdoption counts the
        // streak in. Sorted by `timestamp` rather than `_id` so a backfilled row
        // is placed by when it was proposed, not when it was inserted.
        .find({}, { sort: { timestamp: -1 }, limit: requested })
        .project<{ provenance?: { reason?: string } }>({
          'provenance.reason': 1,
        })
        .toArray()

      const summary = summarizeReasonAdoption(
        rows.map((r) => ({ reason: r.provenance?.reason }))
      )

      consola.box(
        [
          `proposals examined       : ${summary.examined} (requested ${requested})`,
          `with no stated reason    : ${summary.reasonless}`,
          `consecutive with a reason: ${summary.consecutiveWithReason}`,
          `OQ3 flip trigger (${REASON_FLIP_WINDOW})    : ${
            summary.flipReady
              ? 'MET — --reason can be made mandatory'
              : 'not met'
          }`,
        ].join('\n')
      )

      // Fewer rows than asked for is not a failure, but it does mean the trigger
      // cannot be met yet, and saying so beats a reader inferring it.
      if (summary.examined < requested)
        consola.info(
          `Only ${summary.examined} proposals exist; the ${REASON_FLIP_WINDOW}-proposal window is not full yet.`
        )
    } finally {
      await client.close()
    }
  },
})

runMain(main)
