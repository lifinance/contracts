/**
 * Tests for the sign-time executability collector.
 *
 * The decision module is already covered by its own suite, so these pin the
 * things only the collector decides: which account each payload is simulated
 * from, which bytes are replayed, and that a read nobody could make stays
 * absent instead of becoming an answer.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from '../shared/constants'

import {
  collectExecutabilityInput,
  type IExecutabilityChainReader,
} from './executability-collector'
import { evaluateExecutability } from './executability-simulation'
import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_ZERO_PREDECESSOR,
} from './timelock-abi'

const SAFE = '0x5555555555555555555555555555555555555555' as Address
const DIAMOND = '0x3333333333333333333333333333333333333333' as Address
const TIMELOCK = '0x4444444444444444444444444444444444444444' as Address
const FACET = '0x1111111111111111111111111111111111111111' as Address
const SELECTOR = '0xaabbccdd' as Hex

const cut = (action = 0): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      [{ facetAddress: FACET, action, functionSelectors: [SELECTOR] }],
      ZERO_ADDRESS as Address,
      '0x' as Hex,
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

interface IRecordedCall {
  from: Address
  to: Address
  data: Hex
}

const reader = (
  overrides: Partial<IExecutabilityChainReader> = {}
): IExecutabilityChainReader & { calls: IRecordedCall[] } => {
  const calls: IRecordedCall[] = []
  return {
    calls,
    hasCode: async () => true,
    facetAddress: async () => ZERO_ADDRESS as Address,
    owner: async () => TIMELOCK,
    staticCall: async (call) => {
      calls.push(call)
      return { outcome: 'succeeded' as const }
    },
    ...overrides,
  }
}

describe('collectExecutabilityInput', () => {
  // Every diamondCut is owner-gated, so simulating a timelock-wrapped cut from
  // the Safe would revert for a reason the proposal is not responsible for.
  it('simulates a timelock-wrapped cut from the timelock, against the diamond', async () => {
    const inner = cut()
    const chain = reader()

    const input = await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: TIMELOCK,
        data: scheduleBatch([DIAMOND], [inner]),
      },
      chain
    )

    expect(input.staticCalls.attempted).toBe(true)
    expect(chain.calls).toHaveLength(1)
    expect(chain.calls[0]?.from).toBe(TIMELOCK)
    expect(chain.calls[0]?.to).toBe(DIAMOND)
    // The cut's own bytes, not the scheduling envelope: replaying the envelope
    // would only prove the proposal can be queued.
    expect(chain.calls[0]?.data).toBe(inner)
  })

  it('simulates a direct cut from the Safe', async () => {
    const data = cut()
    const chain = reader()

    await collectExecutabilityInput(
      { network: 'arbitrum', safeAddress: SAFE, to: DIAMOND, data },
      chain
    )

    expect(chain.calls[0]?.from).toBe(SAFE)
    expect(chain.calls[0]?.to).toBe(DIAMOND)
    expect(chain.calls[0]?.data).toBe(data)
  })

  it('carries the owner and selector reads the verdict is graded against', async () => {
    const input = await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: TIMELOCK,
        data: scheduleBatch([DIAMOND], [cut()]),
      },
      reader()
    )

    expect(input.observations.available).toBe(true)
    expect(input.observations.owners.get(DIAMOND.toLowerCase())).toBe(TIMELOCK)
    expect(input.observations.selectorFacets.get(SELECTOR)).toBe(ZERO_ADDRESS)
    expect(input.observations.hasCode.get(FACET.toLowerCase())).toBe(true)
  })

  // The property the whole module rests on: a read that did not happen must
  // reach the verdict as an absence, which the simulation grades unchecked.
  it('leaves a failed read absent rather than defaulting it', async () => {
    const input = await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: TIMELOCK,
        data: scheduleBatch([DIAMOND], [cut()]),
      },
      reader({ hasCode: async () => undefined })
    )

    expect(input.observations.hasCode.size).toBe(0)
    expect(evaluateExecutability(input).error).toBe(true)
  })

  it('reports the endpoint as unavailable when no read answered', async () => {
    const input = await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: TIMELOCK,
        data: scheduleBatch([DIAMOND], [cut()]),
      },
      reader({
        hasCode: async () => undefined,
        owner: async () => undefined,
        facetAddress: async () => undefined,
      })
    )

    expect(input.observations.available).toBe(false)
    expect(evaluateExecutability(input).error).toBe(true)
  })

  // A selector map keyed by bare selector can only describe one diamond, so a
  // proposal touching two must not be graded against either one's answers.
  it('omits the selector map when the proposal touches two diamonds', async () => {
    const other = '0x6666666666666666666666666666666666666666' as Address
    const chain = reader({
      facetAddress: async () => FACET,
    })

    const input = await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: TIMELOCK,
        data: scheduleBatch([DIAMOND, other], [cut(), cut()]),
      },
      chain
    )

    expect(input.payloads).toHaveLength(2)
    expect(input.observations.selectorFacets.size).toBe(0)
  })

  it('reports a call it could not read through', async () => {
    const input = await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: DIAMOND,
        data: '0xnothex' as Hex,
      },
      reader()
    )

    expect(input.undecodable).toEqual(['call[0]'])
    expect(evaluateExecutability(input).error).toBe(true)
  })

  it('carries a call with no revert model as an opaque payload', async () => {
    const input = await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: DIAMOND,
        data: '0xdeadbeef' as Hex,
      },
      reader()
    )

    expect(input.payloads[0]?.kind).toBe('opaque')
    expect(evaluateExecutability(input).notSimulated).toHaveLength(1)
    expect(evaluateExecutability(input).notSimulated[0]).toContain('call[0]')
  })

  it('a reverting static call reaches the verdict', async () => {
    const input = await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: TIMELOCK,
        data: scheduleBatch([DIAMOND], [cut()]),
      },
      reader({
        staticCall: async () => ({
          outcome: 'reverted' as const,
          revertReason: 'FunctionAlreadyExists',
        }),
      })
    )

    const verdict = evaluateExecutability(input)
    expect(verdict.refuses || verdict.error).toBe(true)
  })

  it('carries the proposal nonce through when the caller read it', async () => {
    const input = await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: DIAMOND,
        data: cut(),
        nonce: { proposalNonce: 7, safeNonce: 7, pendingNonces: [] },
      },
      reader()
    )

    expect(input.nonce?.proposalNonce).toBe(7)
  })
})
