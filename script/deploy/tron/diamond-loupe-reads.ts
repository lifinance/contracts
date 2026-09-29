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

/** One `facets()` row: `[<base58> [<selector> ...]]`, selectors optional. */
const FACET_ROW = /\[T[A-Za-z0-9]{33}\s+\[(?:0x[\da-fA-F]+\s*)*\]\]/

/** The whole table, anchored — nothing before or after the rows. */
const COMPLETE_TABLE = new RegExp(`^\\[\\s*(?:${FACET_ROW.source}\\s*)+\\]$`)

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
  // troncast prints its diagnostics before the value, so the table runs from the
  // first `[[` to the last `]`.
  const start = output.indexOf('[[')
  const end = output.lastIndexOf(']')
  const table = start === -1 || end <= start ? '' : output.slice(start, end + 1)

  // A live diamond always routes the loupe itself, so no table at all means the
  // read failed. Believing it would plan every selector as an Add and drop every
  // Remove — the failure this planner exists to prevent.
  if (table === '')
    throw new Error(
      `The loupe on ${diamondAddress} reported no facets — the call failed, or troncast printed no table`
    )

  // `parseTroncastFacetsOutput` scans for rows anywhere in the string and skips
  // what it cannot match, which is right for the health check but not here: a
  // table truncated mid-address, or one trailed by error text, would parse to a
  // short table, and a short table is worse than none — the missing facet's
  // selectors look unrouted, pass the collision guard as Adds, and revert
  // FunctionAlreadyExists once the timelock delay has elapsed. So the whole
  // region has to be rows, end to end, before the parse is believed.
  if (!COMPLETE_TABLE.test(table))
    throw new Error(
      `The loupe on ${diamondAddress} returned a facet table this reader will not parse — truncated, or trailed by output that is not a facet row: ${table.slice(
        0,
        200
      )}`
    )

  // troncast prints the value last, so anything after the table means the call
  // said something on its way out — refuse rather than read past it.
  const trailing = output.slice(end + 1).trim()
  if (trailing !== '')
    throw new Error(
      `The loupe on ${diamondAddress} printed output after the facet table: ${trailing.slice(
        0,
        200
      )}`
    )

  const parsed = parseTroncastFacetsOutput(output)
  const rows = table.match(new RegExp(FACET_ROW.source, 'g'))?.length ?? 0
  if (parsed.length !== rows)
    throw new Error(
      `The loupe on ${diamondAddress} returned ${rows} facet rows but ${parsed.length} parsed`
    )

  return parsed.map(([facet, selectors]) => ({
    facet,
    selectors: selectors.map(normalizeSelector),
  }))
}
