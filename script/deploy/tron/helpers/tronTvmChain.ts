/**
 * Tron TVM chain ids from `config/networks.json` (mainnet / Shasta).
 */

import networks from '../../../../config/networks.json'
import type { TronTvmNetworkName } from '../types'

export function getTronNetworkKeyForChainId(
  chainId: number
): TronTvmNetworkName | null {
  if (chainId === networks.tron.chainId) return 'tron'
  if (chainId === networks.tronshasta.chainId) return 'tronshasta'
  return null
}

export function isTronTvmChainId(chainId: number): boolean {
  return getTronNetworkKeyForChainId(chainId) !== null
}
