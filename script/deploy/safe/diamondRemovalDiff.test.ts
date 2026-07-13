// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { EnvironmentEnum } from '../../common/types'

import {
  buildAddressToName,
  collectActiveSelectors,
  computeFacetRemovalDiff,
  diffFacets,
  fetchOnChainFacets,
  getExpectedFacetNames,
  getProtectedNames,
  getSourceContractNames,
  HARDCODED_PROTECTED_FACETS,
  mapLoupeResult,
  resolveAddressToName,
  resolveDiamondAddress,
  type IOnChainFacet,
  type IRemovalDiffIO,
} from './diamondRemovalDiff'

const addr = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`
const sel = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(8, '0')}` as `0x${string}`

const PROD = EnvironmentEnum.production

describe('getProtectedNames', () => {
  it('includes hardcoded machinery, diamonds, core facets and core periphery', () => {
    const p = getProtectedNames()
    for (const name of HARDCODED_PROTECTED_FACETS)
      expect(p.has(name)).toBe(true)
    expect(p.has('LiFiDiamond')).toBe(true)
    expect(p.has('LiFiDiamondImmutable')).toBe(true)
    // From config/global.json core lists.
    expect(p.has('WithdrawFacet')).toBe(true)
    expect(p.has('Executor')).toBe(true)
  })
})

describe('buildAddressToName', () => {
  it('inverts and lowercases, ignoring non-address values', () => {
    const map = buildAddressToName({
      DiamondCutFacet: '0xABCdef0000000000000000000000000000000001',
      SomeVersion: '1.2.3',
      NotAString: 42,
    })
    expect(map['0xabcdef0000000000000000000000000000000001']).toBe(
      'DiamondCutFacet'
    )
    expect(Object.keys(map)).toHaveLength(1)
  })
})

describe('getExpectedFacetNames', () => {
  it('returns the LiFiDiamond key set for a known network/env', () => {
    const names = getExpectedFacetNames('mainnet', PROD)
    expect(names.has('DiamondCutFacet')).toBe(true)
    expect(names.size).toBeGreaterThan(0)
  })

  it('returns an empty set for an unknown network', () => {
    expect(getExpectedFacetNames('not-a-network', PROD).size).toBe(0)
  })
})

describe('collectActiveSelectors', () => {
  it('unions selectors, lowercases, and skips names whose lookup throws', () => {
    const selectorsOf = (name: string): `0x${string}`[] => {
      if (name === 'A') return [sel(0xaa), sel(0xbb)]
      if (name === 'B') return [sel(0xbb)] // duplicate across facets
      throw new Error('no artifact')
    }
    const set = collectActiveSelectors(['A', 'B', 'Missing'], selectorsOf)
    expect(set.has(sel(0xaa))).toBe(true)
    expect(set.has(sel(0xbb))).toBe(true)
    expect(set.size).toBe(2)
  })

  it('returns empty for no names', () => {
    expect(collectActiveSelectors([], () => []).size).toBe(0)
  })
})

describe('mapLoupeResult', () => {
  it('checksums addresses and copies selectors', () => {
    const mapped = mapLoupeResult([
      {
        facetAddress: '0xabcdef0000000000000000000000000000000001',
        functionSelectors: [sel(1)],
      },
    ])
    expect(mapped[0]?.address).toBe(
      '0xaBCdEf0000000000000000000000000000000001'
    )
    expect(mapped[0]?.selectors).toEqual([sel(1)])
  })
})

describe('fetchOnChainFacets', () => {
  it('maps the raw loupe result via an injected reader', async () => {
    const facets = await fetchOnChainFacets(addr(1), 'mainnet', async () => [
      { facetAddress: addr(2), functionSelectors: [sel(3)] },
    ])
    expect(facets).toEqual([{ address: addr(2), selectors: [sel(3)] }])
  })
})

describe('diffFacets', () => {
  const base = {
    network: 'testnet-x',
    environment: PROD,
    diamondAddress: addr(0xd),
    sourceNames: new Set<string>(),
  }

  it('flags a stale facet as a removal candidate with its loupe selectors', () => {
    const diff = diffFacets({
      ...base,
      onChainFacets: [{ address: addr(1), selectors: [sel(1), sel(2)] }],
      addressToName: { [addr(1)]: 'OldFacet' },
      expectedNames: new Set(),
      protectedNames: new Set(),
      activeSelectors: new Set(),
    })
    expect(diff.removals).toEqual([
      { name: 'OldFacet', address: addr(1), selectors: [sel(1), sel(2)] },
    ])
  })

  it('classifies a source-present, target-absent facet as drift, never a removal', () => {
    const diff = diffFacets({
      ...base,
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: { [addr(1)]: 'LiveButUnrecordedFacet' },
      expectedNames: new Set(), // not in target state
      protectedNames: new Set(),
      activeSelectors: new Set(),
      sourceNames: new Set(['LiveButUnrecordedFacet']), // source still exists
    })
    expect(diff.driftDetected).toEqual(['LiveButUnrecordedFacet'])
    expect(diff.removals).toHaveLength(0)
  })

  it('keeps active facets and skips protected facets', () => {
    const diff = diffFacets({
      ...base,
      onChainFacets: [
        { address: addr(1), selectors: [sel(1)] },
        { address: addr(2), selectors: [sel(2)] },
      ],
      addressToName: { [addr(1)]: 'ActiveFacet', [addr(2)]: 'DiamondCutFacet' },
      expectedNames: new Set(['ActiveFacet', 'DiamondCutFacet']),
      protectedNames: new Set(['DiamondCutFacet']),
      activeSelectors: new Set(),
    })
    expect(diff.removals).toHaveLength(0)
    expect(diff.protectedSkipped).toEqual(['DiamondCutFacet'])
    expect(diff.targetStateMissingProtected).toHaveLength(0)
  })

  it('records targetStateMissingProtected when a protected facet was dropped from target state', () => {
    const diff = diffFacets({
      ...base,
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: { [addr(1)]: 'OwnershipFacet' },
      expectedNames: new Set(), // dropped from target state — a bug
      protectedNames: new Set(['OwnershipFacet']),
      activeSelectors: new Set(),
    })
    expect(diff.protectedSkipped).toEqual(['OwnershipFacet'])
    expect(diff.targetStateMissingProtected).toEqual(['OwnershipFacet'])
    expect(diff.removals).toHaveLength(0)
  })

  it('reports unresolved on-chain addresses and never removes them', () => {
    const diff = diffFacets({
      ...base,
      onChainFacets: [{ address: addr(9), selectors: [sel(1)] }],
      addressToName: {},
      expectedNames: new Set(),
      protectedNames: new Set(),
      activeSelectors: new Set(),
    })
    expect(diff.unresolved).toEqual([addr(9)])
    expect(diff.removals).toHaveLength(0)
  })

  it('holds back selectors an active facet is expected to own (partial removal)', () => {
    const diff = diffFacets({
      ...base,
      onChainFacets: [{ address: addr(1), selectors: [sel(0xaa), sel(0xbb)] }],
      addressToName: { [addr(1)]: 'StaleFacet' },
      expectedNames: new Set(),
      protectedNames: new Set(),
      activeSelectors: new Set([sel(0xaa)]), // still owned by an active facet
    })
    expect(diff.heldBackSelectors).toEqual([
      { facet: 'StaleFacet', selectors: [sel(0xaa)] },
    ])
    expect(diff.removals).toEqual([
      { name: 'StaleFacet', address: addr(1), selectors: [sel(0xbb)] },
    ])
  })

  it('emits no removal when every selector is held back', () => {
    const diff = diffFacets({
      ...base,
      onChainFacets: [{ address: addr(1), selectors: [sel(0xaa)] }],
      addressToName: { [addr(1)]: 'StaleFacet' },
      expectedNames: new Set(),
      protectedNames: new Set(),
      activeSelectors: new Set([sel(0xaa)]),
    })
    expect(diff.heldBackSelectors).toHaveLength(1)
    expect(diff.removals).toHaveLength(0)
  })
})

describe('computeFacetRemovalDiff', () => {
  it('returns an empty diff when the network has no LiFiDiamond', async () => {
    const diff = await computeFacetRemovalDiff('mainnet', PROD, {
      getDiamondAddress: async () => undefined,
    })
    expect(diff.diamondAddress).toBeUndefined()
    expect(diff.removals).toHaveLength(0)
  })

  it('orchestrates the diff and passes only active names to getActiveSelectors', async () => {
    let activeNamesSeen: string[] = []
    const io: Partial<IRemovalDiffIO> = {
      getDiamondAddress: async () => addr(0xd),
      getOnChainFacets: async (): Promise<IOnChainFacet[]> => [
        { address: addr(1), selectors: [sel(1)] }, // active
        { address: addr(2), selectors: [sel(2)] }, // stale -> removal
        { address: addr(3), selectors: [sel(3)] }, // unresolved
      ],
      getAddressToName: async () => ({
        [addr(1)]: 'ActiveFacet',
        [addr(2)]: 'StaleFacet',
      }),
      getExpectedNames: () => new Set(['ActiveFacet']),
      getActiveSelectors: (names) => {
        activeNamesSeen = names
        return new Set()
      },
      getSourceNames: () => new Set(), // StaleFacet source deleted → removable
    }
    const diff = await computeFacetRemovalDiff('mainnet', PROD, io)
    expect(activeNamesSeen).toEqual(['ActiveFacet'])
    expect(diff.removals).toEqual([
      { name: 'StaleFacet', address: addr(2), selectors: [sel(2)] },
    ])
    expect(diff.unresolved).toEqual([addr(3)])
    expect(diff.diamondAddress).toBe(addr(0xd))
  })
})

describe('getSourceContractNames', () => {
  it('collects .sol basenames recursively from the real src tree', () => {
    const names = getSourceContractNames()
    expect(names.has('LiFiDiamond')).toBe(true)
    expect(names.has('DiamondCutFacet')).toBe(true)
  })

  it('returns an empty set for a non-existent directory', () => {
    expect(getSourceContractNames('does-not-exist-xyz').size).toBe(0)
  })
})

describe('deploy-log resolvers (injected loader)', () => {
  it('resolveDiamondAddress checksums a present address', async () => {
    const a = await resolveDiamondAddress('x', PROD, async () => ({
      LiFiDiamond: '0xabcdef0000000000000000000000000000000001',
    }))
    expect(a).toBe('0xaBCdEf0000000000000000000000000000000001')
  })

  it('resolveDiamondAddress returns undefined when absent', async () => {
    const a = await resolveDiamondAddress('x', PROD, async () => ({}))
    expect(a).toBeUndefined()
  })

  it('resolveAddressToName inverts the loaded log', async () => {
    const map = await resolveAddressToName('x', PROD, async () => ({
      Foo: addr(7),
    }))
    expect(map[addr(7)]).toBe('Foo')
  })

  it('resolves the real mainnet LiFiDiamond address from the deploy log', async () => {
    const a = await resolveDiamondAddress('mainnet', PROD)
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/)
    const map = await resolveAddressToName('mainnet', PROD)
    expect(Object.keys(map).length).toBeGreaterThan(0)
  })
})
