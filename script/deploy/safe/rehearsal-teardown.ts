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

import {
  deletePendingProposals,
  type IDeleteResult,
} from './delete-pending-proposals'
import { printableField } from './printable-field'
import {
  ADDRESS_COLLATION,
  type ISafeTxDocument,
  type SafeTxStatus,
  getSafeMongoCollection,
} from './safe-utils'

/**
 * The statuses that still occupy a Safe nonce.
 *
 * The same pair `getNextNonce` counts: a broadcast-but-unconfirmed transaction
 * holds its nonce as firmly as a pending one. `executed` and `reverted` are
 * history and must never be matched by a teardown.
 */
const NONCE_HOLDING_STATUSES: readonly SafeTxStatus[] = ['pending', 'submitted']

/**
 * The only status a teardown may delete.
 *
 * A `submitted` row has already been broadcast and its outcome is unknown, so
 * deleting it would drop the record of a transaction that may well have landed.
 * The hunt reports those; clearing one is a decision for a human with the chain
 * in front of them.
 */
const DELETABLE_STATUS: SafeTxStatus = 'pending'

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
 * Restricted to the statuses that actually hold the nonce. A Safe reuses a
 * nonce across history, so an `executed` or `reverted` row can sit at the same
 * number as the one being cleared — and matching it would put a settled
 * transaction in front of a delete.
 *
 * @param pendingTransactions - the proposal collection
 * @param slot - the Safe, network and nonce to hunt
 * @returns every in-flight row holding that nonce
 */
export async function findProposalsAtNonce(
  pendingTransactions: Collection<ISafeTxDocument>,
  slot: IProposalSlot
): Promise<ISafeTxDocument[]> {
  return pendingTransactions
    .find({
      network: slot.network.toLowerCase(),
      chainId: slot.chainId,
      safeAddress: slot.safeAddress,
      'safeTx.data.nonce': slot.nonce,
      status: { $in: [...NONCE_HOLDING_STATUSES] },
    })
    .collation(ADDRESS_COLLATION)
    .toArray()
}

/**
 * Frees a Safe nonce by deleting every row holding it.
 *
 * The network is lowercased here rather than trusted from the caller. The hunt
 * tolerates a miscased network because its collation applies to the whole
 * query, but `deletePendingProposals` matches `network` with an uncollated
 * `$eq` — so `--network Tron` would list the rows, then delete none and report
 * success, leaving the nonce blocked.
 *
 * @param pendingTransactions - the proposal collection
 * @param slot - the Safe, network and nonce to clear
 * @returns one result per row found, as `deletePendingProposals` reports it
 */
export async function tearDownProposalsAtNonce(
  pendingTransactions: Collection<ISafeTxDocument>,
  slot: IProposalSlot
): Promise<IDeleteResult[]> {
  const found = await findProposalsAtNonce(pendingTransactions, slot)
  const deletable = found.filter((doc) => doc.status === DELETABLE_STATUS)
  for (const doc of found)
    if (doc.status !== DELETABLE_STATUS)
      consola.warn(
        `[${slot.network}] leaving ${printableField(
          doc.safeTxHash
        )} alone — status ${printableField(
          doc.status
        )}, which this teardown does not delete`
      )

  if (deletable.length === 0) return []

  return deletePendingProposals(pendingTransactions, {
    network: slot.network.toLowerCase(),
    hashes: deletable.map((doc) => doc.safeTxHash),
    force: false,
  })
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
      const slot: IProposalSlot = {
        network: args.network,
        chainId: Number(args.chainId),
        safeAddress: args.safeAddress,
        nonce: Number(args.nonce),
      }
      const found = await findProposalsAtNonce(pendingTransactions, slot)

      for (const doc of found)
        consola.info(
          `${printableField(doc.safeTxHash)} status=${printableField(
            doc.status
          )} safeAddress=${printableField(doc.safeAddress)}`
        )

      if (!args.delete) {
        consola.info(`${found.length} row(s); pass --delete to remove them`)
        return
      }

      await tearDownProposalsAtNonce(pendingTransactions, slot)
    } finally {
      await client.close(true)
    }
  },
})

if (process.argv[1] && process.argv[1].endsWith('rehearsal-teardown.ts'))
  void runMain(main)
