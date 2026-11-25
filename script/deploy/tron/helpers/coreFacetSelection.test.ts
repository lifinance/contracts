// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { selectCoreContracts } from './coreFacetSelection'

const CORE = ['DiamondCutFacet', 'DiamondLoupeFacet', 'OwnershipFacet']

describe('selectCoreContracts', () => {
  it('deploys every core facet and leaves the diamond unnamed without --only', () => {
    expect(selectCoreContracts(CORE, undefined)).toEqual({
      facets: CORE,
      diamondNamed: false,
    })
  })

  it('keeps only the named facets, in deploy order', () => {
    expect(
      selectCoreContracts(CORE, ['OwnershipFacet', 'DiamondCutFacet'])
    ).toEqual({
      facets: ['DiamondCutFacet', 'OwnershipFacet'],
      diamondNamed: false,
    })
  })

  it('reports LiFiDiamond as named when --only lists it with DiamondCutFacet', () => {
    expect(
      selectCoreContracts(CORE, ['LiFiDiamond', 'DiamondCutFacet'])
    ).toEqual({
      facets: ['DiamondCutFacet'],
      diamondNamed: true,
    })
  })

  it('refuses LiFiDiamond without the DiamondCutFacet its constructor takes', () => {
    expect(() => selectCoreContracts(CORE, ['LiFiDiamond'])).toThrow(
      /without DiamondCutFacet/
    )
  })

  it('refuses a name that is neither a core facet nor LiFiDiamond', () => {
    expect(() =>
      selectCoreContracts(CORE, ['OwnershipFacet', 'EcoFacet'])
    ).toThrow(/--only names EcoFacet, which is not a core facet/)
  })

  it('names every unknown contract at once', () => {
    expect(() => selectCoreContracts(CORE, ['EcoFacet', 'Nope'])).toThrow(
      /--only names EcoFacet, Nope, which are not/
    )
  })

  it('refuses an --only that names nothing', () => {
    expect(() => selectCoreContracts(CORE, [])).toThrow(
      '--only names no contract'
    )
  })
})
