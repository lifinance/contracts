import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  findMismatches,
  type INetworkSources,
} from './checkDeploymentAddressConsistency'

const base: INetworkSources = {
  network: 'testnet',
  whitelistPeriphery: {},
  deploymentFlat: {},
  diamondPeriphery: {},
  diamondFacets: {},
}

describe('findMismatches', () => {
  it('returns no mismatches when all sources agree (case-insensitive)', () => {
    const sources: INetworkSources[] = [
      {
        ...base,
        whitelistPeriphery: { OutputValidator: '0xAAA' },
        deploymentFlat: { OutputValidator: '0xaaa', DiamondCutFacet: '0xF00' },
        diamondPeriphery: { OutputValidator: '0xAaA' },
        diamondFacets: { DiamondCutFacet: '0xf00' },
      },
    ]
    expect(findMismatches(sources)).toEqual([])
  })

  it('flags a periphery address that disagrees with the deployment log', () => {
    const sources: INetworkSources[] = [
      {
        ...base,
        whitelistPeriphery: { OutputValidator: '0x293bef' },
        deploymentFlat: { OutputValidator: '0x1581ca9' },
        diamondPeriphery: { OutputValidator: '0x1581ca9' },
      },
    ]
    const result = findMismatches(sources)
    expect(result).toHaveLength(1)
    const mismatch = result[0]
    expect(mismatch).toMatchObject({
      network: 'testnet',
      kind: 'periphery',
      contract: 'OutputValidator',
    })
    expect(mismatch?.addresses).toHaveLength(3)
  })

  it('flags a facet address that disagrees between the two deployment files', () => {
    const sources: INetworkSources[] = [
      {
        ...base,
        deploymentFlat: { DexManagerFacet: '0xnew' },
        diamondFacets: { DexManagerFacet: '0xold' },
      },
    ]
    const result = findMismatches(sources)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'facet',
      contract: 'DexManagerFacet',
    })
  })

  it('ignores empty placeholders and contracts present in only one source', () => {
    const sources: INetworkSources[] = [
      {
        ...base,
        whitelistPeriphery: { Patcher: '0xabc' },
        deploymentFlat: { Patcher: '0xabc' },
        diamondPeriphery: { Patcher: '' }, // not deployed -> ignored
        diamondFacets: { LonelyFacet: '0x999' }, // only one source -> ignored
      },
    ]
    expect(findMismatches(sources)).toEqual([])
  })
})
