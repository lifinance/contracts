/**
 * Chooses which stored proposals a card describes, and classifies the networks
 * that contributed none.
 *
 * Split out of `render-proposal-card.ts` so it can be tested without a database.
 * It is the part most likely to be wrong: nothing in a proposal document
 * identifies the run that created it, so the selection is a heuristic, and the
 * shortfall classification decides whether an operator is warned or not.
 */

import type { ICardProposal } from './proposal-card'

/** The fields the card reads, as they sit on a stored document. */
export interface IStoredProposal {
  network: unknown
  // Optional because a stored row can lack it: the card renders whatever is
  // there rather than refusing, and a short hash of nothing is visibly empty.
  safeTxHash?: unknown
  timestamp?: unknown
  provenance?: {
    proposerHandle?: unknown
    actor?: unknown
    reason?: unknown
    prUrl?: unknown
    gitCommit?: unknown
    dirtyTreeScoped?: unknown
    dirtyTreeTruncated?: unknown
    captureErrors?: unknown
  }
}

export interface ISelection {
  /** One per network that had a pending row, in the caller's order. */
  proposals: ICardProposal[]
  /** Networks whose proposal exists but is no longer pending. */
  settled: string[]
  /** Networks with no proposal in any status — the only real shortfall. */
  unaccounted: string[]
}

/**
 * Picks the newest pending row per network and classifies the rest.
 *
 * @param networks - The run's networks, already lowercased and deduped.
 * @param pending - Pending rows, NEWEST FIRST as the query returns them.
 * @param networksWithAnyRow - Networks known to have a row in any status.
 * @returns What the card describes, and why anything is missing.
 */
export const selectProposals = (
  networks: string[],
  pending: IStoredProposal[],
  networksWithAnyRow: string[]
): ISelection => {
  const newest = new Map<string, IStoredProposal>()
  for (const row of pending) {
    const network = String(row.network)
    // First wins, because the caller sorted newest first. Re-sorting here would
    // silently disagree with the query when a row has no timestamp.
    if (!newest.has(network)) newest.set(network, row)
  }

  // The caller's order, so the card reads in the same order as the run's output.
  const proposals = networks
    .map((network) => newest.get(network))
    .filter((row): row is IStoredProposal => row !== undefined)
    .map((row) => ({
      network: String(row.network),
      safeTxHash: row.safeTxHash,
      proposerHandle: row.provenance?.proposerHandle,
      actor: row.provenance?.actor,
      reason: row.provenance?.reason,
      prUrl: row.provenance?.prUrl,
      gitCommit: row.provenance?.gitCommit,
      dirtyTreeScoped: row.provenance?.dirtyTreeScoped,
      dirtyTreeTruncated: row.provenance?.dirtyTreeTruncated,
      captureErrors: row.provenance?.captureErrors,
    }))

  const withoutPending = networks.filter((network) => !newest.has(network))
  const known = new Set(networksWithAnyRow)

  return {
    proposals,
    // A row that exists but is not pending was signed and executed already, so
    // its absence from the card is correct rather than a shortfall. Counting it
    // as missing would fire the alarm on every resumed run.
    settled: withoutPending.filter((network) => known.has(network)),
    unaccounted: withoutPending.filter((network) => !known.has(network)),
  }
}
