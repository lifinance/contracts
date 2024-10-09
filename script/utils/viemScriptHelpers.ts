import { Chain, defineChain } from 'viem'
import * as chains from 'viem/chains'
import networksConfig from '../../config/networks.json'

export type Networks = {
  [key: string]: {
    name: string
    chainId: number
    nativeAddress: string
    nativeCurrency: string
    wrappedNativeAddress: string
    status: string
    type: string
    rpcUrl: string
    verificationType: string
    explorerUrl: string
    explorerApiUrl: string
    multicallAddress: string
    safeApiUrl: string
    safeAddress: string
  }
}

const networks: Networks = networksConfig

export const getViemChainForNetworkName = (networkName: string): Chain => {
  const network = networks[networkName]

  if (!network)
    throw new Error(
      `Chain ${networkName} does not exist. Please check that the network exists in 'config/networks.json'`
    )

  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: {
      decimals: 18,
      name: network.nativeCurrency,
      symbol: network.nativeCurrency,
    },
    rpcUrls: {
      default: {
        http: [network.rpcUrl],
      },
    },
    contracts: {
      multicall3: { address: network.multicallAddress as `0x${string}` },
    },
  })
  return chain
}
