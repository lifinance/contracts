/**
 * Turns a facet upgrade into `diamondCut` entries: which selectors are new,
 * which the outgoing facet already serves, and which it serves that the new
 * version dropped.
 *
 * Pure; lives in its own module (not `propose-facet-upgrade-cut.ts`, whose
 * import triggers the citty CLI via `runMain`) so it is unit-testable.
 */

import type { Address, Hex } from 'viem'

import { ZERO_ADDRESS } from '../shared/constants'

/** `LibDiamond.FacetCutAction`: Add=0, Replace=1, Remove=2. */
export const FACET_CUT_ACTION = {
  add: 0,
  replace: 1,
  remove: 2,
} as const

/** One entry of the `diamondCut` array. */
export interface IFacetCut {
  facetAddress: Address
  action: (typeof FACET_CUT_ACTION)[keyof typeof FACET_CUT_ACTION]
  functionSelectors: Hex[]
}

/** How the new facet's selectors line up against the outgoing facet's. */
export interface ISelectorPlan {
  add: Hex[]
  replace: Hex[]
  remove: Hex[]
}

/** One row of a diamond's routing table, as the loupe's `facets()` returns it. */
export interface IFacetRoutingEntry {
  /** Facet address, base58 on Tron. */
  facet: string
  /** Selectors the diamond routes there. */
  selectors: Hex[]
}

/** The facet an upgrade supersedes, resolved against the live routing table. */
export interface IOutgoingFacet {
  /** Address as the diamond log records it, for messages. */
  label: string
  /** The same address in EVM hex form. */
  addressHex: Address
  /** Selectors the diamond routes there today. */
  registered: readonly Hex[]
}

/** Lowercases a selector and gives it a `0x` prefix if it lacks one. */
const normalize = (selector: string): Hex =>
  (selector.startsWith('0x')
    ? selector.toLowerCase()
    : `0x${selector.toLowerCase()}`) as Hex

/**
 * Splits the new facet's selectors against the outgoing facet's registered set.
 * @param newSelectors - Selectors of the facet being installed
 * @param registeredSelectors - Selectors the outgoing facet serves today
 * @returns The Add / Replace / Remove sets, lowercased and `0x`-prefixed
 */
export function planSelectorCuts(
  newSelectors: readonly string[],
  registeredSelectors: readonly string[]
): ISelectorPlan {
  const wanted = newSelectors.map(normalize)
  const registered = registeredSelectors.map(normalize)
  const registeredSet = new Set(registered)
  const wantedSet = new Set(wanted)

  return {
    add: wanted.filter((selector) => !registeredSet.has(selector)),
    replace: wanted.filter((selector) => registeredSet.has(selector)),
    remove: registered.filter((selector) => !wantedSet.has(selector)),
  }
}

/**
 * Plans an upgrade against the facet the diamond routes today.
 *
 * Wraps {@link planSelectorCuts} with the two cases the raw arithmetic cannot
 * see: a diamond log the chain disagrees with, and a re-proposal of an address
 * that is already partly installed.
 * @param facetName - Facet being installed, for the message
 * @param newSelectors - Selectors of the facet being installed
 * @param facetAddressHex - Newly deployed facet, EVM hex
 * @param outgoing - The superseded facet, or null for a first registration
 * @returns The Add / Replace / Remove sets
 * @throws When the log records an outgoing facet the diamond routes nothing to
 */
export function planFacetUpgrade(
  facetName: string,
  newSelectors: readonly string[],
  facetAddressHex: Address,
  outgoing: IOutgoingFacet | null
): ISelectorPlan {
  if (!outgoing) return planSelectorCuts(newSelectors, [])

  // Believing the log here would plan every selector as an Add and drop every
  // Remove — the superseded facet stays routable, which is precisely the bug
  // this planner exists to prevent. Nothing updates the log on a Tron upgrade,
  // so a second upgrade through this path is exactly when it happens.
  if (outgoing.registered.length === 0)
    throw new Error(
      `${facetName} is recorded at ${outgoing.label} in the diamond log, but the diamond routes no selector there. ` +
        `Point that entry at the address the loupe actually serves and re-run — the cut cannot be planned from a log the chain disagrees with.`
    )

  const plan = planSelectorCuts(newSelectors, outgoing.registered)

  // Re-proposing the address that is already installed: a Replace whose target
  // already serves the selector reverts FunctionAlreadyExists
  // (LibDiamond.replaceFunctions), and the selector is already routed where the
  // cut wants it. Only the selectors that never landed are left to do.
  if (outgoing.addressHex.toLowerCase() === facetAddressHex.toLowerCase())
    return { ...plan, replace: [] }

  return plan
}

/**
 * Fails when a selector planned as an Add is already routed somewhere.
 *
 * LibDiamond reverts an Add for a registered selector, and that only surfaces
 * once the timelock delay has elapsed. Taking the selector over as a Replace
 * instead would strand the rest of the holder's selectors on a facet the
 * upgrade never accounted for, so this refuses at proposal time.
 * @param add - Selectors the plan intends to add
 * @param facetName - Facet being installed, for the message
 * @param outgoingLabel - The outgoing facet's address, or a stand-in when none is known
 * @param resolveHolder - Reads which facet the diamond routes a selector to
 * @throws When any selector resolves to a non-zero facet
 */
export async function assertAddsAreUnrouted(
  add: readonly Hex[],
  facetName: string,
  outgoingLabel: string,
  resolveHolder: (selector: Hex) => Promise<Address>
): Promise<void> {
  for (const selector of add) {
    const holder = await resolveHolder(selector)
    if (holder.toLowerCase() !== ZERO_ADDRESS)
      throw new Error(
        `Selector ${selector} of ${facetName} is already served by ${holder}, which is not the outgoing ${outgoingLabel} — resolve the collision before proposing`
      )
  }
}

/**
 * Builds the `diamondCut` entries for a plan, skipping empty ones — LibDiamond
 * reverts on a cut entry that carries no selectors.
 * @param plan - Add / Replace / Remove sets
 * @param newFacetHex - Facet being installed, EVM hex
 * @returns The cut entries, in Add → Replace → Remove order
 */
export function buildFacetCuts(
  plan: ISelectorPlan,
  newFacetHex: Address
): IFacetCut[] {
  const cuts: IFacetCut[] = []

  if (plan.add.length > 0)
    cuts.push({
      facetAddress: newFacetHex,
      action: FACET_CUT_ACTION.add,
      functionSelectors: plan.add,
    })

  if (plan.replace.length > 0)
    cuts.push({
      facetAddress: newFacetHex,
      action: FACET_CUT_ACTION.replace,
      functionSelectors: plan.replace,
    })

  // A Remove cut carries the zero address, per LibDiamond.
  if (plan.remove.length > 0)
    cuts.push({
      facetAddress: ZERO_ADDRESS as Address,
      action: FACET_CUT_ACTION.remove,
      functionSelectors: plan.remove,
    })

  return cuts
}
