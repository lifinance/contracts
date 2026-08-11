import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  evaluateFacetPeripheryCouplings,
  getFacetPeripheryCouplings,
  resolveLiveFacetsFromLog,
  type TFacetPeripheryCouplings,
} from './facetPeripheryCouplings'

const COUPLINGS: TFacetPeripheryCouplings = {
  AcrossFacetV4: { requires: 'ReceiverAcrossV4' },
  AcrossFacetPackedV4: { requires: 'ReceiverAcrossV4' },
  ChainflipFacet: {
    requires: 'ReceiverChainflip',
    notRequiredOn: { somechain: 'destination calls not supported (EXSC-000)' },
  },
}

describe('getFacetPeripheryCouplings', () => {
  it('reads the coupling block declared in config/global.json', () => {
    const couplings = getFacetPeripheryCouplings()
    expect(couplings.AcrossFacetV4?.requires).toBe('ReceiverAcrossV4')
  })
})

describe('evaluateFacetPeripheryCouplings', () => {
  it('collapses facets sharing a companion into one requirement', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'AcrossFacetPackedV4'],
      'mainnet',
      COUPLINGS
    )
    expect(required).toHaveLength(1)
    expect(required[0]?.companion).toBe('ReceiverAcrossV4')
    expect(required[0]?.triggeredBy).toEqual([
      'AcrossFacetPackedV4',
      'AcrossFacetV4',
    ])
  })

  it('ignores facets that have no declared coupling', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['SomeUnrelatedFacet'],
      'mainnet',
      COUPLINGS
    )
    expect(required).toHaveLength(0)
  })

  it('skips a facet carved out on the current network', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'somechain',
      COUPLINGS
    )
    expect(required).toHaveLength(0)
    expect(skipped).toEqual([
      {
        facet: 'ChainflipFacet',
        companion: 'ReceiverChainflip',
        reason: 'destination calls not supported (EXSC-000)',
      },
    ])
  })

  it('enforces a carved-out facet on other networks', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'mainnet',
      COUPLINGS
    )
    expect(skipped).toHaveLength(0)
    expect(required[0]?.companion).toBe('ReceiverChainflip')
  })

  it('deduplicates repeated facet names', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'AcrossFacetV4'],
      'mainnet',
      COUPLINGS
    )
    expect(required[0]?.triggeredBy).toEqual(['AcrossFacetV4'])
  })

  it('defaults to the config registry when none is passed', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4'],
      'mainnet'
    )
    expect(required[0]?.companion).toBe('ReceiverAcrossV4')
  })
})

describe('resolveLiveFacetsFromLog', () => {
  const deployLog = {
    AcrossFacetV4: '0xAAaa000000000000000000000000000000000001',
    AcrossFacetPackedV4: '0xBBbb000000000000000000000000000000000002',
    ChainflipFacet: '0xCCcc000000000000000000000000000000000003',
  }

  it('returns candidates whose deploy-log address is registered on chain', () => {
    const live = resolveLiveFacetsFromLog(
      [
        '0xaaaa000000000000000000000000000000000001',
        '0xdddd000000000000000000000000000000000009',
      ],
      deployLog,
      ['AcrossFacetV4', 'AcrossFacetPackedV4', 'ChainflipFacet']
    )
    expect(live).toEqual(['AcrossFacetV4'])
  })

  it('matches addresses case-insensitively on both sides', () => {
    const live = resolveLiveFacetsFromLog(
      ['0xBBBB000000000000000000000000000000000002'],
      deployLog,
      ['AcrossFacetPackedV4']
    )
    expect(live).toEqual(['AcrossFacetPackedV4'])
  })

  it('skips a candidate absent from the deploy log', () => {
    const live = resolveLiveFacetsFromLog(
      ['0xaaaa000000000000000000000000000000000001'],
      deployLog,
      ['UnknownFacet']
    )
    expect(live).toEqual([])
  })

  it('returns empty when no candidate is registered on chain', () => {
    const live = resolveLiveFacetsFromLog(
      ['0xeeee00000000000000000000000000000000000a'],
      deployLog,
      ['AcrossFacetV4', 'ChainflipFacet']
    )
    expect(live).toEqual([])
  })
})
