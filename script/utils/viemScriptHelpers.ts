import { Chain, defineChain, getAddress } from 'viem'
import networksConfig from '../../config/networks.json'
import * as dotenv from 'dotenv'
dotenv.config()

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
  safeWebUrl: string
  gasZipChainId: number
  id: string
}

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
}

export const networks: NetworksObject = networksConfig

export const getViemChainForNetworkName = (networkName: string): Chain => {
  const network = networks[networkName]

  if (!network)
    throw new Error(
      `Chain ${networkName} does not exist. Please check that the network exists in 'config/networks.json'`
    )

  // Construct the environment variable key dynamically
  const envKey = `ETH_NODE_URI_${networkName.toUpperCase()}`
  const rpcUrl = process.env[envKey] || network.rpcUrl // Use .env value if available, otherwise fallback

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
        http: [rpcUrl],
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

export const printSuccess = (message: string): void => {
  if (!message?.trim()) return
  console.log(`${colors.green}${message}${colors.reset}`)
}
