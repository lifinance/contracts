/**
 * Renders the signing-ask card for the proposals a run just created.
 *
 * Writes the text; `send-slack-webhook-message.ts` posts it.
 *
 * Opens its own client. `getSafeMongoCollection` creates indexes on connect, and
 * a read-only renderer must not alter the schema it reads.
 *
 * No index has `network` as a leading key, so both queries below scan the
 * collection. Acceptable while this runs once per proposal batch.
 */

import 'dotenv/config'

import { writeFileSync } from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient } from 'mongodb'

import { renderProposalCard, type ICardProposal } from './proposal-card'
import type { SafeTxStatus } from './safe-utils'

const DEFAULT_DB = 'sc_private'
const DEFAULT_COLLECTION = 'pendingTransactions'

/**
 * The subset of `ISafeTxDocument` this renderer reads, typed as it may actually
 * be on disk: `timestamp` and `provenance` are absent on rows stored before
 * those fields existed, and each provenance value is `unknown` because a
 * hand-edited or half-migrated row can hold a non-string there.
 */
interface IRow {
  network: string
  safeTxHash?: unknown
  status?: SafeTxStatus
  timestamp?: Date
  provenance?: {
    proposerHandle?: unknown
    actor?: unknown
    reason?: unknown
    prUrl?: unknown
    gitCommit?: unknown
    dirtyTreeScoped?: unknown
  }
}

const main = defineCommand({
  meta: {
    name: 'render-proposal-card',
    description:
      'Renders the Slack signing-ask card for the newest pending proposal on each given network',
  },
  args: {
    networks: {
      type: 'string',
      description: 'Comma-separated network names',
      required: true,
    },
    out: {
      type: 'string',
      description: 'File to write the card to (default: stdout)',
    },
    contract: {
      type: 'string',
      description: 'Contract the run touched, named in the headline',
    },
  },
  async run({ args }) {
    if (!process.env.SC_MONGODB_URI)
      throw new Error('SC_MONGODB_URI environment variable is required')

    // Deduped: a repeated name would count twice, print the same review
    // command twice, and silence the shortfall check by matching the row count.
    const networks = [
      ...new Set(
        args.networks
          .split(',')
          .map((n) => n.trim().toLowerCase())
          .filter(Boolean)
      ),
    ]
    if (networks.length === 0) throw new Error('--networks matched no names')

    const client = new MongoClient(process.env.SC_MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
    })

    try {
      await client.connect()
      const collection = client
        .db(DEFAULT_DB)
        .collection<IRow>(DEFAULT_COLLECTION)

      // Takes the most recent rather than trying to match the run itself, which
      // nothing in the document identifies. A network can carry an older
      // unsigned proposal, and the card is about the run that just finished.
      // Explicit `$eq`/`$in` per the repo's operator-injection convention, so a
      // value can never be read as an operator expression.
      const rows = await collection
        .find(
          {
            network: { $in: networks },
            status: { $eq: 'pending' as SafeTxStatus },
          },
          { sort: { timestamp: -1 } }
        )
        .toArray()

      const newestByNetwork = new Map<string, IRow>()
      rows.forEach((row) => {
        if (!newestByNetwork.has(row.network))
          newestByNetwork.set(row.network, row)
      })

      // Ordered as the caller listed them, so the card reads in the same order
      // as the run's own output.
      const proposals: ICardProposal[] = networks
        .map((network) => newestByNetwork.get(network))
        .filter((row): row is IRow => row !== undefined)
        .map((row) => ({
          network: String(row.network),
          safeTxHash: row.safeTxHash,
          proposerHandle: row.provenance?.proposerHandle,
          actor: row.provenance?.actor,
          reason: row.provenance?.reason,
          prUrl: row.provenance?.prUrl,
          gitCommit: row.provenance?.gitCommit,
          dirtyTreeScoped: row.provenance?.dirtyTreeScoped,
        }))

      if (proposals.length === 0)
        throw new Error(
          `No pending proposals found for: ${networks.join(', ')}`
        )

      // A network with no PENDING row is not necessarily a missing proposal. The
      // caller's list is every network ever marked successful for this action —
      // the progress file survives a partial run and later runs skip networks
      // already done — so on any resumed run it includes networks whose
      // proposals were signed and executed long ago. Counting those as missing
      // would fire the alarm on exactly the runs that needed a retry.
      //
      // Absence of any row in any status is the real signal, so that is what is
      // asked. `distinct` rather than `find`, so the result is bounded by the
      // number of networks asked about rather than by how many rows they have
      // between them.
      const withoutPending = networks.filter((n) => !newestByNetwork.has(n))
      const settled =
        withoutPending.length === 0
          ? []
          : await collection.distinct('network', {
              network: { $in: withoutPending },
            })

      const unaccounted = withoutPending.filter((n) => !settled.includes(n))

      const contract = args.contract
      const card = renderProposalCard(proposals, {
        // Only genuinely absent proposals are a shortfall.
        expectedCount: proposals.length + unaccounted.length,
        // The runner substitutes this literal when it has no contract name, and
        // it reads as one in the headline.
        ...(contract && contract !== 'unknown' ? { contract } : {}),
      })

      // Named without asserting which status: a `reverted` row is flagged for
      // manual review, so reading it back as "signed" would be a false
      // reassurance about the one case that needs a human.
      if (settled.length > 0)
        consola.info(
          `Not on the card — an earlier proposal exists in a non-pending state: ${settled.join(
            ', '
          )}`
        )
      if (unaccounted.length > 0)
        consola.warn(
          `No proposal at all was found on: ${unaccounted.join(
            ', '
          )} — the card names the shortfall.`
        )

      if (args.out) writeFileSync(args.out, `${card}\n`)
      else consola.log(card)
    } finally {
      // Swallowed: the caller reads the exit code to decide between this card
      // and a count-only fallback that overwrites it, so a close failure after
      // the card is on disk would replace a good card with a worse one.
      await client.close().catch(() => undefined)
    }
  },
})

runMain(main)
