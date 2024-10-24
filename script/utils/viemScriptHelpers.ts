import { Chain, defineChain, getAddress, PublicClient } from 'viem'
import * as chains from 'viem/chains'
import networksConfig from '../../config/networks.json'

export type NetworksObject = {
  [key: string]: Omit<Network, 'id'>
}

export type Network = {
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
  gasZipChainId: number
  id: string
}

const networks: NetworksObject = networksConfig

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
      multicall3: { address: getAddress(network.multicallAddress) },
    },
  })
  return chain
}

export const getAllNetworksArray = (): Network[] => {
  // Convert the object into an array of network objects
  const networkArray = Object.entries(networksConfig).map(([key, value]) => ({
    ...value,
    id: key,
  }))

  return networkArray
}

// removes all networks with "status='inactive'"
export const getAllActiveNetworks = (): Network[] => {
  // Convert the object into an array of network objects
  const networkArray = getAllNetworksArray()

  // Example: Filter networks where status is 'active'
  const activeNetworks: Network[] = networkArray.filter(
    (network) => network.status === 'active'
  )

  return activeNetworks
}
