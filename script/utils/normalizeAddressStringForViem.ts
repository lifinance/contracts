import { getAddress, type Address } from 'viem'

import { TRON_NETWORK_KEYS } from '../deploy/shared/constants'
import { getTronWebCodecOnlyForNetwork } from '../deploy/tron/helpers/tronWebCodecOnly'
import { tronAddressToHex } from '../deploy/tron/tronAddressHelpers'

/**
 * Normalize a contract address from config or Mongo for viem RPC usage.
 * - On networks in `TRON_NETWORK_KEYS` (`deploy/shared/constants`), base58 (`T…`) becomes the same 20-byte identity as a checksummed `0x` address.
 * - On all other networks, the string is parsed with `getAddress` (hex / checksum rules).
 */
export function normalizeAddressForNetwork(
  networkId: string,
  rawAddress: string
): Address {
  if (!rawAddress?.trim()) throw new Error('Address string is empty')

  const trimmed = rawAddress.trim()
  const key = networkId.toLowerCase()
  if (TRON_NETWORK_KEYS.has(key) && trimmed.startsWith('T')) {
    const tronWeb = getTronWebCodecOnlyForNetwork(key)
    return getAddress(tronAddressToHex(tronWeb, trimmed) as Address)
  }

  return getAddress(trimmed as Address)
}
