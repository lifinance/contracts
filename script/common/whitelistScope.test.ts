import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import globalConfig from '../../config/global.json'

import {
  assertScopeContractsEligible,
  isNetworkInScope,
} from './whitelistScope'

describe('isNetworkInScope', () => {
  const scope = { LiFiDEXAggregator: ['bob', 'lens', 'opbnb'] }

  it('allows any network for a contract absent from the scope map', () => {
    expect(isNetworkInScope('FeeForwarder', 'mainnet', scope)).toBe(true)
  })

  it('allows a network the contract is scoped to', () => {
    expect(isNetworkInScope('LiFiDEXAggregator', 'bob', scope)).toBe(true)
  })

  it('rejects a network the contract is not scoped to', () => {
    expect(isNetworkInScope('LiFiDEXAggregator', 'mainnet', scope)).toBe(false)
  })

  it('compares network names case-insensitively', () => {
    expect(isNetworkInScope('LiFiDEXAggregator', 'OpBNB', scope)).toBe(true)
  })

  it('treats an empty scope map as unrestricted', () => {
    expect(isNetworkInScope('LiFiDEXAggregator', 'mainnet', {})).toBe(true)
  })

  it('rejects every network for a contract scoped to an empty list', () => {
    expect(isNetworkInScope('X', 'mainnet', { X: [] })).toBe(false)
  })
})

describe('assertScopeContractsEligible', () => {
  it('accepts a scope map whose contracts are all eligible', () => {
    expect(() =>
      assertScopeContractsEligible({ LiFiDEXAggregator: ['bob'] }, [
        'LiFiDEXAggregator',
        'OutputValidator',
      ])
    ).not.toThrow()
  })

  it('rejects a scope map naming an ineligible contract', () => {
    expect(() =>
      assertScopeContractsEligible({ LifiDEXAggregator: ['bob'] }, [
        'LiFiDEXAggregator',
      ])
    ).toThrow(/LifiDEXAggregator/)
  })

  it('accepts an empty scope map', () => {
    expect(() => assertScopeContractsEligible({}, [])).not.toThrow()
  })
})

describe('config/global.json whitelistPeripheryNetworks', () => {
  const scope = (
    globalConfig as { whitelistPeripheryNetworks?: Record<string, string[]> }
  ).whitelistPeripheryNetworks

  it('only scopes contracts that are whitelist-eligible', () => {
    const eligible = Object.keys(globalConfig.whitelistPeripheryFunctions)
    for (const name of Object.keys(scope ?? {}))
      expect(eligible).toContain(name)
  })

  it('only names networks defined in config/networks.json', async () => {
    const networks = Object.keys(
      (await import('../../config/networks.json')).default
    )
    for (const [contract, allowed] of Object.entries(scope ?? {}))
      for (const network of allowed)
        expect(
          networks,
          `${contract} is scoped to unknown network "${network}"`
        ).toContain(network)
  })
})
