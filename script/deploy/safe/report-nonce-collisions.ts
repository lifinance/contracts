/**
 * Read-only report of in-flight proposals that share a Safe nonce.
 *
 * `ensureInFlightNonceIndex` cannot build its unique index while such a pair
 * exists, and warns rather than blocking every Safe script. This names the rows
 * so the warning is actionable, and doubles as the pre-deployment check that the
 * index will build at all.
 *
 * Writes nothing.
 */

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { getSafeMongoCollection } from './safe-utils'

interface ICollisionGroup {
  _id: {
    safeAddress: string
    network: string
    chainId: number
    nonce: unknown
  }
  count: number
  safeTxHashes: string[]
  statuses: string[]
}

const main = defineCommand({
  meta: {
    name: 'report-nonce-collisions',
    description:
      'Lists in-flight proposals sharing a Safe nonce (read-only diagnostic)',
  },
  async run() {
    const { client, pendingTransactions } = await getSafeMongoCollection()

    try {
      const groups = (await pendingTransactions
        .aggregate([
          { $match: { status: { $in: ['pending', 'submitted'] } } },
          {
            $group: {
              _id: {
                safeAddress: '$safeAddress',
                network: '$network',
                chainId: '$chainId',
                nonce: '$safeTx.data.nonce',
              },
              count: { $sum: 1 },
              safeTxHashes: { $push: '$safeTxHash' },
              statuses: { $push: '$status' },
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

      for (const group of groups)
        consola.log(
          `  ${group._id.network} (chain ${group._id.chainId}) Safe ${
            group._id.safeAddress
          } nonce ${String(group._id.nonce)}: ${
            group.count
          } rows [${group.statuses.join(', ')}]\n` +
            group.safeTxHashes.map((hash) => `      ${hash}`).join('\n')
        )

      // Exit code, not just output: this is read in CI and by an operator
      // deciding whether the index will build.
      process.exit(1)
    } finally {
      await client.close()
    }
  },
})

runMain(main)
