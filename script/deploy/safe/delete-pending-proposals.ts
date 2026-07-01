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
import { type Collection } from 'mongodb'

import { getSafeMongoCollection, type ISafeTxDocument } from './safe-utils'

/** Split a comma-separated --hashes value into a trimmed, empty-free list. */
export function parseHashes(raw: string): string[] {
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
}

/**
 * Count the signatures on a proposal's `safeTx.signatures` field. Typed as a
 * `Map` in code, it round-trips through BSON as a plain object, so both shapes
 * must be handled — an undercount here would bypass the partially-signed guard.
 */
export function countSignatures(sigField: unknown): number {
  return sigField instanceof Map
    ? sigField.size
    : Object.keys((sigField as Record<string, unknown>) ?? {}).length
}

export type DeleteOutcome = 'deleted' | 'skipped-signed' | 'not-found'

export interface IDeleteResult {
  hash: string
  outcome: DeleteOutcome
  sigCount: number
}

/**
 * Delete the given proposals from `pendingTransactions`, skipping any that are
 * missing or carry more than one signature (unless `force`). Returns a per-hash
 * summary; logging is a side effect for operator visibility.
 */
export async function deletePendingProposals(
  pendingTransactions: Collection<ISafeTxDocument>,
  {
    network,
    hashes,
    force,
  }: { network: string; hashes: string[]; force: boolean }
): Promise<IDeleteResult[]> {
  const results: IDeleteResult[] = []
  for (const h of hashes) {
    const doc = await pendingTransactions.findOne({ network, safeTxHash: h })
    if (!doc) {
      consola.warn(`[${network}] not found: ${h}`)
      results.push({ hash: h, outcome: 'not-found', sigCount: 0 })
      continue
    }
    const sigCount = countSignatures(doc.safeTx?.signatures)
    const nonce = doc.safeTx?.data?.nonce
    if (sigCount > 1 && !force) {
      consola.error(
        `[${network}] REFUSING to delete ${h} — signatureCount=${sigCount} (use --force)`
      )
      results.push({ hash: h, outcome: 'skipped-signed', sigCount })
      continue
    }
    const res = await pendingTransactions.deleteOne({ network, safeTxHash: h })
    consola.success(
      `[${network}] deleted ${h} (nonce=${String(
        nonce
      )}, sigCount=${sigCount}, deletedCount=${res.deletedCount})`
    )
    results.push({ hash: h, outcome: 'deleted', sigCount })
  }
  return results
}

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
    const hashes = parseHashes(args.hashes)
    if (!hashes.length) throw new Error('no hashes provided')
    const { client, pendingTransactions } = await getSafeMongoCollection()
    try {
      await deletePendingProposals(pendingTransactions, {
        network: args.network,
        hashes,
        force: args.force,
      })
    } finally {
      await client.close(true)
    }
  },
})

if (import.meta.main) runMain(main)
