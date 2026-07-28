/**
 * Diamond Cut proposer — encodes and routes a diamondCut proposal to the
 * correct Safe/Timelock proposer (EVM or Tron).
 *
 * Lives in the deployment domain so it can freely import proposer scripts
 * without creating cycles back through utils.ts.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { consola } from 'consola'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { getFacetSelectors } from '../../utils/utils'
import type { TronTvmNetworkName } from '../tron/types'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from './constants'

/**
 * Post-cut initializer, delegatecalled by the diamond in the same transaction
 * as the cut. Mirrors the `_init`/`_calldata` pair that
 * `UpdateScriptBase.update()` passes on EVM. Grouped in one object so an
 * address can never be supplied without its calldata (or vice versa) — a
 * mismatched pair either silently skips the init or reverts the whole cut.
 */
export interface IDiamondCutInit {
  /** Contract to delegatecall — normally the facet being added. */
  readonly initAddress: Address
  /** Encoded initializer call, e.g. `initAllBridge(ChainIdConfig[])`. */
  readonly initCalldata: Hex
}

/**
 * Encode a `diamondCut` calldata for adding a facet.
 * Resolves selectors from Forge artifacts automatically.
 *
 * @param facetName - Facet whose selectors are read from the Forge artifact
 * @param facetAddressHex - Deployed facet address (EVM hex form)
 * @param options.init - Optional post-cut initializer (see {@link IDiamondCutInit})
 * @param options.excludeSelectors - Selectors to leave unregistered, mirroring
 *   `getExcludes()` on the EVM update scripts (e.g. an owner-only `init*`
 *   function that is delegatecalled by the cut and must not be reachable
 *   through the diamond afterwards)
 */
export async function encodeDiamondCutCalldata(
  facetName: string,
  facetAddressHex: Address,
  options: {
    init?: IDiamondCutInit
    excludeSelectors?: string[]
  } = {}
): Promise<Hex> {
  const selectors = await getFacetSelectors(
    facetName,
    options.excludeSelectors ?? []
  )

  if (selectors.length === 0)
    throw new Error(
      `No selectors left to register for ${facetName} after applying ${
        options.excludeSelectors?.length ?? 0
      } exclusion(s)`
    )

  consola.info(
    `Encoding diamondCut for ${facetName} (${selectors.length} selectors)`
  )

  if (options.init) {
    if (options.init.initCalldata === '0x')
      throw new Error(
        'init.initCalldata is empty (0x); omit `init` entirely instead — the diamond skips the delegatecall when calldata is empty, so the initializer would never run'
      )

    consola.info(
      `  + post-cut init via ${options.init.initAddress} (${
        options.init.initCalldata.length / 2 - 1
      } bytes calldata)`
    )
  }

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
      options.init?.initAddress ?? (ZERO_ADDRESS as Address),
      options.init?.initCalldata ?? ('0x' as Hex),
    ],
  })
}

/**
 * Encode a diamondCut and propose it to Safe via Timelock.
 * Routes to the correct propose script based on network (Tron vs EVM).
 *
 * The optional `init`/`excludeSelectors` pass straight through to
 * {@link encodeDiamondCutCalldata}, so the initializer rides inside the cut
 * itself — one timelock operation, no window in which the facet is live but
 * uninitialised.
 */
export async function proposeDiamondCut(options: {
  facetName: string
  facetAddressHex: Address
  diamondAddress: string
  network: string
  privateKey?: string
  init?: IDiamondCutInit
  excludeSelectors?: string[]
}): Promise<void> {
  const calldata = await encodeDiamondCutCalldata(
    options.facetName,
    options.facetAddressHex,
    { init: options.init, excludeSelectors: options.excludeSelectors }
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
