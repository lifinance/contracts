import { getAddress, type Address } from 'viem'

import { TRON_NETWORK_KEYS } from '../../shared/constants'
import {
  evmHexToTronBase58,
  tronAddressLikeToBase58,
} from '../tronAddressHelpers'

import { getTronWebCodecOnly } from './tronWebCodecOnly'

/**
 * Format addresses for CLI output on the given network (e.g. Tron: `0x` hex → base58 `T…`).
 * Pass-through for non-Tron networks, invalid hex, or already-base58 strings.
 */
export function formatAddressForNetworkCliDisplay(
  networkKey: string,
  address: string
): string {
  const key = networkKey.toLowerCase()
  if (!TRON_NETWORK_KEYS.has(key)) return address

  const codec = getTronWebCodecOnly()
  const trimmed = address.trim()

  if (trimmed.startsWith('T') && trimmed.length >= 34) return trimmed

  if (trimmed.startsWith('0x') && trimmed.length >= 42) {
    try {
      const hex = getAddress(trimmed as Address)
      return evmHexToTronBase58(codec, hex)
    } catch {
      return address
    }
  }

  if (trimmed.startsWith('41') || trimmed.startsWith('0x')) {
    try {
      return tronAddressLikeToBase58(codec, trimmed)
    } catch {
      return address
    }
  }

  return address
}
