/**
 * The loupe read feeding an upgrade cut, driven through the transport seam so
 * the real troncast parsing stays under test.
 *
 * What is pinned here is that parsing: `callTronContract` hands back the
 * command echo and TronWeb's diagnostic lines along with the value, and a
 * routing table misread as empty produces a cut that removes nothing — a
 * silent failure that only surfaces as the old facet still being routable
 * after the cut executes.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  readFacetRouting,
  type TronContractCaller,
} from './diamond-loupe-reads'

const DIAMOND = 'TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt'
const ECO_FACET = 'TG6586TTEv664XWSD875tMk6yDuwedphpW'
const OWNERSHIP_FACET = 'TVofq5iFiwsDf4M3xcucpV7HCX5M6XpcHW'

/** Per [CONV:TEST-ASSERT-REJECTS] — `expect().rejects` is not a real Promise. */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp | string
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  if (match instanceof RegExp) expect(error?.message).toMatch(match)
  else expect(error?.message).toContain(match)
}

/** Records what it was asked and replays `output`, the way troncast prints it. */
const stubCaller = (
  output: string
): { call: TronContractCaller; asked: () => [string, string[]] } => {
  let signature = ''
  let params: string[] = []
  return {
    call: async (_address, functionSignature, callParams) => {
      signature = functionSignature
      params = callParams
      return output
    },
    asked: () => [signature, params],
  }
}

describe('readFacetRouting', () => {
  it('reads the whole table past the command echo and diagnostics', async () => {
    const stub = stubCaller(
      [
        '$ bun run script/troncast/index.ts call …',
        '⚙ Initializing TronWeb...',
        `[[${ECO_FACET} [0x0ff754ea 0x7e56b7b0]] [${OWNERSHIP_FACET} [0x8da5cb5b]]]`,
      ].join('\n')
    )

    expect(await readFacetRouting(DIAMOND, 'rpc', stub.call)).toEqual([
      { facet: ECO_FACET, selectors: ['0x0ff754ea', '0x7e56b7b0'] },
      { facet: OWNERSHIP_FACET, selectors: ['0x8da5cb5b'] },
    ])
    expect(stub.asked()).toEqual(['facets()', []])
  })

  // A live diamond always routes the loupe itself, so nothing at all means the
  // read failed — believing it would drop every Remove from the cut.
  it('refuses an empty table rather than reading it as a bare diamond', async () => {
    await expectRejects(
      readFacetRouting(DIAMOND, 'rpc', stubCaller('[]').call),
      `The loupe on ${DIAMOND} reported no facets`
    )
  })

  // A short table is worse than no table: the dropped facet's selectors read as
  // unrouted, pass the collision guard as Adds, and revert at execution.
  it('refuses a table with a row the parser could not read', async () => {
    const stub = stubCaller(
      `[[${ECO_FACET} [0x0ff754ea]] [${OWNERSHIP_FACET} [zzzz]]]`
    )

    await expectRejects(
      readFacetRouting(DIAMOND, 'rpc', stub.call),
      `returned facet rows the parser could not read: ${OWNERSHIP_FACET}`
    )
  })

  it('refuses output whose shape the parser does not match', async () => {
    await expectRejects(
      readFacetRouting(
        DIAMOND,
        'rpc',
        stubCaller('Error: connection refused').call
      ),
      /reported no facets/
    )
  })
})
