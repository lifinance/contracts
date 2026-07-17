/**
 * Target-state-diff engine for removing deprecated facets from a LiFiDiamond.
 *
 * Given a network + environment it compares the diamond's on-chain loupe
 * (`facets()`) against `script/deploy/_targetState.json` and returns the set of
 * facets that are registered on-chain but no longer present in target state
 * (i.e. deprecated) and are therefore safe to remove. The on-chain loupe is the
 * source of truth for which selectors each facet owns, so this works even for
 * facets whose source (and `out/` artifact) was already deleted by
 * `/deprecate-contract`.
 *
 * Consumed by `script/tasks/cleanUpProdDiamond.ts` (interactive `--auto` and
 * fleet `--all-networks` modes). Pure diff logic (`diffFacets`) is separated
 * from I/O (`computeFacetRemovalDiff`) so both are unit-testable; all I/O is
 * injectable via the `io` parameter.
 */

import * as fs from 'fs'
import * as path from 'path'

import { createPublicClient, getAddress, http, parseAbi } from 'viem'

import type { EnvironmentEnum, SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import {
  getFunctionSelectors,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import targetStateJson from '../_targetState.json'
import { getCoreFacets, getCorePeriphery } from '../shared/globalContractLists'

/**
 * Diamond-machinery facets that permanently brick the diamond if removed. They
 * are protected independent of config/target state: `/deprecate-contract` edits
 * both, and a bad edit must never make these removable.
 */
export const HARDCODED_PROTECTED_FACETS = [
  'DiamondCutFacet',
  'DiamondLoupeFacet',
  'OwnershipFacet',
  'EmergencyPauseFacet',
] as const

/** Diamond contract names never treated as removable facets. */
const DIAMOND_NAMES = ['LiFiDiamond', 'LiFiDiamondImmutable'] as const

const FACETS_ABI = parseAbi([
  'function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])',
])

/** A single facet slated for removal, with the selectors taken from the loupe. */
export interface IFacetRemoval {
  name: string
  address: `0x${string}`
  selectors: `0x${string}`[]
}

/** Selectors held back from a removal because an active facet is expected to own them. */
export interface IHeldBackSelectors {
  facet: string
  selectors: `0x${string}`[]
}

/** Result of diffing on-chain facets against target state for one network. */
export interface IRemovalDiff {
  network: string
  environment: EnvironmentEnum
  diamondAddress?: `0x${string}`
  removals: IFacetRemoval[]
  /** On-chain, absent from target state, but on the never-remove allowlist. */
  protectedSkipped: string[]
  /** On-chain facet addresses not found in the deploy log — never auto-removed. */
  unresolved: `0x${string}`[]
  /** Selectors refused because an active facet is expected to own them (mis-wiring signal). */
  heldBackSelectors: IHeldBackSelectors[]
  /** Allowlisted facet dropped from target state (a target-state bug worth surfacing). */
  targetStateMissingProtected: string[]
  /**
   * On-chain, absent from target state, but the source still exists in `src/` —
   * i.e. target-state drift, NOT a deprecation. Surfaced, never removed: only a
   * facet whose source was deleted by `/deprecate-contract` is a removal candidate.
   */
  driftDetected: string[]
}

/** A facet as returned by the on-chain `facets()` loupe call. */
export interface IOnChainFacet {
  address: `0x${string}`
  selectors: `0x${string}`[]
}

/** Injectable I/O for {@link computeFacetRemovalDiff}; defaults hit the real chain/files. */
export interface IRemovalDiffIO {
  getDiamondAddress: (
    network: string,
    environment: EnvironmentEnum
  ) => Promise<`0x${string}` | undefined>
  getOnChainFacets: (
    diamondAddress: `0x${string}`,
    network: string
  ) => Promise<IOnChainFacet[]>
  getAddressToName: (
    network: string,
    environment: EnvironmentEnum
  ) => Promise<Record<string, string>>
  getExpectedNames: (
    network: string,
    environment: EnvironmentEnum
  ) => Set<string>
  /** Union of selectors owned by the given (active) facet names whose artifacts exist. */
  getActiveSelectors: (names: string[]) => Set<string>
  /** Set of contract names whose `.sol` source still exists under `src/`. */
  getSourceNames: () => Set<string>
}

const lower = (s: string): string => s.toLowerCase()

/** Returns the never-remove allowlist: hardcoded machinery ∪ core facets ∪ core periphery ∪ diamonds. */
export function getProtectedNames(): Set<string> {
  return new Set<string>([
    ...HARDCODED_PROTECTED_FACETS,
    ...getCoreFacets(),
    ...getCorePeriphery(),
    ...DIAMOND_NAMES,
  ])
}

/**
 * Recursively collects the basenames (without `.sol`) of every Solidity source
 * file under `srcDir`. A facet is only a removal candidate if its name is NOT in
 * this set: a facet on-chain and absent from target state but whose source still
 * exists is target-state drift (a live facet the state hasn't recorded), not a
 * deprecation, and must never be auto-removed.
 */
export function getSourceContractNames(srcDir = 'src'): Set<string> {
  const names = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.sol'))
        names.add(entry.name.replace(/\.sol$/, ''))
    }
  }
  if (fs.existsSync(srcDir)) walk(srcDir)
  return names
}

/** Inverts a deploy-log `{name: address}` map into `{lowercasedAddress: name}`. */
export function buildAddressToName(
  deployments: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, address] of Object.entries(deployments)) {
    if (typeof address === 'string' && address.startsWith('0x'))
      out[lower(address)] = name
  }
  return out
}

/** Returns the set of contract names listed under `LiFiDiamond` in target state for a network/env. */
export function getExpectedFacetNames(
  network: string,
  environment: EnvironmentEnum
): Set<string> {
  const state = targetStateJson as Record<
    string,
    Record<string, Record<string, Record<string, string>>>
  >
  const diamond = state[lower(network)]?.[environment]?.LiFiDiamond
  if (!diamond) return new Set<string>()
  return new Set<string>(Object.keys(diamond))
}

/**
 * Union of function selectors declared by the given active facet names, read from
 * compiled artifacts. These selectors are exactly what a removal must NEVER sweep
 * out from under a facet that should keep them, so the gate fails **closed**:
 * every name passed here is an active facet expected by target state, so a
 * missing/unreadable artifact means a stale build — not a deprecation — and we
 * throw rather than silently return an incomplete protected set. Run
 * `forge build` before a removal.
 *
 * @param selectorsOf - Selector lookup; defaults to reading `out/` artifacts. Injectable for tests.
 */
export function collectActiveSelectors(
  names: string[],
  selectorsOf: (name: string) => `0x${string}`[] = getFunctionSelectors
): Set<string> {
  const selectors = new Set<string>()
  for (const name of names)
    try {
      for (const sel of selectorsOf(name)) selectors.add(lower(sel))
    } catch (error) {
      throw new Error(
        `Cannot read selectors for active facet "${name}" — its artifact is ` +
          `missing or unreadable. Run "forge build" and retry; refusing to ` +
          `compute a facet removal from an incomplete protected-selector set. ` +
          `Underlying: ${
            error instanceof Error ? error.message : String(error)
          }`
      )
    }
  return selectors
}

/** Maps a raw on-chain `facets()` loupe result into {@link IOnChainFacet}s (checksummed addresses). */
export function mapLoupeResult(
  result: readonly {
    facetAddress: `0x${string}`
    functionSelectors: readonly `0x${string}`[]
  }[]
): IOnChainFacet[] {
  return result.map((f) => ({
    address: getAddress(f.facetAddress),
    selectors: [...f.functionSelectors],
  }))
}

/** Live-RPC reader: calls `facets()` on the diamond. Isolated so callers can inject a fake. */
async function readFacetsFromChain(
  diamondAddress: `0x${string}`,
  network: string
): Promise<
  readonly {
    facetAddress: `0x${string}`
    functionSelectors: readonly `0x${string}`[]
  }[]
> {
  const client = createPublicClient({
    chain: getViemChainForNetworkName(network),
    transport: http(),
  })
  return client.readContract({
    address: diamondAddress,
    abi: FACETS_ABI,
    functionName: 'facets',
  })
}

/**
 * Fetches and maps the diamond's on-chain facets.
 *
 * @param reader - Raw `facets()` reader; defaults to a live RPC call. Injectable for tests.
 */
export async function fetchOnChainFacets(
  diamondAddress: `0x${string}`,
  network: string,
  reader = readFacetsFromChain
): Promise<IOnChainFacet[]> {
  return mapLoupeResult(await reader(diamondAddress, network))
}

/**
 * Pure diff: partitions on-chain facets into removals / protected / unresolved,
 * holding back any selector an active facet is expected to own.
 *
 * @param params.onChainFacets - Facets from the diamond loupe (source of truth for selectors).
 * @param params.addressToName - Lowercased on-chain address → contract name (from deploy log).
 * @param params.expectedNames - Contract names present in target state (kept).
 * @param params.protectedNames - Never-remove allowlist.
 * @param params.activeSelectors - Lowercased selectors owned by active facets (held back if matched).
 * @param params.sourceNames - Contract names whose `.sol` source still exists (drift, not deprecation).
 */
export function diffFacets(params: {
  network: string
  environment: EnvironmentEnum
  diamondAddress?: `0x${string}`
  onChainFacets: IOnChainFacet[]
  addressToName: Record<string, string>
  expectedNames: Set<string>
  protectedNames: Set<string>
  activeSelectors: Set<string>
  sourceNames: Set<string>
}): IRemovalDiff {
  const {
    network,
    environment,
    diamondAddress,
    onChainFacets,
    addressToName,
    expectedNames,
    protectedNames,
    activeSelectors,
    sourceNames,
  } = params

  const diff: IRemovalDiff = {
    network,
    environment,
    diamondAddress,
    removals: [],
    protectedSkipped: [],
    unresolved: [],
    heldBackSelectors: [],
    targetStateMissingProtected: [],
    driftDetected: [],
  }

  for (const facet of onChainFacets) {
    const name = addressToName[lower(facet.address)]

    if (!name) {
      diff.unresolved.push(facet.address)
      continue
    }

    if (protectedNames.has(name)) {
      diff.protectedSkipped.push(name)
      if (!expectedNames.has(name)) diff.targetStateMissingProtected.push(name)
      continue
    }

    if (expectedNames.has(name)) continue

    // On-chain and absent from target state, but source still exists → drift, not
    // deprecation. A live facet the state hasn't recorded — never auto-remove.
    if (sourceNames.has(name)) {
      diff.driftDetected.push(name)
      continue
    }

    // Removal candidate: hold back any selector an active facet is expected to own.
    const held: `0x${string}`[] = []
    const toRemove: `0x${string}`[] = []
    for (const sel of facet.selectors)
      if (activeSelectors.has(lower(sel))) held.push(sel)
      else toRemove.push(sel)

    if (held.length > 0)
      diff.heldBackSelectors.push({ facet: name, selectors: held })
    if (toRemove.length > 0)
      diff.removals.push({ name, address: facet.address, selectors: toRemove })
  }

  return diff
}

/** Deploy-log loader shape; defaults to {@link getDeployments}. Injectable for tests. */
export type DeployLogLoader = (
  network: string,
  environment: EnvironmentEnum
) => Promise<Record<string, unknown>>

const defaultLoader: DeployLogLoader = (network, environment) =>
  getDeployments(network as SupportedChain, environment)

/** Reads the mutable `LiFiDiamond` address from the deploy log; `undefined` if absent. */
export async function resolveDiamondAddress(
  network: string,
  environment: EnvironmentEnum,
  loader: DeployLogLoader = defaultLoader
): Promise<`0x${string}` | undefined> {
  const deployments = await loader(network, environment)
  const address = deployments.LiFiDiamond
  return typeof address === 'string' && address.startsWith('0x')
    ? getAddress(address)
    : undefined
}

/** Reads the deploy log and inverts it to a lowercased address → name map. */
export async function resolveAddressToName(
  network: string,
  environment: EnvironmentEnum,
  loader: DeployLogLoader = defaultLoader
): Promise<Record<string, string>> {
  const deployments = await loader(network, environment)
  return buildAddressToName(deployments)
}

const defaultIO: IRemovalDiffIO = {
  getDiamondAddress: resolveDiamondAddress,
  getOnChainFacets: fetchOnChainFacets,
  getAddressToName: resolveAddressToName,
  getExpectedNames: getExpectedFacetNames,
  getActiveSelectors: collectActiveSelectors,
  getSourceNames: () => getSourceContractNames(),
}

/**
 * Computes the facet-removal diff for one network/environment by gathering the
 * on-chain loupe, deploy log, target state and protected sets, then delegating
 * to {@link diffFacets}. Returns an empty diff (no `diamondAddress`) if the
 * network has no `LiFiDiamond` deployed in that environment.
 *
 * @param io - Injectable I/O overrides for testing; defaults hit the real chain/files.
 */
export async function computeFacetRemovalDiff(
  network: string,
  environment: EnvironmentEnum,
  io: Partial<IRemovalDiffIO> = {}
): Promise<IRemovalDiff> {
  const resolved: IRemovalDiffIO = { ...defaultIO, ...io }

  const diamondAddress = await resolved.getDiamondAddress(network, environment)
  const empty: IRemovalDiff = {
    network,
    environment,
    removals: [],
    protectedSkipped: [],
    unresolved: [],
    heldBackSelectors: [],
    targetStateMissingProtected: [],
    driftDetected: [],
  }
  if (!diamondAddress) return empty

  const [onChainFacets, addressToName] = await Promise.all([
    resolved.getOnChainFacets(diamondAddress, network),
    resolved.getAddressToName(network, environment),
  ])

  const expectedNames = resolved.getExpectedNames(network, environment)
  const protectedNames = getProtectedNames()

  // Selectors that must never be swept out from under an active facet: the union
  // owned by EVERY facet target state expects to keep — not only those already
  // routed on-chain. A replacement facet listed in target state but not yet
  // registered still owns its selectors, so a deprecated facet currently holding
  // them must have them held back, not removed. Fails closed on a missing
  // artifact (see collectActiveSelectors).
  const activeSelectors = resolved.getActiveSelectors([...expectedNames])
  const sourceNames = resolved.getSourceNames()

  return diffFacets({
    network,
    environment,
    diamondAddress,
    onChainFacets,
    addressToName,
    expectedNames,
    protectedNames,
    activeSelectors,
    sourceNames,
  })
}

/** Result of resolving an explicit set of facet names against one diamond. */
export interface INamedRemovalResult {
  network: string
  environment: EnvironmentEnum
  diamondAddress?: `0x${string}`
  removals: IFacetRemoval[]
  /** Requested names not registered on this diamond (nothing to remove here). */
  notFoundOnChain: string[]
  /** Requested names on the never-remove allowlist — refused (should never be deprecated). */
  protectedSkipped: string[]
  /**
   * Requested names whose deploy-log entry was pruned (so the loupe address no
   * longer resolves to the name) but whose stored `facetAddress` is still routed
   * on-chain. NOT gone — the log was pruned prematurely. Surfaced (never removed,
   * never superseded) so a human restores the log entry; empty unless a
   * `nameToAddress` hint is supplied (spec §8 deploy-log longevity hazard).
   */
  prunedButRouted: { name: string; address: `0x${string}` }[]
}

/**
 * Pure resolution of an explicit set of requested facet names against the
 * on-chain loupe. Unlike {@link diffFacets} there is no target-state diff and no
 * source/drift gate: the caller has *explicitly named* the facets to remove
 * (e.g. via `/deprecate-contract`), so the only checks are "is it actually on
 * this diamond" and "is it on the never-remove allowlist". Selectors come from
 * the loupe (the diamond's current routing for that address).
 */
export function diffNamedFacets(params: {
  network: string
  environment: EnvironmentEnum
  diamondAddress?: `0x${string}`
  requestedNames: Set<string>
  onChainFacets: IOnChainFacet[]
  addressToName: Record<string, string>
  protectedNames: Set<string>
  /**
   * Optional `name → stored facetAddress` hint (e.g. a parked task's snapshot).
   * A requested name that resolves via neither the log nor this hint stays in
   * `notFoundOnChain`; one whose hinted address is still routed on-chain but is
   * no longer in the log is moved to `prunedButRouted` instead (spec §8).
   */
  nameToAddress?: Record<string, `0x${string}`>
}): INamedRemovalResult {
  const {
    network,
    environment,
    diamondAddress,
    requestedNames,
    onChainFacets,
    addressToName,
    protectedNames,
    nameToAddress,
  } = params

  const result: INamedRemovalResult = {
    network,
    environment,
    diamondAddress,
    removals: [],
    notFoundOnChain: [],
    protectedSkipped: [],
    prunedButRouted: [],
  }

  const foundOnChain = new Set<string>()
  for (const facet of onChainFacets) {
    const name = addressToName[lower(facet.address)]
    if (!name || !requestedNames.has(name)) continue
    foundOnChain.add(name)

    if (protectedNames.has(name)) {
      result.protectedSkipped.push(name)
      continue
    }

    result.removals.push({
      name,
      address: facet.address,
      selectors: facet.selectors,
    })
  }

  // A name absent from the log is normally "gone", but if its stored address is
  // still routed on-chain the log was pruned prematurely — keep it out of
  // `notFoundOnChain` so the drain never false-supersedes a live facet.
  const onChainAddresses = new Set(onChainFacets.map((f) => lower(f.address)))
  for (const name of requestedNames) {
    if (foundOnChain.has(name)) continue
    const hinted = nameToAddress?.[name]
    if (hinted && onChainAddresses.has(lower(hinted)))
      result.prunedButRouted.push({
        name,
        address: getAddress(lower(hinted)),
      })
    else result.notFoundOnChain.push(name)
  }

  return result
}

/**
 * Resolves an explicit set of facet names against a single diamond and returns
 * the ones to remove (registered on-chain and not protected), taking selectors
 * from the loupe so it works after the facet's source/artifact was deleted by
 * `/deprecate-contract`. This is the deprecation-driven removal path; the
 * facet-name set comes from the deprecation, not from a target-state diff.
 *
 * @param io - Injectable I/O overrides for testing; defaults hit the real chain/files.
 */
export async function computeNamedFacetRemovals(
  network: string,
  environment: EnvironmentEnum,
  names: string[],
  io: Partial<IRemovalDiffIO> = {},
  nameToAddress?: Record<string, `0x${string}`>
): Promise<INamedRemovalResult> {
  const resolved: IRemovalDiffIO = { ...defaultIO, ...io }

  const diamondAddress = await resolved.getDiamondAddress(network, environment)
  if (!diamondAddress)
    return {
      network,
      environment,
      removals: [],
      notFoundOnChain: names,
      protectedSkipped: [],
      prunedButRouted: [],
    }

  const [onChainFacets, addressToName] = await Promise.all([
    resolved.getOnChainFacets(diamondAddress, network),
    resolved.getAddressToName(network, environment),
  ])

  return diffNamedFacets({
    network,
    environment,
    diamondAddress,
    requestedNames: new Set(names),
    onChainFacets,
    addressToName,
    protectedNames: getProtectedNames(),
    nameToAddress,
  })
}
