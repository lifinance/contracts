/**
 * Builds the constructor arguments for the core facets deployed to Tron, and
 * checks them against each facet's compiled ABI.
 *
 * The core facet list is read from config, so a facet can be added to it with a
 * constructor no script has a branch for; the check here turns that into a
 * failure before anything is broadcast, rather than a facet deployed with no
 * arguments. Pass the set actually being deployed: `GasZipFacet` is in
 * `coreFacets` and has a constructor with no branch here, so an unfiltered list
 * fails on it.
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
        `${message} Core facet constructor arguments are built by getConstructorArgs in script/deploy/tron/helpers/coreFacetConstructorArgs.ts.`
      )
    }

    argsByFacet.set(facet, args)
  }

  return argsByFacet
}

/**
 * A well-formed address, used only to prove the diamond's constructor shape.
 */
const ARITY_PROBE_ADDRESS = '0x0000000000000000000000000000000000000001'

/**
 * The diamond's constructor parameters, in the order the deploy supplies them.
 *
 * The probe and the deploy call have to agree on this list. If they drift, the
 * pre-flight proves a shape the deploy does not use and the mismatch lands back
 * inside the deploy call — after every facet has been paid for, which is the
 * failure the probe exists to prevent. Deriving both from this const makes the
 * disagreement a compile error: adding a parameter here leaves the deploy site's
 * argument object missing a property.
 */
export const DIAMOND_CONSTRUCTOR_PARAMS = ['owner', 'diamondCutFacet'] as const

/** The values the deploy supplies, one per declared parameter. */
export type DiamondConstructorArgs = Record<
  (typeof DIAMOND_CONSTRUCTOR_PARAMS)[number],
  string
>

/**
 * Checks the diamond's constructor shape before any facet is deployed.
 *
 * The diamond is deployed last, after every facet has been paid for, and its
 * real arguments do not exist until the DiamondCutFacet has an address. Probing
 * with placeholders proves the arity while nothing has been spent. It does not
 * prove the parameter types: the placeholders are addresses, so a constructor
 * that kept its arity but changed a parameter to another word-sized type still
 * passes, and one that took an array or tuple would fail here for a reason that
 * is not arity.
 *
 * @param diamondName - Contract name of the diamond.
 * @param network - Network the diamond is being deployed to.
 * @param argCount - How many arguments the deploy call will pass, normally
 * `DIAMOND_CONSTRUCTOR_PARAMS.length`.
 * @param loadArtifact - Artifact loader; defaults to reading Forge's `out/`.
 * @throws When the ABI does not declare exactly `argCount` arguments, cannot be
 * read, or does not accept address-shaped placeholders.
 */
export async function assertDiamondConstructorShape(
  diamondName: string,
  network: SupportedChain,
  argCount: number,
  loadArtifact: ArtifactLoader = loadForgeArtifact
): Promise<void> {
  const artifact = await loadArtifact(diamondName)
  const probe = Array.from({ length: argCount }, () => ARITY_PROBE_ADDRESS)

  try {
    assertTronDeploymentRecordable(artifact, probe, diamondName, network)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${message} The diamond is deployed with [owner, diamondCutFacet] in script/deploy/tron/deploy-core-facets.ts.`
    )
  }
}
