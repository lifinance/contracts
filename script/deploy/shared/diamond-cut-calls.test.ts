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
    const result = collectDiamondCutCalls([
      cut([
        { facetAddress: FACET_A, action: 1 },
        { facetAddress: ZERO_ADDRESS as Address, action: 2 },
      ]),
    ])
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
