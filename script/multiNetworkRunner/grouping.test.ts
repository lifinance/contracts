// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { groupNetworks } from './grouping'
import type { INetworkConfig } from './types'

const makeNetwork = (
  id: string,
  evmVersion: string,
  isZkEVM = false
): INetworkConfig => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  id: id as any,
  name: id,
  chainId: 1,
  nativeAddress: '0x0',
  nativeCurrency: 'ETH',
  wrappedNativeAddress: '0x0',
  status: 'active',
  type: 'evm',
  rpcUrl: 'https://rpc',
  verificationType: 'etherscan',
  explorerUrl: '',
  explorerApiUrl: '',
  multicallAddress: '0x0000000000000000000000000000000000000000',
  safeAddress: '',
  deployedWithEvmVersion: evmVersion,
  deployedWithSolcVersion: '0.8.29',
  gasZipChainId: 0,
  isZkEVM,
})

describe('grouping', () => {
  it('groups networks by evm version and zkevm', () => {
    const networks: INetworkConfig[] = [
      makeNetwork('alpha', 'cancun') as INetworkConfig,
      makeNetwork('beta', 'london') as INetworkConfig,
      makeNetwork('gamma', 'cancun', true) as INetworkConfig,
      makeNetwork('delta', 'n/a') as INetworkConfig,
    ]

    const result = groupNetworks(networks, 'cancun')
    expect(result.groups.length).toBe(3)
    expect(result.groups[0]?.name).toBe('primary')
    expect(result.groups[1]?.name).toBe('london')
    expect(result.groups[2]?.name).toBe('zkevm')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.skipped.map((net) => net.id) as any).toEqual(['delta'])
  })

  it('skips london group when default is london', () => {
    const networks: INetworkConfig[] = [
      makeNetwork('alpha', 'london') as INetworkConfig,
    ]

    const result = groupNetworks(networks, 'london')
    expect(result.groups.length).toBe(1)
    expect(result.groups[0]?.name).toBe('primary')
  })

  it('handles zkevm-only grouping', () => {
    const networks: INetworkConfig[] = [
      makeNetwork('zk', 'cancun', true) as INetworkConfig,
    ]

    const result = groupNetworks(networks, 'cancun')
    expect(result.groups.length).toBe(1)
    expect(result.groups[0]?.name).toBe('zkevm')
  })
})
