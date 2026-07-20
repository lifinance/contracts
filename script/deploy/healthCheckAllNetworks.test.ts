import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { INetwork } from '../common/types'

import {
  deploymentPathsToNetworks,
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

describe('deploymentPathsToNetworks', () => {
  it('extracts production network keys, ignoring staging/diamond/non-network files', () => {
    const result = deploymentPathsToNetworks([
      'deployments/optimism.json',
      'deployments/opbnb.json',
      'deployments/base.staging.json',
      'deployments/polygon.diamond.json',
      'deployments/_deployments_log_file.json',
      'src/Periphery/Executor.sol',
    ])
    expect(result).toEqual(['opbnb', 'optimism'])
  })

  it('dedupes and returns empty when no network file changed', () => {
    expect(
      deploymentPathsToNetworks([
        'deployments/arbitrum.json',
        'deployments/arbitrum.json',
      ])
    ).toEqual(['arbitrum'])
    expect(deploymentPathsToNetworks(['deployments/x.diamond.json'])).toEqual(
      []
    )
  })
})

describe('summarizeHealthChecks', () => {
  it('splits passed / failed / skipped and counts the total', () => {
    const summary = summarizeHealthChecks([
      { network: 'polygon', status: 'passed', detail: '' },
      { network: 'optimism', status: 'failed', detail: 'boom' },
      { network: 'arbitrum', status: 'passed', detail: '' },
      { network: 'tron', status: 'skipped', detail: 'skipHealthcheck' },
    ])
    expect(summary.total).toBe(4)
    expect(summary.passed).toEqual(['arbitrum', 'polygon'])
    expect(summary.failed).toEqual(['optimism'])
    expect(summary.skipped).toEqual(['tron'])
  })

  it('handles the all-passed case', () => {
    const summary = summarizeHealthChecks([
      { network: 'polygon', status: 'passed', detail: '' },
    ])
    expect(summary.failed).toEqual([])
    expect(summary.passed).toEqual(['polygon'])
  })

  it('handles the empty case', () => {
    const summary = summarizeHealthChecks([])
    expect(summary).toEqual({
      total: 0,
      passed: [],
      failed: [],
      skipped: [],
    })
  })
})
