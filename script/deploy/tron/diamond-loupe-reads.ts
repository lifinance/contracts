/**
 * Loupe reads against a Tron diamond: what the diamond routes where, today.
 *
 * Kept apart from the cut arithmetic in `facet-upgrade-cut.ts` (pure, unit
 * tested) so the arithmetic never needs a network to be exercised.
 */

import type { IFacetRoutingEntry } from './facet-upgrade-cut'
import { parseTroncastFacetsOutput } from './helpers/parseTroncastFacetsOutput'
import { callTronContract, normalizeSelector } from './tronUtils'

/**
 * Makes a constant call and returns troncast's raw output. The seam exists so
 * the readers below can be tested against recorded output without a network —
 * mocking the module instead would leak into every other suite in the run.
 */
export type TronContractCaller = typeof callTronContract

/**
 * Reads the diamond's whole routing table in one call.
 *
 * One `facets()` read answers both questions an upgrade asks — what the
 * outgoing facet serves, and who holds each selector being added. Asking per
 * selector instead costs a `bun run troncast` subprocess and a rate-limit
 * delay each.
 * @param diamondAddress - Diamond, base58
 * @param rpcUrl - Tron RPC the loupe is read through
 * @param call - Constant-call transport; defaults to troncast
 * @returns One entry per facet the diamond routes to, selectors `0x`-prefixed
 * @throws When the loupe yields no facets — see below
 */
export async function readFacetRouting(
  diamondAddress: string,
  rpcUrl: string,
  call: TronContractCaller = callTronContract
): Promise<IFacetRoutingEntry[]> {
  const output = await call(
    diamondAddress,
    'facets()',
    [],
    '(address,bytes4[])[]',
    rpcUrl
  )
  const parsed = parseTroncastFacetsOutput(output)

  // The parser returns [] both for a diamond that routes nothing — which a live
  // one never does, it routes the loupe itself — and for output whose shape it
  // could not match. Reading the second as the first plans every selector as an
  // Add and drops every Remove, which is the failure this planner exists to
  // prevent, so an empty table is refused rather than believed.
  if (parsed.length === 0)
    throw new Error(
      `The loupe on ${diamondAddress} reported no facets — the call failed, or troncast printed a shape the parser does not match`
    )

  return parsed.map(([facet, selectors]) => ({
    facet,
    selectors: selectors.map(normalizeSelector),
  }))
}
