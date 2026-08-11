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
 * actually required. Import it from the `facet-required-periphery` health-check invariant.
 */
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

/**
 * Resolve which coupled facets are live on a chain from the deploy log, confirmed against the
 * diamond's registered facet addresses.
 *
 * A facet counts as live iff its `deployments/<network>.json` address is one of the addresses the
 * diamond returns from `facets()`. The reverse gap — a facet registered on chain but absent from the
 * deploy log — is the domain of the `no-unexpected-facets` warning, not this gate: a diamond whose
 * live facets are not even recorded in the deploy log has a bookkeeping failure that a coupling check
 * should not try to reconstruct from compiled selectors.
 *
 * @param onChainFacetAddresses - facet addresses from the diamond's `facets()` call
 * @param deployedContracts - the deploy log for this chain (`deployments/<network>.json`)
 * @param candidateFacetNames - facet names to test (the coupling registry keys)
 * @returns the subset of `candidateFacetNames` whose deploy-log address is registered on chain
 */
export function resolveLiveFacetsFromLog(
  onChainFacetAddresses: string[],
  deployedContracts: Record<string, string>,
  candidateFacetNames: string[]
): string[] {
  const onChain = new Set(
    onChainFacetAddresses.map((address) => address.toLowerCase())
  )
  return candidateFacetNames.filter((name) => {
    const address = deployedContracts[name]
    return typeof address === 'string' && onChain.has(address.toLowerCase())
  })
}
