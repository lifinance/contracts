/**
 * Facet ↔ periphery coupling registry reader (EXSC-684).
 *
 * Some facets are only half a feature on their own: a bridge facet handles the source side, while
 * the matching Receiver handles destination calls. Nothing used to tie the two together, so a facet
 * could be rolled out to a new chain while its companion Receiver was silently forgotten — which is
 * what disabled Across destination calls on Robinhood.
 *
 * `config/global.json` → `facetPeripheryCouplings` declares those couplings, keyed by facet name.
 * This module reads them and evaluates, for one chain, which companion periphery contracts are
 * actually required. Import it from the health-check invariant (the enforcing consumer) and from
 * the deploy-time reminder.
 */
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

import globalConfig from '../../../config/global.json'

/** What one facet requires on the same chain to be functionally complete. */
export interface IFacetPeripheryCoupling {
  /** Periphery contracts, ANY ONE of which satisfies the coupling. */
  requiresAnyOf: string[]
  /** Per-network carve-outs: network key → why the companion is genuinely not needed there. */
  notRequiredOn?: Record<string, string>
  /** Free-form context for humans reading the config. Never consumed by code. */
  devNotes?: string
}

/** Map of facet name → what it requires. Lookup is a direct key hit on the facet name. */
export type TFacetPeripheryCouplings = Record<string, IFacetPeripheryCoupling>

/** An active requirement for one chain: these facets are live and need one of these contracts. */
export interface IActiveCouplingRequirement {
  /** The facets present on this chain that require this companion set. */
  triggeredBy: string[]
  /** Periphery contracts, any one of which satisfies it. */
  requiresAnyOf: string[]
}

/** A facet whose companion requirement is deliberately not enforced on this chain. */
export interface ISkippedCouplingRequirement {
  facet: string
  requiresAnyOf: string[]
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
 * Each present facet is looked up directly by name. Facets that require the same companion set are
 * merged into one requirement, so three Across V4 facets needing `ReceiverAcrossV4` produce a single
 * entry listing all three as `triggeredBy`. A facet is reported as `skipped` (with a reason) instead
 * when `notRequiredOn` names this network. Pure — callers do the on-chain lookup.
 *
 * @param presentFacets - facet names live on the chain (registered in the diamond)
 * @param network - network key as in `config/networks.json`; matched case-insensitively
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
  // Keyed by the companion set so facets of the same family collapse into one requirement.
  const byCompanionSet = new Map<string, IActiveCouplingRequirement>()

  for (const facet of [...new Set(presentFacets)].sort()) {
    const declaration = couplings[facet]
    if (!declaration) continue

    const requiresAnyOf = declaration.requiresAnyOf ?? []
    if (requiresAnyOf.length === 0) continue

    const perNetworkReason = Object.entries(
      declaration.notRequiredOn ?? {}
    ).find(([key]) => key.toLowerCase() === networkLower)?.[1]
    if (perNetworkReason) {
      skipped.push({ facet, requiresAnyOf, reason: perNetworkReason })
      continue
    }

    const key = requiresAnyOf.join('|')
    const existing = byCompanionSet.get(key)
    if (existing) existing.triggeredBy.push(facet)
    else byCompanionSet.set(key, { triggeredBy: [facet], requiresAnyOf })
  }

  return { required: [...byCompanionSet.values()], skipped }
}

/** One diamond facet as returned by `facets()`: its address and the selectors it serves. */
export interface IOnChainFacetSelectors {
  address: string
  selectors: string[]
}

/** Live-facet resolution for one chain, plus a warning when a possible gap could not be closed. */
export interface IResolvedLiveFacets {
  /** Facet names live on the chain: the deploy log and on-chain selectors, unioned. */
  liveFacets: string[]
  /**
   * Non-null when a facet is registered on chain, absent from the deploy log, and some candidate's
   * selectors could not be determined — so a coupled facet could be missed and the gate must not
   * pass silently.
   */
  blindSpotWarning: string | null
  /**
   * One note per candidate the deploy log identifies whose current-artifact selectors match no
   * on-chain facet (deployed build older than HEAD): selector identity is inactive for it, so its
   * coverage rests on the deploy log alone.
   */
  versionDriftNotes: string[]
}

/**
 * Facet names are Solidity contract identifiers (alphanumeric + underscore). Reject anything else
 * so a name can never traverse outside `out/` (e.g. `../../.env`) once composed into a file path.
 */
export function isValidFacetName(name: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(name)
}

/**
 * Load a facet's `methodIdentifiers` (function signature → 4-byte selector hex, no `0x`) from its
 * Forge artifact (`out/<Facet>.sol/<Facet>.json`).
 *
 * @returns the map, or null when the artifact or its `methodIdentifiers` is absent — callers treat
 *   null as "identity unknown", never as "facet not present" (the TS unit-test job runs without a
 *   Foundry build, so `out/` is legitimately missing there).
 */
function loadFacetMethodIdentifiers(
  facetName: string
): Record<string, string> | null {
  if (!isValidFacetName(facetName)) return null

  const outDir = resolve(process.cwd(), 'out')
  const artifactPath = resolve(outDir, `${facetName}.sol`, `${facetName}.json`)
  // Belt-and-braces on top of the name check: the resolved path must stay inside out/, so no
  // combination of inputs can make this read an arbitrary file.
  const relativeToDir = relative(outDir, artifactPath)
  if (relativeToDir.startsWith('..') || isAbsolute(relativeToDir)) return null

  if (!existsSync(artifactPath)) return null
  try {
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      methodIdentifiers?: Record<string, string>
    }
    return artifact.methodIdentifiers ?? null
  } catch {
    return null
  }
}

/**
 * Load a facet's full function selector set from its Forge artifact, lowercased and `0x`-prefixed.
 * Selectors are keccak of the function signature, so they are the same across compilers
 * (evm / zkevm) and match what a diamond's `facets()` returns on any chain.
 *
 * @returns the selectors, or null when the artifact or its `methodIdentifiers` is absent
 */
export function loadFacetSelectorsFromArtifact(
  facetName: string
): string[] | null {
  const methodIdentifiers = loadFacetMethodIdentifiers(facetName)
  if (!methodIdentifiers) return null
  return Object.values(methodIdentifiers).map(
    (selector) => '0x' + selector.toLowerCase()
  )
}

/** `getExcludes()` content parsed from an update script: function names and/or raw literals. */
export interface IParsedUpdateScriptExcludes {
  /** Excludes written as `excludes[i] = <facet>.<name>.selector;` — the function names. */
  functionNames: string[]
  /** Excludes written as raw literals (`excludes[i] = 0x23452b9c;`), lowercased. */
  literalSelectors: string[]
}

/**
 * Parse the selector excludes out of an update script's `getExcludes()` body.
 *
 * The parse is validated against the declared array size (`new bytes4[](N)`): if the number of
 * recognized assignments differs from N, the body uses a shape this parser does not understand and
 * the result is null ("excludes unknown") rather than a silently incomplete list — an incomplete
 * list would make the caller compute a registered-selector set that never matches on chain.
 *
 * @param source - full Solidity source of `script/deploy/facets/Update<Facet>.s.sol`
 * @returns the parsed excludes; empty lists when the script overrides nothing; null when a
 *   `getExcludes()` body exists but could not be fully parsed
 */
export function parseUpdateScriptExcludes(
  source: string
): IParsedUpdateScriptExcludes | null {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  const marker = stripped.indexOf('function getExcludes')
  if (marker === -1) return { functionNames: [], literalSelectors: [] }

  const bodyStart = stripped.indexOf('{', marker)
  if (bodyStart === -1) return null
  let depth = 0
  let bodyEnd = -1
  for (let i = bodyStart; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++
    else if (stripped[i] === '}') {
      depth--
      if (depth === 0) {
        bodyEnd = i
        break
      }
    }
  }
  if (bodyEnd === -1) return null
  const body = stripped.slice(bodyStart + 1, bodyEnd)

  const sizeMatch = body.match(/new bytes4\[\]\((\d+)\)/)
  if (!sizeMatch) return null
  const declaredSize = Number(sizeMatch[1])

  const functionNames = [
    ...body.matchAll(
      /=\s*[A-Za-z0-9_$.\s]*?([A-Za-z0-9_$]+)\s*\.\s*selector\s*;/g
    ),
  ]
    .map((match) => match[1])
    .filter((name): name is string => typeof name === 'string')
  const literalSelectors = [...body.matchAll(/=\s*(0x[0-9a-fA-F]{8})\s*;/g)]
    .map((match) => match[1])
    .filter((literal): literal is string => typeof literal === 'string')
    .map((literal) => literal.toLowerCase())

  if (functionNames.length + literalSelectors.length !== declaredSize)
    return null
  return { functionNames, literalSelectors }
}

/**
 * Load the selector set a facet actually REGISTERS on chain: its artifact selectors minus the
 * update script's `getExcludes()`.
 *
 * The distinction matters: facets are cut into the diamond with exclusions (immutable getters,
 * ownership functions that would collide with OwnershipFacet), so a facet's full artifact selector
 * set never appears on chain for such facets — matching against it would silently identify
 * nothing. `UpdateAcrossFacetV4.s.sol` alone excludes `SPOKEPOOL()` and `WRAPPED_NATIVE()`.
 *
 * @returns the registered selectors (lowercased, `0x`-prefixed), or null when the identity cannot
 *   be established: artifact missing, excludes unparseable, an excluded name absent from the
 *   artifact (script and build drifted apart), or the zksync update script declaring different
 *   excludes than the canonical one (this loader is network-agnostic, so a divergence means the
 *   registered set is ambiguous)
 */
export function loadFacetRegisteredSelectors(
  facetName: string
): string[] | null {
  const methodIdentifiers = loadFacetMethodIdentifiers(facetName)
  if (!methodIdentifiers) return null

  const parsed = parseExcludesFromScript(
    resolve(process.cwd(), 'script', 'deploy', 'facets'),
    `Update${facetName}.s.sol`
  )
  if (parsed === null) return null

  // zksync diamonds are cut by their own update script; if its excludes diverge from the
  // canonical one, a single network-agnostic registered set does not exist.
  const zksyncParsed = parseExcludesFromScript(
    resolve(process.cwd(), 'script', 'deploy', 'zksync'),
    `Update${facetName}.zksync.s.sol`
  )
  if (zksyncParsed === null) return null
  if (zksyncParsed !== 'absent' && parsed !== 'absent') {
    const canonical = JSON.stringify({
      names: [...parsed.functionNames].sort(),
      literals: [...parsed.literalSelectors].sort(),
    })
    const zksync = JSON.stringify({
      names: [...zksyncParsed.functionNames].sort(),
      literals: [...zksyncParsed.literalSelectors].sort(),
    })
    if (canonical !== zksync) return null
  }

  const excluded = new Set<string>()
  const effective =
    parsed !== 'absent'
      ? parsed
      : zksyncParsed !== 'absent'
      ? zksyncParsed
      : null
  if (effective) {
    for (const literal of effective.literalSelectors) excluded.add(literal)
    for (const name of effective.functionNames) {
      const selectors = Object.entries(methodIdentifiers)
        .filter(([signature]) => signature.startsWith(`${name}(`))
        .map(([, selector]) => '0x' + selector.toLowerCase())
      if (selectors.length === 0) return null
      for (const selector of selectors) excluded.add(selector)
    }
  }

  return Object.values(methodIdentifiers)
    .map((selector) => '0x' + selector.toLowerCase())
    .filter((selector) => !excluded.has(selector))
}

/**
 * Read and parse one update script's excludes, with path containment.
 *
 * @returns the parsed excludes; `'absent'` when the script does not exist (the standard tooling
 *   never cut this facet with exclusions from that script); null when it exists but cannot be
 *   parsed or the path escapes the scripts dir
 */
function parseExcludesFromScript(
  scriptsDir: string,
  fileName: string
): IParsedUpdateScriptExcludes | 'absent' | null {
  const scriptPath = resolve(scriptsDir, fileName)
  // Belt-and-braces on top of the name check: the resolved path must stay inside the scripts dir.
  const relativeToDir = relative(scriptsDir, scriptPath)
  if (relativeToDir.startsWith('..') || isAbsolute(relativeToDir)) return null

  if (!existsSync(scriptPath)) return 'absent'
  try {
    return parseUpdateScriptExcludes(readFileSync(scriptPath, 'utf8'))
  } catch {
    return null
  }
}

/** Selector-based facet identity for one chain. */
export interface ICoupledFacetIdentity {
  /** Names whose registered selector set is live on some on-chain facet. */
  live: string[]
  /** Names whose registered selectors could not be determined, so presence could not be judged. */
  unresolved: string[]
  /** On-chain facet address per identified name (unique: a diamond maps each selector once). */
  addressByName: Record<string, string>
}

/**
 * Identify which of `facetNames` are live on a chain from the diamond's on-chain selector map,
 * without consulting the deploy log.
 *
 * Facet identity is otherwise resolved by matching an on-chain address against
 * `deployments/<network>.json`, which can be incomplete: a facet registered on chain may have no
 * entry there (the `no-unexpected-facets` health-check warning exists for exactly this). A diamond
 * maps each selector to exactly one facet, so a facet is present iff some on-chain facet registers
 * its whole REGISTERED selector set — artifact selectors minus the update script's `getExcludes()`,
 * because facets are cut with exclusions and the full artifact set never appears on chain for them.
 *
 * @param onChainFacets - the diamond's registered facets (address + selectors), from `facets()`
 * @param facetNames - candidate facet names to test for (coupling registry keys, or any other
 *   facet names a caller needs to locate on chain)
 * @param loadRegisteredSelectors - registered-selector loader; injectable for tests, defaults to
 *   reading `out/` + the facet's update script
 */
export function identifyCoupledFacetsOnChain(
  onChainFacets: IOnChainFacetSelectors[],
  facetNames: string[],
  loadRegisteredSelectors: (
    facetName: string
  ) => string[] | null = loadFacetRegisteredSelectors
): ICoupledFacetIdentity {
  const candidates = onChainFacets.map((facet) => ({
    address: facet.address,
    selectorSet: new Set(
      facet.selectors.map((selector) => selector.toLowerCase())
    ),
  }))
  const live: string[] = []
  const unresolved: string[] = []
  const addressByName: Record<string, string> = {}

  for (const name of facetNames) {
    const selectors = loadRegisteredSelectors(name)
    // Empty is unresolved, not absent: an empty wanted set would vacuously match every facet.
    if (!selectors || selectors.length === 0) {
      unresolved.push(name)
      continue
    }
    const wanted = selectors.map((selector) => selector.toLowerCase())
    const match = candidates.find((candidate) =>
      wanted.every((selector) => candidate.selectorSet.has(selector))
    )
    if (match) {
      live.push(name)
      addressByName[name] = match.address
    }
  }

  return { live, unresolved, addressByName }
}

/**
 * Resolve which facets are live on a chain, unioning two independent identity sources so coverage
 * only grows: the deploy log (address → name) and on-chain selectors matched to compiled artifacts.
 *
 * Relying on the deploy log alone lets a facet that is live on chain but missing from the log fall
 * through — silently, on an error gate. The selector source does not depend on the log, so such a
 * facet is still caught. When a candidate's registered selectors could not be determined
 * (`unresolved`: `out/` not built, unparseable excludes) AND an on-chain facet is absent from the
 * deploy log, `blindSpotWarning` is set so the reduced coverage stays visible — per candidate, not
 * only when identity failed wholesale, because unresolvability is a per-facet condition.
 *
 * A candidate the deploy log names but whose current-artifact selectors match nothing on chain is
 * reported in `versionDriftNotes`: the deployed build predates the artifact, so selector identity
 * is inactive for it and only the deploy log covers it.
 *
 * @param onChainFacets - the diamond's registered facets (address + selectors), from `facets()`
 * @param deployedContracts - the deploy log for this chain (`deployments/<network>.json`)
 * @param candidateFacetNames - facet names to identify by selector (the coupling registry keys)
 * @param loadRegisteredSelectors - registered-selector loader; injectable for tests, defaults to
 *   reading `out/` + the facet's update script
 */
export function resolveLiveFacets(
  onChainFacets: IOnChainFacetSelectors[],
  deployedContracts: Record<string, string>,
  candidateFacetNames: string[],
  loadRegisteredSelectors: (
    facetName: string
  ) => string[] | null = loadFacetRegisteredSelectors
): IResolvedLiveFacets {
  const nameByAddress = Object.fromEntries(
    Object.entries(deployedContracts).map(([name, address]) => [
      String(address).toLowerCase(),
      name,
    ])
  )

  const fromDeployLog = onChainFacets
    .map((facet) => nameByAddress[facet.address.toLowerCase()])
    .filter((name): name is string => typeof name === 'string')

  const { live: fromSelectors, unresolved } = identifyCoupledFacetsOnChain(
    onChainFacets,
    candidateFacetNames,
    loadRegisteredSelectors
  )

  const unidentifiedOnChain = onChainFacets.filter(
    (facet) => !nameByAddress[facet.address.toLowerCase()]
  )
  // Warn when ANY candidate's selectors could not be determined while an on-chain facet is
  // unaccounted for in the deploy log: that unresolved candidate could be exactly that facet,
  // and it would slip through the coupling gate unseen.
  const blindSpotWarning =
    unresolved.length > 0 && unidentifiedOnChain.length > 0
      ? `${
          unidentifiedOnChain.length
        } on-chain facet(s) absent from the deploy log while the registered selectors of ${unresolved.join(
          ', '
        )} could not be determined (run 'forge build'; check the update script's getExcludes shape) - a coupled facet could be missed`
      : null

  const versionDriftNotes = candidateFacetNames
    .filter(
      (name) =>
        fromDeployLog.includes(name) &&
        !fromSelectors.includes(name) &&
        !unresolved.includes(name)
    )
    .map(
      (name) =>
        `${name} is on chain (deploy log) but its registered selectors do not match the current artifact - deployed build predates HEAD, selector identity inactive for it`
    )

  return {
    liveFacets: [...new Set([...fromDeployLog, ...fromSelectors])],
    blindSpotWarning,
    versionDriftNotes,
  }
}
