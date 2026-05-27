/**
 * Tron CLI hex suffix helper.
 *
 * Returns the ` (0x…)` checksummed-EVM-hex suffix that confirm-safe-tx /
 * safe-decode-utils append next to Tron base58 addresses so reviewers can
 * cross-reference the hex form from `config/global.json` or EVM explorers.
 * Kept separate from `formatAddressForNetworkCliDisplay` (in @lifi/tron-devkit)
 * because that function's plain output also feeds explorer URL builders, so it
 * must stay a bare address.
 */
import { isTronNetworkKey } from '@lifi/tron-devkit'
import { getAddress, type Address } from 'viem'

/**
 * Returns ` (0x…)` (checksummed EVM hex) for Tron addresses so CLI output can
 * show the hex form familiar from EVM contexts alongside the displayed base58.
 * Returns `''` for non-Tron networks or unrecognizable input. Assumes the input
 * is an EVM `0x`-form address — matches every current caller in confirm-safe-tx
 * / safe-decode-utils, which pass addresses sourced from MongoDB (stored via
 * tronBase58ToEvm20Hex on insert) or viem-decoded args (always `0x`).
 *
 * @param networkKey - Network key (case-insensitive); non-Tron keys yield ''.
 * @param evmAddress - 0x-form EVM address.
 * @returns ` (0x<checksummed>)` for Tron + valid input, `''` otherwise.
 */
export function tronHexSuffix(networkKey: string, evmAddress: string): string {
  if (!isTronNetworkKey(networkKey.toLowerCase())) return ''

  try {
    return ` (${getAddress(evmAddress.trim() as Address)})`
  } catch {
    return ''
  }
}
