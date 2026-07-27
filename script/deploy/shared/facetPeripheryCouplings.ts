/**
 * Facet ↔ periphery coupling registry reader (EXSC-682 follow-up).
 *
 * Some facets are only half a feature on their own: a bridge facet handles the source side, while
 * the matching Receiver handles destination calls. Nothing used to tie the two together, so a facet
 * could be rolled out to a new chain while its companion Receiver was silently forgotten — which is
 * what disabled Across destination calls on Robinhood.
 *
 * `config/global.json` → `facetPeripheryCouplings` declares those couplings. This module reads them
 * and evaluates, for one chain, which companion periphery contracts are actually required. Import it
 * from the health-check invariant (the enforcing consumer) and from the deploy-time reminder.
 */
import globalConfig from '../../../config/global.json'

/** One declared coupling: the facets that imply it and the periphery that satisfies it. */
export interface IFacetPeripheryCoupling {
  /** Facet names that, when live on a chain, make this coupling apply. */
  facets: string[]
  /** Periphery contracts, ANY ONE of which satisfies the coupling. */
  requiresAnyOf: string[]
  /**
   * Set when the coupling is recorded but not active yet (integration shipped source-side only).
   * A non-empty reason disables the requirement on every chain — recording the relationship now so
   * nobody has to rediscover it, without failing checks for a feature that does not exist.
   */
  notRequiredYet?: string
  /** Per-network carve-outs: network key → why the companion is genuinely not needed there. */
  notRequiredOn?: Record<string, string>
  /** Free-form context for humans reading the config. Never consumed by code. */
  devNotes?: string
}

/** Map of coupling key (e.g. `acrossV4`) → its declaration. */
export type TFacetPeripheryCouplings = Record<string, IFacetPeripheryCoupling>

/** An active requirement for one chain: this coupling applies and must be satisfied. */
export interface IActiveCouplingRequirement {
  /** Coupling key as declared in config (e.g. `acrossV4`). */
  coupling: string
  /** The facets present on this chain that triggered the requirement. */
  triggeredBy: string[]
  /** Periphery contracts, any one of which satisfies it. */
  requiresAnyOf: string[]
}

/** A coupling that applies to this chain's facets but is deliberately not enforced. */
export interface ISkippedCouplingRequirement {
  coupling: string
  triggeredBy: string[]
  /** Why it is not enforced — always printed so a carve-out is never invisible. */
  reason: string
}

/** Outcome of evaluating every declared coupling against one chain's facet set. */
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
 * A coupling applies as soon as ANY of its `facets` is present. It is reported as `skipped` (with a
 * reason) rather than `required` when it carries `notRequiredYet`, or when `notRequiredOn` names this
 * network. Pure — callers do the on-chain/deploy-log lookup.
 *
 * @param presentFacets - facet names live on the chain (registered in the diamond or target state)
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
  const present = new Set(presentFacets)
  const required: IActiveCouplingRequirement[] = []
  const skipped: ISkippedCouplingRequirement[] = []

  for (const [coupling, declaration] of Object.entries(couplings)) {
    const triggeredBy = (declaration.facets ?? []).filter((facet) =>
      present.has(facet)
    )
    if (triggeredBy.length === 0) continue

    if (declaration.notRequiredYet) {
      skipped.push({
        coupling,
        triggeredBy,
        reason: declaration.notRequiredYet,
      })
      continue
    }

    const perNetworkReason = Object.entries(
      declaration.notRequiredOn ?? {}
    ).find(([key]) => key.toLowerCase() === networkLower)?.[1]
    if (perNetworkReason) {
      skipped.push({ coupling, triggeredBy, reason: perNetworkReason })
      continue
    }

    required.push({
      coupling,
      triggeredBy,
      requiresAnyOf: declaration.requiresAnyOf ?? [],
    })
  }

  return { required, skipped }
}
