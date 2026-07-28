import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  evaluateFacetPeripheryCouplings,
  getFacetPeripheryCouplings,
  identifyCoupledFacetsOnChain,
  isValidFacetName,
  loadFacetSelectorsFromArtifact,
  resolveLiveFacets,
  type TFacetPeripheryCouplings,
} from './facetPeripheryCouplings'

const COUPLINGS: TFacetPeripheryCouplings = {
  AcrossFacetV4: { requiresAnyOf: ['ReceiverAcrossV4'] },
  AcrossFacetPackedV4: { requiresAnyOf: ['ReceiverAcrossV4'] },
  ChainflipFacet: {
    requiresAnyOf: ['ReceiverChainflip'],
    notRequiredOn: { SomeChain: 'Chainflip is source-only there (EXSC-000)' },
  },
  LiFiIntentEscrowFacetV2: { requiresAnyOf: ['ReceiverOIF'] },
}

describe('evaluateFacetPeripheryCouplings', () => {
  it('requires the companion when a coupled facet is present', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4'],
      'mainnet',
      COUPLINGS
    )

    expect(skipped).toEqual([])
    expect(required).toEqual([
      { triggeredBy: ['AcrossFacetV4'], requiresAnyOf: ['ReceiverAcrossV4'] },
    ])
  })

  it('merges facets that need the same companion into one requirement', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'AcrossFacetPackedV4'],
      'mainnet',
      COUPLINGS
    )

    expect(required).toHaveLength(1)
    expect(required[0]?.triggeredBy).toEqual([
      'AcrossFacetPackedV4',
      'AcrossFacetV4',
    ])
  })

  it('keeps facets with different companions as separate requirements', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'LiFiIntentEscrowFacetV2'],
      'mainnet',
      COUPLINGS
    )

    expect(required.map((r) => r.requiresAnyOf.join())).toEqual([
      'ReceiverAcrossV4',
      'ReceiverOIF',
    ])
  })

  it('ignores facets with no declared coupling', () => {
    expect(
      evaluateFacetPeripheryCouplings(
        ['GenericSwapFacetV3'],
        'mainnet',
        COUPLINGS
      )
    ).toEqual({ required: [], skipped: [] })
  })

  it('deduplicates a facet listed twice', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'AcrossFacetV4'],
      'mainnet',
      COUPLINGS
    )

    expect(required[0]?.triggeredBy).toEqual(['AcrossFacetV4'])
  })

  it('skips a facet carved out for this network, case-insensitively', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'somechain',
      COUPLINGS
    )

    expect(required).toEqual([])
    expect(skipped).toEqual([
      {
        facet: 'ChainflipFacet',
        requiresAnyOf: ['ReceiverChainflip'],
        reason: 'Chainflip is source-only there (EXSC-000)',
      },
    ])
  })

  it('still requires a carved-out facet on other networks', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'mainnet',
      COUPLINGS
    )

    expect(skipped).toEqual([])
    expect(required[0]?.requiresAnyOf).toEqual(['ReceiverChainflip'])
  })

  it('treats a declaration without requiresAnyOf as inert rather than throwing', () => {
    expect(
      evaluateFacetPeripheryCouplings(['AcrossFacetV4'], 'mainnet', {
        AcrossFacetV4: {} as TFacetPeripheryCouplings[string],
      })
    ).toEqual({ required: [], skipped: [] })
  })
})

describe('facetPeripheryCouplings registry in config/global.json', () => {
  const registry = getFacetPeripheryCouplings()

  it('is non-empty', () => {
    expect(Object.keys(registry).length).toBeGreaterThan(0)
  })

  it('keys are real facets and values are real periphery contracts', () => {
    for (const [facet, declaration] of Object.entries(registry)) {
      expect(
        Bun.file(`src/Facets/${facet}.sol`).size,
        `src/Facets/${facet}.sol must exist`
      ).toBeGreaterThan(0)

      expect(declaration.requiresAnyOf.length).toBeGreaterThan(0)
      for (const periphery of declaration.requiresAnyOf)
        expect(
          Bun.file(`src/Periphery/${periphery}.sol`).size,
          `${facet}: src/Periphery/${periphery}.sol must exist`
        ).toBeGreaterThan(0)
    }
  })

  it('gives every per-network carve-out a non-empty reason', () => {
    for (const declaration of Object.values(registry))
      for (const reason of Object.values(declaration.notRequiredOn ?? {}))
        expect(reason.length).toBeGreaterThan(0)
  })

  it('every registry key resolves to a build artifact with selectors (selector identity is viable)', () => {
    // resolveLiveFacets identifies coupled facets by their compiled selectors, so a registry key
    // that has no loadable artifact would silently fall back to deploy-log-only identity. Guard it.
    for (const facet of Object.keys(registry)) {
      const selectors = loadFacetSelectorsFromArtifact(facet)
      // Skipped, not failed, when out/ is absent (the TS unit-test job runs without forge build).
      if (selectors === null) continue
      expect(
        selectors.length,
        `${facet}: build artifact must expose at least one selector`
      ).toBeGreaterThan(0)
    }
  })

  it('covers every facet of an already-coupled family (guards a forgotten new variant)', () => {
    // The registry is an allowlist, so a new family member (e.g. a future AcrossFacetV5) would
    // otherwise be silently unchecked. Any facet sharing a coupled facet's bridge prefix must
    // itself be coupled — the deprecated AcrossFacet is the one documented exemption.
    const DEPRECATED_EXEMPT = ['AcrossFacet']
    const families = ['Across', 'Chainflip', 'LiFiIntentEscrow', 'Stargate']
    const facetsOnDisk = [...new Bun.Glob('*.sol').scanSync('src/Facets')].map(
      (f) => f.replace(/\.sol$/, '')
    )
    // Guard the guard: a broken glob would make the assertion below vacuously pass.
    expect(facetsOnDisk.length).toBeGreaterThan(20)

    const uncovered = facetsOnDisk.filter(
      (facet) =>
        families.some((family) => facet.startsWith(family)) &&
        !registry[facet] &&
        !DEPRECATED_EXEMPT.includes(facet)
    )

    expect(uncovered).toEqual([])
  })
})

describe('identifyCoupledFacetsOnChain', () => {
  // Injected loader — the suite never touches out/, so it is hermetic (the TS test job has no build).
  const SELECTORS: Record<string, string[]> = {
    AcrossFacetV4: ['0xaaaa0001', '0xaaaa0002'],
    StargateFacetV2: ['0xbbbb0001'],
  }
  const load = (name: string) => SELECTORS[name] ?? null

  it('identifies a facet whose full selector set is registered on chain, ignoring the deploy log', () => {
    const { live, unresolved } = identifyCoupledFacetsOnChain(
      [
        {
          address: '0xdead',
          selectors: ['0xAAAA0001', '0xaaaa0002', '0x99999999'],
        },
      ],
      ['AcrossFacetV4', 'StargateFacetV2'],
      load
    )

    expect(live).toEqual(['AcrossFacetV4'])
    expect(unresolved).toEqual([])
  })

  it('does not identify a facet when only part of its selector set is present', () => {
    const { live } = identifyCoupledFacetsOnChain(
      [{ address: '0xdead', selectors: ['0xaaaa0001'] }],
      ['AcrossFacetV4'],
      load
    )

    expect(live).toEqual([])
  })

  it('refuses a path-traversal facet name rather than reading outside out/', () => {
    // Names come from config/global.json today, but harden the read regardless (mirrors readDeployLog).
    expect(isValidFacetName('AcrossFacetV4')).toBe(true)
    expect(isValidFacetName('../../.env')).toBe(false)
    expect(loadFacetSelectorsFromArtifact('../../../etc/passwd')).toBeNull()
  })

  it('reports a facet whose artifact cannot be loaded as unresolved, not absent', () => {
    const { live, unresolved } = identifyCoupledFacetsOnChain(
      [{ address: '0xdead', selectors: ['0xffffffff'] }],
      ['UnknownFacet'],
      load
    )

    expect(live).toEqual([])
    expect(unresolved).toEqual(['UnknownFacet'])
  })
})

describe('resolveLiveFacets', () => {
  const SELECTORS: Record<string, string[]> = {
    AcrossFacetV4: ['0xaaaa0001'],
  }
  const load = (name: string) => SELECTORS[name] ?? null
  const FACET = '0x1111111111111111111111111111111111111111'

  it('resolves a facet present in the deploy log by name (no selector help needed)', () => {
    const { liveFacets, blindSpotWarning } = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xaaaa0001'] }],
      { AcrossFacetV4: FACET },
      ['AcrossFacetV4'],
      load
    )

    expect(liveFacets).toEqual(['AcrossFacetV4'])
    expect(blindSpotWarning).toBeNull()
  })

  it('closes the gap: a coupled facet absent from the deploy log is caught via selectors', () => {
    // The failure Daniela flagged — facet live on chain, missing from deploys/<network>.json.
    const { liveFacets, blindSpotWarning } = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xaaaa0001'] }],
      {},
      ['AcrossFacetV4'],
      load
    )

    expect(liveFacets).toEqual(['AcrossFacetV4'])
    expect(blindSpotWarning).toBeNull()
  })

  it('warns when an on-chain facet is absent from the log and selectors cannot identify it either', () => {
    const noArtifacts = () => null
    const { liveFacets, blindSpotWarning } = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xaaaa0001'] }],
      {},
      ['AcrossFacetV4'],
      noArtifacts
    )

    expect(liveFacets).toEqual([])
    expect(blindSpotWarning).toContain('could not be identified from selectors')
  })

  it('does not warn about a fully deploy-log-resolved facet even when artifacts are unavailable', () => {
    const noArtifacts = () => null
    const { blindSpotWarning } = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xaaaa0001'] }],
      { AcrossFacetV4: FACET },
      ['AcrossFacetV4'],
      noArtifacts
    )

    expect(blindSpotWarning).toBeNull()
  })
})
