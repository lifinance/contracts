/**
 * Builds the constructor arguments for the core facets deployed to Tron, and
 * checks them against each facet's compiled ABI.
 *
 * Import this from any script that deploys the core facet set. The core facet
 * list is read from config, so a facet can be added to it with a constructor no
 * script has a branch for; the check here turns that into a failure before
 * anything is broadcast, rather than a facet deployed with no arguments.
 */

import {
  evmHexToTronBase58,
  getTronWebCodecOnlyForNetwork,
  loadForgeArtifact,
  tronAddressToHex,
} from '@lifi/tron-devkit'
import { consola } from 'consola'

import type { SupportedChain } from '../../../common/types'
import { assertTronDeploymentRecordable } from '../tronUtils'

/** Loads a compiled artifact by contract name. Injectable so tests need no `out/`. */
export type ArtifactLoader = (
  contractName: string
) => Promise<{ abi?: unknown }>

/**
 * Builds one facet's constructor arguments.
 *
 * Requires no private key, so it can run before a deployment is confirmed.
 *
 * @param facetName - Facet to build arguments for.
 * @param network - Tron network key the facet is being deployed to.
 * @param networksConfig - Parsed `config/networks.json`.
 * @returns Constructor values in declaration order, empty when the facet takes none.
 * @throws When a value the facet's constructor needs is missing from config.
 */
export async function getConstructorArgs(
  facetName: string,
  network: string,
  networksConfig: unknown
): Promise<unknown[]> {
  if (facetName === 'EmergencyPauseFacet') {
    const globalConfig = await Bun.file('config/global.json').json()
    const pauserWallet = globalConfig.pauserWallet // EVM 0x address
    const pauserWalletTron = globalConfig.tronWallets?.pauserWallet // Tron base58 address

    if (!pauserWallet)
      throw new Error('pauserWallet not found in config/global.json')

    // The encoder needs a 20-byte 0x address; the base58 form is for display only
    const displayAddr =
      pauserWalletTron ||
      evmHexToTronBase58(getTronWebCodecOnlyForNetwork(network), pauserWallet)
    consola.info(`Using pauserWallet: ${displayAddr} (hex: ${pauserWallet})`)
    return [pauserWallet]
  } else if (facetName === 'GenericSwapFacetV3') {
    const nativeAddress = (
      networksConfig as Record<string, { nativeAddress?: string } | undefined>
    )[network]?.nativeAddress

    if (!nativeAddress)
      throw new Error(
        `nativeAddress not found for ${network} in config/networks.json`
      )

    // Display only; the encoder takes the 0x form
    const tronBase58 = evmHexToTronBase58(
      getTronWebCodecOnlyForNetwork(network),
      nativeAddress
    )

    consola.info(
      `Using native token address: ${tronBase58} (hex: ${nativeAddress})`
    )
    return [nativeAddress]
  } else if (facetName === 'LiFiIntentEscrowFacetV2') {
    const escrowConfig = await Bun.file('config/lifiintentescrow.json').json()
    const inputSettlerTron = escrowConfig[network]?.lifiEscrowInputSettler

    if (!inputSettlerTron)
      throw new Error(
        `lifiEscrowInputSettler not found for ${network} in config/lifiintentescrow.json`
      )

    const inputSettler = tronAddressToHex(
      getTronWebCodecOnlyForNetwork(network),
      inputSettlerTron
    )

    consola.info(
      `Using input settler: ${inputSettlerTron} (hex: ${inputSettler})`
    )
    return [inputSettler]
  }

  return []
}

/**
 * Builds every core facet's constructor arguments and checks each against its ABI.
 *
 * Call this before deploying anything. The core facet list is config-driven, so
 * discovering a facet with unsupplied constructor arguments partway through the
 * deploy loop leaves the facets ahead of it paid for and the diamond unassembled.
 *
 * @param coreFacets - Facets about to be deployed.
 * @param network - Network the facets are being deployed to.
 * @param networksConfig - Parsed `config/networks.json`.
 * @param loadArtifact - Artifact loader; defaults to reading Forge's `out/`.
 * @returns Each facet's constructor values, keyed by facet name.
 * @throws When a facet's arguments do not match what its ABI declares, or a value
 * the constructor needs is missing from config.
 */
export async function resolveCoreFacetConstructorArgs(
  coreFacets: string[],
  network: SupportedChain,
  networksConfig: unknown,
  loadArtifact: ArtifactLoader = loadForgeArtifact
): Promise<Map<string, unknown[]>> {
  const argsByFacet = new Map<string, unknown[]>()

  for (const facet of coreFacets) {
    const args = await getConstructorArgs(facet, network, networksConfig)
    const artifact = await loadArtifact(facet)

    try {
      assertTronDeploymentRecordable(artifact, args, facet, network)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${message} They are built by getConstructorArgs in script/deploy/tron/helpers/coreFacetConstructorArgs.ts.`
      )
    }

    argsByFacet.set(facet, args)
  }

  return argsByFacet
}
