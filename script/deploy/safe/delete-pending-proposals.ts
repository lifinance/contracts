/**
 * Delete pending Safe proposals from MongoDB by safeTxHash (one network).
 *
 * Use ONLY to remove unsigned/duplicate proposals before re-proposing. Refuses to
 * delete a proposal that already carries more than the proposer's single signature
 * (signatureCount > 1) unless --force is given, so a partially-signed tx is never lost.
 *
 *   bunx tsx script/deploy/safe/delete-pending-proposals.ts --network fuse --hashes 0xaaa,0xbbb
 */
import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { getSafeMongoCollection } from './safe-utils'

const main = defineCommand({
  meta: {
    name: 'delete-pending-proposals',
    description: 'Delete pending proposals by safeTxHash',
  },
  args: {
    network: { type: 'string', required: true },
    hashes: {
      type: 'string',
      required: true,
      description: 'Comma-separated safeTxHash list',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'Allow deleting proposals with signatureCount > 1',
    },
  },
  async run({ args }) {
    const hashes = args.hashes
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)
    if (!hashes.length) throw new Error('no hashes provided')
    const { client, pendingTransactions } = await getSafeMongoCollection()
    try {
      for (const h of hashes) {
        const doc = await pendingTransactions.findOne({
          network: args.network,
          safeTxHash: h,
        })
        if (!doc) {
          consola.warn(`[${args.network}] not found: ${h}`)
          continue
        }
        const sigField: unknown = doc.safeTx?.signatures
        const sigCount =
          sigField instanceof Map
            ? sigField.size
            : Object.keys((sigField as Record<string, unknown>) ?? {}).length
        const nonce = doc.safeTx?.data?.nonce
        if (sigCount > 1 && !args.force) {
          consola.error(
            `[${args.network}] REFUSING to delete ${h} — signatureCount=${sigCount} (use --force)`
          )
          continue
        }
        const res = await pendingTransactions.deleteOne({
          network: args.network,
          safeTxHash: h,
        })
        consola.success(
          `[${args.network}] deleted ${h} (nonce=${String(
            nonce
          )}, sigCount=${sigCount}, deletedCount=${res.deletedCount})`
        )
      }
    } finally {
      await client.close(true)
    }
  },
})

runMain(main)
