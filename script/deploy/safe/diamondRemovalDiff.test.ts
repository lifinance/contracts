// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { EnvironmentEnum } from '../../common/types'
import { buildDiamondCutRemoveCalldata } from '../../utils/viemScriptHelpers'

import {
  buildAddressToName,
  buildRemovalSnapshotFromPayloads,
  collectActiveSelectors,
  computeFacetRemovalDiff,
  computeFacetRemovalsByAddress,
  computeNamedFacetRemovals,
  diffFacets,
  diffFacetsByAddress,
  diffNamedFacets,
  extractRemoveFacetCuts,
  fetchOnChainFacets,
  describeStaleRemovals,
  filterRePointedRemovals,
  getExpectedFacetNames,
  getFacetSourceNames,
  getProtectedNames,
  getSourceContractNames,
  createArtifactBuilder,
  tryCollectFacetSelectorUnion,
  HARDCODED_PROTECTED_FACETS,
  mapLoupeResult,
  resolveAddressToName,
  resolveDiamondAddress,
  revalidateRemovalsOnChain,
  type IAddressRemovalResult,
  type IFacetRemoval,
  type IOnChainFacet,
  type IRemovalDiffIO,
} from './diamondRemovalDiff'

const addr = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`
const sel = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(8, '0')}` as `0x${string}`

/**
 * Asserts `promise` rejects with an error whose message matches `match`. Kept as
 * a helper (rather than `expect().rejects`) so the awaited value is a real
 * Promise — `@typescript-eslint/await-thenable` rejects awaiting bun's matcher.
 */
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
    expect(names).toBeDefined()
    expect(names?.has('DiamondCutFacet')).toBe(true)
    expect(names?.size).toBeGreaterThan(0)
  })

  it('returns undefined for an unknown network (distinct from an empty block)', () => {
    expect(getExpectedFacetNames('not-a-network', PROD)).toBeUndefined()
  })
})

describe('getFacetSourceNames', () => {
  it('collects facet basenames from the real src/Facets tree', () => {
    const names = getFacetSourceNames()
    expect(names.has('DiamondCutFacet')).toBe(true)
    expect(names.has('GasZipFacet')).toBe(true)
    // periphery/util lives under src/Periphery, not src/Facets → excluded
    expect(names.has('GasZipPeriphery')).toBe(false)
    expect(names.has('Executor')).toBe(false)
  })
})

describe('collectActiveSelectors', () => {
  it('unions selectors and lowercases them across facets', () => {
    const selectorsOf = (name: string): `0x${string}`[] => {
      if (name === 'A') return [sel(0xaa), sel(0xbb)]
      if (name === 'B') return [sel(0xbb)] // duplicate across facets
      return []
    }
    const set = collectActiveSelectors(['A', 'B'], selectorsOf)
    expect(set.has(sel(0xaa))).toBe(true)
    expect(set.has(sel(0xbb))).toBe(true)
    expect(set.size).toBe(2)
  })

  it('fails closed: throws when an active facet has no readable artifact', () => {
    const selectorsOf = (name: string): `0x${string}`[] => {
      if (name === 'Present') return [sel(0xaa)]
      throw new Error('Contract JSON not found')
    }
    expect(() =>
      collectActiveSelectors(['Present', 'MissingArtifact'], selectorsOf)
    ).toThrow(/MissingArtifact/)
  })

  it('returns empty for no names', () => {
    expect(collectActiveSelectors([], () => []).size).toBe(0)
  })
})

describe('createArtifactBuilder', () => {
  it('reports availability after a successful build and does not build twice', () => {
    let runs = 0
    const ensure = createArtifactBuilder(() => {
      runs++
    })
    expect(ensure()).toBe(true)
    expect(ensure()).toBe(true)
    expect(runs).toBe(1)
  })

  it('reports unavailable when the build throws, and does not retry it', () => {
    let runs = 0
    const ensure = createArtifactBuilder(() => {
      runs++
      throw new Error('forge: command not found')
    })
    expect(ensure()).toBe(false)
    expect(ensure()).toBe(false)
    expect(runs).toBe(1)
  })
})

describe('tryCollectFacetSelectorUnion', () => {
  it('compiles and re-reads when an artifact is missing', () => {
    let built = false
    let reads = 0
    const union = tryCollectFacetSelectorUnion(['A'], {
      getFacetNames: () => new Set(['A']),
      getActiveSelectors: () => {
        reads++
        if (!built) throw new Error('Contract JSON not found')
        return new Set([sel(0xaa)])
      },
      ensureArtifacts: () => {
        built = true
        return true
      },
    })
    expect(reads).toBe(2)
    expect(union).toEqual(new Set([sel(0xaa)]))
  })

  it('stays unavailable when the build cannot produce the artifact', () => {
    let reads = 0
    const union = tryCollectFacetSelectorUnion(['A'], {
      getFacetNames: () => new Set(['A']),
      getActiveSelectors: () => {
        reads++
        throw new Error('Contract JSON not found')
      },
      ensureArtifacts: () => false,
    })
    expect(union).toBeUndefined()
    expect(reads).toBe(1)
  })

  it('does not compile when the union reads on the first try', () => {
    let builds = 0
    const union = tryCollectFacetSelectorUnion(['A'], {
      getFacetNames: () => new Set(['A']),
      getActiveSelectors: () => new Set([sel(0xaa)]),
      ensureArtifacts: () => {
        builds++
        return true
      },
    })
    expect(union).toEqual(new Set([sel(0xaa)]))
    expect(builds).toBe(0)
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

  it('protects every target-state facet — including a not-yet-routed replacement — via getActiveSelectors', async () => {
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
      // ReplacementFacet is expected by target state but not yet routed on-chain;
      // its selectors must still be protected from a concurrent removal.
      getExpectedNames: () => new Set(['ActiveFacet', 'ReplacementFacet']),
      getActiveSelectors: (names) => {
        activeNamesSeen = names
        return new Set()
      },
      getSourceNames: () => new Set(), // StaleFacet source deleted → removable
      getFacetNames: () => new Set(['ActiveFacet', 'ReplacementFacet']),
    }
    const diff = await computeFacetRemovalDiff('mainnet', PROD, io)
    expect([...activeNamesSeen].sort()).toEqual([
      'ActiveFacet',
      'ReplacementFacet',
    ])
    expect(diff.removals).toEqual([
      { name: 'StaleFacet', address: addr(2), selectors: [sel(2)] },
    ])
    expect(diff.unresolved).toEqual([addr(3)])
    expect(diff.diamondAddress).toBe(addr(0xd))
  })

  it('throws when the network has a diamond but no target-state entry', async () => {
    const io: Partial<IRemovalDiffIO> = {
      getDiamondAddress: async () => addr(0xd),
      getOnChainFacets: async () => [{ address: addr(1), selectors: [sel(1)] }],
      getAddressToName: async () => ({ [addr(1)]: 'SomeFacet' }),
      getExpectedNames: () => undefined, // network absent from target state
    }
    await expectRejects(
      computeFacetRemovalDiff('mainnet', PROD, io),
      /no LiFiDiamond target-state entry/
    )
  })

  it('scopes active-selectors to real facets — periphery names never hold back selectors', async () => {
    let activeNamesSeen: string[] = []
    const io: Partial<IRemovalDiffIO> = {
      getDiamondAddress: async () => addr(0xd),
      getOnChainFacets: async () => [
        { address: addr(2), selectors: [sel(2)] }, // stale facet, removable
      ],
      getAddressToName: async () => ({ [addr(2)]: 'StaleFacet' }),
      // target state lists a facet AND a periphery contract
      getExpectedNames: () => new Set(['GasZipFacet', 'GasZipPeriphery']),
      getActiveSelectors: (names) => {
        activeNamesSeen = names
        return new Set()
      },
      getSourceNames: () => new Set(),
      getFacetNames: () => new Set(['GasZipFacet']), // only the facet is a real facet
    }
    await computeFacetRemovalDiff('mainnet', PROD, io)
    // periphery name filtered out before reaching getActiveSelectors
    expect(activeNamesSeen).toEqual(['GasZipFacet'])
  })
})

describe('diffNamedFacets', () => {
  const base = {
    network: 'net',
    environment: PROD,
    diamondAddress: addr(0xd),
  }

  it('removes a requested facet that is registered on-chain', () => {
    const r = diffNamedFacets({
      ...base,
      requestedNames: new Set(['OldFacet']),
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: { [addr(1)]: 'OldFacet' },
      protectedNames: new Set(),
    })
    expect(r.removals).toEqual([
      { name: 'OldFacet', address: addr(1), selectors: [sel(1)] },
    ])
    expect(r.notFoundOnChain).toHaveLength(0)
  })

  it('refuses a requested facet on the never-remove allowlist', () => {
    const r = diffNamedFacets({
      ...base,
      requestedNames: new Set(['DiamondCutFacet']),
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: { [addr(1)]: 'DiamondCutFacet' },
      protectedNames: new Set(['DiamondCutFacet']),
    })
    expect(r.protectedSkipped).toEqual(['DiamondCutFacet'])
    expect(r.removals).toHaveLength(0)
  })

  it('reports requested names that are not on-chain', () => {
    const r = diffNamedFacets({
      ...base,
      requestedNames: new Set(['Absent']),
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: { [addr(1)]: 'SomethingElse' },
      protectedNames: new Set(),
    })
    expect(r.notFoundOnChain).toEqual(['Absent'])
    expect(r.removals).toHaveLength(0)
  })

  it('surfaces on-chain-but-unmapped addresses as unresolved (not silently dropped)', () => {
    const r = diffNamedFacets({
      ...base,
      requestedNames: new Set(['OldFacet']),
      onChainFacets: [
        { address: addr(1), selectors: [sel(1)] }, // in log → mapped
        { address: addr(9), selectors: [sel(9)] }, // NOT in deploy log
      ],
      addressToName: { [addr(1)]: 'SomethingElse' },
      protectedNames: new Set(),
    })
    expect(r.unresolved).toEqual([addr(9)])
    // OldFacet may be the unlogged address — must not be flatly "not on chain"
    expect(r.notFoundOnChain).toEqual(['OldFacet'])
    expect(r.removals).toHaveLength(0)
  })

  it('cannot distinguish two co-registered versions — the reason the queue is address-keyed', () => {
    const r = diffNamedFacets({
      ...base,
      requestedNames: new Set(['SymbiosisFacet']),
      onChainFacets: [
        { address: addr(1), selectors: [sel(1)] }, // v2.0.0, live, owns the log name
        { address: addr(9), selectors: [sel(9)] }, // v1.0.0, superseded, unlogged
      ],
      addressToName: { [addr(1)]: 'SymbiosisFacet' },
      protectedNames: new Set(),
    })
    // The LIVE facet is what a name resolves to; the stale one is merely surfaced.
    expect(r.removals).toEqual([
      { name: 'SymbiosisFacet', address: addr(1), selectors: [sel(1)] },
    ])
    expect(r.unresolved).toEqual([addr(9)])
  })
})

describe('diffFacetsByAddress', () => {
  const base = {
    network: 'net',
    environment: PROD,
    diamondAddress: addr(0xd),
    // Explicit "nothing is protected/expected"; the unavailable case is undefined, tested below.
    protectedSelectors: new Set<string>(),
    expectedNames: new Set<string>(),
    activeSelectors: new Set<string>(),
  }

  it('removes exactly the requested address, using its live loupe selectors', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(1)]),
      onChainFacets: [
        { address: addr(1), selectors: [sel(1), sel(2)] },
        { address: addr(2), selectors: [sel(3)] },
      ],
      addressToName: { [addr(1)]: 'OldFacet' },
      protectedNames: new Set(),
    })
    expect(r.removals).toEqual([
      { name: 'OldFacet', address: addr(1), selectors: [sel(1), sel(2)] },
    ])
    expect(r.notFoundOnChain).toHaveLength(0)
  })

  it('removes a superseded version while leaving its live successor registered under the same name', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(9)]), // SymbiosisFacet v1.0.0
      onChainFacets: [
        { address: addr(1), selectors: [sel(1)] }, // v2.0.0 — live, owns the log name
        { address: addr(9), selectors: [sel(9)] }, // v1.0.0 — superseded, unlogged
      ],
      addressToName: { [addr(1)]: 'SymbiosisFacet' },
      protectedNames: new Set(),
    })
    expect(r.removals).toEqual([
      { name: undefined, address: addr(9), selectors: [sel(9)] },
    ])
    expect(r.removals.map((x) => x.address)).not.toContain(addr(1))
  })

  it('removes an address the deploy log never listed (no name to resolve)', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(9)]),
      onChainFacets: [{ address: addr(9), selectors: [sel(1)] }],
      addressToName: {},
      protectedNames: new Set(),
    })
    expect(r.removals).toEqual([
      { name: undefined, address: addr(9), selectors: [sel(1)] },
    ])
  })

  it('matches the loupe case-insensitively', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([
        addr(1).toUpperCase().replace('0X', '0x') as `0x${string}`,
      ]),
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: {},
      protectedNames: new Set(),
    })
    expect(r.removals).toHaveLength(1)
    expect(r.notFoundOnChain).toHaveLength(0)
  })

  it('refuses an address the log maps to a never-remove facet', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(1)]),
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: { [addr(1)]: 'DiamondCutFacet' },
      protectedNames: new Set(['DiamondCutFacet']),
    })
    expect(r.protectedSkipped).toEqual([
      { name: 'DiamondCutFacet', address: addr(1) },
    ])
    expect(r.removals).toHaveLength(0)
  })

  it('reports requested addresses that are not registered on this diamond', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(9)]),
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: {},
      protectedNames: new Set(),
    })
    expect(r.notFoundOnChain).toEqual([addr(9)])
    expect(r.removals).toHaveLength(0)
  })

  it('refuses an UNLOGGED address that holds a protected facet selector', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(9)]),
      onChainFacets: [{ address: addr(9), selectors: [sel(0xc), sel(1)] }],
      addressToName: {}, // the log cannot name it, so the name check cannot fire
      protectedNames: new Set(['DiamondCutFacet']),
      protectedSelectors: new Set([sel(0xc)]),
    })
    expect(r.removals).toHaveLength(0)
    expect(r.protectedSkipped).toEqual([
      {
        name: `unknown (address not in deploy log, holds protected selector ${sel(
          0xc
        )})`,
        address: addr(9),
      },
    ])
  })

  it('reports an UNLOGGED address as unverifiable when the protected union is unavailable', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(9)]),
      onChainFacets: [{ address: addr(9), selectors: [sel(1)] }],
      addressToName: {},
      protectedNames: new Set(['DiamondCutFacet']),
      protectedSelectors: undefined, // e.g. a missing artifact — cannot verify
    })
    expect(r.removals).toHaveLength(0)
    // NOT protectedSkipped: the drain cancels that set (terminal, "parked in
    // error"), which would retire a legitimate task over a missing artifact.
    expect(r.protectedSkipped).toHaveLength(0)
    expect(r.unverifiable).toEqual([addr(9)])
  })

  it('still removes an unlogged address whose selectors are not protected', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(9)]),
      onChainFacets: [{ address: addr(9), selectors: [sel(9)] }],
      addressToName: {},
      protectedNames: new Set(['DiamondCutFacet']),
      protectedSelectors: new Set([sel(0xc)]),
    })
    expect(r.removals).toEqual([
      { name: undefined, address: addr(9), selectors: [sel(9)] },
    ])
  })

  it('reports the deploy-log names the loupe routes, for the suspect-snapshot check', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(9)]),
      onChainFacets: [
        { address: addr(1), selectors: [sel(1)] },
        { address: addr(2), selectors: [sel(2)] },
      ],
      addressToName: { [addr(1)]: 'AcrossFacetV3' },
      protectedNames: new Set(),
    })
    expect(r.routedNames).toEqual(new Set(['AcrossFacetV3']))
    expect(r.notFoundOnChain).toEqual([addr(9)])
  })

  it('leaves unrequested on-chain facets untouched', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(1)]),
      onChainFacets: [
        { address: addr(1), selectors: [sel(1)] },
        { address: addr(2), selectors: [sel(2)] },
      ],
      addressToName: {},
      protectedNames: new Set(),
    })
    expect(r.removals).toHaveLength(1)
    expect(r.removals[0]?.address).toBe(addr(1))
  })

  it('refuses an address the deploy log names as a facet target state still expects', () => {
    // The wrong-snapshot shape: the parked address points at the LIVE facet.
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(1)]),
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: { [addr(1)]: 'GenericSwapFacetV3' },
      protectedNames: new Set(),
      expectedNames: new Set(['GenericSwapFacetV3']),
    })
    expect(r.removals).toHaveLength(0)
    expect(r.stillExpected).toHaveLength(1)
    expect(r.stillExpected[0]?.name).toBe('GenericSwapFacetV3')
  })

  it('refuses an UNLOGGED address that routes a selector an expected facet owns', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(9)]),
      onChainFacets: [{ address: addr(9), selectors: [sel(5)] }],
      addressToName: {},
      protectedNames: new Set(),
      activeSelectors: new Set([sel(5)]),
    })
    expect(r.removals).toHaveLength(0)
    expect(r.stillExpected).toHaveLength(1)
    expect(r.stillExpected[0]?.address).toBe(addr(9))
  })

  it('reports a LOGGED non-protected address as unverifiable without a target-state entry', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(1)]),
      onChainFacets: [{ address: addr(1), selectors: [sel(1)] }],
      addressToName: { [addr(1)]: 'OldFacet' },
      protectedNames: new Set(),
      expectedNames: undefined,
    })
    expect(r.removals).toHaveLength(0)
    expect(r.unverifiable).toEqual([addr(1)])
  })

  it('reports an UNLOGGED address as unverifiable when the active union is unavailable', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(9)]),
      onChainFacets: [{ address: addr(9), selectors: [sel(1)] }],
      addressToName: {},
      protectedNames: new Set(),
      activeSelectors: undefined,
    })
    expect(r.removals).toHaveLength(0)
    expect(r.unverifiable).toEqual([addr(9)])
  })

  it('refuses a LOGGED deprecated facet that still routes a selector an expected facet owns', () => {
    // Same held-back rule as diffFacets: the replacement's Add has not landed yet,
    // so sweeping the shared selector out would break it until the cut ships.
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set([addr(1)]),
      onChainFacets: [{ address: addr(1), selectors: [sel(1), sel(5)] }],
      addressToName: { [addr(1)]: 'OldFacet' },
      protectedNames: new Set(),
      expectedNames: new Set(['ReplacementFacet']),
      activeSelectors: new Set([sel(5)]),
    })
    expect(r.removals).toHaveLength(0)
    expect(r.stillExpected).toHaveLength(1)
    expect(r.stillExpected[0]?.name).toBe('OldFacet')
  })

  it('resolves the real co-registered SymbiosisFacet shape (EXSC-750 mainnet data)', () => {
    // Live v2.0.0 is logged and owns 0xe23b7a08/0xc46059b2; superseded v1.0.0 is
    // unlogged and routes 0xb70fb9a5/0x6e067161 — the queue's core use case.
    const LIVE = '0xa0353221443ca4e2e6a040f30a57b47f5a6d479d' as `0x${string}`
    const STALE = '0x23Fc1b73Ff1B0f9C1e4A0B8dD5B0d0c0A0e0F000' as `0x${string}`
    const params = {
      ...base,
      onChainFacets: [
        {
          address: LIVE,
          selectors: ['0xe23b7a08', '0xc46059b2'] as `0x${string}`[],
        },
        {
          address: STALE,
          selectors: ['0xb70fb9a5', '0x6e067161'] as `0x${string}`[],
        },
      ],
      addressToName: { [LIVE]: 'SymbiosisFacet' },
      protectedNames: new Set(['DiamondCutFacet']),
      expectedNames: new Set(['SymbiosisFacet']),
      protectedSelectors: new Set<string>(),
      activeSelectors: new Set(['0xe23b7a08', '0xc46059b2']),
    }
    // The stale version is removable; the live one is refused as stillExpected.
    const stale = diffFacetsByAddress({
      ...params,
      requestedAddresses: new Set([STALE]),
    })
    expect(stale.removals.map((r) => r.address)).toEqual([STALE])
    const live = diffFacetsByAddress({
      ...params,
      requestedAddresses: new Set([LIVE]),
    })
    expect(live.removals).toHaveLength(0)
    expect(live.stillExpected[0]?.name).toBe('SymbiosisFacet')
  })

  it('exposes the loupe addresses so callers need no second read', () => {
    const r = diffFacetsByAddress({
      ...base,
      requestedAddresses: new Set<`0x${string}`>(),
      onChainFacets: [
        { address: addr(1), selectors: [sel(1)] },
        { address: addr(2), selectors: [sel(2)] },
      ],
      addressToName: {},
      protectedNames: new Set(),
    })
    expect(r.routedAddresses).toEqual(new Set([addr(1), addr(2)]))
  })
})

describe('computeNamedFacetRemovals', () => {
  it('returns all names as notFoundOnChain when the diamond is absent', async () => {
    const r = await computeNamedFacetRemovals('net', PROD, ['A', 'B'], {
      getDiamondAddress: async () => undefined,
    })
    expect(r.notFoundOnChain).toEqual(['A', 'B'])
    expect(r.removals).toHaveLength(0)
  })

  it('resolves named removals against the loupe', async () => {
    const r = await computeNamedFacetRemovals('net', PROD, ['OldFacet'], {
      getDiamondAddress: async () => addr(0xd),
      getOnChainFacets: async () => [
        { address: addr(1), selectors: [sel(1), sel(2)] },
      ],
      getAddressToName: async () => ({ [addr(1)]: 'OldFacet' }),
    })
    expect(r.diamondAddress).toBe(addr(0xd))
    expect(r.removals).toEqual([
      { name: 'OldFacet', address: addr(1), selectors: [sel(1), sel(2)] },
    ])
  })
})

describe('computeFacetRemovalsByAddress', () => {
  it('flags an unresolvable diamond instead of reporting the addresses absent', async () => {
    const r = await computeFacetRemovalsByAddress(
      'net',
      PROD,
      [addr(1), addr(2)],
      { getDiamondAddress: async () => undefined }
    )
    // No chain read happened, so nothing may be reported as gone — the drain
    // supersedes on notFoundOnChain and would retire the whole queue.
    expect(r.diamondUnresolved).toBe(true)
    expect(r.notFoundOnChain).toEqual([])
    expect(r.removals).toHaveLength(0)
  })

  it('resolves address removals against the loupe', async () => {
    const r = await computeFacetRemovalsByAddress('net', PROD, [addr(9)], {
      getDiamondAddress: async () => addr(0xd),
      getOnChainFacets: async () => [
        { address: addr(1), selectors: [sel(1)] },
        { address: addr(9), selectors: [sel(9)] },
      ],
      getAddressToName: async () => ({ [addr(1)]: 'SymbiosisFacet' }),
      getExpectedNames: () => new Set(['SymbiosisFacet']),
      getFacetNames: () => new Set(['DiamondCutFacet']),
      getActiveSelectors: () => new Set([sel(0xc)]),
    })
    expect(r.diamondAddress).toBe(addr(0xd))
    expect(r.removals).toEqual([
      { name: undefined, address: addr(9), selectors: [sel(9)] },
    ])
  })

  it('lands every address in unverifiable when the network has no target-state entry', async () => {
    const r = await computeFacetRemovalsByAddress('net', PROD, [addr(9)], {
      getDiamondAddress: async () => addr(0xd),
      getOnChainFacets: async () => [{ address: addr(9), selectors: [sel(9)] }],
      getAddressToName: async () => ({}),
      getExpectedNames: () => undefined,
      getFacetNames: () => new Set(['DiamondCutFacet']),
      getActiveSelectors: () => new Set([sel(0xc)]),
    })
    expect(r.removals).toHaveLength(0)
    expect(r.unverifiable).toEqual([addr(9)])
  })

  /**
   * The EXSC-912 shape: a superseded facet co-registered alongside its successor
   * (EXSC-750), so the deploy log names only the successor and the doomed address
   * resolves by selector alone — against a union no artifact was there to build.
   *
   * @param rebuiltSelectors - The union once the build has run.
   */
  const uncompiledIncident = async (
    rebuiltSelectors: Set<`0x${string}`>
  ): Promise<{ result: IAddressRemovalResult; builds: number }> => {
    let builds = 0
    const result = await computeFacetRemovalsByAddress('net', PROD, [addr(9)], {
      getDiamondAddress: async () => addr(0xd),
      getOnChainFacets: async () => [
        { address: addr(9), selectors: [sel(9)] },
        { address: addr(0x42), selectors: [sel(0xc)] },
      ],
      getAddressToName: async () => ({ [addr(0x42)]: 'SymbiosisFacet' }),
      getExpectedNames: () => new Set(['SymbiosisFacet']),
      getFacetNames: () => new Set(['SymbiosisFacet']),
      getActiveSelectors: (names) => {
        // The protected union reads no artifact here (no protected name is a
        // facet in this fixture), so only the target-state union hits the gap.
        if (names.length === 0) return new Set<string>()
        if (builds === 0) throw new Error('Contract JSON not found')
        return rebuiltSelectors
      },
      ensureArtifacts: () => {
        builds++
        return true
      },
    })
    return { result, builds }
  }

  it('removes the superseded address once the build supplies the union', async () => {
    const { result, builds } = await uncompiledIncident(new Set([sel(0xc)]))
    expect(builds).toBe(1)
    expect(result.unverifiable).toHaveLength(0)
    expect(result.removals).toEqual([
      { name: undefined, address: addr(9), selectors: [sel(9)] },
    ])
  })

  it('holds the same address back when the rebuilt union claims its selector', async () => {
    // The build's own output decides the verdict — not merely whether one exists.
    const { result } = await uncompiledIncident(new Set([sel(9)]))
    expect(result.removals).toHaveLength(0)
    expect(result.unverifiable).toHaveLength(0)
    expect(result.stillExpected).toHaveLength(1)
    expect(result.stillExpected[0]?.address).toBe(addr(9))
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

describe('filterRePointedRemovals', () => {
  const snapshot: IFacetRemoval[] = [
    { name: 'OldFacet', address: addr(2), selectors: [sel(1), sel(2), sel(3)] },
  ]

  it('keeps selectors that still route to the doomed facet', () => {
    const r = filterRePointedRemovals(snapshot, [
      { address: addr(2), selectors: [sel(1), sel(2), sel(3)] },
    ])
    expect(r.stale).toHaveLength(0)
    expect(r.stillRemovable).toEqual(snapshot)
  })

  it('drops a selector re-pointed to a different (live) facet', () => {
    const r = filterRePointedRemovals(snapshot, [
      { address: addr(2), selectors: [sel(1), sel(3)] },
      { address: addr(7), selectors: [sel(2)] }, // sel(2) re-pointed to a live facet
    ])
    expect(r.stillRemovable).toEqual([
      { name: 'OldFacet', address: addr(2), selectors: [sel(1), sel(3)] },
    ])
    expect(r.stale).toEqual([
      {
        facet: 'OldFacet',
        selector: sel(2),
        reason: 're-pointed',
        currentAddress: addr(7),
      },
    ])
  })

  it('drops a selector already removed on-chain (would revert)', () => {
    const r = filterRePointedRemovals(snapshot, [
      { address: addr(2), selectors: [sel(1), sel(2)] }, // sel(3) gone
    ])
    expect(r.stillRemovable).toEqual([
      { name: 'OldFacet', address: addr(2), selectors: [sel(1), sel(2)] },
    ])
    expect(r.stale).toEqual([
      { facet: 'OldFacet', selector: sel(3), reason: 'already-gone' },
    ])
  })

  it('emits no removal when every snapshot selector is stale', () => {
    const r = filterRePointedRemovals(snapshot, [
      { address: addr(7), selectors: [sel(1), sel(2), sel(3)] },
    ])
    expect(r.stillRemovable).toHaveLength(0)
    expect(r.stale).toHaveLength(3)
  })
})

describe('describeStaleRemovals', () => {
  const snapshot: IFacetRemoval[] = [
    { name: 'AcrossFacetV3', address: addr(2), selectors: [sel(1), sel(2)] },
  ]

  // The EXSC-816 shape: an old AcrossFacetV3 was replaced, so every snapshotted
  // selector now routes to the live successor and the Remove removes nothing.
  it('flags a removal whose every selector has moved on as fully obsolete', () => {
    const revalidated = filterRePointedRemovals(snapshot, [
      { address: addr(7), selectors: [sel(1), sel(2)] },
    ])
    const d = describeStaleRemovals(revalidated)
    expect(d.fullyObsolete).toBe(true)
    expect(d.detail).toContain('AcrossFacetV3')
    expect(d.detail).toContain('re-pointed')
    expect(d.remediation).toContain('no-op')
    expect(d.remediation).toContain('re-propose the primary cut(s) alone')
  })

  it('flags a partially stale removal as needing a re-draft, not obsolete', () => {
    const revalidated = filterRePointedRemovals(snapshot, [
      { address: addr(2), selectors: [sel(1)] },
      { address: addr(7), selectors: [sel(2)] },
    ])
    const d = describeStaleRemovals(revalidated)
    expect(d.fullyObsolete).toBe(false)
    expect(d.remediation).toContain('fresh loupe drain')
  })

  // Re-pointing was the intuitive-but-wrong remediation: those selectors route
  // to a live facet, and Remove zeroes them regardless of owner.
  it('warns against re-pointing in both shapes', () => {
    const obsolete = describeStaleRemovals(
      filterRePointedRemovals(snapshot, [
        { address: addr(7), selectors: [sel(1), sel(2)] },
      ])
    )
    const partial = describeStaleRemovals(
      filterRePointedRemovals(snapshot, [
        { address: addr(2), selectors: [sel(1)] },
        { address: addr(7), selectors: [sel(2)] },
      ])
    )
    for (const d of [obsolete, partial])
      expect(d.remediation).toMatch(/Do NOT re-point/)
  })

  it('renders already-gone selectors without a current address', () => {
    const revalidated = filterRePointedRemovals(snapshot, [
      { address: addr(2), selectors: [sel(1)] },
    ])
    const d = describeStaleRemovals(revalidated)
    expect(d.fullyObsolete).toBe(false)
    expect(d.detail).toBe(`AcrossFacetV3:${sel(2)} (already-gone)`)
  })

  // Guards against emitting one of the two staleness remediations for an input
  // that has no stale selectors at all.
  it('reports no staleness without claiming any selector is stale', () => {
    const d = describeStaleRemovals({ stillRemovable: snapshot, stale: [] })
    expect(d.fullyObsolete).toBe(false)
    expect(d.detail).toBe('')
    expect(d.remediation).toBe(
      'No stale folded removal selectors were detected.'
    )
    expect(d.remediation).not.toMatch(/cancel this op/)
  })

  // An empty snapshot has nothing removable, which must not be mistaken for
  // "every selector moved on".
  it('does not call an empty snapshot fully obsolete', () => {
    const d = describeStaleRemovals({ stillRemovable: [], stale: [] })
    expect(d.fullyObsolete).toBe(false)
    expect(d.remediation).not.toMatch(/no-op/)
  })
})

describe('revalidateRemovalsOnChain', () => {
  it('re-reads the loupe via injected reader and filters re-pointed selectors', async () => {
    const snapshot: IFacetRemoval[] = [
      { name: 'OldFacet', address: addr(2), selectors: [sel(1), sel(2)] },
    ]
    const r = await revalidateRemovalsOnChain('mainnet', addr(0xd), snapshot, {
      getOnChainFacets: async (): Promise<IOnChainFacet[]> => [
        { address: addr(2), selectors: [sel(1)] }, // sel(2) no longer here
        { address: addr(7), selectors: [sel(2)] }, // re-pointed
      ],
    })
    expect(r.stillRemovable).toEqual([
      { name: 'OldFacet', address: addr(2), selectors: [sel(1)] },
    ])
    expect(r.stale).toEqual([
      {
        facet: 'OldFacet',
        selector: sel(2),
        reason: 're-pointed',
        currentAddress: addr(7),
      },
    ])
  })
})

describe('extractRemoveFacetCuts / buildRemovalSnapshotFromPayloads', () => {
  it('extracts Remove cuts and ignores non-diamondCut payloads', () => {
    const remove = buildDiamondCutRemoveCalldata([
      { name: 'A', selectors: [sel(1), sel(2)] },
    ])
    const cuts = extractRemoveFacetCuts(['0x12345678' as `0x${string}`, remove])
    expect(cuts).toEqual([{ selectors: [sel(1), sel(2)] }])
  })

  it('returns none when there are no Remove cuts and no parked rows', () => {
    expect(buildRemovalSnapshotFromPayloads([], [])).toEqual({ kind: 'none' })
  })

  it('zips trailing Remove cuts with parked identities (drain append order)', () => {
    const primaryRemove = buildDiamondCutRemoveCalldata([
      { name: 'PrimaryGone', selectors: [sel(9)] },
    ])
    const foldedA = buildDiamondCutRemoveCalldata([
      { name: 'A', selectors: [sel(1)] },
    ])
    const foldedB = buildDiamondCutRemoveCalldata([
      { name: 'B', selectors: [sel(2), sel(3)] },
    ])
    const built = buildRemovalSnapshotFromPayloads(
      [primaryRemove, foldedA, foldedB],
      [
        { facetName: 'A', facetAddress: addr(2) },
        { facetName: 'B', facetAddress: addr(3) },
      ]
    )
    expect(built).toEqual({
      kind: 'snapshot',
      snapshot: [
        { name: 'A', address: addr(2), selectors: [sel(1)] },
        { name: 'B', address: addr(3), selectors: [sel(2), sel(3)] },
      ],
    })
  })

  it('signals unvalidated when Remove cuts exist without parked rows (execute aborts)', () => {
    const remove = buildDiamondCutRemoveCalldata([
      { name: 'Legacy', selectors: [sel(1)] },
    ])
    expect(buildRemovalSnapshotFromPayloads([remove], [])).toEqual({
      kind: 'unvalidated',
      removeCutCount: 1,
    })
  })

  it('signals mismatch when parked outnumber Remove cuts', () => {
    const remove = buildDiamondCutRemoveCalldata([
      { name: 'A', selectors: [sel(1)] },
    ])
    const built = buildRemovalSnapshotFromPayloads(
      [remove],
      [
        { facetName: 'A', facetAddress: addr(2) },
        { facetName: 'B', facetAddress: addr(3) },
      ]
    )
    expect(built.kind).toBe('mismatch')
  })

  it('signals mismatch when parked rows exist but payloads have no Remove cuts', () => {
    const built = buildRemovalSnapshotFromPayloads(
      [],
      [{ facetName: 'A', facetAddress: addr(2) }]
    )
    expect(built.kind).toBe('mismatch')
  })
})
