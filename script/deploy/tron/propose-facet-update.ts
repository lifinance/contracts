/**
 * Helper for proposing Tron diamondCut updates via Safe → Timelock.
 *
 * Exports `planAndProposeFacetUpdates`, called by the
 * `deploy-and-register-*-facet.ts` scripts after a successful deploy.
 *
 * For each facet name:
 *   - Resolves the new facet address from `deployments/<network>.json`
 *     (the authoritative deployment log, written by deployContractWithLogging).
 *   - Reads the new facet's selectors from its Forge artifact.
 *   - Reads the live DiamondLoupe state via `readDiamondFacets`.
 *   - Computes Add/Replace/Remove via `buildDiamondCut` (TS port of
 *     `script/deploy/facets/utils/UpdateScriptBase.sol:buildDiamondCut`).
 *   - Emits one Safe → Timelock proposal per facet.
 */

import * as fs from 'fs'
import * as path from 'path'

import { consola } from 'consola'
import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem'

import { getFacetSelectors } from '../../utils/utils'
import {
  buildDiamondCut,
  FacetCutActionEnum,
  type IFacetCut,
} from '../shared/buildDiamondCut'
import { DIAMOND_CUT_ABI } from '../shared/constants'

import {
  getTronProposalContext,
  proposeViaTimelock,
} from './helpers/tronProposalContext'
import { readDiamondFacets } from './tronUtils'

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/** Plan FacetCuts for a single facet by diffing on-chain Loupe vs artifact. */
async function planForFacet(
  facetName: string,
  newAddressBase58: string,
  onChainFacets: Awaited<ReturnType<typeof readDiamondFacets>>,
  newAddrToEvmHex: (base58: string) => Address
): Promise<IFacetCut[]> {
  const newSelectors = (await getFacetSelectors(facetName)) as Hex[]
  if (newSelectors.length === 0)
    throw new Error(`No selectors found in Forge artifact for ${facetName}`)
  const newFacetAddress = newAddrToEvmHex(newAddressBase58)
  return buildDiamondCut({
    newSelectors,
    newFacetAddress,
    onChainFacets,
  })
}

/**
 * Plans `diamondCut` updates for the given facets and proposes one Safe →
 * Timelock transaction per facet. Reused by the CLI (interactive) and by
 * `deploy-core-facets.ts` (after each production redeploy). Returns silently
 * when every facet is already wired correctly.
 *
 * @throws if no `--facet` given, deployments file missing, or any facet has
 *   no entry in the deployment log.
 */
export async function planAndProposeFacetUpdates(options: {
  facetNames: string[]
  dryRun?: boolean
}): Promise<void> {
  const { facetNames, dryRun = false } = options
  if (facetNames.length === 0)
    throw new Error('planAndProposeFacetUpdates: at least one facet required')

  const { networkName, diamondAddressBase58, deployments, readTronWeb } =
    getTronProposalContext()

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
    const cuts = await planForFacet(
      facetName,
      newAddressBase58,
      onChainFacets,
      base58ToEvmHex
    )
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
