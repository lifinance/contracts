/**
 * Narrows `deploy-core-facets.ts` to the contracts its `--only` flag names, including
 * whether LiFiDiamond, which is redeployed only when named, is among them.
 */

export const DIAMOND = 'LiFiDiamond'
const DIAMOND_CUT_FACET = 'DiamondCutFacet'

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
