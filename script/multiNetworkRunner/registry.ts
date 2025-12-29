import networksData from '../../config/networks.json'

import type { NetworkConfig } from './types'

export const loadNetworks = (): Record<string, NetworkConfig> => {
  return Object.entries(networksData).reduce((acc, [id, config]) => {
    acc[id] = {
      ...(config as NetworkConfig),
      id: id as NetworkConfig['id'],
    }
    return acc
  }, {} as Record<string, NetworkConfig>)
}

export const getNetworkConfig = (
  networks: Record<string, NetworkConfig>,
  networkName: string
): NetworkConfig | undefined => {
  return networks[networkName]
}
