/**
 * Read-only report of in-flight proposals that share a Safe nonce.
 *
 * `ensureInFlightNonceIndex` cannot build its unique index while such a pair
 * exists, and warns rather than blocking every Safe script. This names the rows
 * so the warning is actionable, and doubles as the pre-deployment check that the
 * index will build at all.
 *
 * It opens its own client rather than using `getSafeMongoCollection`, which
 * creates indexes on connect — a diagnostic must not mutate the schema it is
 * asked to describe, least of all the schema whose creation failed.
 *
 * Grouping is case-insensitive on `safeAddress` on purpose: the index keys the
 * raw field, so two inserts that spell the same Safe differently do NOT collide
 * in the index. Those pairs are real nonce collisions the index cannot catch,
 * and a report that grouped the same way as the index would hide exactly them.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient } from 'mongodb'

const DEFAULT_DB = 'sc_private'
const DEFAULT_COLLECTION = 'pendingTransactions'

interface ICollisionGroup {
  _id: {
    safeAddress: string
    network: string
    chainId: number
    nonce: unknown
  }
  count: number
  rows: { safeTxHash: string; status: string; safeAddress: string }[]
}

const main = defineCommand({
  meta: {
    name: 'report-nonce-collisions',
    description:
      'Lists in-flight proposals sharing a Safe nonce (read-only diagnostic)',
  },
  async run() {
    if (!process.env.SC_MONGODB_URI)
      throw new Error('SC_MONGODB_URI environment variable is required')

    const client = new MongoClient(process.env.SC_MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
    })

    try {
      await client.connect()
      const collection = client
        .db(DEFAULT_DB)
        .collection<Record<string, unknown>>(DEFAULT_COLLECTION)

      const groups = (await collection
        .aggregate([
          { $match: { status: { $in: ['pending', 'submitted'] } } },
          {
            $group: {
              _id: {
                safeAddress: { $toLower: '$safeAddress' },
                network: { $toLower: '$network' },
                chainId: '$chainId',
                nonce: '$safeTx.data.nonce',
              },
              count: { $sum: 1 },
              rows: {
                $push: {
                  safeTxHash: '$safeTxHash',
                  status: '$status',
                  safeAddress: '$safeAddress',
                },
              },
            },
          },
          { $match: { count: { $gt: 1 } } },
          { $sort: { count: -1 } },
        ])
        .toArray()) as ICollisionGroup[]

      if (groups.length === 0) {
        consola.success(
          'No in-flight nonce collisions. The unique index can be built.'
        )
        return
      }

      consola.error(
        `${groups.length} nonce collision(s) among in-flight proposals. The unique index cannot be built until these are resolved:`
      )

      for (const group of groups) {
        const spellings = new Set(group.rows.map((row) => row.safeAddress))

        consola.log(
          `  ${group._id.network} (chain ${group._id.chainId}) Safe ${
            group._id.safeAddress
          } nonce ${String(group._id.nonce)}: ${group.count} rows\n` +
            group.rows
              .map((row) => `      ${row.status.padEnd(9)} ${row.safeTxHash}`)
              .join('\n') +
            (spellings.size > 1
              ? `\n      NOTE: ${spellings.size} spellings of this Safe address in one group ` +
                `(${[...spellings].join(
                  ', '
                )}). The index keys the raw field, so these rows do ` +
                `NOT collide in it — this collision is invisible to the database guarantee.`
              : '')
        )
      }

      // Exit code so an operator (or a wrapper) can gate on it rather than
      // having to read the output.
      process.exit(1)
    } finally {
      await client.close()
    }
  },
})

runMain(main)
