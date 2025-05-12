import { arbitrum, mainnet, Chain } from 'viem/chains'
import networks from '../../../config/networks.json'

export type SupportedChain = keyof typeof networks

// The `viemChainMap` object maps supported chains to their
// respective viem `Chain` configuration.
// This object can be modified to include additional chains if
// tests require connections to other networks.
export const viemChainMap: Partial<Record<SupportedChain, Chain>> = {
  mainnet: mainnet,
  arbitrum: arbitrum,
}
