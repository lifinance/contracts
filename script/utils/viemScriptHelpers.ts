import { Chain } from 'viem'
import * as chains from 'viem/chains'

const chainNameMappings: Record<string, string> = {
  zksync: 'zkSync',
  polygonzkevm: 'polygonZkEvm',
  immutablezkevm: 'immutableZkEvm',
}

const chainMap: Record<string, Chain> = {}
for (const [k, v] of Object.entries(chains)) {
  // @ts-ignore
  chainMap[k] = v
}

export const getViemChainForNetworkName = (networkName: string): Chain => {
  const chainName = chainNameMappings[networkName] || networkName
  const chain: Chain = chainMap[chainName]

  if (!chain)
    throw new Error(
      `Chain ${networkName} (aka '${chainName}', if a mapping exists) not supported by viem or requires name mapping. Check if you can find your chain here: https://github.com/wevm/viem/tree/main/src/chains/definitions`
    )

  return chain
}
