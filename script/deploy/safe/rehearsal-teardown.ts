/**
 * Finds and removes the dummy proposals a verify rehearsal leaves behind.
 *
 * Import this from the rehearsal runner, or drive it from the CLI at the foot
 * of this file to clear a junk row by hand.
 *
 * A pending row occupies a Safe nonce, and Safes execute strictly in order, so
 * a dummy left at nonce N blocks every real proposal after it. A row created
 * and deleted in the same run never touches the on-chain nonce — the slot frees
 * when the row goes — which makes this module, not the preflight, the safety
 * story for creating dummy proposals at all.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { type Collection } from 'mongodb'

import { deletePendingProposals } from './delete-pending-proposals'
import {
  ADDRESS_COLLATION,
  type ISafeTxDocument,
  getSafeMongoCollection,
} from './safe-utils'

/** Which Safe, on which network, at which nonce. */
export interface IProposalSlot {
  readonly network: string
  readonly chainId: number
  readonly safeAddress: string
  readonly nonce: number
}

/**
 * Every row occupying one Safe nonce, matched under the store's own collation.
 *
 * The collation is not optional. One Safe has two spellings in this collection
 * — `propose-to-safe-tron.ts` stores lowercase hex, `initializeSafeClient`
 * stores the checksummed form — and an equality match silently returns nothing
 * for the spelling the row does not use. Measured against the production store
 * on 2026-09-12: the checksummed spelling of the Tron Safe matches 0 rows
 * uncollated and 34 collated.
 *
 * @param pendingTransactions - the proposal collection
 * @param slot - the Safe, network and nonce to hunt
 * @returns every row holding that nonce, newest ordering left to the caller
 */
export async function findProposalsAtNonce(
  pendingTransactions: Collection<ISafeTxDocument>,
  slot: IProposalSlot
): Promise<ISafeTxDocument[]> {
  return pendingTransactions
    .find({
      network: slot.network,
      chainId: slot.chainId,
      safeAddress: slot.safeAddress,
      'safeTx.data.nonce': slot.nonce,
    })
    .collation(ADDRESS_COLLATION)
    .toArray()
}

const main = defineCommand({
  meta: {
    name: 'rehearsal-teardown',
    description:
      'Find (and optionally delete) the proposals occupying a Safe nonce',
  },
  args: {
    network: { type: 'string', required: true },
    chainId: { type: 'string', required: true },
    safeAddress: { type: 'string', required: true },
    nonce: { type: 'string', required: true },
    delete: {
      type: 'boolean',
      default: false,
      description: 'Delete the rows found instead of only listing them',
    },
  },
  async run({ args }) {
    const { client, pendingTransactions } = await getSafeMongoCollection()
    try {
      const found = await findProposalsAtNonce(pendingTransactions, {
        network: args.network,
        chainId: Number(args.chainId),
        safeAddress: args.safeAddress,
        nonce: Number(args.nonce),
      })

      for (const doc of found)
        consola.info(
          `${doc.safeTxHash} status=${doc.status} safeAddress=${doc.safeAddress}`
        )

      if (!args.delete) {
        consola.info(`${found.length} row(s); pass --delete to remove them`)
        return
      }

      await deletePendingProposals(pendingTransactions, {
        network: args.network,
        hashes: found.map((doc) => doc.safeTxHash),
        force: false,
      })
    } finally {
      await client.close(true)
    }
  },
})

if (process.argv[1] && process.argv[1].endsWith('rehearsal-teardown.ts'))
  void runMain(main)
