/**
 * Coverage gate for the `immutable-bindings-match-config` health-check invariant.
 *
 * That invariant only checks constructor args annotated with a `getter` in
 * `script/deploy/resources/deployRequirements.json`, so a contract added without the annotation
 * reopens the bug class the invariant exists to close — a counterparty bound immutably at
 * construction, pointing at a migrated or dead address, invisible to presence and owner checks.
 * This module finds every public immutable address getter declared in the deployed source trees
 * so a test can require each one to be either annotated or explicitly exempted.
 *
 * Import it from `immutableGetterCoverage.test.ts`. It reads Solidity sources rather than `out/`
 * artifacts on purpose: the only CI job that runs the TypeScript suite is Foundry-free, so an
 * artifact-based gate would skip there and enforce nothing.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'

import deployRequirementsJson from '../resources/deployRequirements.json'

import type { IDeployRequirementEntry } from './immutableBindings'

/** Directories whose contracts are deployed and therefore worth gating. */
const GATED_SOURCE_DIRECTORIES = ['src/Facets', 'src/Periphery', 'src/Security']

/**
 * Solidity restricts `immutable` to value types, so a declaration is address-valued unless its
 * type is one of these. Contract and interface types are address-valued and pass through.
 */
const NON_ADDRESS_VALUE_TYPE = /^(u?int\d*|bool|bytes\d*)$/

/**
 * Matches a `<type> public immutable <NAME>;` declaration.
 *
 * @remarks Solidity accepts the two specifiers in either order, and the whole declaration may be
 *   wrapped across lines, so neither is assumed — a form this pattern could not read would be a
 *   getter the gate never sees, which is the one failure mode it must not have. `address payable`
 *   is spelled out as the one two-word type in use; `public immutable` appears only in state
 *   variable declarations, so no line anchor is needed to avoid matching inside a function body.
 */
const PUBLIC_IMMUTABLE_DECLARATION =
  /(address\s+payable|[A-Za-z_][A-Za-z0-9_]*)\s+(?:public\s+immutable|immutable\s+public)\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g

/** One public immutable whose value is an address, and thus readable on chain by name. */
export interface IPublicImmutableGetter {
  getter: string
  solidityType: string
}

/** A public immutable getter located in the repo's Solidity sources. */
export interface IDeclaredImmutableGetter extends IPublicImmutableGetter {
  contractName: string
  /** Repo-relative path, so a failure message points at the file to fix. */
  sourceFile: string
}

/**
 * Bound to a contract LI.FI deploys itself, whose address comes from the deploy log rather than a
 * `config/*.json` file — the invariant has no config-side value to compare against.
 */
const LIFI_DEPLOYED_CONTRACT =
  'resolved from the deploy log, not config; covered by the periphery presence and registry checks'

/** Bound to a wallet LI.FI operates, not an external counterparty. */
const LIFI_OPERATED_WALLET =
  'a LI.FI-operated wallet rather than an external counterparty; covered by the wallet-role checks'

/**
 * Config does hold the expected value, so this is coverage still owed rather than a binding that
 * cannot be checked. Annotating it promotes an unverified binding to an error-severity comparison
 * on every chain at once, which needs a fleet-wide dry run first — tracked in EXSC-917.
 */
const ANNOTATION_PENDING_FLEET_DRY_RUN =
  'config-backed and annotatable; annotation deferred until a fleet dry run confirms it matches on chain'

/**
 * Public immutable address getters that `immutable-bindings-match-config` does not check, each
 * with the reason it is not checked. Keyed `<Contract>.<GETTER>`.
 *
 * @remarks This list may only shrink. Tests fail on an entry that has since been annotated or
 *   whose getter no longer exists, so it cannot quietly accumulate and misrepresent how much of
 *   the fleet is verified. Annotating the binding is always the preferred fix; add an entry here
 *   only when no config file holds a value to compare against.
 */
export const UNANNOTATED_IMMUTABLE_GETTERS: Record<string, string> = {
  'AcrossFacetPackedV4.SPOKEPOOL': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'AcrossFacetV4.SPOKEPOOL': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'AcrossV4SwapFacet.SPOKE_POOL': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'AcrossV4SwapFacet.SPOKE_POOL_PERIPHERY': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'AcrossV4SwapFacet.SPONSORED_CCTP_SRC_PERIPHERY':
    ANNOTATION_PENDING_FLEET_DRY_RUN,
  'AcrossV4SwapFacet.SPONSORED_OFT_SRC_PERIPHERY':
    ANNOTATION_PENDING_FLEET_DRY_RUN,
  'AcrossV4SwapFacet.WRAPPED_NATIVE': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'CelerCircleBridgeFacet.CIRCLE_BRIDGE_PROXY':
    ANNOTATION_PENDING_FLEET_DRY_RUN,
  'CelerCircleBridgeFacet.USDC': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'ChainflipFacet.CHAINFLIP_VAULT': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'EmergencyPauseFacet.pauserWallet': LIFI_OPERATED_WALLET,
  'FraxFacet.FRAX_HOP': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'FraxFacet.FRAX_PATH_USD': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'FraxFacet.FRAX_TIP_FEE_MANAGER': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'GasZipFacet.GAS_ZIP_ROUTER': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'GasZipPeriphery.GAS_ZIP_ROUTER': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'GasZipPeriphery.LIFI_DIAMOND': LIFI_DEPLOYED_CONTRACT,
  'GenericSwapFacetV3.NATIVE_ADDRESS': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'GlacisFacet.AIRLIFT': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'LayerSwapFacet.LAYERSWAP_DEPOSITORY': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'LiFiDEXAggregator.BENTO_BOX': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'LiFiIntentEscrowFacetV2.LIFI_INTENT_ESCROW_SETTLER_V2':
    ANNOTATION_PENDING_FLEET_DRY_RUN,
  'PaxosTransitFacet.TRANSIT_STATION': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'Permit2Proxy.LIFI_DIAMOND': LIFI_DEPLOYED_CONTRACT,
  'Permit2Proxy.PERMIT2': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'PolymerCCTPFacet.POLYMER_FEE_RECEIVER': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'PolymerCCTPFacet.TOKEN_MESSENGER': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'PolymerCCTPFacet.USDC': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'ReceiverAcrossV3.executor': LIFI_DEPLOYED_CONTRACT,
  'ReceiverAcrossV3.spokepool': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'ReceiverAcrossV4.EXECUTOR': LIFI_DEPLOYED_CONTRACT,
  'ReceiverChainflip.executor': LIFI_DEPLOYED_CONTRACT,
  'ReceiverOIF.EXECUTOR': LIFI_DEPLOYED_CONTRACT,
  'ReceiverStargateV2.executor': LIFI_DEPLOYED_CONTRACT,
  'RelayDepositoryFacet.RELAY_DEPOSITORY': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'StargateFacetV2.tokenMessaging': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'SupersetFacet.POOL_MANAGER': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'TokenWrapper.CONVERTER': ANNOTATION_PENDING_FLEET_DRY_RUN,
  'TokenWrapper.WRAPPED_TOKEN': ANNOTATION_PENDING_FLEET_DRY_RUN,
}

/**
 * Extract the address-valued public immutables declared in one Solidity source.
 *
 * @remarks A public immutable's compiler-generated getter carries the variable's own name, so the
 *   name found here is exactly the `getter` value a `deployRequirements.json` annotation needs.
 *   Value-typed and non-public immutables are skipped: the former cannot hold a counterparty, the
 *   latter expose nothing to read.
 * @param source - contents of a `.sol` file
 * @returns one entry per address-valued public immutable, in declaration order
 */
export function parsePublicImmutableGetters(
  source: string
): IPublicImmutableGetter[] {
  const found: IPublicImmutableGetter[] = []

  for (const [, rawType, getter] of source.matchAll(
    PUBLIC_IMMUTABLE_DECLARATION
  )) {
    if (!rawType || !getter) continue
    const solidityType = rawType.replace(/\s+/g, ' ')
    if (NON_ADDRESS_VALUE_TYPE.test(solidityType)) continue
    found.push({ getter, solidityType })
  }

  return found
}

/**
 * List every `.sol` file under a directory, recursing into subdirectories.
 *
 * @param directory - repo-relative directory to walk
 * @returns repo-relative paths, or an empty list when the directory is absent
 */
function listSolidityFiles(directory: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries.sort()) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) files.push(...listSolidityFiles(path))
    else if (entry.endsWith('.sol')) files.push(path)
  }
  return files
}

/**
 * Collect the address-valued public immutable getters declared by every deployed contract.
 *
 * @param directories - source roots to scan; defaults to the facet and periphery trees
 * @returns one entry per getter, sorted by contract then getter for stable output
 */
export function collectPublicImmutableGetters(
  directories: string[] = GATED_SOURCE_DIRECTORIES
): IDeclaredImmutableGetter[] {
  const declared: IDeclaredImmutableGetter[] = []

  for (const directory of directories)
    for (const sourceFile of listSolidityFiles(directory)) {
      const contractName = basename(sourceFile, '.sol')
      for (const getter of parsePublicImmutableGetters(
        readFileSync(sourceFile, 'utf8')
      ))
        declared.push({ ...getter, contractName, sourceFile })
    }

  return declared.sort((a, b) =>
    `${a.contractName}.${a.getter}`.localeCompare(
      `${b.contractName}.${b.getter}`
    )
  )
}

/**
 * The `<Contract>.<GETTER>` keys that `deployRequirements.json` already annotates.
 *
 * @remarks Read straight from the registry rather than through
 *   `collectImmutableBindingChecks`, so that a config file the annotation points at being
 *   unreadable cannot make an annotated binding look unannotated and shift the blame here.
 * @param deployRequirements - registry override, for tests
 * @returns the annotated keys
 */
export function collectAnnotatedGetterKeys(
  deployRequirements: Record<
    string,
    IDeployRequirementEntry
  > = deployRequirementsJson as Record<string, IDeployRequirementEntry>
): Set<string> {
  const keys = new Set<string>()

  for (const [contractName, entry] of Object.entries(deployRequirements))
    for (const configData of Object.values(entry.configData ?? {}))
      if (configData.getter) keys.add(`${contractName}.${configData.getter}`)

  return keys
}
