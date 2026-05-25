import { getAddress, type Address } from 'viem'

import { isTronNetworkKey } from '../../shared/tron-network-keys'
import {
  evmHexToTronBase58,
  tronAddressLikeToBase58,
  tronAddressToHex,
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
  if (!isTronNetworkKey(key)) return address

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

/**
 * Returns ` (0x…)` (checksummed EVM hex) for Tron addresses so CLI output can
 * show both base58 and the hex form familiar from EVM contexts. Returns `''`
 * for non-Tron networks or when the input can't be resolved to a 20-byte hex.
 * Designed to be concatenated *after* `formatAddressForNetworkCliDisplay`; keep
 * it separate so the plain-base58 output can still feed explorer URL builders.
 */
export function tronHexSuffix(networkKey: string, address: string): string {
  if (!isTronNetworkKey(networkKey.toLowerCase())) return ''

  const codec = getTronWebCodecOnly()
  const trimmed = address.trim()

  try {
    if (trimmed.startsWith('0x') && trimmed.length >= 42)
      return ` (${getAddress(trimmed as Address)})`

    if (
      (trimmed.startsWith('T') && trimmed.length >= 34) ||
      trimmed.startsWith('41')
    )
      return ` (${getAddress(tronAddressToHex(codec, trimmed) as Address)})`
  } catch {
    return ''
  }

  return ''
}
