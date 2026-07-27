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
  acrossV4: {
    facets: ['AcrossFacetV4', 'AcrossFacetPackedV4'],
    requiresAnyOf: ['ReceiverAcrossV4', 'ReceiverAcrossV3'],
  },
  chainflip: {
    facets: ['ChainflipFacet'],
    requiresAnyOf: ['ReceiverChainflip'],
    notRequiredOn: { SomeChain: 'Chainflip is source-only there (EXSC-000)' },
  },
  oif: {
    facets: ['LiFiIntentEscrowFacetV2'],
    requiresAnyOf: ['ReceiverOIF'],
    notRequiredYet: 'destination-side execution not supported yet',
  },
}

describe('evaluateFacetPeripheryCouplings', () => {
  it('requires the companion when a triggering facet is present', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4'],
      'mainnet',
      COUPLINGS
    )

    expect(skipped).toEqual([])
    expect(required).toEqual([
      {
        coupling: 'acrossV4',
        triggeredBy: ['AcrossFacetV4'],
        requiresAnyOf: ['ReceiverAcrossV4', 'ReceiverAcrossV3'],
      },
    ])
  })

  it('reports every triggering facet of one coupling, not just the first', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'AcrossFacetPackedV4'],
      'mainnet',
      COUPLINGS
    )

    expect(required[0]?.triggeredBy).toEqual([
      'AcrossFacetV4',
      'AcrossFacetPackedV4',
    ])
  })

  it('ignores couplings whose facets are absent', () => {
    const result = evaluateFacetPeripheryCouplings(
      ['GenericSwapFacetV3'],
      'mainnet',
      COUPLINGS
    )

    expect(result).toEqual({ required: [], skipped: [] })
  })

  it('skips a coupling marked notRequiredYet on every network', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['LiFiIntentEscrowFacetV2'],
      'mainnet',
      COUPLINGS
    )

    expect(required).toEqual([])
    expect(skipped).toEqual([
      {
        coupling: 'oif',
        triggeredBy: ['LiFiIntentEscrowFacetV2'],
        reason: 'destination-side execution not supported yet',
      },
    ])
  })

  it('skips a coupling carved out for this network, case-insensitively', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'somechain',
      COUPLINGS
    )

    expect(required).toEqual([])
    expect(skipped[0]?.reason).toContain('source-only')
  })

  it('still requires a carved-out coupling on other networks', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'mainnet',
      COUPLINGS
    )

    expect(skipped).toEqual([])
    expect(required[0]?.requiresAnyOf).toEqual(['ReceiverChainflip'])
  })

  it('evaluates couplings independently of one another', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'LiFiIntentEscrowFacetV2'],
      'mainnet',
      COUPLINGS
    )

    expect(required.map((r) => r.coupling)).toEqual(['acrossV4'])
    expect(skipped.map((s) => s.coupling)).toEqual(['oif'])
  })

  it('treats a declaration without facets or requiresAnyOf as inert rather than throwing', () => {
    const result = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4'],
      'mainnet',
      {
        broken: {} as TFacetPeripheryCouplings[string],
      }
    )

    expect(result).toEqual({ required: [], skipped: [] })
  })

  it('yields an empty requiresAnyOf when a triggered coupling declares none', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4'],
      'mainnet',
      {
        partial: {
          facets: ['AcrossFacetV4'],
        } as TFacetPeripheryCouplings[string],
      }
    )

    expect(required[0]?.requiresAnyOf).toEqual([])
  })
})

describe('getFacetPeripheryCouplings', () => {
  it('reads the registry from config/global.json', () => {
    const couplings = getFacetPeripheryCouplings()

    expect(Object.keys(couplings).length).toBeGreaterThan(0)
  })

  it('declares only real facets and periphery contracts, and gives every carve-out a reason', () => {
    for (const [key, declaration] of Object.entries(
      getFacetPeripheryCouplings()
    )) {
      expect(declaration.facets.length).toBeGreaterThan(0)
      expect(declaration.requiresAnyOf.length).toBeGreaterThan(0)

      for (const facet of declaration.facets)
        expect(
          Bun.file(`src/Facets/${facet}.sol`).size,
          `${key}: src/Facets/${facet}.sol must exist`
        ).toBeGreaterThan(0)

      for (const periphery of declaration.requiresAnyOf)
        expect(
          Bun.file(`src/Periphery/${periphery}.sol`).size,
          `${key}: src/Periphery/${periphery}.sol must exist`
        ).toBeGreaterThan(0)

      if (declaration.notRequiredYet !== undefined)
        expect(declaration.notRequiredYet.length).toBeGreaterThan(0)

      for (const reason of Object.values(declaration.notRequiredOn ?? {}))
        expect(reason.length).toBeGreaterThan(0)
    }
  })
})
