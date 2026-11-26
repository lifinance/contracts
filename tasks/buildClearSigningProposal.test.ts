/**
 * Tests for the classification step of the clear-signing proposal generator:
 * which diamond functions get a display format, which are skipped, and which
 * fail the build.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  buildFormats,
  UPSTREAM_MAINTAINED_SIGNATURES,
  type IAbiFn,
  type IAbiParam,
} from './buildClearSigningProposal'

const SWAP_DATA_COMPONENTS: IAbiParam[] = [
  { name: 'callTo', type: 'address' },
  { name: 'approveTo', type: 'address' },
  { name: 'sendingAssetId', type: 'address' },
  { name: 'receivingAssetId', type: 'address' },
  { name: 'fromAmount', type: 'uint256' },
  { name: 'callData', type: 'bytes' },
  { name: 'requiresDeposit', type: 'bool' },
]

function swapFn(name: string, multiple: boolean): IAbiFn {
  return {
    type: 'function',
    name,
    stateMutability: 'payable',
    inputs: [
      { name: '_transactionId', type: 'bytes32' },
      { name: '_integrator', type: 'string' },
      { name: '_referrer', type: 'string' },
      { name: '_receiver', type: 'address' },
      { name: '_minAmountOut', type: 'uint256' },
      {
        name: '_swapData',
        type: multiple ? 'tuple[]' : 'tuple',
        components: SWAP_DATA_COMPONENTS,
      },
    ],
  }
}

const UPSTREAM_SIGS = [...UPSTREAM_MAINTAINED_SIGNATURES]
const UPSTREAM_FNS = UPSTREAM_SIGS.map((sig) =>
  swapFn(sig.slice(0, sig.indexOf('(')), true)
)

describe('buildFormats', () => {
  it('emits no format for an upstream-maintained function and does not fail', () => {
    const result = buildFormats(UPSTREAM_FNS)

    expect(result.failures).toEqual([])
    expect(result.formats).toEqual({})
    expect(result.upstreamMaintained).toEqual(UPSTREAM_SIGS)
  })

  it('still emits the formats LI.FI owns next to a skipped function', () => {
    const result = buildFormats([
      ...UPSTREAM_FNS,
      swapFn('swapTokensMultipleV3NativeToERC20', true),
    ])

    expect(result.failures).toEqual([])
    const keys = Object.keys(result.formats)
    expect(keys).toHaveLength(1)
    expect(keys[0]?.startsWith('swapTokensMultipleV3NativeToERC20(')).toBe(true)
  })

  it('fails on an upstream-maintained signature that matches no function', () => {
    const [present, ...missing] = UPSTREAM_FNS
    if (!present) throw new Error('UPSTREAM_MAINTAINED_SIGNATURES is empty')

    const result = buildFormats([present])

    expect(result.failures).toHaveLength(missing.length)
    for (const sig of UPSTREAM_SIGS.slice(1))
      expect(
        result.failures.some((f) =>
          f.startsWith(
            `${sig}\n      reason: listed in UPSTREAM_MAINTAINED_SIGNATURES`
          )
        )
      ).toBe(true)
  })

  it('fails when an upstream-maintained function changes its signature', () => {
    const [changed, ...rest] = UPSTREAM_FNS
    if (!changed) throw new Error('UPSTREAM_MAINTAINED_SIGNATURES is empty')
    const withExtraParam = {
      ...changed,
      inputs: [...changed.inputs, { name: '_deadline', type: 'uint256' }],
    }

    const result = buildFormats([withExtraParam, ...rest])

    expect(result.formats).toEqual({})
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]).toContain(
      `no SWAP_TEMPLATES entry for "${changed.name}"`
    )
    expect(result.failures[1]).toContain(
      'listed in UPSTREAM_MAINTAINED_SIGNATURES but no diamond function'
    )
  })

  it('fails on a swap function with neither a template nor an upstream entry', () => {
    const result = buildFormats([
      ...UPSTREAM_FNS,
      swapFn('swapTokensMultipleV4ERC20ToERC20', true),
    ])

    expect(result.formats).toEqual({})
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain(
      'no SWAP_TEMPLATES entry for "swapTokensMultipleV4ERC20ToERC20"'
    )
  })
})
