/**
 * The selector arithmetic an upgrade cut rests on. Both failure directions are
 * silent until execution — a mis-sorted selector reverts the cut after the
 * timelock delay, and a dropped removal leaves the superseded facet reachable —
 * so the sets are pinned here rather than read off a proposal.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Address } from 'viem'

import { buildFacetCuts, planSelectorCuts } from './facet-upgrade-cut'

const NEW_FACET = '0x1111111111111111111111111111111111111111' as Address
const ZERO = '0x0000000000000000000000000000000000000000'

describe('planSelectorCuts', () => {
  it('splits an upgrade into add, replace and remove', () => {
    // EcoFacet 1.1.0 → 2.0.0: PORTAL() is unchanged, both entry points changed
    // shape, so their old selectors have to go.
    const plan = planSelectorCuts(
      ['0x0ff754ea', '0xbff90b61', '0x762aea18'],
      ['0x0ff754ea', '0x7e56b7b0', '0x9e75aa95']
    )

    expect(plan.add).toEqual(['0xbff90b61', '0x762aea18'])
    expect(plan.replace).toEqual(['0x0ff754ea'])
    expect(plan.remove).toEqual(['0x7e56b7b0', '0x9e75aa95'])
  })

  it('treats an unchanged ABI as replace-only', () => {
    const plan = planSelectorCuts(['0xaabbccdd'], ['0xaabbccdd'])

    expect(plan.add).toEqual([])
    expect(plan.replace).toEqual(['0xaabbccdd'])
    expect(plan.remove).toEqual([])
  })

  it('compares selectors case-insensitively', () => {
    const plan = planSelectorCuts(['0xAABBCCDD'], ['0xaabbccdd'])

    expect(plan.replace).toEqual(['0xaabbccdd'])
    expect(plan.add).toEqual([])
  })

  it('accepts selectors without the 0x prefix', () => {
    const plan = planSelectorCuts(['aabbccdd'], ['ddccbbaa'])

    expect(plan.add).toEqual(['0xaabbccdd'])
    expect(plan.remove).toEqual(['0xddccbbaa'])
  })
})

describe('buildFacetCuts', () => {
  it('orders add, replace, remove and points removals at the zero address', () => {
    const cuts = buildFacetCuts(
      {
        add: ['0xbff90b61'],
        replace: ['0x0ff754ea'],
        remove: ['0x7e56b7b0'],
      },
      NEW_FACET
    )

    expect(cuts).toEqual([
      {
        facetAddress: NEW_FACET,
        action: 0,
        functionSelectors: ['0xbff90b61'],
      },
      {
        facetAddress: NEW_FACET,
        action: 1,
        functionSelectors: ['0x0ff754ea'],
      },
      {
        facetAddress: ZERO as Address,
        action: 2,
        functionSelectors: ['0x7e56b7b0'],
      },
    ])
  })

  it('omits empty entries — LibDiamond reverts on a cut with no selectors', () => {
    const cuts = buildFacetCuts(
      { add: [], replace: ['0x0ff754ea'], remove: [] },
      NEW_FACET
    )

    expect(cuts).toHaveLength(1)
    expect(cuts[0]?.action).toBe(1)
  })

  it('returns nothing when the diamond already matches', () => {
    expect(
      buildFacetCuts({ add: [], replace: [], remove: [] }, NEW_FACET)
    ).toEqual([])
  })
})
