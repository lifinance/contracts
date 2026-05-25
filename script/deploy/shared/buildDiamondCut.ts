/**
 * Chain-agnostic diamondCut planner.
 *
 * Port of `script/deploy/facets/utils/UpdateScriptBase.sol:buildDiamondCut`.
 * Given the new facet's selectors (from artifact), the new facet address,
 * and the current on-chain Loupe state, produces the FacetCut[] needed
 * to bring the diamond's wiring in line with the new facet.
 *
 * Reused by Tron and EVM proposers — chain-specific code is only the
 * Loupe read and the Safe proposal submission.
 */

import type { Address, Hex } from 'viem'

/** Numeric action values used by IDiamondCut.diamondCut (uint8). */
export enum FacetCutActionEnum {
  Add = 0,
  Replace = 1,
  Remove = 2,
}

export interface IOnChainFacet {
  /** Facet contract address (EVM 20-byte hex, checksum or lowercase). */
  address: Address
  /** Function selectors registered to this facet (4-byte 0x hex). */
  selectors: Hex[]
}

export interface IFacetCut {
  facetAddress: Address
  action: FacetCutActionEnum
  functionSelectors: Hex[]
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

const normAddr = (a: string): string => a.toLowerCase()
const normSelector = (s: string): string => s.toLowerCase()

/**
 * Computes the FacetCut[] to register `newFacetAddress` with `newSelectors`,
 * accounting for the diamond's current Loupe state.
 *
 * Returns an empty array when the new facet is already wired exactly as-is.
 * Cut ordering matches UpdateScriptBase.sol: Replace → Remove → Add.
 *
 * @param newSelectors - Selectors of the new facet (from Forge artifact methodIdentifiers).
 * @param newFacetAddress - The new facet's EVM-20 hex address.
 * @param onChainFacets - Result of `DiamondLoupeFacet.facets()` on the live diamond.
 */
export function buildDiamondCut({
  newSelectors,
  newFacetAddress,
  onChainFacets,
}: {
  newSelectors: Hex[]
  newFacetAddress: Address
  onChainFacets: IOnChainFacet[]
}): IFacetCut[] {
  // selector → currently-registered facet address (lowercase)
  const selectorToFacet = new Map<string, string>()
  // facet address (lowercase) → its current selectors (lowercase)
  const facetToSelectors = new Map<string, string[]>()
  for (const f of onChainFacets) {
    const addr = normAddr(f.address)
    const sels = f.selectors.map(normSelector)
    facetToSelectors.set(addr, sels)
    for (const sel of sels) selectorToFacet.set(sel, addr)
  }

  const newAddrNorm = normAddr(newFacetAddress)
  const newSelectorSet = new Set(newSelectors.map(normSelector))

  const selectorsToAdd: Hex[] = []
  const selectorsToReplace: Hex[] = []
  let oldFacet = '' // last facet whose selectors we displaced (mirrors Solidity)

  for (const sel of newSelectors) {
    const selNorm = normSelector(sel)
    const existing = selectorToFacet.get(selNorm)
    if (!existing) selectorsToAdd.push(sel)
    else if (existing !== newAddrNorm) {
      selectorsToReplace.push(sel)
      oldFacet = existing
    }
    // existing === newAddrNorm → already wired, skip
  }

  const selectorsToRemove: Hex[] = []
  if (oldFacet) {
    const oldSelectors = facetToSelectors.get(oldFacet) ?? []
    for (const oldSel of oldSelectors)
      if (!newSelectorSet.has(oldSel)) selectorsToRemove.push(oldSel as Hex)
  }

  const cuts: IFacetCut[] = []
  if (selectorsToReplace.length > 0)
    cuts.push({
      facetAddress: newFacetAddress,
      action: FacetCutActionEnum.Replace,
      functionSelectors: selectorsToReplace,
    })
  if (selectorsToRemove.length > 0)
    cuts.push({
      facetAddress: ZERO_ADDRESS,
      action: FacetCutActionEnum.Remove,
      functionSelectors: selectorsToRemove,
    })
  if (selectorsToAdd.length > 0)
    cuts.push({
      facetAddress: newFacetAddress,
      action: FacetCutActionEnum.Add,
      functionSelectors: selectorsToAdd,
    })

  return cuts
}
