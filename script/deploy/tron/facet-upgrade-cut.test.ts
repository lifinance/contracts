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
import type { Address, Hex } from 'viem'

import {
  assertAddsAreUnrouted,
  buildFacetCuts,
  planSelectorCuts,
} from './facet-upgrade-cut'

const NEW_FACET = '0x1111111111111111111111111111111111111111' as Address
const ZERO = '0x0000000000000000000000000000000000000000'

/** Per [CONV:TEST-ASSERT-REJECTS] — `expect().rejects` is not a real Promise. */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp | string
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  if (match instanceof RegExp) expect(error?.message).toMatch(match)
  else expect(error?.message).toContain(match)
}

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

describe('assertAddsAreUnrouted', () => {
  const OTHER_FACET = '0x2222222222222222222222222222222222222222' as Address
  const OUTGOING = 'TG6586TTEv664XWSD875tMk6yDuwedphpW'

  it('passes when the diamond routes none of the added selectors', async () => {
    const asked: Hex[] = []

    await assertAddsAreUnrouted(
      ['0xbff90b61', '0x762aea18'],
      'EcoFacet',
      OUTGOING,
      async (selector) => {
        asked.push(selector)
        return ZERO as Address
      }
    )

    expect(asked).toEqual(['0xbff90b61', '0x762aea18'])
  })

  // The add would revert LibDiamond after the timelock delay, and silently
  // replacing instead would strand the holder's other selectors.
  it('throws naming the selector, the holder and the outgoing facet', async () => {
    await expectRejects(
      assertAddsAreUnrouted(
        ['0xbff90b61'],
        'EcoFacet',
        OUTGOING,
        async () => OTHER_FACET
      ),
      `Selector 0xbff90b61 of EcoFacet is already served by ${OTHER_FACET}, which is not the outgoing ${OUTGOING} — resolve the collision before proposing`
    )
  })

  it('stops at the first collision instead of reading the rest', async () => {
    let reads = 0

    await expectRejects(
      assertAddsAreUnrouted(
        ['0xbff90b61', '0x762aea18'],
        'EcoFacet',
        OUTGOING,
        async () => {
          reads += 1
          return OTHER_FACET
        }
      ),
      /already served by/
    )
    expect(reads).toBe(1)
  })

  it('reads nothing for a replace-only upgrade', async () => {
    let reads = 0

    await assertAddsAreUnrouted([], 'EcoFacet', OUTGOING, async () => {
      reads += 1
      return ZERO as Address
    })

    expect(reads).toBe(0)
  })

  // The loupe returns a checksummed address; the zero comparison is lowercased.
  it('treats a checksummed holder as a collision', async () => {
    const checksummed = '0xAaBbCcDdEeFf00112233445566778899AaBbCcDd' as Address

    await expectRejects(
      assertAddsAreUnrouted(
        ['0xbff90b61'],
        'EcoFacet',
        'facet',
        async () => checksummed
      ),
      `already served by ${checksummed}`
    )
  })
})
