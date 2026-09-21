/**
 * The selector arithmetic an upgrade cut rests on. Both failure directions are
 * silent until execution — a mis-sorted selector reverts the cut after the
 * timelock delay, and a dropped removal leaves the superseded facet reachable —
 * so the sets are pinned here rather than read off a proposal.
 */

import { realpathSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getTronWebCodecOnlyForNetwork,
  tronAddressToHex,
} from '@lifi/tron-devkit'
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { getAddress, type Address, type Hex } from 'viem'

import { getFacetAddressFromDiamondLog } from '../../utils/utils'

import type { IFacetRoutingEntry } from './facet-upgrade-cut'
import {
  assertAddsAreUnrouted,
  buildFacetCuts,
  holderResolver,
  indexFacetRouting,
  planFacetUpgrade,
  planSelectorCuts,
  resolveOutgoingFacet,
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

describe('planFacetUpgrade', () => {
  const OLD_FACET = '0x3333333333333333333333333333333333333333' as Address
  const OUTGOING = 'TG6586TTEv664XWSD875tMk6yDuwedphpW'

  const outgoing = (addressHex: Address, registered: Hex[]) => ({
    label: OUTGOING,
    addressHex,
    registered,
  })

  it('reduces a first registration to a plain add cut', () => {
    const plan = planFacetUpgrade(
      'EcoFacet',
      ['0xbff90b61', '0x762aea18'],
      NEW_FACET,
      null
    )

    expect(plan).toEqual({
      add: ['0xbff90b61', '0x762aea18'],
      replace: [],
      remove: [],
    })
  })

  it('replaces and removes against the outgoing facet', () => {
    const plan = planFacetUpgrade(
      'EcoFacet',
      ['0x0ff754ea', '0xbff90b61'],
      NEW_FACET,
      outgoing(OLD_FACET, ['0x0ff754ea', '0x7e56b7b0'])
    )

    expect(plan).toEqual({
      add: ['0xbff90b61'],
      replace: ['0x0ff754ea'],
      remove: ['0x7e56b7b0'],
    })
  })

  // A recorded address the loupe routes nothing to no longer identifies what
  // the upgrade supersedes, so the cut cannot be planned from it.
  it('refuses a log entry the diamond routes nothing to', () => {
    expect(() =>
      planFacetUpgrade(
        'EcoFacet',
        ['0xbff90b61'],
        NEW_FACET,
        outgoing(OLD_FACET, [])
      )
    ).toThrow(
      `EcoFacet is recorded at ${OUTGOING} in the diamond log, but the diamond routes no selector there`
    )
  })

  // LibDiamond.replaceFunctions reverts FunctionAlreadyExists when the selector
  // already points at the facet the Replace names.
  it('drops the replaces when re-proposing the installed address', () => {
    const plan = planFacetUpgrade(
      'EcoFacet',
      ['0x0ff754ea', '0xbff90b61'],
      NEW_FACET,
      outgoing(NEW_FACET, ['0x0ff754ea', '0x7e56b7b0'])
    )

    expect(plan).toEqual({
      add: ['0xbff90b61'],
      replace: [],
      remove: ['0x7e56b7b0'],
    })
  })

  // The proposal is written to the log when it is made, so a rejected or
  // expired one comes back with the log naming this very deployment and the
  // loupe routing nothing to it. That is the cut that never executed, not a log
  // the chain disagrees with — the dead-entry guard must not claim it and tell
  // the operator to repoint a committed log back to a superseded address.
  it('plans a plain add when the recorded address never landed', () => {
    const plan = planFacetUpgrade(
      'EcoFacet',
      ['0x0ff754ea', '0xbff90b61'],
      NEW_FACET,
      outgoing(NEW_FACET, [])
    )

    expect(plan).toEqual({
      add: ['0x0ff754ea', '0xbff90b61'],
      replace: [],
      remove: [],
    })
  })

  // The loupe hands back a checksummed address; the diamond log stores base58,
  // which converts to lowercase hex.
  it('matches the installed address regardless of case', () => {
    const lowercase = '0xaabbccddeeff00112233445566778899aabbccdd' as Address

    const plan = planFacetUpgrade(
      'EcoFacet',
      ['0x0ff754ea'],
      getAddress(lowercase),
      outgoing(lowercase, ['0x0ff754ea'])
    )

    expect(plan.replace).toEqual([])
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
    const checksummed = getAddress('0xaabbccddeeff00112233445566778899aabbccdd')

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

/**
 * The layer between the loupe read and the arithmetic: address form, map keying
 * and resolving the outgoing facet out of the diamond log. Both directions are
 * silent — a map keyed on one address form and read with another answers
 * "unrouted", which plans an Add the diamond reverts after the timelock delay —
 * so the real Tron codec is the point of these fixtures, not a stand-in.
 */
describe('routing index', () => {
  const codec = getTronWebCodecOnlyForNetwork('tron')
  const toHex = (base58: string): Address =>
    tronAddressToHex(codec, base58) as Address

  const ECO_V1 = 'TG6586TTEv664XWSD875tMk6yDuwedphpW'
  const ALLBRIDGE = 'TR15epdwXG9kBXtEBnF5bv6kSYRY5w6mXY'
  const ECO_V1_HEX = '0x431d16f24befda1794fa7e94805e326dc32c7674'
  const ECO_V2_HEX = '0x2222222222222222222222222222222222222222' as Address

  // EcoFacet 1.1.0 as the live diamond routed it, plus one unrelated facet.
  // The uppercase selector is deliberate: troncast has printed both.
  const ROUTING: IFacetRoutingEntry[] = [
    {
      facet: ECO_V1,
      selectors: ['0x0ff754ea', '0x7e56b7b0', '0x9E75AA95'] as Hex[],
    },
    { facet: ALLBRIDGE, selectors: ['0x8da5cb5b'] as Hex[] },
  ]

  it('keys both views on lowercase hex, whatever the codec returns', () => {
    const index = indexFacetRouting(ROUTING, (base58) =>
      getAddress(toHex(base58))
    )

    expect([...index.selectorsOf.keys()]).toEqual([
      ECO_V1_HEX,
      '0xa4e49588c1e391c202ac1d94ad8b69b6fe1da3e1',
    ])
    expect(index.selectorsOf.get(ECO_V1_HEX as Address)).toEqual([
      '0x0ff754ea',
      '0x7e56b7b0',
      '0x9e75aa95',
    ])
    expect(index.holderOf.get('0x9e75aa95')).toBe(ECO_V1_HEX as Address)
  })

  it('answers the zero address for a selector the diamond does not route', async () => {
    const resolve = holderResolver(indexFacetRouting(ROUTING, toHex))

    expect(await resolve('0xbff90b61')).toBe(
      '0x0000000000000000000000000000000000000000'
    )
    expect(await resolve('0x0FF754EA')).toBe(ECO_V1_HEX as Address)
  })

  it('pairs the recorded address with what it still serves', () => {
    const index = indexFacetRouting(ROUTING, toHex)

    expect(resolveOutgoingFacet(ECO_V1, index, toHex)).toEqual({
      label: ECO_V1,
      addressHex: ECO_V1_HEX as Address,
      registered: ['0x0ff754ea', '0x7e56b7b0', '0x9e75aa95'],
    })
    expect(resolveOutgoingFacet(null, index, toHex)).toBeNull()
  })

  // End to end over the seam, against the cut this PR verified on the live
  // diamond: diamond log → outgoing facet → plan → cut entries.
  it('plans the EcoFacet 2.0.0 cut from a diamond log and a routing table', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'upgrade-cut-')))
    const previousCwd = process.cwd()
    try {
      mkdirSync(join(root, 'deployments'), { recursive: true })
      writeFileSync(
        join(root, 'deployments', 'tron.diamond.json'),
        JSON.stringify({
          LiFiDiamond: {
            Facets: {
              [ECO_V1]: { Name: 'EcoFacet', Version: '1.1.0' },
              [ALLBRIDGE]: { Name: 'AllBridgeFacet', Version: '2.2.0' },
            },
          },
        })
      )
      process.chdir(root)

      const index = indexFacetRouting(ROUTING, toHex)
      const outgoingBase58 = await getFacetAddressFromDiamondLog(
        'tron',
        'EcoFacet'
      )
      const plan = planFacetUpgrade(
        'EcoFacet',
        ['0xbff90b61', '0x762aea18', '0x0ff754ea'],
        ECO_V2_HEX,
        resolveOutgoingFacet(outgoingBase58, index, toHex)
      )

      await assertAddsAreUnrouted(
        plan.add,
        'EcoFacet',
        outgoingBase58 ?? 'facet',
        holderResolver(index)
      )

      expect(buildFacetCuts(plan, ECO_V2_HEX)).toEqual([
        {
          facetAddress: ECO_V2_HEX,
          action: 0,
          functionSelectors: ['0xbff90b61', '0x762aea18'],
        },
        {
          facetAddress: ECO_V2_HEX,
          action: 1,
          functionSelectors: ['0x0ff754ea'],
        },
        {
          facetAddress: '0x0000000000000000000000000000000000000000',
          action: 2,
          functionSelectors: ['0x7e56b7b0', '0x9e75aa95'],
        },
      ])
    } finally {
      process.chdir(previousCwd)
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The collision the guard exists for, reached through the same seam: another
  // facet already serves a selector the new version introduces.
  it('refuses when a selector being added is served by a third facet', async () => {
    const index = indexFacetRouting(ROUTING, toHex)
    const plan = planFacetUpgrade(
      'EcoFacet',
      ['0x8da5cb5b'],
      ECO_V2_HEX,
      resolveOutgoingFacet(ECO_V1, index, toHex)
    )

    await expectRejects(
      assertAddsAreUnrouted(
        plan.add,
        'EcoFacet',
        ECO_V1,
        holderResolver(index)
      ),
      'is already served by 0xa4e49588c1e391c202ac1d94ad8b69b6fe1da3e1'
    )
  })
})
