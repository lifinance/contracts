/**
 * Loupe reads against a Tron diamond: what the diamond routes where, today.
 *
 * Kept apart from the cut arithmetic in `facet-upgrade-cut.ts` (pure, unit
 * tested) so the arithmetic never needs a network to be exercised.
 */

import {
  getTronWebCodecOnlyForNetwork,
  tronAddressToHex,
  type TronTvmNetworkName,
} from '@lifi/tron-devkit'
import type { Address, Hex } from 'viem'

import {
  callTronContract,
  normalizeSelector,
  parseTronAddressOutput,
  parseTroncastArrayOutput,
} from './tronUtils'

/**
 * Makes a constant call and returns troncast's raw output. The seam exists so
 * the readers below can be tested against recorded output without a network —
 * mocking the module instead would leak into every other suite in the run.
 */
export type TronContractCaller = typeof callTronContract

/**
 * Reads the selectors a diamond currently routes to a facet.
 * @param diamondAddress - Diamond, base58
 * @param facetAddress - Facet to look up, base58
 * @param rpcUrl - Tron RPC the loupe is read through
 * @param call - Constant-call transport; defaults to troncast
 * @returns The registered selectors, `0x`-prefixed; empty when the facet serves none
 */
export async function readRegisteredSelectors(
  diamondAddress: string,
  facetAddress: string,
  rpcUrl: string,
  call: TronContractCaller = callTronContract
): Promise<Hex[]> {
  const output = await call(
    diamondAddress,
    'facetFunctionSelectors(address)',
    [facetAddress],
    'bytes4[]',
    rpcUrl
  )
  return parseTroncastArrayOutput(output).map((selector) =>
    normalizeSelector(String(selector))
  )
}

/**
 * Reads which facet a diamond currently routes a selector to.
 * @param diamondAddress - Diamond, base58
 * @param selector - Function selector
 * @param rpcUrl - Tron RPC the loupe is read through
 * @param network - Network key, for the base58→hex codec
 * @param call - Constant-call transport; defaults to troncast
 * @returns The facet address in EVM hex form; the zero address when unregistered
 */
export async function readFacetAddress(
  diamondAddress: string,
  selector: Hex,
  rpcUrl: string,
  network: TronTvmNetworkName,
  call: TronContractCaller = callTronContract
): Promise<Address> {
  const output = await call(
    diamondAddress,
    'facetAddress(bytes4)',
    [selector],
    'address',
    rpcUrl
  )
  return tronAddressToHex(
    getTronWebCodecOnlyForNetwork(network),
    parseTronAddressOutput(output)
  ) as Address
}
