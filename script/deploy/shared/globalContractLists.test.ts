import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { deriveNonCoreFacets } from './globalContractLists'

describe('deriveNonCoreFacets', () => {
  const CORE = ['OwnershipFacet', 'GasZipFacet', 'LiFiIntentEscrowFacetV2']
  const PERIPHERY = ['Executor', 'ERC20Proxy']

  const derive = (targetStateContracts: string[], coreFacets = CORE) =>
    deriveNonCoreFacets({
      targetStateContracts,
      coreFacets,
      corePeriphery: PERIPHERY,
    })

  it('keeps target-state facets that are neither core nor periphery', () => {
    expect(derive(['SquidFacet', 'MayanFacet'])).toEqual([
      'SquidFacet',
      'MayanFacet',
    ])
  })

  it('drops core facets, core periphery, and the diamond itself', () => {
    expect(
      derive([
        'OwnershipFacet',
        'Executor',
        'ERC20Proxy',
        'LiFiDiamond',
        'SquidFacet',
      ])
    ).toEqual(['SquidFacet'])
  })

  it('drops entries whose name does not contain "Facet"', () => {
    expect(derive(['TokenWrapper', 'SquidFacet'])).toEqual(['SquidFacet'])
  })

  // Regression: passing a core list that already had per-network exclusions applied made an
  // excluded core facet reappear as "non-core", so it was re-checked via target state and
  // failed anyway — silently defeating the exclusion (GasZip-unsupported networks and
  // CORE_FACET_EXEMPTIONS grandfathering both hit this).
  it('still treats an excluded core facet as core when given the full core list', () => {
    const targetState = ['LiFiIntentEscrowFacetV2', 'GasZipFacet', 'SquidFacet']
    expect(derive(targetState, CORE)).toEqual(['SquidFacet'])
  })

  it('demonstrates the bug shape when handed a pre-excluded core list', () => {
    // Documents WHY callers must pass the full list: with the exclusions already applied,
    // the excluded facets leak back in as non-core.
    const preExcluded = CORE.filter(
      (f) => f !== 'GasZipFacet' && f !== 'LiFiIntentEscrowFacetV2'
    )
    const targetState = ['LiFiIntentEscrowFacetV2', 'GasZipFacet', 'SquidFacet']
    expect(derive(targetState, preExcluded)).toEqual(targetState)
  })

  it('returns an empty list for empty target state', () => {
    expect(derive([])).toEqual([])
  })
})
