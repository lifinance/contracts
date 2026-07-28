import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  evaluateFacetPeripheryCouplings,
  getFacetPeripheryCouplings,
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
