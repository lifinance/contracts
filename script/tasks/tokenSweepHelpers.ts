/**
 * Helpers for the ERC20 sweep (`moveTokenFundsToNewWallet.ts`): the minimal ERC20 ABI and
 * a validating parser for the curated per-network token list. Kept separate from the CLI so
 * the pure parsing logic can be unit-tested without triggering the command's `runMain`.
 */

import { getAddress, parseAbi, type Address } from 'viem'

/** Minimal ERC20 surface needed to read balances and sweep them. */
export const ERC20_SWEEP_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

/** Curated list of ERC20 token contracts to sweep, keyed by network name. */
export interface ITokenSweepList {
  [network: string]: Address[]
}

/**
 * Parses and validates a curated token-sweep list from JSON text.
 *
 * The list is human-curated (e.g. from a portfolio export) so only tokens worth more than the
 * gas to move them are included — the sweep itself applies no USD threshold.
 *
 * @param raw - JSON of shape `{ "<network>": ["0xTokenAddress", ...], ... }`.
 * @returns The parsed list with every token address checksummed.
 * @throws If the JSON is not an object, an entry is not an array, or any address is invalid.
 */
export function parseTokenSweepList(raw: string): ITokenSweepList {
  const parsed: unknown = JSON.parse(raw)

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(
      'Token list must be a JSON object of { network: [tokenAddress, ...] }'
    )

  const result: ITokenSweepList = {}
  for (const [network, addresses] of Object.entries(parsed)) {
    if (!Array.isArray(addresses))
      throw new Error(`Token list entry for "${network}" must be an array`)

    result[network] = addresses.map((entry) => {
      if (typeof entry !== 'string')
        throw new Error(`Non-string token address in "${network}"`)
      // getAddress throws on a malformed address, failing fast on a bad list.
      return getAddress(entry)
    })
  }

  return result
}
