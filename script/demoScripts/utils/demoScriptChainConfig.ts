import { arbitrum, mainnet, Chain } from 'viem/chains'
import networks from '../../../config/networks.json'
import { getEnvVar } from './demoScriptHelpers'

export type SupportedChain = keyof typeof networks

const viemChainMap: Partial<Record<SupportedChain, Chain>> = {
  mainnet: mainnet,
  arbitrum: arbitrum,
}

/**
 * Return the correct RPC environment variable
 * (e.g. `ETH_NODE_URI_ARBITRUM` or `ETH_NODE_URI_MAINNET`)
 * or fallback to the chain's "rpcUrl" from `networks.json`.
 */
export const getRpcUrl = (chain: SupportedChain) => {
  const envKey = `ETH_NODE_URI_${chain.toUpperCase()}`
  return getEnvVar(envKey) as string
}

/**
 * Return the `Chain` object from viem. If you request a chain that doesn't
 * exist in `viemChainMap`, this will throw an error.
 */
export const getViemChain = (chain: SupportedChain): Chain => {
  const viemChain = viemChainMap[chain]
  if (!viemChain) {
    throw new Error(
      `No viem chain object defined for chain: ${chain}. Please take a look at viemChainMap`
    )
  }
  return viemChain
}
