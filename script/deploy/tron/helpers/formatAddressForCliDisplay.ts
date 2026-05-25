import { getAddress, type Address } from 'viem'

import { isTronNetworkKey } from '../../shared/tron-network-keys'
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
 * show the hex form familiar from EVM contexts alongside the displayed base58.
 * Returns `''` for non-Tron networks or unrecognizable input. Assumes the input
 * is an EVM `0x`-form address — matches every current caller in confirm-safe-tx
 * / safe-decode-utils, which pass addresses sourced from MongoDB or viem-decoded
 * args (always `0x`). Kept separate from `formatAddressForNetworkCliDisplay` so
 * the plain-base58 output can still feed explorer URL builders.
 */
export function tronHexSuffix(networkKey: string, evmAddress: string): string {
  if (!isTronNetworkKey(networkKey.toLowerCase())) return ''

  try {
    return ` (${getAddress(evmAddress.trim() as Address)})`
  } catch {
    return ''
  }
}
