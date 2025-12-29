// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { getNetworkConfig, loadNetworks } from './registry'

describe('registry', () => {
  it('loads networks with ids', () => {
    const networks = loadNetworks()
    expect(networks.mainnet?.id).toBe('mainnet')
    expect(getNetworkConfig(networks, 'mainnet')?.id).toBe('mainnet')
  })

  it('returns undefined for missing network', () => {
    const networks = loadNetworks()
    expect(getNetworkConfig(networks, 'does-not-exist')).toBeUndefined()
  })
})
