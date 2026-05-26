/**
 * Chain-agnostic helper for proposing diamondCut updates via Safe → Timelock.
 *
 * Plans the Add/Replace/Remove diff (via `buildDiamondCut`, a TS port of
 * `script/deploy/facets/utils/UpdateScriptBase.sol:buildDiamondCut`) and
 * submits one Safe → Timelock proposal per facet.
 *
 * Dispatches on `isTronNetworkKey(network)`:
 *   - **Tron**: reads Loupe via TronWeb, proposes via `propose-to-safe-tron`.
 *     Tron-specific modules (TronWeb, base58 codec) are loaded via dynamic
 *     `await import()` so EVM-only consumers don't pull them into their bundle.
 *   - **EVM**: not implemented in TS. EVM facet updates go through
 *     `script/tasks/diamondUpdateFacet.sh`, which runs `Update<Facet>.s.sol`
 *     via forge — `UpdateScriptBase.sol:buildDiamondCut` computes the diff
 *     on-chain via Loupe — and pipes the captured calldata to
 *     `propose-to-safe.ts --timelock`. This branch throws with a pointer to
 *     that flow, preserving the chain-agnostic API contract for future
 *     TS-side EVM use.
 */

import * as fs from 'fs'
import * as path from 'path'

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { consola } from 'consola'
import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem'

import { getFacetSelectors } from '../../utils/utils'

import {
  buildDiamondCut,
  FacetCutActionEnum,
  type IFacetCut,
} from './buildDiamondCut'
import { DIAMOND_CUT_ABI } from './constants'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/**
 * Plans `diamondCut` updates for the given facets and proposes one Safe →
 * Timelock transaction per facet. Returns silently when every facet is
 * already wired correctly.
 *
 * @param options.network     Target network key (e.g. `tron`, `tronshasta`,
 *                            or any EVM network from `config/networks.json`).
 *                            Chain dispatch is decided by
 *                            `isTronNetworkKey(network)`.
 * @param options.facetNames  Facet names to propose updates for. Addresses
 *                            are resolved from `deployments/<network>.json`.
 * @param options.dryRun      When true, prints the planned cuts + encoded
 *                            calldata but does not write to MongoDB.
 * @throws on missing deployments file, missing facet entries, EVM dispatch
 *   (not yet implemented), or any underlying TronWeb / propose-to-safe error.
 */
export async function planAndProposeDiamondCut(options: {
  network: string
  facetNames: string[]
  dryRun?: boolean
}): Promise<void> {
  if (isTronNetworkKey(options.network))
    return planAndProposeDiamondCutForTron(options)
  throw new Error(
    `planAndProposeDiamondCut: EVM TS-side proposing not yet implemented. ` +
      `For EVM networks, use \`script/tasks/diamondUpdateFacet.sh\` which ` +
      `runs Update<Facet>.s.sol via forge and pipes the captured calldata ` +
      `to propose-to-safe.ts --timelock.`
  )
}

async function planAndProposeDiamondCutForTron(options: {
  network: string
  facetNames: string[]
  dryRun?: boolean
}): Promise<void> {
  const { facetNames, dryRun = false } = options
  if (facetNames.length === 0)
    throw new Error('planAndProposeDiamondCut: at least one facet required')

  // Dynamic imports keep TronWeb / Tron helpers out of EVM-only consumers.
  const { getTronProposalContext, proposeViaTimelock } = await import(
    '../tron/helpers/tronProposalContext'
  )
  const { readDiamondFacets } = await import('../tron/tronUtils')

  const { networkName, diamondAddressBase58, deployments, readTronWeb } =
    getTronProposalContext(
      options.network as Parameters<typeof getTronProposalContext>[0]
    )

  // Load DiamondLoupeFacet ABI from the Forge artifact (already on disk
  // post-`forge build`).
  const loupeArtifactPath = path.join(
    process.cwd(),
    'out',
    'DiamondLoupeFacet.sol',
    'DiamondLoupeFacet.json'
  )
  if (!fs.existsSync(loupeArtifactPath))
    throw new Error(
      `${loupeArtifactPath} not found — run \`forge build\` first`
    )
  const diamondLoupeAbi = JSON.parse(fs.readFileSync(loupeArtifactPath, 'utf8'))
    .abi as Abi

  consola.info(`Network: ${networkName}`)
  consola.info(`Diamond: ${diamondAddressBase58}`)
  consola.info(`Facets to plan: ${facetNames.join(', ')}`)

  const onChainFacets = await readDiamondFacets(
    readTronWeb,
    diamondAddressBase58,
    diamondLoupeAbi
  )
  consola.info(
    `On-chain Loupe reports ${onChainFacets.length} registered facet(s)`
  )

  // Reusable base58 → EVM-20 hex converter (no signer needed for codec).
  const base58ToEvmHex = (base58: string): Address => {
    const hex = readTronWeb.address.toHex(base58)
    return (hex.startsWith('41') ? `0x${hex.slice(2)}` : hex) as Address
  }

  let proposed = 0
  let skipped = 0
  for (const facetName of facetNames) {
    const newAddressBase58 = deployments[facetName]
    if (!newAddressBase58)
      throw new Error(
        `Facet ${facetName} not found in deployments/${networkName}.json`
      )

    const newSelectors = (await getFacetSelectors(facetName)) as Hex[]
    if (newSelectors.length === 0)
      throw new Error(`No selectors found in Forge artifact for ${facetName}`)
    const newFacetAddress = base58ToEvmHex(newAddressBase58)
    const cuts: IFacetCut[] = buildDiamondCut({
      newSelectors,
      newFacetAddress,
      onChainFacets,
    })

    if (cuts.length === 0) {
      consola.info(
        `  ✓ ${facetName} (${newAddressBase58}): already wired, skipping`
      )
      skipped++
      continue
    }

    const summary = cuts
      .map(
        (c) => `${FacetCutActionEnum[c.action]}×${c.functionSelectors.length}`
      )
      .join(', ')
    consola.info(`  → ${facetName} (${newAddressBase58}): ${summary}`)

    const calldata: Hex = encodeFunctionData({
      abi: DIAMOND_CUT_ABI,
      functionName: 'diamondCut',
      args: [
        cuts.map((c) => ({
          facetAddress: c.facetAddress,
          action: c.action,
          functionSelectors: c.functionSelectors,
        })),
        ZERO_ADDRESS,
        '0x',
      ],
    })

    consola.info(
      `Encoded diamondCut calldata for ${facetName} (${
        calldata.length / 2
      } bytes)`
    )
    if (dryRun)
      consola.info(
        `--dryRun — FacetCut plan for ${facetName}:\n${JSON.stringify(
          cuts.map((c) => ({
            facetAddress: c.facetAddress,
            action: FacetCutActionEnum[c.action],
            functionSelectors: c.functionSelectors,
          })),
          null,
          2
        )}`
      )

    await proposeViaTimelock({
      networkName,
      diamondAddressBase58,
      calldata,
      dryRun,
    })
    proposed++
  }

  if (proposed === 0 && skipped === facetNames.length)
    consola.success(
      'No changes needed — every facet is already wired correctly.'
    )
  else
    consola.info(
      `Done — proposed ${proposed} facet update(s), skipped ${skipped} already-wired facet(s).`
    )
}
