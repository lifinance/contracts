/**
 * Tests for {@link buildDiamondCut}.
 *
 * Mirrors the algorithm in `script/deploy/facets/utils/UpdateScriptBase.sol:buildDiamondCut`.
 * Covers Add-only, Replace-only, Replace+Remove, Replace+Add, idempotency,
 * case-insensitivity, multi-old-facet behaviour, and empty-selector input.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Address, Hex } from 'viem'

import {
  buildDiamondCut,
  FacetCutActionEnum,
  type IOnChainFacet,
} from './buildDiamondCut'

const NEW_FACET = '0x1111111111111111111111111111111111111111' as Address
const OLD_FACET = '0x2222222222222222222222222222222222222222' as Address
const OTHER_FACET = '0x3333333333333333333333333333333333333333' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

const SEL_A = '0xaaaaaaaa' as Hex
const SEL_B = '0xbbbbbbbb' as Hex
const SEL_C = '0xcccccccc' as Hex
const SEL_D = '0xdddddddd' as Hex

describe('buildDiamondCut', () => {
  it('returns a single Add cut when no selectors exist on chain', () => {
    const cuts = buildDiamondCut({
      newSelectors: [SEL_A, SEL_B],
      newFacetAddress: NEW_FACET,
      onChainFacets: [],
    })

    expect(cuts).toEqual([
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Add,
        functionSelectors: [SEL_A, SEL_B],
      },
    ])
  })

  it('returns an empty cut when the new facet is already wired exactly', () => {
    const facets: IOnChainFacet[] = [
      { address: NEW_FACET, selectors: [SEL_A, SEL_B] },
    ]
    const cuts = buildDiamondCut({
      newSelectors: [SEL_A, SEL_B],
      newFacetAddress: NEW_FACET,
      onChainFacets: facets,
    })
    expect(cuts).toEqual([])
  })

  it('emits a Replace when selectors move from old facet to new', () => {
    const facets: IOnChainFacet[] = [
      { address: OLD_FACET, selectors: [SEL_A, SEL_B] },
    ]
    const cuts = buildDiamondCut({
      newSelectors: [SEL_A, SEL_B],
      newFacetAddress: NEW_FACET,
      onChainFacets: facets,
    })
    expect(cuts).toEqual([
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Replace,
        functionSelectors: [SEL_A, SEL_B],
      },
    ])
  })

  it('emits Replace + Remove when new facet drops some old selectors', () => {
    const facets: IOnChainFacet[] = [
      { address: OLD_FACET, selectors: [SEL_A, SEL_B, SEL_C] },
    ]
    const cuts = buildDiamondCut({
      newSelectors: [SEL_A, SEL_B],
      newFacetAddress: NEW_FACET,
      onChainFacets: facets,
    })
    // Order matches Solidity: Replace → Remove → Add
    expect(cuts).toEqual([
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Replace,
        functionSelectors: [SEL_A, SEL_B],
      },
      {
        facetAddress: ZERO,
        action: FacetCutActionEnum.Remove,
        functionSelectors: [SEL_C],
      },
    ])
  })

  it('emits Replace + Add when new facet introduces extra selectors', () => {
    const facets: IOnChainFacet[] = [
      { address: OLD_FACET, selectors: [SEL_A, SEL_B] },
    ]
    const cuts = buildDiamondCut({
      newSelectors: [SEL_A, SEL_B, SEL_C],
      newFacetAddress: NEW_FACET,
      onChainFacets: facets,
    })
    expect(cuts).toEqual([
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Replace,
        functionSelectors: [SEL_A, SEL_B],
      },
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Add,
        functionSelectors: [SEL_C],
      },
    ])
  })

  it('produces Replace + Remove + Add in canonical order for a mixed diff', () => {
    const facets: IOnChainFacet[] = [
      { address: OLD_FACET, selectors: [SEL_A, SEL_B, SEL_C] },
    ]
    // SEL_A stays, SEL_B replaced (no-op same selector, different facet), SEL_C dropped, SEL_D new
    const cuts = buildDiamondCut({
      newSelectors: [SEL_A, SEL_B, SEL_D],
      newFacetAddress: NEW_FACET,
      onChainFacets: facets,
    })
    expect(cuts).toEqual([
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Replace,
        functionSelectors: [SEL_A, SEL_B],
      },
      {
        facetAddress: ZERO,
        action: FacetCutActionEnum.Remove,
        functionSelectors: [SEL_C],
      },
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Add,
        functionSelectors: [SEL_D],
      },
    ])
  })

  it('only sweeps the last displaced facet for Remove (matches Solidity)', () => {
    // SEL_A is currently at OLD_FACET, SEL_B at OTHER_FACET. Both replaced.
    // Solidity keeps the LAST oldFacet (OTHER_FACET) for the Remove sweep,
    // so SEL_X that only existed on OLD_FACET is NOT swept here.
    const facets: IOnChainFacet[] = [
      { address: OLD_FACET, selectors: [SEL_A, SEL_C] }, // SEL_C orphaned if not in newSelectors
      { address: OTHER_FACET, selectors: [SEL_B, SEL_D] }, // SEL_D orphaned if not in newSelectors
    ]
    const cuts = buildDiamondCut({
      newSelectors: [SEL_A, SEL_B],
      newFacetAddress: NEW_FACET,
      onChainFacets: facets,
    })
    // Replace pass encounters SEL_A first (oldFacet=OLD), then SEL_B (oldFacet=OTHER).
    // Remove pass uses OTHER's leftover selectors → SEL_D.
    // SEL_C from OLD_FACET stays orphaned — same as Solidity. Document this limitation.
    expect(cuts).toEqual([
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Replace,
        functionSelectors: [SEL_A, SEL_B],
      },
      {
        facetAddress: ZERO,
        action: FacetCutActionEnum.Remove,
        functionSelectors: [SEL_D],
      },
    ])
  })

  it('treats addresses and selectors case-insensitively', () => {
    const facets: IOnChainFacet[] = [
      {
        address: OLD_FACET.toUpperCase() as Address,
        selectors: [SEL_A.toUpperCase() as Hex, SEL_B],
      },
    ]
    const cuts = buildDiamondCut({
      newSelectors: [SEL_A, SEL_B.toUpperCase() as Hex],
      newFacetAddress: NEW_FACET,
      onChainFacets: facets,
    })
    expect(cuts).toEqual([
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Replace,
        functionSelectors: [SEL_A, SEL_B.toUpperCase() as Hex],
      },
    ])
  })

  it('returns empty cut when newSelectors is empty', () => {
    const cuts = buildDiamondCut({
      newSelectors: [],
      newFacetAddress: NEW_FACET,
      onChainFacets: [{ address: OLD_FACET, selectors: [SEL_A] }],
    })
    expect(cuts).toEqual([])
  })

  it('handles facet with empty selectors list in onChainFacets', () => {
    const facets: IOnChainFacet[] = [{ address: OLD_FACET, selectors: [] }]
    const cuts = buildDiamondCut({
      newSelectors: [SEL_A],
      newFacetAddress: NEW_FACET,
      onChainFacets: facets,
    })
    expect(cuts).toEqual([
      {
        facetAddress: NEW_FACET,
        action: FacetCutActionEnum.Add,
        functionSelectors: [SEL_A],
      },
    ])
  })
})
