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
import { fileURLToPath } from 'url'

import {
  createPublicClient,
  decodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Hex,
} from 'viem'

import type { EnvironmentEnum, SupportedChain } from '../../common/types'
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
  /** Set of contract names whose `.sol` source still exists under `src/`. */
  getSourceNames: () => Set<string>
  /** Set of contract names whose `.sol` source lives under `src/Facets/` (real facets only). */
  getFacetNames: () => Set<string>
}

const lower = (s: string): string => s.toLowerCase()

const selectorsByContractCache = new Map<string, `0x${string}`[]>()
/** Memoized {@link getFunctionSelectors} — one artifact parse per contract per process. */
function cachedFunctionSelectors(name: string): `0x${string}`[] {
  const hit = selectorsByContractCache.get(name)
  if (hit) return hit
  const selectors = getFunctionSelectors(name)
  selectorsByContractCache.set(name, selectors)
  return selectors
}

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

let sourceContractNamesCache: Set<string> | undefined
/**
 * Memoized {@link getSourceContractNames} for the default root — the source tree
 * is immutable per process.
 *
 * @returns Basenames of every `.sol` source under `src/`.
 */
export const cachedSourceContractNames = (): Set<string> =>
  (sourceContractNamesCache ??= getSourceContractNames())

let facetSourceNamesCache: Set<string> | undefined
/**
 * Memoized {@link getFacetSourceNames} for the default root.
 *
 * @returns Basenames of every `.sol` source under `src/Facets/`.
 */
export const cachedFacetSourceNames = (): Set<string> =>
  (facetSourceNamesCache ??= getFacetSourceNames())

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
 * @param selectorsOf - Selector lookup; defaults to reading `out/` artifacts (memoized —
 *   artifacts are immutable per process and fleet sweeps re-ask per network). Injectable for tests.
 */
export function collectActiveSelectors(
  names: string[],
  selectorsOf: (name: string) => `0x${string}`[] = cachedFunctionSelectors
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
  getSourceNames: cachedSourceContractNames,
  getFacetNames: cachedFacetSourceNames,
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
   * On-chain facet addresses not present in the deploy log, so unmappable to a
   * name. A requested facet registered at an unlogged address (redeploy drift,
   * pruned/stale log entry, name mismatch) lands here rather than being silently
   * reported as "not on chain" — the operator must investigate before assuming
   * the deprecated facet was actually removed.
   */
  unresolved: `0x${string}`[]
}

/** Result of resolving an explicit set of facet ADDRESSES against one diamond. */
export interface IAddressRemovalResult {
  network: string
  environment: EnvironmentEnum
  diamondAddress?: `0x${string}`
  /**
   * Removals, one per requested address still routed on-chain. `name` is the
   * deploy-log label when the address maps to one, else `undefined` — the caller
   * supplies its own label (a parked task carries `facetName` for this).
   */
  removals: (Omit<IFacetRemoval, 'name'> & { name?: string })[]
  /**
   * Requested addresses the loupe does not route. Only ever populated from a real
   * loupe read: when the diamond itself could not be resolved this stays empty and
   * {@link IAddressRemovalResult.diamondUnresolved} is set instead, so a caller can
   * never read "we could not ask the chain" as "the chain says absent".
   */
  notFoundOnChain: `0x${string}`[]
  /** Requested addresses that resolve to a never-remove facet — refused. */
  protectedSkipped: { name: string; address: `0x${string}` }[]
  /**
   * Requested addresses whose removability could NOT be established: the network
   * has no target-state entry, or a selector union (protected/active) needed for
   * the checks was unavailable. Distinct from
   * {@link IAddressRemovalResult.protectedSkipped} because the two call for opposite
   * handling — a protected facet was parked in error (terminal), while an
   * unverifiable one is a tooling gap (retry after `forge build`), so a caller must
   * neither remove nor resolve it.
   */
  unverifiable: `0x${string}`[]
  /**
   * Requested addresses that ARE routed but must not be removed because target
   * state still expects them: the deploy log names them as an expected facet, or
   * (for an unlogged address) they route a selector an expected facet owns. This
   * is the shape of a wrong address snapshot pointing at a LIVE facet — refused,
   * never removed, never resolved.
   */
  stillExpected: { name?: string; address: `0x${string}`; reason: string }[]
  /**
   * Set when the network has no resolvable `LiFiDiamond` in its deploy log, so no
   * chain read happened at all. A caller that treats absence as "already removed"
   * (the drain supersedes on it) MUST bail on this instead.
   */
  diamondUnresolved?: true
  /** Deploy-log names of every facet the loupe routes — the suspect-snapshot signal. */
  routedNames: Set<string>
  /** Lowercased addresses the loupe routes — so callers need no second loupe read. */
  routedAddresses: Set<string>
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
}): INamedRemovalResult {
  const {
    network,
    environment,
    diamondAddress,
    requestedNames,
    onChainFacets,
    addressToName,
    protectedNames,
  } = params

  const result: INamedRemovalResult = {
    network,
    environment,
    diamondAddress,
    removals: [],
    notFoundOnChain: [],
    protectedSkipped: [],
    unresolved: [],
  }

  const foundOnChain = new Set<string>()
  for (const facet of onChainFacets) {
    const name = addressToName[lower(facet.address)]
    // On-chain but unmapped: could be a requested facet at an address the deploy
    // log doesn't list. Surface it rather than dropping it, so it isn't
    // misreported as "not on chain".
    if (!name) {
      result.unresolved.push(facet.address)
      continue
    }
    if (!requestedNames.has(name)) continue
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

  for (const name of requestedNames)
    if (!foundOnChain.has(name)) result.notFoundOnChain.push(name)

  return result
}

/**
 * Selector union owned by the given contract names, scoped to real facets (a
 * target-state `LiFiDiamond` block also lists periphery, whose ABIs are not
 * diamond-routed and would cause false selector matches). Returns `undefined`
 * when the union cannot be built (a missing artifact), which every caller must
 * treat as "cannot verify" — never as "nothing matched".
 *
 * @param names - Contract names to collect selectors for (non-facets are filtered out).
 * @param io - I/O providing facet names + selector collection; defaults hit real files.
 * @returns Lowercased selectors, or `undefined` if unavailable.
 */
export function tryCollectFacetSelectorUnion(
  names: Iterable<string>,
  io: Pick<IRemovalDiffIO, 'getActiveSelectors' | 'getFacetNames'> = defaultIO
): Set<string> | undefined {
  try {
    const facetNames = io.getFacetNames()
    return io.getActiveSelectors(
      [...names].filter((name) => facetNames.has(name))
    )
  } catch {
    return undefined
  }
}

/**
 * Pure resolution of an explicit set of requested facet ADDRESSES against the
 * on-chain loupe — the removal path for anything that must target one exact
 * facet, including a version co-registered alongside its successor under the
 * same name (EXSC-750). Unlike {@link diffNamedFacets} the deploy log is never
 * load-bearing: it supplies a display label when it happens to know the address,
 * and the never-remove check when it does. Selectors always come from the loupe,
 * so they cannot go stale between enqueue and drain.
 *
 * The checks have a deploy-log-independent second side: an address the log cannot
 * name is matched by SELECTOR against the unions owned by the protected facets and
 * by the target-state (expected) facets, because the very cases this path exists
 * for (a superseded version, a pruned log entry) are exactly the ones the log
 * cannot name. An `undefined` union means it could not be built, and every address
 * that would need it lands in `unverifiable` — never removed, and never reported
 * as protected either, since "parked in error" and "we could not check" call for
 * opposite handling.
 *
 * A routed address that target state still EXPECTS — the deploy log names it as an
 * expected facet, or it routes a selector an expected facet owns — is refused as
 * `stillExpected`: removing it would take down a live facet, and a parked task
 * pointing at one is a wrong snapshot, not a removal.
 */
export function diffFacetsByAddress(params: {
  network: string
  environment: EnvironmentEnum
  diamondAddress?: `0x${string}`
  /** Addresses to remove; matched case-insensitively against the loupe. */
  requestedAddresses: Set<`0x${string}`>
  onChainFacets: IOnChainFacet[]
  addressToName: Record<string, string>
  protectedNames: Set<string>
  /**
   * Target-state `LiFiDiamond` names, or `undefined` when the network has no
   * entry — which fails closed: without target state, "safe to remove" cannot be
   * established for any address.
   */
  expectedNames: Set<string> | undefined
  /**
   * Lowercased selectors owned by the protected facets, or `undefined` when that
   * union is unavailable (missing artifact) — which fails closed for any address
   * the deploy log cannot name. Required (never optional) so a caller cannot pick
   * either failure direction by omission.
   */
  protectedSelectors: Set<string> | undefined
  /**
   * Lowercased selectors owned by the expected (target-state) facets, or
   * `undefined` when unavailable — same fail-closed contract as
   * `protectedSelectors`.
   */
  activeSelectors: Set<string> | undefined
}): IAddressRemovalResult {
  const {
    network,
    environment,
    diamondAddress,
    requestedAddresses,
    onChainFacets,
    addressToName,
    protectedNames,
    expectedNames,
    protectedSelectors,
    activeSelectors,
  } = params

  const result: IAddressRemovalResult = {
    network,
    environment,
    diamondAddress,
    removals: [],
    notFoundOnChain: [],
    protectedSkipped: [],
    unverifiable: [],
    stillExpected: [],
    routedNames: new Set(
      onChainFacets
        .map((f) => addressToName[lower(f.address)])
        .filter((name): name is string => name !== undefined)
    ),
    routedAddresses: new Set(onChainFacets.map((f) => lower(f.address))),
  }

  const requested = new Map<string, `0x${string}`>()
  for (const address of requestedAddresses)
    requested.set(lower(address), address)

  const foundOnChain = new Set<string>()
  for (const facet of onChainFacets) {
    const key = lower(facet.address)
    if (!requested.has(key)) continue
    foundOnChain.add(key)

    const name = addressToName[key]
    if (name !== undefined) {
      if (protectedNames.has(name)) {
        result.protectedSkipped.push({ name, address: facet.address })
        continue
      }
      if (!expectedNames || !activeSelectors) {
        result.unverifiable.push(facet.address)
        continue
      }
      if (expectedNames.has(name)) {
        result.stillExpected.push({
          name,
          address: facet.address,
          reason: `the deploy log names it ${name}, which target state expects to stay registered`,
        })
        continue
      }
      // Same held-back rule diffFacets applies: a selector an expected facet
      // owns must not be swept out before that facet's Add re-points it — the
      // refusal self-resolves once the replacement cut lands.
      const activeHit = facet.selectors.find((selector) =>
        activeSelectors.has(lower(selector))
      )
      if (activeHit !== undefined) {
        result.stillExpected.push({
          name,
          address: facet.address,
          reason: `routes selector ${activeHit}, which a target-state facet owns`,
        })
        continue
      }
    } else {
      if (!protectedSelectors || !activeSelectors) {
        result.unverifiable.push(facet.address)
        continue
      }
      const protectedHit = facet.selectors.find((selector) =>
        protectedSelectors.has(lower(selector))
      )
      if (protectedHit !== undefined) {
        result.protectedSkipped.push({
          name: `unknown (address not in deploy log, holds protected selector ${protectedHit})`,
          address: facet.address,
        })
        continue
      }
      const activeHit = facet.selectors.find((selector) =>
        activeSelectors.has(lower(selector))
      )
      if (activeHit !== undefined) {
        result.stillExpected.push({
          address: facet.address,
          reason: `routes selector ${activeHit}, which a target-state facet owns`,
        })
        continue
      }
    }

    result.removals.push({
      name,
      address: facet.address,
      selectors: facet.selectors,
    })
  }

  for (const [key, address] of requested)
    if (!foundOnChain.has(key)) result.notFoundOnChain.push(address)

  return result
}

/**
 * Resolves an explicit set of facet names against a single diamond and returns
 * the ones to remove (registered on-chain and not protected), taking selectors
 * from the loupe so it works after the facet's source/artifact was deleted by
 * `/deprecate-contract`. This is the deprecation-driven removal path; the
 * facet-name set comes from the deprecation, not from a target-state diff.
 *
 * Resolves a name through the deploy log, which holds exactly ONE address per
 * name — so it cannot target a superseded version co-registered under the same
 * name. Use {@link computeFacetRemovalsByAddress} whenever the exact facet
 * matters (the parked-removal queue always does).
 *
 * @param io - Injectable I/O overrides for testing; defaults hit the real chain/files.
 */
export async function computeNamedFacetRemovals(
  network: string,
  environment: EnvironmentEnum,
  names: string[],
  io: Partial<IRemovalDiffIO> = {}
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
      unresolved: [],
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
  })
}

/**
 * Resolves an explicit set of facet ADDRESSES against a single diamond and
 * returns the ones to remove, taking selectors from the loupe. The address-keyed
 * counterpart of {@link computeNamedFacetRemovals}, and the path the parked
 * removal queue drains through: a task's stored `facetAddress` names exactly one
 * facet, so a superseded version can be removed while its live successor —
 * registered under the very same deploy-log name — is left untouched.
 *
 * @param io - Injectable I/O overrides for testing; defaults hit the real chain/files.
 */
export async function computeFacetRemovalsByAddress(
  network: string,
  environment: EnvironmentEnum,
  addresses: `0x${string}`[],
  io: Partial<IRemovalDiffIO> = {}
): Promise<IAddressRemovalResult> {
  const resolved: IRemovalDiffIO = { ...defaultIO, ...io }

  const diamondAddress = await resolved.getDiamondAddress(network, environment)
  if (!diamondAddress)
    return {
      network,
      environment,
      removals: [],
      notFoundOnChain: [],
      protectedSkipped: [],
      unverifiable: [],
      stillExpected: [],
      diamondUnresolved: true,
      routedNames: new Set<string>(),
      routedAddresses: new Set<string>(),
    }

  const [onChainFacets, addressToName] = await Promise.all([
    resolved.getOnChainFacets(diamondAddress, network),
    resolved.getAddressToName(network, environment),
  ])

  const protectedNames = getProtectedNames()
  const expectedNames = resolved.getExpectedNames(network, environment)

  return diffFacetsByAddress({
    network,
    environment,
    diamondAddress,
    requestedAddresses: new Set(addresses),
    onChainFacets,
    addressToName,
    protectedNames,
    expectedNames,
    protectedSelectors: tryCollectFacetSelectorUnion(protectedNames, resolved),
    activeSelectors: expectedNames
      ? tryCollectFacetSelectorUnion(expectedNames, resolved)
      : undefined,
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
