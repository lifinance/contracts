/**
 * The decode seam the sign-time codehash gate reads its targets from.
 *
 * Two properties are load-bearing and are asserted rather than assumed. The cut
 * is recovered through the display path's own `ABI_DIAMOND_CUT`, so the bytes
 * vouched for and the bytes shown cannot come from two ABIs. And the timelock
 * envelope is unwrapped, because every production proposal is `scheduleBatch`-
 * wrapped and a gate that only reads the outer selector sees nothing.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, getAddress, type Hex } from 'viem'

import { FacetCutActionEnum } from '../codehash/cut-classification'

import { ABI_DIAMOND_CUT, collectDiamondCutTargets } from './safe-decode-utils'
import { TIMELOCK_SCHEDULE_BATCH_ABI } from './timelock-abi'

const FACET_A = '0x1111111111111111111111111111111111111111'
const FACET_B = '0x2222222222222222222222222222222222222222'
const INIT = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const DIAMOND = '0x4444444444444444444444444444444444444444'
const TIMELOCK = '0x5555555555555555555555555555555555555555'
const SELECTOR_A = '0xaabbccdd'
const SELECTOR_B = '0x11223344'

const cutCalldata = (
  entries: [string, number, string[]][],
  init: string,
  initCalldata: Hex = '0x'
): Hex =>
  encodeFunctionData({
    abi: ABI_DIAMOND_CUT,
    functionName: 'diamondCut',
    args: [
      entries.map(([address, action, selectors]) => [
        address as `0x${string}`,
        action,
        selectors as `0x${string}`[],
      ]) as never,
      init as `0x${string}`,
      initCalldata,
    ],
  })

const scheduleBatch = (payloads: Hex[], targets: string[] = []): Hex =>
  encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      (targets.length > 0 ? targets : payloads.map(() => DIAMOND)).map(
        (t) => t as `0x${string}`
      ),
      payloads.map(() => 0n),
      payloads,
      `0x${'00'.repeat(32)}` as Hex,
      `0x${'11'.repeat(32)}` as Hex,
      86_400n,
    ],
  })

describe('collectDiamondCutTargets', () => {
  it('recovers the cut entries and the init target from a bare diamondCut', () => {
    const collected = collectDiamondCutTargets(
      cutCalldata(
        [
          [FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]],
          [FACET_B, FacetCutActionEnum.Remove, [SELECTOR_B]],
        ],
        INIT,
        '0xdeadbeef'
      )
    )

    expect(collected.refusals).toEqual([])
    expect(collected.calls).toHaveLength(1)
    const call = collected.calls[0]
    expect(call?.init).toBe(getAddress(INIT))
    expect(call?.cuts).toEqual([
      { facetAddress: getAddress(FACET_A), action: FacetCutActionEnum.Add },
      { facetAddress: getAddress(FACET_B), action: FacetCutActionEnum.Remove },
    ])
  })

  it('unwraps the scheduleBatch envelope every production proposal carries', () => {
    const collected = collectDiamondCutTargets(
      scheduleBatch([
        cutCalldata(
          [[FACET_A, FacetCutActionEnum.Replace, [SELECTOR_A]]],
          ZERO
        ),
      ])
    )

    expect(collected.refusals).toEqual([])
    expect(collected.calls).toHaveLength(1)
    expect(collected.calls[0]?.cuts[0]?.facetAddress).toBe(getAddress(FACET_A))
    expect(collected.calls[0]?.init).toBe(getAddress(ZERO))
  })

  it('recovers every cut in a multi-payload batch, not just the first', () => {
    const collected = collectDiamondCutTargets(
      scheduleBatch([
        cutCalldata([[FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]]], ZERO),
        cutCalldata([[FACET_B, FacetCutActionEnum.Add, [SELECTOR_B]]], ZERO),
      ])
    )

    expect(collected.calls.map((c) => c.cuts[0]?.facetAddress)).toEqual([
      getAddress(FACET_A),
      getAddress(FACET_B),
    ])
  })

  it('ignores non-cut payloads inside the envelope without refusing them', () => {
    const roleChange = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'grantRole',
          inputs: [
            { type: 'bytes32', name: 'role' },
            { type: 'address', name: 'account' },
          ],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'grantRole',
      args: [`0x${'00'.repeat(32)}` as Hex, TIMELOCK as `0x${string}`],
    })

    const collected = collectDiamondCutTargets(scheduleBatch([roleChange]))

    expect(collected.calls).toEqual([])
    expect(collected.refusals).toEqual([])
  })

  it('returns nothing for empty calldata', () => {
    expect(collectDiamondCutTargets('0x')).toEqual({
      calls: [],
      refusals: [],
    })
  })

  it('refuses calldata that hides a cut inside an envelope it cannot decode', () => {
    const inner = cutCalldata(
      [[FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]]],
      ZERO
    )
    // An envelope the display path does not know: a selector nothing here
    // decodes, carrying the cut in its tail.
    const unknownEnvelope = `0xdeadc0de${inner.slice(2)}` as Hex

    const collected = collectDiamondCutTargets(unknownEnvelope)

    expect(collected.calls).toEqual([])
    expect(collected.refusals).toHaveLength(1)
    expect(collected.refusals[0]).toContain('diamondCut')
  })

  it('does not refuse a recognised call whose arguments happen to carry the selector', () => {
    // The paired positive for the refusal above: the same four bytes, in a call
    // the display path decodes, must not read as a hidden cut.
    const cutSelector = cutCalldata(
      [[FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]]],
      ZERO
    ).slice(0, 10) as Hex
    const whitelist = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'batchSetContractSelectorWhitelist',
          inputs: [
            { type: 'address[]', name: 'contracts' },
            { type: 'bytes4[]', name: 'selectors' },
            { type: 'bool', name: 'approved' },
          ],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'batchSetContractSelectorWhitelist',
      args: [[DIAMOND as `0x${string}`], [cutSelector], true],
    })

    const collected = collectDiamondCutTargets(whitelist)

    expect(collected.calls).toEqual([])
    expect(collected.refusals).toEqual([])
  })

  it('unwraps the singular timelock schedule, not only the batch', () => {
    const inner = cutCalldata(
      [[FACET_A, FacetCutActionEnum.Replace, [SELECTOR_A]]],
      ZERO
    )
    const single = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'schedule',
          inputs: [
            { type: 'address', name: 'target' },
            { type: 'uint256', name: 'value' },
            { type: 'bytes', name: 'data' },
            { type: 'bytes32', name: 'predecessor' },
            { type: 'bytes32', name: 'salt' },
            { type: 'uint256', name: 'delay' },
          ],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ],
      functionName: 'schedule',
      args: [
        DIAMOND as `0x${string}`,
        0n,
        inner,
        `0x${'00'.repeat(32)}` as Hex,
        `0x${'11'.repeat(32)}` as Hex,
        86_400n,
      ],
    })

    const collected = collectDiamondCutTargets(single)

    expect(collected.refusals).toEqual([])
    expect(collected.calls).toHaveLength(1)
    expect(collected.calls[0]?.cuts[0]?.facetAddress).toBe(getAddress(FACET_A))
  })

  it('decodes a case-shifted proposal exactly as the lowercase one', () => {
    // Upper-casing the nibbles changes no byte, so the EIP-712 hash and the
    // executed cut are identical — but viem's selector match is
    // case-sensitive, so this decoded to nothing before the hex was folded.
    const lower = scheduleBatch([
      cutCalldata([[FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]]], ZERO),
    ])
    const shifted = `0x${lower.slice(2).toUpperCase()}` as Hex

    expect(collectDiamondCutTargets(shifted)).toEqual(
      collectDiamondCutTargets(lower)
    )
    expect(collectDiamondCutTargets(shifted).calls).toHaveLength(1)
  })

  it('refuses calldata that is not well-formed hex', () => {
    const collected = collectDiamondCutTargets('0xzz1f931c1c' as Hex)

    expect(collected.calls).toEqual([])
    expect(collected.refusals[0]).toContain('not well-formed hex')
  })

  it('refuses odd-length calldata rather than reading it as no cut', () => {
    expect(
      collectDiamondCutTargets('0x1f931c1c0' as Hex).refusals
    ).toHaveLength(1)
  })

  it('refuses a cut hidden one level below a known envelope', () => {
    // The shape an outer-selector test cannot see: the top frame is
    // scheduleBatch, which this decoder does open, and the cut sits inside a
    // payload it does not.
    const inner = cutCalldata(
      [[FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]]],
      ZERO
    )
    const collected = collectDiamondCutTargets(
      scheduleBatch([`0xdeadc0de${inner.slice(2)}` as Hex])
    )

    expect(collected.calls).toEqual([])
    expect(collected.refusals[0]).toContain('0xdeadc0de')
  })

  it('refuses a batch that pairs a readable cut with an unreadable frame', () => {
    const hidden = `0xdeadc0de${cutCalldata(
      [[FACET_B, FacetCutActionEnum.Add, [SELECTOR_B]]],
      ZERO
    ).slice(2)}` as Hex
    const collected = collectDiamondCutTargets(
      scheduleBatch([
        cutCalldata([[FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]]], ZERO),
        hidden,
      ])
    )

    // The readable half is still reported, so the signer sees both facts.
    expect(collected.calls).toHaveLength(1)
    expect(collected.refusals).toHaveLength(1)
  })

  it('refuses a diamondCut whose own body will not decode', () => {
    const truncated = cutCalldata(
      [[FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]]],
      ZERO
    ).slice(0, 60) as Hex

    const collected = collectDiamondCutTargets(truncated)

    expect(collected.calls).toEqual([])
    expect(collected.refusals).toHaveLength(1)
  })

  it('refuses envelopes nested deeper than it will walk', () => {
    let payload = cutCalldata(
      [[FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]]],
      ZERO
    )
    for (let i = 0; i < 6; i += 1) payload = scheduleBatch([payload])

    const collected = collectDiamondCutTargets(payload)

    expect(collected.calls).toEqual([])
    expect(collected.refusals[0]).toContain('deep')
  })

  it('does not refuse an empty payload inside a batch', () => {
    // A value-only entry is a legitimate batch member, not a frame that
    // failed to open — paired with the refusals above so "no refusal" is not
    // the answer to everything.
    const collected = collectDiamondCutTargets(
      scheduleBatch([
        '0x',
        cutCalldata([[FACET_A, FacetCutActionEnum.Add, [SELECTOR_A]]], ZERO),
      ])
    )

    expect(collected.refusals).toEqual([])
    expect(collected.calls).toHaveLength(1)
  })
})
