/**
 * Diamond Cut proposer — encodes and routes a diamondCut proposal to the
 * correct Safe/Timelock proposer (EVM or Tron).
 *
 * Lives in the deployment domain so it can freely import proposer scripts
 * without creating cycles back through utils.ts.
 */

import {
  getTronWebCodecOnlyForNetwork,
  isTronNetworkKey,
  tronAddressToHex,
} from '@lifi/tron-devkit'
import { consola } from 'consola'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import {
  getEnvVar,
  getFacetAddressFromDiamondLog,
  getFacetSelectors,
  getRPCEnvVarName,
} from '../../utils/utils'
import {
  assertAddsAreUnrouted,
  buildFacetCuts,
  planSelectorCuts,
} from '../tron/facet-upgrade-cut'
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
 * Encode a `diamondCut` that installs a facet over whatever the diamond routes
 * today: Add for selectors it does not serve, Replace for the ones the outgoing
 * facet serves, Remove for the ones the new version dropped.
 *
 * Reads the live loupe, so it needs a network — Tron only, since that is where
 * every caller of {@link proposeDiamondCut} runs. A first registration
 * (no diamond-log entry for the facet) reduces to the plain Add cut.
 *
 * @param facetName - Facet whose selectors are read from the Forge artifact
 * @param facetAddressHex - Newly deployed facet (EVM hex form)
 * @param network - Tron network key
 * @param diamondAddress - Diamond, base58
 * @param options - Same `init`/`excludeSelectors` as {@link encodeDiamondCutCalldata}
 * @throws When a selector is served by a facet that is not the outgoing one —
 *   an Add would revert at execution, and taking it over silently would strand
 *   the other facet's remaining selectors
 */
export async function encodeFacetUpgradeCutCalldata(
  facetName: string,
  facetAddressHex: Address,
  network: TronTvmNetworkName,
  diamondAddress: string,
  options: {
    init?: IDiamondCutInit
    excludeSelectors?: string[]
  } = {}
): Promise<Hex> {
  // Dynamic, like the proposer imports below: the loupe reads pull in the Tron
  // deploy stack, which an EVM cut never needs.
  const { readFacetAddress, readRegisteredSelectors } = await import(
    '../tron/diamond-loupe-reads'
  )

  const newSelectors = await getFacetSelectors(
    facetName,
    options.excludeSelectors ?? []
  )
  if (newSelectors.length === 0)
    throw new Error(
      `No selectors left to register for ${facetName} after applying ${
        options.excludeSelectors?.length ?? 0
      } exclusion(s)`
    )

  const rpcUrl = getEnvVar(getRPCEnvVarName(network))
  const codec = getTronWebCodecOnlyForNetwork(network)
  const toHex = (base58: string): Address =>
    (tronAddressToHex(codec, base58) as Address).toLowerCase() as Address

  const outgoingBase58 = await getFacetAddressFromDiamondLog(network, facetName)
  const outgoingHex = outgoingBase58 ? toHex(outgoingBase58) : null

  const registered =
    outgoingBase58 && outgoingHex !== facetAddressHex.toLowerCase()
      ? await readRegisteredSelectors(diamondAddress, outgoingBase58, rpcUrl)
      : []

  if (outgoingBase58 && registered.length === 0)
    consola.warn(
      `${facetName} is logged at ${outgoingBase58} but serves no selectors on ${diamondAddress} — proposing a plain add cut`
    )

  const plan = planSelectorCuts(newSelectors, registered)

  await assertAddsAreUnrouted(
    plan.add,
    facetName,
    outgoingBase58 ?? 'facet',
    (selector) => readFacetAddress(diamondAddress, selector, rpcUrl, network)
  )

  const cuts = buildFacetCuts(plan, facetAddressHex)
  if (cuts.length === 0)
    throw new Error(
      `${facetName} at ${facetAddressHex} is already what the diamond routes — nothing to cut`
    )

  consola.info(
    `Encoding diamondCut for ${facetName}: ${plan.add.length} added, ${plan.replace.length} replaced, ${plan.remove.length} removed`
  )
  if (plan.remove.length > 0)
    consola.info(
      `  - removing ${plan.remove.join(', ')} from ${outgoingBase58}`
    )

  if (options.init) {
    if (options.init.initCalldata === '0x')
      throw new Error(
        'init.initCalldata is empty (0x); omit `init` entirely instead — the diamond skips the delegatecall when calldata is empty, so the initializer would never run'
      )

    consola.info(`  + post-cut init via ${options.init.initAddress}`)
  }

  return encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      cuts,
      options.init?.initAddress ?? (ZERO_ADDRESS as Address),
      options.init?.initCalldata ?? ('0x' as Hex),
    ],
  })
}

/**
 * Encode a diamondCut and propose it to Safe via Timelock.
 * Routes to the correct propose script based on network (Tron vs EVM).
 *
 * On Tron the cut is planned against the live loupe by
 * {@link encodeFacetUpgradeCutCalldata}, so an upgrade replaces and removes
 * what it has to; an Add-only cut would revert on the first unchanged selector
 * and leave the superseded version routable.
 *
 * The optional `init`/`excludeSelectors` pass straight through, so the
 * initializer rides inside the cut itself — one timelock operation, no window
 * in which the facet is live but uninitialised.
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
  const calldata = isTronNetworkKey(options.network)
    ? await encodeFacetUpgradeCutCalldata(
        options.facetName,
        options.facetAddressHex,
        options.network as TronTvmNetworkName,
        options.diamondAddress,
        { init: options.init, excludeSelectors: options.excludeSelectors }
      )
    : await encodeDiamondCutCalldata(
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
