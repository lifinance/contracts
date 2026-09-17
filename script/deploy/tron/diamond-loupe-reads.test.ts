/**
 * The loupe reads feeding an upgrade cut, driven through the transport seam so
 * the real troncast parsers stay under test.
 *
 * What is pinned here is that parsing: `callTronContract` hands back the
 * command echo and TronWeb's diagnostic lines along with the value, and a
 * selector list misread as empty produces a cut that removes nothing — a
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
  readFacetAddress,
  readRegisteredSelectors,
  type TronContractCaller,
} from './diamond-loupe-reads'

const DIAMOND = 'TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt'
const ECO_FACET = 'TG6586TTEv664XWSD875tMk6yDuwedphpW'
const ECO_FACET_HEX = '0x431d16f24befda1794fa7e94805e326dc32c7674'
const ZERO_BASE58 = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'

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

describe('readRegisteredSelectors', () => {
  it('reads the selectors past the command echo and diagnostics', async () => {
    const stub = stubCaller(
      [
        '$ bun run script/troncast/index.ts call …',
        '⚙ Formatted params: []',
        '[0x0ff754ea 0x7e56b7b0 0x9e75aa95]',
      ].join('\n')
    )

    expect(
      await readRegisteredSelectors(DIAMOND, ECO_FACET, 'rpc', stub.call)
    ).toEqual(['0x0ff754ea', '0x7e56b7b0', '0x9e75aa95'])
    expect(stub.asked()).toEqual([
      'facetFunctionSelectors(address)',
      [ECO_FACET],
    ])
  })

  it('returns an empty list for a facet the diamond does not route to', async () => {
    const stub = stubCaller('⚙ Formatted params: []\n[]')

    expect(
      await readRegisteredSelectors(DIAMOND, ECO_FACET, 'rpc', stub.call)
    ).toEqual([])
  })

  it('prefixes selectors that come back bare', async () => {
    const stub = stubCaller('[0ff754ea]')

    expect(
      await readRegisteredSelectors(DIAMOND, ECO_FACET, 'rpc', stub.call)
    ).toEqual(['0x0ff754ea'])
  })
})

describe('readFacetAddress', () => {
  it('converts the routed facet to EVM hex', async () => {
    const stub = stubCaller(
      `⚙ Calling facetAddress on ${DIAMOND}\n${ECO_FACET}`
    )

    expect(
      (
        await readFacetAddress(DIAMOND, '0x0ff754ea', 'rpc', 'tron', stub.call)
      ).toLowerCase()
    ).toBe(ECO_FACET_HEX)
    expect(stub.asked()).toEqual(['facetAddress(bytes4)', ['0x0ff754ea']])
  })

  it('reports an unrouted selector as the zero address', async () => {
    const stub = stubCaller(ZERO_BASE58)

    expect(
      await readFacetAddress(DIAMOND, '0xdeadbeef', 'rpc', 'tron', stub.call)
    ).toBe('0x0000000000000000000000000000000000000000')
  })
})
