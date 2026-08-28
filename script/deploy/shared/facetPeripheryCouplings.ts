/**
 * Facet ↔ periphery coupling registry reader (EXSC-684).
 *
 * Some facets are only half a feature on their own: a bridge facet handles the source side, while
 * the matching Receiver handles destination calls. Nothing used to tie the two together, so a facet
 * could be rolled out to a new chain while its companion Receiver was silently forgotten — which is
 * what disabled Across destination calls on Robinhood (EXSC-682).
 *
 * `config/global.json` → `facetPeripheryCouplings` declares those couplings, keyed by facet name.
 * This module reads them and evaluates, for one chain, which companion periphery contracts are
 * actually required — which first needs to know which facets are live there, so it also identifies
 * a diamond's on-chain facets, by deploy-log address and by compiled selector set. Import it from
 * the `facet-required-periphery` and `no-unexpected-facets` health-check invariants.
 */
import { existsSync, readdirSync, readFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

import globalConfig from '../../../config/global.json'

/** What one facet requires on the same chain to be functionally complete. */
export interface IFacetPeripheryCoupling {
  /** The companion periphery contract this facet needs. */
  requires: string
  /**
   * Per-network carve-outs: network key → why the companion is genuinely not needed there. Keys
   * must be the canonical lowercase network key (as in `config/networks.json`).
   */
  notRequiredOn?: Record<string, string>
  /** Free-form context for humans reading the config. Never consumed by code. */
  devNotes?: string
}

/** Map of facet name → what it requires. Lookup is a direct key hit on the facet name. */
export type TFacetPeripheryCouplings = Record<string, IFacetPeripheryCoupling>

/** An active requirement for one chain: these facets are live and all need this companion. */
export interface IActiveCouplingRequirement {
  /** The companion periphery contract that must be registered. */
  companion: string
  /** The facets present on this chain that require it. */
  triggeredBy: string[]
}

/** A facet whose companion requirement is deliberately not enforced on this chain. */
export interface ISkippedCouplingRequirement {
  facet: string
  companion: string
  /** Why it is not enforced — always printed so a carve-out is never invisible. */
  reason: string
}

/** Outcome of evaluating the registry against one chain's facet set. */
export interface ICouplingEvaluation {
  required: IActiveCouplingRequirement[]
  skipped: ISkippedCouplingRequirement[]
}

/**
 * Read the coupling registry from `config/global.json`.
 *
 * @returns the declared couplings, or an empty map when the key is absent.
 */
export function getFacetPeripheryCouplings(): TFacetPeripheryCouplings {
  return (
    (globalConfig as { facetPeripheryCouplings?: TFacetPeripheryCouplings })
      .facetPeripheryCouplings ?? {}
  )
}

/**
 * Work out which companion periphery contracts one chain must have, given the facets live there.
 *
 * Each present facet is looked up directly by name. Facets requiring the same companion are merged
 * into one requirement, so three Across V4 facets needing `ReceiverAcrossV4` produce a single entry
 * listing all three as `triggeredBy`. A facet is reported as `skipped` (with a reason) instead when
 * `notRequiredOn` names this network. Pure — callers do the on-chain lookup.
 *
 * @param presentFacets - facet names live on the chain (registered in the diamond)
 * @param network - network key as in `config/networks.json`
 * @param couplings - registry override, for tests
 * @returns active requirements plus the deliberately-skipped ones
 */
export function evaluateFacetPeripheryCouplings(
  presentFacets: string[],
  network: string,
  couplings: TFacetPeripheryCouplings = getFacetPeripheryCouplings()
): ICouplingEvaluation {
  const networkLower = network.toLowerCase()
  const skipped: ISkippedCouplingRequirement[] = []
  // Keyed by companion so facets of the same family collapse into one requirement.
  const byCompanion = new Map<string, string[]>()

  for (const facet of [...new Set(presentFacets)].sort()) {
    const declaration = couplings[facet]
    if (!declaration?.requires) continue

    const reason = declaration.notRequiredOn?.[networkLower]
    if (reason) {
      skipped.push({ facet, companion: declaration.requires, reason })
      continue
    }

    const triggeredBy = byCompanion.get(declaration.requires) ?? []
    triggeredBy.push(facet)
    byCompanion.set(declaration.requires, triggeredBy)
  }

  return {
    required: [...byCompanion].map(([companion, triggeredBy]) => ({
      companion,
      triggeredBy,
    })),
    skipped,
  }
}

/** One facet as returned by the diamond's `facets()` call. */
export interface IOnChainFacetSelectors {
  address: string
  selectors: string[]
}

/** Selector sets arrive 0x-prefixed from `facets()` and bare from build artifacts. */
function normalizeSelectors(selectors: string[]): Set<string> {
  return new Set(
    selectors.map((selector) => selector.toLowerCase().replace(/^0x/, ''))
  )
}

/**
 * Name the facet behind one on-chain selector set, or return undefined when it cannot be named.
 *
 * A diamond registers a facet's selectors, which on real chains is frequently a strict subset of
 * what the facet compiles to: constants and view getters are routinely left unregistered at cut
 * time. Identity therefore holds when the on-chain selectors are *contained* in a compiled set,
 * and only when exactly one compiled facet fits — an ambiguous set stays unnamed rather than
 * guessed. An exact match wins over a merely containing one, which is what separates a facet from
 * the packed variant that re-exports its selectors.
 *
 * @param selectors - the selectors the diamond registers for this facet
 * @param compiledSelectors - facet name → its full compiled selector set
 * @returns the facet name, or undefined when no single compiled facet accounts for the set
 */
export function identifyFacetBySelectorSet(
  selectors: string[],
  compiledSelectors: Record<string, string[]>
): string | undefined {
  const onChain = normalizeSelectors(selectors)
  if (onChain.size === 0) return undefined

  const containing = Object.entries(compiledSelectors)
    .map(([name, compiled]) => ({
      name,
      compiled: normalizeSelectors(compiled),
    }))
    .filter(
      ({ compiled }) =>
        compiled.size > 0 &&
        [...onChain].every((selector) => compiled.has(selector))
    )
  const exact = containing.filter(
    ({ compiled }) => compiled.size === onChain.size
  )
  const winners = exact.length > 0 ? exact : containing
  return winners.length === 1 ? winners[0]?.name : undefined
}

/**
 * Resolve which coupled facets are live on a chain, identifying each on-chain facet by its
 * deploy-log address first and by its compiled selector set second.
 *
 * The selector-set fallback is what makes this robust to deploy-log drift: a facet live on chain but
 * missing from — or stale in — `deployments/<network>.json` is still identified, so a coupling
 * requirement cannot be skipped just because the bookkeeping lags the chain.
 *
 * Identity by selector set is delegated to {@link identifyFacetBySelectorSet}.
 *
 * @param onChainFacets - facets from the diamond's `facets()` call, with their selectors
 * @param deployedContracts - the deploy log for this chain (`deployments/<network>.json`)
 * @param candidateFacetNames - facet names to test (the coupling registry keys)
 * @param compiledSelectors - facet name → its full compiled selector set; empty disables the
 *   selector fallback, leaving deploy-log resolution alone
 * @returns the subset of `candidateFacetNames` that is live on chain
 */
export function resolveLiveFacets(
  onChainFacets: IOnChainFacetSelectors[],
  deployedContracts: Record<string, string>,
  candidateFacetNames: string[],
  compiledSelectors: Record<string, string[]> = {}
): string[] {
  const nameByLogAddress = new Map<string, string>()
  for (const [name, address] of Object.entries(deployedContracts))
    if (typeof address === 'string')
      nameByLogAddress.set(address.toLowerCase(), name)

  const candidates = new Set(candidateFacetNames)
  const liveNames = new Set<string>()

  for (const facet of onChainFacets) {
    // A log entry naming this address something that is not a candidate must not shadow the
    // selector fallback: a mislabelled or superseded log line would otherwise hide a live
    // coupled facet as effectively as a missing one.
    const loggedName = nameByLogAddress.get(facet.address.toLowerCase())
    const name =
      loggedName !== undefined && candidates.has(loggedName)
        ? loggedName
        : identifyFacetBySelectorSet(facet.selectors, compiledSelectors)
    if (name !== undefined && candidates.has(name)) liveNames.add(name)
  }

  return candidateFacetNames.filter((name) => liveNames.has(name))
}

/** Facet names come from a directory listing; the guard keeps a hostile filename out of a path. */
function isValidFacetName(name: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(name)
}

/** Memoized per working directory: a fleet run reads these artifacts once, not once per network. */
const compiledSelectorCache = new Map<string, Record<string, string[]>>()

/**
 * Read every facet's compiled selector set from the Foundry build output under `out/`.
 *
 * Both directories are resolved from the process working directory, which is the repository root
 * for every caller (the health check, its tests). A facet with no artifact is omitted rather than
 * reported: `out/` is generated, so an unbuilt or partially built checkout must degrade the
 * selector-identity fallback instead of failing the health check.
 *
 * @returns facet name → its full compiled selector set, `0x`-prefixed; empty when nothing is built
 */
export function loadCompiledFacetSelectors(): Record<string, string[]> {
  const cwd = process.cwd()
  const cached = compiledSelectorCache.get(cwd)
  if (cached) return cached

  const facetSourceDir = resolve(cwd, 'src', 'Facets')
  const outDir = resolve(cwd, 'out')
  if (!existsSync(facetSourceDir) || !existsSync(outDir)) {
    const unbuilt: Record<string, string[]> = {}
    compiledSelectorCache.set(cwd, unbuilt)
    return unbuilt
  }

  const selectorsByFacet: Record<string, string[]> = {}
  for (const entry of readdirSync(facetSourceDir)) {
    if (!entry.endsWith('.sol')) continue
    const name = entry.slice(0, -'.sol'.length)
    if (!isValidFacetName(name)) continue

    const artifactPath = resolve(outDir, `${name}.sol`, `${name}.json`)
    const relativeToOut = relative(outDir, artifactPath)
    if (relativeToOut.startsWith('..') || isAbsolute(relativeToOut)) continue
    if (!existsSync(artifactPath)) continue

    try {
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
        methodIdentifiers?: Record<string, string>
      }
      const selectors = Object.values(artifact.methodIdentifiers ?? {})
      if (selectors.length > 0)
        selectorsByFacet[name] = selectors.map((selector) => `0x${selector}`)
    } catch {
      // An unreadable artifact only costs this facet its selector identity.
    }
  }
  compiledSelectorCache.set(cwd, selectorsByFacet)
  return selectorsByFacet
}
