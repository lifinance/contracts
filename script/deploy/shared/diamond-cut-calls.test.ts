/**
 * Tests for the shared proposal-calldata walker in `diamond-cut-calls.ts`.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_ZERO_PREDECESSOR,
} from '../safe/timelock-abi'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from './constants'
import { collectDiamondCutCalls } from './diamond-cut-calls'

const FACET_A = '0x1111111111111111111111111111111111111111' as Address
const FACET_B = '0x2222222222222222222222222222222222222222' as Address
const DIAMOND = '0x3333333333333333333333333333333333333333' as Address
const TIMELOCK = '0x4444444444444444444444444444444444444444' as Address
const SAFE = '0x5555555555555555555555555555555555555555' as Address

const SELECTORS = ['0xaabbccdd', '0x11223344'] as Hex[]

const cut = (
  entries: { facetAddress: Address; action: number }[],
  init?: Address
): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      entries.map((entry) => ({
        facetAddress: entry.facetAddress,
        action: entry.action,
        functionSelectors: SELECTORS,
      })),
      init ?? (ZERO_ADDRESS as Address),
      init ? ('0xdeadbeef' as Hex) : ('0x' as Hex),
    ],
  })

const schedule = (target: Address, payload: Hex): Hex =>
  encodeFunctionData({
    abi: parseAbi([
      'function schedule(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt, uint256 delay)',
    ]),
    functionName: 'schedule',
    args: [
      target,
      0n,
      payload,
      TIMELOCK_ZERO_PREDECESSOR,
      TIMELOCK_ZERO_PREDECESSOR,
      86400n,
    ],
  })

const scheduleBatch = (targets: Address[], payloads: Hex[]): Hex =>
  encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      targets,
      targets.map(() => 0n),
      payloads,
      TIMELOCK_ZERO_PREDECESSOR,
      TIMELOCK_ZERO_PREDECESSOR,
      86400n,
    ],
  })

const unknownWrapper = (payload: Hex): Hex =>
  encodeFunctionData({
    abi: parseAbi(['function multiSend(bytes transactions)']),
    functionName: 'multiSend',
    args: [payload],
  })

describe('collectDiamondCutCalls', () => {
  it('keeps the action of every entry, Remove included', () => {
    const payload = cut([
      { facetAddress: FACET_A, action: 1 },
      { facetAddress: ZERO_ADDRESS as Address, action: 2 },
    ])
    const result = collectDiamondCutCalls([payload])
    expect(result.undecodable).toEqual([])
    expect(result.calls).toEqual([
      {
        callIndex: 0,
        cuts: [
          {
            facetAddress: FACET_A,
            action: 1,
            selectors: ['0xaabbccdd', '0x11223344'],
          },
          {
            facetAddress: ZERO_ADDRESS,
            action: 2,
            selectors: ['0xaabbccdd', '0x11223344'],
          },
        ],
        init: ZERO_ADDRESS,
        initCalldata: '0x',
        raw: payload,
      },
    ])
  })

  it('reports the init target of a cut that carries one', () => {
    const result = collectDiamondCutCalls([
      cut([{ facetAddress: FACET_A, action: 0 }], FACET_A),
    ])
    expect(result.calls[0]?.init).toBe(FACET_A)
  })

  it('unwraps a singular timelock schedule', () => {
    const result = collectDiamondCutCalls([
      schedule(DIAMOND, cut([{ facetAddress: FACET_A, action: 0 }])),
    ])
    expect(result.calls.map((c) => c.cuts[0]?.facetAddress)).toEqual([FACET_A])
    expect(result.undecodable).toEqual([])
  })

  it('unwraps a scheduleBatch and keeps the cuts in payload order', () => {
    const result = collectDiamondCutCalls([
      scheduleBatch(
        [DIAMOND, DIAMOND],
        [
          cut([{ facetAddress: FACET_A, action: 0 }]),
          cut([{ facetAddress: FACET_B, action: 1 }]),
        ]
      ),
    ])
    expect(result.calls.map((c) => c.cuts[0]?.facetAddress)).toEqual([
      FACET_A,
      FACET_B,
    ])
    expect(result.calls.map((c) => c.callIndex)).toEqual([0, 0])
  })

  it('refuses a cut nested past the unwrap bound', () => {
    let payload = cut([{ facetAddress: FACET_A, action: 0 }])
    for (let layer = 0; layer < 5; layer++)
      payload = schedule(TIMELOCK, payload)
    const result = collectDiamondCutCalls([payload])
    expect(result.calls).toEqual([])
    expect(result.undecodable).toEqual([0])
  })

  it('reports a cut hidden in an envelope it cannot open', () => {
    const result = collectDiamondCutCalls([
      unknownWrapper(cut([{ facetAddress: FACET_A, action: 0 }])),
    ])
    expect(result.calls).toEqual([])
    expect(result.undecodable).toEqual([0])
  })

  it('reports malformed calldata rather than skipping it', () => {
    const result = collectDiamondCutCalls(['0xabc' as Hex])
    expect(result.calls).toEqual([])
    expect(result.undecodable).toEqual([0])
  })

  it('refuses one call and reads its readable sibling', () => {
    const result = collectDiamondCutCalls([
      unknownWrapper(cut([{ facetAddress: FACET_B, action: 0 }])),
      cut([{ facetAddress: FACET_A, action: 0 }]),
    ])
    expect(result.undecodable).toEqual([0])
    expect(result.calls.map((c) => c.cuts[0]?.facetAddress)).toEqual([FACET_A])
  })

  it('finds no cut in a call that is not one', () => {
    const transferOwnership = encodeFunctionData({
      abi: parseAbi(['function transferOwnership(address newOwner)']),
      functionName: 'transferOwnership',
      args: [FACET_A],
    })
    const result = collectDiamondCutCalls([transferOwnership])
    expect(result.calls).toEqual([])
    expect(result.undecodable).toEqual([])
  })
})

describe('what a cut carries beyond its facet addresses', () => {
  const INIT = '0x1417141714171417141714171417141714171417' as Address

  // `initCalldata` decides whether an init delegatecall is graded at all, and
  // the empty string is what a dropped field returns, so the payload has to be
  // asserted as a value and not merely as present.
  it('carries the init payload, not just the init target', () => {
    const payload = cut([{ facetAddress: FACET_A, action: 0 }], INIT)
    const { calls } = collectDiamondCutCalls([payload])

    expect(calls[0]?.init).toBe(INIT)
    expect(calls[0]?.initCalldata).toBe('0xdeadbeef')
  })

  // The singular `schedule` envelope carries one target, and losing it makes a
  // cut read as executing against the timelock rather than the diamond.
  it('recovers the target through a singular schedule envelope', () => {
    const inner = cut([{ facetAddress: FACET_A, action: 1 }])
    const { calls } = collectDiamondCutCalls([schedule(DIAMOND, inner)], {
      targets: [TIMELOCK],
      caller: SAFE,
    })

    expect(calls[0]?.target).toBe(DIAMOND)
    expect(calls[0]?.caller).toBe(TIMELOCK)
    expect(calls[0]?.raw).toBe(inner)
  })

  it('recovers the target through a batch envelope', () => {
    const inner = cut([{ facetAddress: FACET_B, action: 0 }])
    const { calls } = collectDiamondCutCalls(
      [scheduleBatch([DIAMOND], [inner])],
      { targets: [TIMELOCK], caller: SAFE }
    )

    expect(calls[0]?.target).toBe(DIAMOND)
    expect(calls[0]?.caller).toBe(TIMELOCK)
  })

  // A caller that hands in bare calldata cannot be told where it was sent, and
  // inventing an address would put one into a verdict that nothing observed.
  it('leaves target and caller absent when no context is supplied', () => {
    const { calls } = collectDiamondCutCalls([
      cut([{ facetAddress: FACET_A, action: 0 }]),
    ])

    // The paired present: absent fields on a cut that was never decoded would
    // satisfy the two assertions below without the behaviour existing.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cuts.map((entry) => entry.facetAddress)).toEqual([FACET_A])
    expect(calls[0]?.target).toBeUndefined()
    expect(calls[0]?.caller).toBeUndefined()
  })

  it('a direct cut executes against its own target, sent by the Safe', () => {
    const payload = cut([{ facetAddress: FACET_A, action: 0 }])
    const { calls } = collectDiamondCutCalls([payload], {
      targets: [DIAMOND],
      caller: SAFE,
    })

    expect(calls[0]?.target).toBe(DIAMOND)
    expect(calls[0]?.caller).toBe(SAFE)
    expect(calls[0]?.raw).toBe(payload)
  })
})
