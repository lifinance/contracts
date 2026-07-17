import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { INetwork } from '../common/types'

import {
  getProductionNetworkNames,
  summarizeHealthChecks,
} from './healthCheckAllNetworks'

/** Builds a minimal INetwork with only the fields the filter reads. */
function net(id: string, type: string, status: string): INetwork {
  return { id, type, status } as INetwork
}

describe('getProductionNetworkNames', () => {
  it('keeps only active mainnets and sorts them', () => {
    const result = getProductionNetworkNames([
      net('polygon', 'mainnet', 'active'),
      net('arbitrum', 'mainnet', 'active'),
      net('sepolia', 'testnet', 'active'),
      net('oldchain', 'mainnet', 'inactive'),
    ])
    expect(result).toEqual(['arbitrum', 'polygon'])
  })

  it('returns an empty list when nothing qualifies', () => {
    expect(
      getProductionNetworkNames([net('sepolia', 'testnet', 'active')])
    ).toEqual([])
  })
})

describe('summarizeHealthChecks', () => {
  it('splits passed and failed and counts the total', () => {
    const summary = summarizeHealthChecks([
      { network: 'polygon', passed: true, detail: '' },
      { network: 'optimism', passed: false, detail: 'boom' },
      { network: 'arbitrum', passed: true, detail: '' },
    ])
    expect(summary.total).toBe(3)
    expect(summary.passed).toEqual(['arbitrum', 'polygon'])
    expect(summary.failed).toEqual(['optimism'])
  })

  it('handles the all-passed case', () => {
    const summary = summarizeHealthChecks([
      { network: 'polygon', passed: true, detail: '' },
    ])
    expect(summary.failed).toEqual([])
    expect(summary.passed).toEqual(['polygon'])
  })

  it('handles the empty case', () => {
    const summary = summarizeHealthChecks([])
    expect(summary).toEqual({ total: 0, passed: [], failed: [] })
  })
})
