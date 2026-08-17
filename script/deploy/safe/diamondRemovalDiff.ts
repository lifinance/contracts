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
 * The second entrypoint (`computeTargetedFacetRemovals`) resolves an explicitly
 * requested set of removal targets instead of diffing target state. Targets are
 * keyed by facet ADDRESS: the deploy log holds one address per contract name, so
 * a name is ambiguous whenever two versions of a facet are co-registered on the
 * same diamond, and resolving by name would target the live one.
 *
 * Consumed by `script/tasks/cleanUpProdDiamond.ts` (interactive `--auto` and
 * fleet `--all-networks` modes) and by the parked-task drain. Pure diff logic
 * (`diffFacets`, `diffTargetedFacets`) is separated from I/O so both are
 * unit-testable; all I/O is injectable via the `io` parameter.
 */

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

import {
  createPublicClient,
  decodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Hex,
} from 'viem'

import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import {
  getFunctionSelectors,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import targetStateJson from '../_targetState.json'
import { getCoreFacets, getCorePeriphery } from '../shared/globalContractLists'

import { ABI_DIAMOND_CUT } from './safe-decode-utils'

// ES-module `__dirname`, so source-tree paths resolve from this file's location
// rather than `process.cwd()`. A CWD-relative `src` lookup would silently return
// an empty set when run from another directory, disabling the drift guard.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Repo `src/` root, resolved absolutely from this module (script/deploy/safe → repo root). */
const SRC_ROOT = path.resolve(MODULE_DIR, '../../../src')
/** Repo `src/Facets/` root — where every active facet's source lives. */
const FACETS_ROOT = path.resolve(SRC_ROOT, 'Facets')

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
  /** Display label only — `address` is the identity of what gets removed. */
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
  /**
   * Contract names in the network's target-state `LiFiDiamond` block, or
   * `undefined` when the network/env has no target-state entry at all (distinct
   * from a present-but-empty block — the former must never be diffed).
   */
  getExpectedNames: (
    network: string,
    environment: EnvironmentEnum
  ) => Set<string> | undefined
  /** Union of selectors owned by the given (active) facet names whose artifacts exist. */
  getActiveSelectors: (names: string[]) => Set<string>
  /** Union of selectors owned by the diamond-machinery facets that must never be removed. */
  getProtectedSelectors: () => Set<string>
  /** Set of contract names whose `.sol` source still exists under `src/`. */
  getSourceNames: () => Set<string>
  /** Set of contract names whose `.sol` source lives under `src/Facets/` (real facets only). */
  getFacetNames: () => Set<string>
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
export function getSourceContractNames(srcDir: string = SRC_ROOT): Set<string> {
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

/**
 * Basenames of the Solidity sources under `src/Facets/` — i.e. the names that are
 * actually diamond facets. Used to scope the active-selector set: a target-state
 * `LiFiDiamond` block lists periphery/util contracts (`Executor`, `GasZipPeriphery`,
 * `LiFiDEXAggregator`, `Receiver*`, …) alongside facets, and those are NOT diamond
 * facets — feeding their ABIs into the held-back-selector set would wrongly retain
 * a deprecated facet's selectors that merely share a signature with a periphery ABI.
 */
export function getFacetSourceNames(
  facetsDir: string = FACETS_ROOT
): Set<string> {
  return getSourceContractNames(facetsDir)
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

/**
 * Contract names listed under `LiFiDiamond` in target state for a network/env, or
 * `undefined` when that network/env has no `LiFiDiamond` block at all. The
 * `undefined` vs empty-`Set` distinction is load-bearing: a network absent from
 * target state must never be diffed (every on-chain facet would look "not
 * expected" → a removal candidate), whereas a present-but-empty block genuinely
 * expects zero facets.
 */
export function getExpectedFacetNames(
  network: string,
  environment: EnvironmentEnum
): Set<string> | undefined {
  const state = targetStateJson as Record<
    string,
    Record<string, Record<string, Record<string, string>>>
  >
  const diamond = state[lower(network)]?.[environment]?.LiFiDiamond
  if (!diamond) return undefined
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
  getProtectedSelectors: () =>
    collectActiveSelectors([...HARDCODED_PROTECTED_FACETS]),
  getSourceNames: () => getSourceContractNames(),
  getFacetNames: () => getFacetSourceNames(),
}

/**
 * Computes the facet-removal diff for one network/environment by gathering the
 * on-chain loupe, deploy log, target state and protected sets, then delegating
 * to {@link diffFacets}. Returns an empty diff (no `diamondAddress`) if the
 * network has no `LiFiDiamond` deployed in that environment. Throws if the
 * network has a diamond but no target-state entry (see below) — a caller in a
 * fleet loop should catch, record the network as failed, and continue.
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

  // A network absent from target state is NOT "expects zero facets": diffing it
  // would classify every on-chain facet as a removal candidate. Refuse — the
  // caller (fleet loop) records this network as failed and continues.
  if (expectedNames === undefined)
    throw new Error(
      `[${network}/${environment}] no LiFiDiamond target-state entry — refusing ` +
        `to compute a facet-removal diff (an absent network would make every ` +
        `on-chain facet look removable). Add the network to _targetState.json first.`
    )

  const protectedNames = getProtectedNames()

  // Selectors that must never be swept out from under an active facet: the union
  // owned by EVERY facet target state expects to keep — not only those already
  // routed on-chain. A replacement facet listed in target state but not yet
  // registered still owns its selectors, so a deprecated facet currently holding
  // them must have them held back, not removed. Fails closed on a missing
  // artifact (see collectActiveSelectors). Scoped to REAL facets: target-state
  // `LiFiDiamond` blocks also list periphery/util contracts, whose ABIs are not
  // diamond-routed and would otherwise cause a deprecated facet's shared-signature
  // selectors to be wrongly held back instead of removed.
  const facetNames = resolved.getFacetNames()
  const activeFacetNames = [...expectedNames].filter((n) => facetNames.has(n))
  const activeSelectors = resolved.getActiveSelectors(activeFacetNames)
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

/**
 * A facet slated for removal, identified by its ADDRESS. The deploy log maps one
 * address per contract name, so a name cannot identify a removal target once two
 * versions of a facet are co-registered on the same diamond — the log points at
 * the live one, and a name-keyed removal would target it instead of the
 * deprecated one. `label` is therefore display-only and never matched against.
 */
export interface IRemovalTarget {
  address: `0x${string}`
  /** Human-readable name for logs/prompts (deploy-log name at enqueue time). */
  label?: string
}

/** Why a requested target was refused by the never-remove guards. */
export type ProtectedReason = 'allowlisted-name' | 'machinery-selectors'

/** A requested target refused because removing it is never allowed. */
export interface IProtectedTarget {
  address: `0x${string}`
  name: string
  reason: ProtectedReason
}

/** A requested target and the deploy-log name its address resolves to. */
export interface INamedAddress {
  name: string
  address: `0x${string}`
}

/** Result of resolving an explicit set of removal targets against one diamond. */
export interface ITargetedRemovalResult {
  network: string
  environment: EnvironmentEnum
  diamondAddress?: `0x${string}`
  removals: IFacetRemoval[]
  /** Targets whose address routes no selectors on this diamond (nothing to remove). */
  notFoundOnChain: IRemovalTarget[]
  /** Requested names with no deploy-log entry — only the name-keyed entrypoint fills this. */
  unresolvedNames: string[]
  /** Targets refused by a never-remove guard (allowlisted name, or machinery selectors). */
  protectedSkipped: IProtectedTarget[]
  /**
   * On-chain facet addresses not present in the deploy log. Informational: the
   * loupe, not the log, decides what a target owns, so an unlogged address is
   * removable — but a growing list here means the log has drifted from chain.
   */
  unresolved: `0x${string}`[]
  /**
   * Targeted addresses that ARE routed on-chain but are absent from the deploy
   * log. They are removed (the address is authoritative), and reported so the log
   * gets reconciled — under name-keyed resolution this state used to make a live
   * facet look "already gone" and false-supersede its removal task.
   */
  prunedButRouted: INamedAddress[]
  /**
   * Targets refused because their deploy-log name is still listed in target state,
   * i.e. the address is the LIVE deployment of an active facet. Guards a mistyped
   * address and a name-keyed request for a facet with a co-registered old version.
   */
  liveInTargetState: INamedAddress[]
}

/**
 * Pure resolution of explicitly requested removal targets against the on-chain
 * loupe. Unlike {@link diffFacets} there is no target-state *diff* and no
 * source/drift gate: the caller has explicitly named the addresses to remove
 * (e.g. via `/deprecate-contract`), so the checks are "is this address actually
 * routing selectors on this diamond" and "is removing it forbidden".
 *
 * Selectors come from the loupe entry of the targeted address, which is why no
 * selector hold-back is needed here: the loupe routes every selector to exactly
 * one facet, so a co-registered newer version's selectors are in its own entry
 * and can never be swept out by removing the older one.
 *
 * @param params.targets - Removal targets, keyed by address (deduped here).
 * @param params.addressToName - Lowercased address → deploy-log name (labels + guards).
 * @param params.protectedNames - Never-remove allowlist, matched on the resolved name.
 * @param params.protectedSelectors - Lowercased selectors of the diamond-machinery
 *   facets; a target owning any of them is refused even when its address is
 *   absent from the deploy log (so an unlogged address can't bypass the allowlist).
 * @param params.expectedNames - Names target state expects to keep, or `undefined`
 *   when the network has no target-state entry (the live-facet guard is then skipped).
 */
export function diffTargetedFacets(params: {
  network: string
  environment: EnvironmentEnum
  diamondAddress?: `0x${string}`
  targets: IRemovalTarget[]
  onChainFacets: IOnChainFacet[]
  addressToName: Record<string, string>
  protectedNames: Set<string>
  protectedSelectors: Set<string>
  expectedNames?: Set<string>
  unresolvedNames?: string[]
}): ITargetedRemovalResult {
  const {
    network,
    environment,
    diamondAddress,
    targets,
    onChainFacets,
    addressToName,
    protectedNames,
    protectedSelectors,
    expectedNames,
    unresolvedNames,
  } = params

  const result: ITargetedRemovalResult = {
    network,
    environment,
    diamondAddress,
    removals: [],
    notFoundOnChain: [],
    unresolvedNames: unresolvedNames ?? [],
    protectedSkipped: [],
    unresolved: [],
    prunedButRouted: [],
    liveInTargetState: [],
  }

  const onChainByAddress = new Map<string, IOnChainFacet>()
  for (const facet of onChainFacets) {
    onChainByAddress.set(lower(facet.address), facet)
    if (!addressToName[lower(facet.address)])
      result.unresolved.push(facet.address)
  }

  const seen = new Set<string>()
  for (const target of targets) {
    const key = lower(target.address)
    if (seen.has(key)) continue
    seen.add(key)

    const facet = onChainByAddress.get(key)
    if (!facet) {
      result.notFoundOnChain.push(target)
      continue
    }

    const loggedName = addressToName[key]
    const name = loggedName ?? target.label ?? 'unknown'

    if (loggedName && protectedNames.has(loggedName)) {
      result.protectedSkipped.push({
        address: facet.address,
        name,
        reason: 'allowlisted-name',
      })
      continue
    }

    if (facet.selectors.some((sel) => protectedSelectors.has(lower(sel)))) {
      result.protectedSkipped.push({
        address: facet.address,
        name,
        reason: 'machinery-selectors',
      })
      continue
    }

    if (loggedName && expectedNames?.has(loggedName)) {
      result.liveInTargetState.push({ name, address: facet.address })
      continue
    }

    if (!loggedName)
      result.prunedButRouted.push({ name, address: facet.address })

    result.removals.push({
      name,
      address: facet.address,
      selectors: facet.selectors,
    })
  }

  return result
}

/** Shared prelude for both entrypoints: loupe + log + guard inputs for one diamond. */
async function loadTargetingContext(
  network: string,
  environment: EnvironmentEnum,
  resolved: IRemovalDiffIO,
  diamondAddress: `0x${string}`
): Promise<{
  onChainFacets: IOnChainFacet[]
  addressToName: Record<string, string>
  protectedSelectors: Set<string>
  expectedNames?: Set<string>
}> {
  const [onChainFacets, addressToName] = await Promise.all([
    resolved.getOnChainFacets(diamondAddress, network),
    resolved.getAddressToName(network, environment),
  ])
  return {
    onChainFacets,
    addressToName,
    protectedSelectors: resolved.getProtectedSelectors(),
    // The live-facet guard exists because a production removal is irreversible and
    // goes through Safe + timelock. Staging diamonds are direct-send and routinely
    // have facets removed to be re-added, so gating them on target state would
    // block a normal workflow to prevent a cheap, self-inflicted mistake.
    expectedNames:
      environment === EnvironmentEnum.production
        ? resolved.getExpectedNames(network, environment)
        : undefined,
  }
}

/** Empty result for a network with no diamond deployed: every target is a no-op. */
function noDiamondResult(
  network: string,
  environment: EnvironmentEnum,
  targets: IRemovalTarget[],
  unresolvedNames: string[] = []
): ITargetedRemovalResult {
  return {
    network,
    environment,
    removals: [],
    notFoundOnChain: targets,
    unresolvedNames,
    protectedSkipped: [],
    unresolved: [],
    prunedButRouted: [],
    liveInTargetState: [],
  }
}

/**
 * Resolves explicit removal targets (addresses) against a single diamond and
 * returns the ones to remove, taking selectors from the loupe so it works after
 * the facet's source/artifact was deleted by `/deprecate-contract`. This is the
 * deprecation-driven removal path; the target set comes from the deprecation
 * (parked task or `--facetAddresses`), not from a target-state diff.
 *
 * @param io - Injectable I/O overrides for testing; defaults hit the real chain/files.
 */
export async function computeTargetedFacetRemovals(
  network: string,
  environment: EnvironmentEnum,
  targets: IRemovalTarget[],
  io: Partial<IRemovalDiffIO> = {}
): Promise<ITargetedRemovalResult> {
  const resolved: IRemovalDiffIO = { ...defaultIO, ...io }

  const diamondAddress = await resolved.getDiamondAddress(network, environment)
  if (!diamondAddress) return noDiamondResult(network, environment, targets)

  const context = await loadTargetingContext(
    network,
    environment,
    resolved,
    diamondAddress
  )

  return diffTargetedFacets({
    network,
    environment,
    diamondAddress,
    targets,
    protectedNames: getProtectedNames(),
    ...context,
  })
}

/**
 * Name-keyed convenience wrapper over {@link computeTargetedFacetRemovals}: maps
 * each requested name to the address the deploy log lists for it, then resolves
 * those addresses. Names with no log entry are reported in `unresolvedNames`
 * rather than throwing, so a fleet sweep over networks that never had the facet
 * stays quiet.
 *
 * A name resolves to exactly one address, so this cannot express "remove the old
 * version while the new one stays registered" — such a request is refused by the
 * live-facet guard (`liveInTargetState`) and the operator must pass the address.
 */
export async function computeFacetRemovalsByName(
  network: string,
  environment: EnvironmentEnum,
  names: string[],
  io: Partial<IRemovalDiffIO> = {}
): Promise<ITargetedRemovalResult> {
  const resolved: IRemovalDiffIO = { ...defaultIO, ...io }

  const diamondAddress = await resolved.getDiamondAddress(network, environment)
  if (!diamondAddress) return noDiamondResult(network, environment, [], names)

  const context = await loadTargetingContext(
    network,
    environment,
    resolved,
    diamondAddress
  )

  const nameToAddress = new Map<string, `0x${string}`>()
  for (const [address, name] of Object.entries(context.addressToName))
    nameToAddress.set(name, getAddress(address))

  const targets: IRemovalTarget[] = []
  const unresolvedNames: string[] = []
  for (const name of names) {
    const address = nameToAddress.get(name)
    if (address) targets.push({ address, label: name })
    else unresolvedNames.push(name)
  }

  return diffTargetedFacets({
    network,
    environment,
    diamondAddress,
    targets,
    protectedNames: getProtectedNames(),
    unresolvedNames,
    ...context,
  })
}

/** A snapshot removal selector that must be dropped from a timelock `Remove` before executing it. */
export interface IStaleRemovalSelector {
  facet: string
  selector: `0x${string}`
  /** `re-pointed`: now routed to a different (live) facet; `already-gone`: no longer registered. */
  reason: 're-pointed' | 'already-gone'
  /** The address the selector currently routes to (undefined when `already-gone`). */
  currentAddress?: `0x${string}`
}

/** Result of re-validating a removal snapshot against the current on-chain loupe. */
export interface IRevalidatedRemovals {
  /** Removals safe to execute — every selector still routes to the doomed facet address. */
  stillRemovable: IFacetRemoval[]
  /** Selectors dropped because the chain changed after the snapshot (see {@link IStaleRemovalSelector}). */
  stale: IStaleRemovalSelector[]
}

/**
 * Re-validates a removal snapshot against a fresh on-chain loupe. A facet removal
 * is proposed as a timelock `scheduleBatch` and executed ≥ the timelock delay
 * later; in that window an intervening rollout can re-point one of the snapshotted
 * selectors onto a new, live facet. Executing the stale `Remove` (which sets
 * `facetAddress = address(0)`) would then delete a live selector →
 * `FunctionDoesNotExist` on every call until a corrective cut ships. It can also
 * revert outright if a selector was already removed.
 *
 * This pure diff keeps only selectors that STILL route to the address they were
 * snapshotted at, and reports the rest as stale. Wired into
 * `execute-pending-timelock-tx` / `executeOperation`: under the fold any stale
 * selector aborts the **entire** timelock batch (primary cut + removals).
 */
export function filterRePointedRemovals(
  snapshot: IFacetRemoval[],
  currentFacets: IOnChainFacet[]
): IRevalidatedRemovals {
  const selectorToAddress = new Map<string, `0x${string}`>()
  for (const facet of currentFacets)
    for (const selector of facet.selectors)
      selectorToAddress.set(lower(selector), facet.address)

  const stillRemovable: IFacetRemoval[] = []
  const stale: IStaleRemovalSelector[] = []

  for (const removal of snapshot) {
    const keep: `0x${string}`[] = []
    for (const selector of removal.selectors) {
      const current = selectorToAddress.get(lower(selector))
      if (current === undefined)
        stale.push({ facet: removal.name, selector, reason: 'already-gone' })
      else if (lower(current) === lower(removal.address)) keep.push(selector)
      else
        stale.push({
          facet: removal.name,
          selector,
          reason: 're-pointed',
          currentAddress: current,
        })
    }
    if (keep.length > 0)
      stillRemovable.push({
        name: removal.name,
        address: removal.address,
        selectors: keep,
      })
  }

  return { stillRemovable, stale }
}

/**
 * Re-reads the diamond's on-chain loupe and re-validates a removal snapshot via
 * {@link filterRePointedRemovals}. Called by `execute-pending-timelock-tx`
 * immediately before `executeBatch` when the op carries folded parked removals
 * (see {@link buildRemovalSnapshotFromPayloads}), closing the propose→execute race.
 *
 * @param io - Injectable I/O overrides for testing; defaults hit the real chain.
 */
export async function revalidateRemovalsOnChain(
  network: string,
  diamondAddress: `0x${string}`,
  snapshot: IFacetRemoval[],
  io: Partial<Pick<IRemovalDiffIO, 'getOnChainFacets'>> = {}
): Promise<IRevalidatedRemovals> {
  const getOnChainFacets = io.getOnChainFacets ?? fetchOnChainFacets
  const currentFacets = await getOnChainFacets(diamondAddress, network)
  return filterRePointedRemovals(snapshot, currentFacets)
}

/** EIP-2535 FacetCutAction.Remove */
const FACET_CUT_REMOVE = 2

/** One Remove facet-cut extracted from a `diamondCut` payload (address is always 0 on-wire). */
export interface IRemoveFacetCut {
  selectors: `0x${string}`[]
}

/**
 * Walks timelock-batch payloads and returns every FacetCut with action=Remove,
 * in appearance order (primary cuts first; drain-folded removals are the trailing
 * suffix — see {@link buildRemovalSnapshotFromPayloads}).
 *
 * @param payloads - Inner call payloads from a timelock `scheduleBatch` / `executeBatch`.
 * @returns Remove cuts in appearance order (non-`diamondCut` payloads are skipped).
 */
export function extractRemoveFacetCuts(
  payloads: readonly Hex[]
): IRemoveFacetCut[] {
  const cuts: IRemoveFacetCut[] = []
  for (const payload of payloads) {
    let decoded: ReturnType<typeof decodeFunctionData>
    try {
      decoded = decodeFunctionData({ abi: ABI_DIAMOND_CUT, data: payload })
    } catch {
      continue
    }
    if (decoded.functionName !== 'diamondCut' || !decoded.args) continue
    // ABI_DIAMOND_CUT uses positional tuple components; viem yields
    // [facetAddress, action, functionSelectors][] (not named fields).
    const facetCuts = decoded.args[0] as readonly (readonly [
      unknown,
      number | bigint,
      readonly `0x${string}`[]
    ])[]
    for (const cut of facetCuts) {
      const action = cut[1]
      const selectors = cut[2]
      if (Number(action) === FACET_CUT_REMOVE)
        cuts.push({ selectors: [...selectors] })
    }
  }
  return cuts
}

/** Parked-task fields needed to rebuild an {@link IFacetRemoval} snapshot at execute time. */
export interface IParkedRemovalIdentity {
  facetName: string
  facetAddress: `0x${string}`
}

/**
 * Result of zipping Remove cuts from a timelock batch with parked-task identities.
 * - `none`: no Remove cuts (and no parked rows) — skip the pre-execute guard.
 * - `snapshot`: zip succeeded; caller must run {@link revalidateRemovalsOnChain}.
 * - `unvalidated`: Remove cuts present but no parked rows — cannot recover doomed
 *   addresses from calldata (always 0); caller MUST abort (fail closed).
 * - `mismatch`: parked/cut counts disagree — refuse to execute.
 */
export type RemovalSnapshotBuild =
  | { kind: 'none' }
  | { kind: 'snapshot'; snapshot: IFacetRemoval[] }
  | { kind: 'unvalidated'; removeCutCount: number }
  | { kind: 'mismatch'; reason: string }

/**
 * Rebuilds the propose-time removal snapshot from immutable schedule payloads +
 * parked-task doomed addresses. Drain appends one Remove call per claimed facet
 * after the primary, so the trailing `parked.length` Remove cuts zip 1:1 with
 * parked tasks sorted by `proposedAt` ascending (then `taskKey` for ties).
 * Same-ms `proposedAt` ties can theoretically mis-label cuts → a false
 * `re-pointed` abort (fail-safe, not silent delete); accepted until an explicit
 * append index is stamped at claim time.
 *
 * @param payloads - Inner call payloads from the timelock batch.
 * @param parked - Parked-task identities for this Safe tx, claim/append order.
 * @returns A {@link RemovalSnapshotBuild} discriminant for the execute guard.
 */
export function buildRemovalSnapshotFromPayloads(
  payloads: readonly Hex[],
  parked: readonly IParkedRemovalIdentity[]
): RemovalSnapshotBuild {
  const removeCuts = extractRemoveFacetCuts(payloads)
  if (removeCuts.length === 0) {
    if (parked.length === 0) return { kind: 'none' }
    return {
      kind: 'mismatch',
      reason: `parked tasks present (${parked.length}) but no Remove diamondCut payloads found in the timelock batch`,
    }
  }
  if (parked.length === 0)
    return { kind: 'unvalidated', removeCutCount: removeCuts.length }
  if (removeCuts.length < parked.length)
    return {
      kind: 'mismatch',
      reason: `Remove cuts (${removeCuts.length}) < parked tasks (${parked.length}) — cannot zip safely`,
    }
  const folded = removeCuts.slice(-parked.length)
  return {
    kind: 'snapshot',
    snapshot: parked.map((task, i) => {
      const cut = folded[i]
      if (!cut)
        throw new Error(
          `internal error: missing Remove cut at index ${i} after length check`
        )
      return {
        name: task.facetName,
        address: getAddress(task.facetAddress),
        selectors: cut.selectors,
      }
    }),
  }
}
