/**
 * Narrows `deploy-core-facets.ts` to the contracts its `--only` flag names and decides what
 * happens to LiFiDiamond, which is redeployed only when named.
 */

const DIAMOND = 'LiFiDiamond'
const DIAMOND_CUT_FACET = 'DiamondCutFacet'

/** What `deploy-core-facets.ts` does with LiFiDiamond. */
export type TDiamondPlan =
  | { action: 'deploy' }
  | { action: 'reuse'; address: string }
  | { action: 'skip' }

/**
 * The core facets a run deploys, and whether `--only` names LiFiDiamond.
 *
 * @param coreFacets - Every core facet the script knows, in deploy order.
 * @param only - The names `--only` gave, or undefined when the flag is absent.
 * @returns The facets to deploy, in deploy order, and whether LiFiDiamond is named.
 * @throws When `--only` names a contract that is neither a core facet nor LiFiDiamond, names
 *   nothing, or names LiFiDiamond without the DiamondCutFacet its constructor takes.
 */
export function selectCoreContracts(
  coreFacets: readonly string[],
  only: readonly string[] | undefined
): { facets: string[]; diamondNamed: boolean } {
  if (only === undefined)
    return { facets: [...coreFacets], diamondNamed: false }
  if (only.length === 0) throw new Error('--only names no contract')

  const unknown = only.filter(
    (name) => name !== DIAMOND && !coreFacets.includes(name)
  )
  if (unknown.length > 0)
    throw new Error(
      `--only names ${unknown.join(', ')}, which ${
        unknown.length === 1 ? 'is' : 'are'
      } not a core facet or ${DIAMOND}. Core facets: ${coreFacets.join(', ')}`
    )

  const diamondNamed = only.includes(DIAMOND)
  if (diamondNamed && !only.includes(DIAMOND_CUT_FACET))
    throw new Error(
      `--only names ${DIAMOND} without ${DIAMOND_CUT_FACET}, whose address its constructor takes; name both`
    )

  return {
    facets: coreFacets.filter((facet) => only.includes(facet)),
    diamondNamed,
  }
}

/**
 * Decides LiFiDiamond's fate when `--only` does not name it: a diamond recorded for the
 * network is kept, since replacing it would orphan every facet cut into it.
 *
 * @param options.onlyGiven - Whether `--only` was passed at all.
 * @param options.recordedAddress - LiFiDiamond's address in this network's own log, if any.
 * @returns `reuse` for a recorded diamond, `skip` when `--only` leaves it out and none is
 *   recorded, `deploy` for a full run on a network without one.
 */
export function planUnnamedDiamond(options: {
  onlyGiven: boolean
  recordedAddress: string | null
}): TDiamondPlan {
  if (options.recordedAddress)
    return { action: 'reuse', address: options.recordedAddress }
  return options.onlyGiven ? { action: 'skip' } : { action: 'deploy' }
}
