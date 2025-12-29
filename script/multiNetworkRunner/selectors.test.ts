// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { EnvironmentEnum } from '../common/types'

import { selectNetworks } from './selectors'
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

describe('selectors', () => {
  const networks: Record<string, INetworkConfig> = {
    alpha: makeNetwork('alpha', 'cancun') as INetworkConfig,
    beta: makeNetwork('beta', 'london') as INetworkConfig,
  }

  it('selects explicit networks', async () => {
    const result = await selectNetworks({
      networks,
      explicitNetworks: ['alpha', 'missing'],
      environment: EnvironmentEnum.production,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((net) => net.id) as any).toEqual(['alpha'])
  })

  it('selects by evm selector', async () => {
    const result = await selectNetworks({
      networks,
      selectors: ['evm:london'],
      environment: EnvironmentEnum.production,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((net) => net.id) as any).toEqual(['beta'])
  })

  it('selects by deployed contract with code check', async () => {
    const deploymentLoader = async () => ({
      TestContract: '0x0000000000000000000000000000000000000010',
    })
    const rpcPool = {
      getCode: async () => '0x1234',
    }

    const result = await selectNetworks({
      networks,
      selectors: ['deployed:TestContract'],
      environment: EnvironmentEnum.production,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rpcPool: rpcPool as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deploymentLoader: deploymentLoader as any,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((net) => net.id) as any).toEqual(['alpha', 'beta'])
  })

  it('defaults to all networks when no selector provided', async () => {
    const result = await selectNetworks({
      networks,
      environment: EnvironmentEnum.production,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.map((net) => net.id) as any).toEqual(['alpha', 'beta'])
  })

  it('handles deployment selector errors', async () => {
    const extendedNetworks: Record<string, INetworkConfig> = {
      alpha: makeNetwork('alpha', 'cancun') as INetworkConfig,
      beta: makeNetwork('beta', 'cancun') as INetworkConfig,
      gamma: makeNetwork('gamma', 'cancun') as INetworkConfig,
      delta: makeNetwork('delta', 'cancun') as INetworkConfig,
    }

    const deploymentLoader = async (chain: string) => {
      if (chain === 'alpha') throw new Error('missing deployments')
      if (chain === 'beta') return { TestContract: '0x123' }
      return { TestContract: '0x0000000000000000000000000000000000000010' }
    }

    const rpcPool = {
      getCode: async (network: { id: string }) => {
        if (network.id === 'gamma') throw new Error('rpc error')
        return '0x'
      },
    }

    const result = await selectNetworks({
      networks: extendedNetworks,
      selectors: ['deployed:TestContract'],
      environment: EnvironmentEnum.production,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rpcPool: rpcPool as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deploymentLoader: deploymentLoader as any,
    })

    expect(result).toEqual([])
  })

  it('throws for unknown selector and missing rpc', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      selectNetworks({
        networks,
        selectors: ['unknown:foo'],
        environment: EnvironmentEnum.production,
      })
    ).rejects.toThrow('Unknown selector')

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      selectNetworks({
        networks,
        selectors: ['evm:'],
        environment: EnvironmentEnum.production,
      })
    ).rejects.toThrow('requires a version')

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      selectNetworks({
        networks,
        selectors: ['deployed:TestContract'],
        environment: EnvironmentEnum.production,
      })
    ).rejects.toThrow('RPC pool is required')

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      selectNetworks({
        networks,
        selectors: ['deployed'],
        environment: EnvironmentEnum.production,
      })
    ).rejects.toThrow('requires a contract name')
  })
})
