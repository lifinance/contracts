/**
 * Diamond Cut proposer — encodes and routes a diamondCut proposal to the
 * correct Safe/Timelock proposer (EVM or Tron).
 *
 * Lives in the deployment domain so it can freely import proposer scripts
 * without creating cycles back through utils.ts.
 */

import { consola } from 'consola'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { getFacetSelectors } from '../../utils/utils'
import type { TronTvmNetworkName } from '../tron/types'

import { DIAMOND_CUT_ABI } from './constants'
import { isTronNetworkKey } from './tron-network-keys'

/**
 * Encode a `diamondCut` calldata for adding a facet.
 * Resolves selectors from Forge artifacts automatically.
 */
export async function encodeDiamondCutCalldata(
  facetName: string,
  facetAddressHex: Address
): Promise<Hex> {
  const selectors = await getFacetSelectors(facetName)

  consola.info(
    `Encoding diamondCut for ${facetName} (${selectors.length} selectors)`
  )

  return encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      [
        {
          facetAddress: facetAddressHex,
          action: 0,
          functionSelectors: selectors as Hex[],
        },
      ],
      '0x0000000000000000000000000000000000000000' as Address,
      '0x' as Hex,
    ],
  })
}

/**
 * Encode a diamondCut and propose it to Safe via Timelock.
 * Routes to the correct propose script based on network (Tron vs EVM).
 */
export async function proposeDiamondCut(options: {
  facetName: string
  facetAddressHex: Address
  diamondAddress: string
  network: string
  privateKey?: string
}): Promise<void> {
  const calldata = await encodeDiamondCutCalldata(
    options.facetName,
    options.facetAddressHex
  )

  if (isTronNetworkKey(options.network)) {
    const { runPropose } = await import('../tron/propose-to-safe-tron')
    await runPropose({
      network: options.network as TronTvmNetworkName,
      to: options.diamondAddress,
      calldata,
      timelock: true,
      privateKey: options.privateKey,
    })
  } else {
    const { runPropose } = await import('../safe/propose-to-safe')
    await runPropose({
      network: options.network,
      to: options.diamondAddress,
      calldata,
      timelock: true,
      privateKey: options.privateKey,
    })
  }
}
