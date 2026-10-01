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
import {
  BaseError,
  CallExecutionError,
  createPublicClient,
  custom,
  encodeFunctionData,
  ExecutionRevertedError,
  http,
  parseAbi,
  RpcRequestError,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { parseAccount } from 'viem/accounts'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from '../shared/constants'

import {
  collectExecutabilityInput,
  createExecutabilityChainReader,
  summariseRpcError,
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
const REGISTER_ABI = parseAbi([
  'function registerPeripheryContract(string _name, address _contractAddress)',
])

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
    expect(chain.calls[0]?.from).toBe(TIMELOCK)
    expect(chain.calls[0]?.to).toBe(DIAMOND)
    // The cut's own bytes, not the scheduling envelope: replaying the envelope
    // would only prove the proposal can be queued.
    expect(chain.calls[0]?.data).toBe(inner)

    // …and the envelope is simulated too, from the Safe. `schedule` can be
    // refused on its own — an operation already queued, a Safe without the
    // proposer role — while the call inside it would have executed.
    expect(chain.calls).toHaveLength(2)
    expect(chain.calls[1]?.from).toBe(SAFE)
    expect(chain.calls[1]?.to).toBe(TIMELOCK)
  })

  // The point of the whole check: an owner-gated call scheduled through the
  // timelock must be simulated as the timelock. Simulated as the Safe it
  // reverts on the ownership check, and simulating only the envelope proves
  // nothing at all — `schedule` succeeds whatever it carries.
  it('simulates a timelock-wrapped non-cut call from the timelock', async () => {
    const inner = encodeFunctionData({
      abi: REGISTER_ABI,
      functionName: 'registerPeripheryContract',
      args: ['FeeCollector', FACET],
    })
    const chain = reader()

    await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: TIMELOCK,
        data: scheduleBatch([DIAMOND], [inner]),
      },
      chain
    )

    const scheduled = chain.calls.find((call) => call.data === inner)
    expect(scheduled).toBeDefined()
    expect(scheduled?.from).toBe(TIMELOCK)
    expect(scheduled?.to).toBe(DIAMOND)
  })

  it('reports a reverting scheduled call as the proposal not executing', async () => {
    const inner = encodeFunctionData({
      abi: REGISTER_ABI,
      functionName: 'registerPeripheryContract',
      args: ['FeeCollector', FACET],
    })
    const chain = reader({
      staticCall: async (call) => {
        return call.data === inner
          ? { outcome: 'reverted' as const, revertReason: 'OnlyContractOwner' }
          : { outcome: 'succeeded' as const }
      },
    })
    const verdict = evaluateExecutability(
      await collectExecutabilityInput(
        {
          network: 'arbitrum',
          safeAddress: SAFE,
          to: TIMELOCK,
          data: scheduleBatch([DIAMOND], [inner]),
        },
        chain
      )
    )

    // Before the leaf was unwrapped this proposal came back clean: the only
    // thing simulated was `scheduleBatch`, which succeeds whatever it carries.
    expect(verdict.refuses).toBe(true)
    expect(verdict.reason).toContain('scheduled')
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

  const wrapped = {
    network: 'arbitrum',
    safeAddress: SAFE,
    to: TIMELOCK,
    data: scheduleBatch([DIAMOND], [cut()]),
  }

  // The property the whole module rests on, asserted per read rather than
  // in aggregate — a defaulted read is the false-green path this module's
  // header names, so each of the three is driven on its own.

  it('leaves a failed code read absent rather than defaulting it', async () => {
    const input = await collectExecutabilityInput(
      wrapped,
      reader({ hasCode: async () => undefined })
    )

    expect(input.observations.hasCode.size).toBe(0)
    expect(evaluateExecutability(input).error).toBe(true)
  })

  it('leaves a failed owner read absent rather than defaulting it', async () => {
    const input = await collectExecutabilityInput(
      wrapped,
      reader({ owner: async () => undefined })
    )

    expect(input.observations.owners.size).toBe(0)
    // The one that matters most: `gradeOwner` returns no finding for an owner
    // it was never given, so a defaulted value would read as a verified match.
    expect(evaluateExecutability(input).error).toBe(true)
  })

  it('a malformed diamond loses its own read, not the whole batch', async () => {
    // `Promise.all` rejects on the first throw, so an unguarded address parse
    // anywhere in the fan-out discards every read that did land — and the
    // collection then reports one error where it had real observations.
    // Direct, not wrapped: a timelock envelope carries its own target, so the
    // diamond would come from there and `to` would never be parsed as one.
    const malformed = {
      network: 'arbitrum',
      safeAddress: SAFE,
      to: '0x1234' as Address,
      data: cut(),
    }

    const input = await collectExecutabilityInput(malformed, reader({}))

    // The owner read is the one keyed on the malformed diamond, so it is absent.
    expect(input.observations.owners.size).toBe(0)
    // The paired present: the reads that do not depend on it still landed, so
    // the batch was not thrown away.
    expect(input.observations.hasCode.size).toBeGreaterThan(0)
    // Absent is still unchecked, so the verdict blocks either way.
    expect(evaluateExecutability(input).error).toBe(true)
  })

  // `attempted` gates the "the endpoint answered nothing" claim, so a payload
  // that was never read must not be counted into it. The proposal blocks either
  // way — the absent reads are unchecked — but a malformed `to` would otherwise
  // send the signer after an endpoint outage that never happened.
  it('does not count a skipped owner read as an unanswered one', async () => {
    const skipped = {
      network: 'arbitrum',
      safeAddress: SAFE,
      to: '0x1234' as Address,
      // Every address in the cut is the zero address, which is deliberately
      // not read, so the unparsable diamond is the only read left to skip.
      data: encodeFunctionData({
        abi: DIAMOND_CUT_ABI,
        functionName: 'diamondCut',
        args: [
          [
            {
              facetAddress: ZERO_ADDRESS as Address,
              action: 2,
              functionSelectors: [SELECTOR],
            },
          ],
          ZERO_ADDRESS as Address,
          '0x' as Hex,
        ],
      }),
    }

    const input = await collectExecutabilityInput(skipped, reader({}))

    expect(input.observations.hasCode.size).toBe(0)
    expect(input.observations.owners.size).toBe(0)
    expect(input.observations.available).toBe(true)
    expect(input.observations.unavailableReason).toBeUndefined()
    // The absent reads still block; only the outage claim is withdrawn.
    expect(evaluateExecutability(input).error).toBe(true)
  })

  it('leaves a failed selector read absent rather than defaulting it', async () => {
    const input = await collectExecutabilityInput(
      wrapped,
      reader({ facetAddress: async () => undefined })
    )

    expect(input.observations.selectorFacets.size).toBe(0)
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

    expect(
      input.payloads.filter((payload) => payload.kind === 'diamond-cut')
    ).toHaveLength(2)
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
    expect(verdict.refuses).toBe(true)
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

describe('createExecutabilityChainReader', () => {
  // The contract the whole module rests on: a read that fails must resolve to
  // `undefined`, not throw. A throw would abort the collection and lose the
  // reads that did land, and the verdict would then rest on a partial set it
  // could not report as partial.
  const failing = {
    getCode: async () => {
      throw new Error('rpc down')
    },
    readContract: async () => {
      throw new Error('rpc down')
    },
    call: async () => {
      throw new Error('rpc down')
    },
  } as unknown as PublicClient

  // Asserted against what viem is actually handed, not against what the
  // collector passed in. viem names the sender `account`; a `from` key compiles
  // — the argument is a variable, so excess-property checking never sees it —
  // and is then dropped, so every payload simulated as the zero address and
  // every owner-gated call reverted on its ownership check whatever the
  // proposal did. The fake reader the tests above use records whatever it is
  // given, so it cannot see this: only the real client's parameter name can.
  it('hands viem the sender under the name viem reads', async () => {
    const seen: Record<string, unknown>[] = []
    const reader = createExecutabilityChainReader({
      call: async (params: Record<string, unknown>) => {
        seen.push(params)
        return {}
      },
    } as unknown as PublicClient)

    await reader.staticCall({ from: TIMELOCK, to: DIAMOND, data: cut() })

    expect(seen[0]?.['account']).toBe(TIMELOCK)
    expect(seen[0]?.['from']).toBeUndefined()
  })

  it('reports a failed read as unanswered rather than throwing', async () => {
    const reader = createExecutabilityChainReader(failing)

    expect(await reader.hasCode(FACET)).toBeUndefined()
    expect(await reader.facetAddress(DIAMOND, SELECTOR)).toBeUndefined()
    expect(await reader.owner(DIAMOND)).toBeUndefined()
  })

  it('distinguishes a revert from an endpoint that could not answer', async () => {
    const reverting = {
      call: async () => {
        throw Object.assign(
          new Error('execution reverted: FunctionAlreadyExists'),
          { code: -32000 }
        )
      },
    } as unknown as PublicClient
    const unreachable = {
      call: async () => {
        throw new Error('fetch failed')
      },
    } as unknown as PublicClient

    const call = { from: SAFE, to: DIAMOND, data: '0x' as Hex }
    expect(
      (await createExecutabilityChainReader(reverting).staticCall(call)).outcome
    ).toBe('reverted')
    expect(
      (await createExecutabilityChainReader(unreachable).staticCall(call))
        .outcome
    ).toBe('errored')
  })

  it('reads an address holding no code as no code, not as unanswered', async () => {
    const empty = { getCode: async () => '0x' } as unknown as PublicClient
    expect(await createExecutabilityChainReader(empty).hasCode(FACET)).toBe(
      false
    )
  })
})

describe('simulating across several endpoints', () => {
  const clientThat = (behaviour: () => Promise<unknown>): PublicClient =>
    ({ call: behaviour } as unknown as PublicClient)

  /** A node's JSON-RPC answer, which carries a code a wrapper does not. */
  const reverting = (message: string) =>
    clientThat(async () => {
      throw Object.assign(new Error(message), { code: -32000 })
    })
  const succeeding = () => clientThat(async () => ({}))
  /** A transport-level failure, which fails over to the next endpoint. */
  const unreachable = () =>
    clientThat(async () => {
      const error = new Error('HTTP request failed: 503 Service Unavailable')
      error.name = 'HttpRequestError'
      throw error
    })

  // The false green a fallback transport produces. viem stops failing over only
  // for a revert it recognises by wording, so a node answering
  // `-32000 "Reverted 0x…"` is treated as unreachable and the next endpoint's
  // success is recorded as the answer — a reverting proposal reads as fine.
  it('a revert settles the answer, whatever the node calls it', async () => {
    for (const wording of [
      'execution reverted: FunctionAlreadyExists',
      'Reverted 0xdeadbeef',
      'VM Exception while processing transaction: reverted',
    ]) {
      const reader = createExecutabilityChainReader(succeeding(), [
        reverting(wording),
        succeeding(),
      ])

      const outcome = await reader.staticCall({
        from: SAFE,
        to: DIAMOND,
        data: '0x' as Hex,
      })
      expect(outcome.outcome).toBe('reverted')
    }
  })

  // An invalid opcode is the EVM's own answer, so it stops the walk like a
  // revert. An out-of-gas runs under the node's own gas cap and an unworded
  // failure says nothing about the payload, so both ask the next endpoint.
  it('an invalid opcode stops the walk even without the word revert', async () => {
    const reader = createExecutabilityChainReader(succeeding(), [
      reverting('invalid opcode: INVALID'),
      succeeding(),
    ])

    expect(
      (await reader.staticCall({ from: SAFE, to: DIAMOND, data: '0x' as Hex }))
        .outcome
    ).toBe('reverted')
  })

  it('an out-of-gas or an unworded failure asks the next endpoint', async () => {
    for (const wording of [
      'out of gas',
      'CallExecutionError: An unknown error occurred while executing the call',
    ]) {
      const alone = createExecutabilityChainReader(succeeding(), [
        reverting(wording),
      ])
      expect(
        (await alone.staticCall({ from: SAFE, to: DIAMOND, data: '0x' as Hex }))
          .outcome
      ).toBe('errored')

      const reader = createExecutabilityChainReader(succeeding(), [
        reverting(wording),
        succeeding(),
      ])
      expect(
        (
          await reader.staticCall({
            from: SAFE,
            to: DIAMOND,
            data: '0x' as Hex,
          })
        ).outcome
      ).toBe('succeeded')
    }
  })

  it('a code-3 link is a revert with no other signal', async () => {
    const reader = createExecutabilityChainReader(succeeding(), [
      clientThat(async () => {
        throw Object.assign(new Error('call failed'), { code: 3 })
      }),
      succeeding(),
    ])

    expect(
      (await reader.staticCall({ from: SAFE, to: DIAMOND, data: '0x' as Hex }))
        .outcome
    ).toBe('reverted')
  })

  it("viem's revert error over a node answer is a revert with no other signal", async () => {
    const reader = createExecutabilityChainReader(succeeding(), [
      clientThat(async () => {
        throw new ExecutionRevertedError({
          cause: Object.assign(new BaseError('RPC Request failed.'), {
            code: -32000,
          }),
        })
      }),
      succeeding(),
    ])

    expect(
      (await reader.staticCall({ from: SAFE, to: DIAMOND, data: '0x' as Hex }))
        .outcome
    ).toBe('reverted')
  })

  // A proxy's report or an HTTP body is not the chain: only a link carrying
  // a JSON-RPC code is a node's answer.
  it('reads revert wording on a wrapper with no node code as errored', async () => {
    for (const thrown of [
      new Error('execution reverted'),
      Object.assign(new Error('proxy error'), {
        details: 'execution reverted: FunctionAlreadyExists',
      }),
      new ExecutionRevertedError({
        cause: new BaseError('HTTP request failed.', {
          details: 'execution reverted',
        }),
      }),
      Object.assign(new Error('execution reverted'), {
        cause: { code: -32603, message: 'Internal error' },
      }),
    ]) {
      const reader = createExecutabilityChainReader(succeeding(), [
        clientThat(async () => {
          throw thrown
        }),
        succeeding(),
      ])

      expect(
        (
          await reader.staticCall({
            from: SAFE,
            to: DIAMOND,
            data: '0x' as Hex,
          })
        ).outcome
      ).toBe('succeeded')
    }
  })

  // viem's composed message names the endpoint, and a host is not evidence.
  it('judges the node string, not the report around it', async () => {
    const reader = createExecutabilityChainReader(succeeding(), [
      clientThat(async () => {
        throw Object.assign(
          new Error(
            'RPC Request failed.\n\nURL: https://rpc-cache.example/\nDetails: execution reverted'
          ),
          { code: -32000, details: 'execution reverted' }
        )
      }),
      succeeding(),
    ])

    expect(
      (await reader.staticCall({ from: SAFE, to: DIAMOND, data: '0x' as Hex }))
        .outcome
    ).toBe('reverted')
  })

  it('an unreachable endpoint hands the question to the next one', async () => {
    const reader = createExecutabilityChainReader(succeeding(), [
      unreachable(),
      succeeding(),
    ])

    expect(
      (await reader.staticCall({ from: SAFE, to: DIAMOND, data: '0x' as Hex }))
        .outcome
    ).toBe('succeeded')
  })

  it('a revert found after an unreachable endpoint is still the answer', async () => {
    const reader = createExecutabilityChainReader(succeeding(), [
      unreachable(),
      reverting('Reverted 0xdeadbeef'),
    ])

    expect(
      (await reader.staticCall({ from: SAFE, to: DIAMOND, data: '0x' as Hex }))
        .outcome
    ).toBe('reverted')
  })

  it('every endpoint failing is unverified, never a pass', async () => {
    const reader = createExecutabilityChainReader(succeeding(), [
      unreachable(),
      unreachable(),
    ])

    const outcome = await reader.staticCall({
      from: SAFE,
      to: DIAMOND,
      data: '0x' as Hex,
    })
    expect(outcome.outcome).toBe('errored')
    expect(outcome.outcome).not.toBe('succeeded')
  })

  it('stops at the first endpoint that answers', async () => {
    let asked = 0
    const counting = clientThat(async () => {
      asked += 1
      return {}
    })
    const reader = createExecutabilityChainReader(counting, [
      counting,
      counting,
    ])

    await reader.staticCall({ from: SAFE, to: DIAMOND, data: '0x' as Hex })
    expect(asked).toBe(1)
  })
})

describe('summariseRpcError', () => {
  const clientThat = (behaviour: () => Promise<unknown>): PublicClient =>
    ({ call: behaviour } as unknown as PublicClient)

  const realCallError = (data: Hex): string =>
    new CallExecutionError(
      new ExecutionRevertedError({ message: 'execution reverted' }),
      {
        account: parseAccount(SAFE),
        to: DIAMOND,
        data,
      }
    ).message

  it('keeps the revert reason and drops the echoed payload', () => {
    const data = `0x1f931c1c${'ab'.repeat(300)}` as Hex
    const summary = summariseRpcError(realCallError(data))

    expect(summary).toContain('Execution reverted for an unknown reason.')
    expect(summary).not.toContain('Raw Call Arguments')
    expect(summary).not.toContain('ababab')
    expect(summary).not.toContain(DIAMOND)
    expect(summary).not.toContain('viem@')
    expect(summary).not.toContain('\n')
  })

  it('leaves a message it recognises nothing to drop in untouched', () => {
    expect(summariseRpcError('  execution reverted: Ownable  ')).toBe(
      'execution reverted: Ownable'
    )
  })

  it('reports the summary, not the raw report, as the revert reason', async () => {
    const data = `0x1f931c1c${'ab'.repeat(300)}` as Hex
    const reverting = clientThat(async () => {
      throw new CallExecutionError(
        new ExecutionRevertedError({
          cause: new RpcRequestError({
            body: {},
            error: { code: -32000, message: 'execution reverted' },
            url: 'https://node.example/',
          }),
          message: 'execution reverted',
        }),
        { account: parseAccount(SAFE), to: DIAMOND, data }
      )
    })
    const reader = createExecutabilityChainReader(reverting)

    const outcome = await reader.staticCall({ from: SAFE, to: DIAMOND, data })

    expect(outcome.outcome).toBe('reverted')
    expect(outcome.revertReason).not.toContain('ababab')
    expect(outcome.revertReason).toContain('Execution reverted')
  })
})

describe('summariseRpcError and viem’s Details line', () => {
  const callError = (inner: Error): string =>
    new CallExecutionError(inner as never, {
      account: parseAccount(SAFE),
      to: DIAMOND,
      data: `0x1f931c1c${'ab'.repeat(200)}` as Hex,
    }).message

  it('drops a Details line that only restates the reason', () => {
    const summary = summariseRpcError(
      callError(
        new BaseError(
          'Execution reverted with reason: TimelockController: insufficient delay.',
          {
            details:
              'execution reverted: TimelockController: insufficient delay',
          }
        )
      )
    )

    expect(summary).toBe(
      'Execution reverted with reason: TimelockController: insufficient delay.'
    )
    expect(summary).not.toContain('Details:')
  })

  it('keeps a Details line that says something the reason does not', () => {
    const summary = summariseRpcError(
      callError(
        new BaseError('Execution reverted for an unknown reason.', {
          details: 'out of gas',
        })
      )
    )

    expect(summary).toContain('out of gas')
  })
})

describe('the sender a payload is simulated from', () => {
  /**
   * Drives a real viem client rather than a stub with a `call` method. The
   * stubs elsewhere in this file receive whatever object the reader hands
   * them, so they cannot see a key viem would drop on its way to the wire —
   * which is the whole failure this pins.
   *
   * Retries are off so the failover test's throwing transport fails once
   * rather than three times over a second of backoff.
   */
  const capturingClient = (
    captured: { params?: Record<string, unknown> },
    answer: () => unknown = () => '0x'
  ): PublicClient =>
    createPublicClient({
      transport: custom(
        {
          request: async ({ method, params }) => {
            if (method !== 'eth_call') return '0x1'
            captured.params = (params as Record<string, unknown>[])[0]
            return answer()
          },
        },
        { retryCount: 0 }
      ),
    }) as unknown as PublicClient

  it('reaches the node as the account the payload will really be sent from', async () => {
    const captured: { params?: Record<string, unknown> } = {}
    const reader = createExecutabilityChainReader(capturingClient(captured))

    await reader.staticCall({ from: SAFE, to: TIMELOCK, data: '0xdeadbeef' })

    expect(captured.params?.from).toBe(SAFE)
    expect(captured.params?.to).toBe(TIMELOCK)
    expect(captured.params?.data).toBe('0xdeadbeef')
  })

  it('never simulates from the zero address, which no caller gate admits', async () => {
    const captured: { params?: Record<string, unknown> } = {}
    const reader = createExecutabilityChainReader(capturingClient(captured))

    await reader.staticCall({ from: SAFE, to: TIMELOCK, data: '0x' as Hex })

    expect(captured.params?.from).toBeDefined()
    expect(captured.params?.from).not.toBe(ZERO_ADDRESS)
  })

  it('carries the sender to every endpoint it fails over to', async () => {
    const first: { params?: Record<string, unknown> } = {}
    const second: { params?: Record<string, unknown> } = {}
    const unreachable = capturingClient(first, () => {
      throw new Error('fetch failed')
    })
    const reachable = capturingClient(second)

    const reader = createExecutabilityChainReader(unreachable, [
      unreachable,
      reachable,
    ])
    await reader.staticCall({ from: SAFE, to: TIMELOCK, data: '0x' as Hex })

    expect(first.params?.from).toBe(SAFE)
    expect(second.params?.from).toBe(SAFE)
  })

  // The two halves of the sender only meet here. The tests above pin what the
  // collector decides each payload's caller is, against a stub; the ones before
  // them pin that a caller handed to the reader reaches the wire. Neither sees a
  // collector that decided correctly and a reader that then sent every payload
  // from one address.
  it('sends each payload from its own caller, not one sender for all', async () => {
    const seen: Record<string, unknown>[] = []
    const client = createPublicClient({
      transport: custom(
        {
          request: async ({ method, params }) => {
            if (method !== 'eth_call') return '0x1'
            const [request] = params as [Record<string, unknown>]
            seen.push(request)
            return '0x'
          },
        },
        { retryCount: 0 }
      ),
    }) as unknown as PublicClient
    const inner = cut()

    await collectExecutabilityInput(
      {
        network: 'arbitrum',
        safeAddress: SAFE,
        to: TIMELOCK,
        data: scheduleBatch([DIAMOND], [inner]),
      },
      createExecutabilityChainReader(client)
    )

    expect(seen.find((call) => call.data === inner)?.from).toBe(TIMELOCK)
    expect(seen.find((call) => call.to === TIMELOCK)?.from).toBe(SAFE)
  })
})

/**
 * Real endpoint failures, as viem raises them.
 *
 * Built through viem's own client so the error chain is the one a live endpoint
 * produces: every failure arrives as a `CallExecutionError`, so a test that
 * throws a bare `Error` with a chosen name never reaches the case that matters.
 * The two rejections are the bodies a keyless `rpc.ankr.com/eth` and
 * `cloudflare-eth.com` return to `eth_call`; the revert is a node's code-3
 * answer with the custom error's selector as data.
 */
describe('a node error is a revert only when the chain says so', () => {
  const answering = (body: Record<string, unknown>): PublicClient =>
    createPublicClient({
      transport: custom(
        {
          request: async () => {
            throw body
          },
        },
        { retryCount: 0 }
      ),
    })
  const succeeding = createPublicClient({
    transport: custom({ request: async () => '0x' }, { retryCount: 0 }),
  })

  const KEYLESS = {
    code: -32000,
    message:
      'Unauthorized: You must authenticate your request with an API key. Create an account and generate your personal API key for free.',
  }
  const INTERNAL = { code: -32603, message: 'Internal error' }
  const REVERT = { code: 3, message: 'execution reverted', data: '0x277d76f8' }

  const simulate = (simulators: PublicClient[]) =>
    createExecutabilityChainReader(succeeding, simulators).staticCall({
      from: SAFE,
      to: DIAMOND,
      data: '0x8da5cb5b' as Hex,
    })

  it('reads a keyless rejection and an internal error as errored, not reverted', async () => {
    for (const body of [KEYLESS, INTERNAL]) {
      const outcome = await simulate([answering(body)])
      expect(outcome.outcome).toBe('errored')
      expect(outcome.revertReason).toBeUndefined()
    }
  })

  it('asks the next endpoint after a rejection, and takes its answer', async () => {
    for (const body of [KEYLESS, INTERNAL])
      expect((await simulate([answering(body), succeeding])).outcome).toBe(
        'succeeded'
      )
  })

  it('reads a code-3 answer carrying revert data as reverted', async () => {
    const outcome = await simulate([answering(REVERT)])
    expect(outcome.outcome).toBe('reverted')
  })

  it('still finds a revert behind a flaky first endpoint', async () => {
    for (const body of [KEYLESS, INTERNAL])
      expect(
        (await simulate([answering(body), answering(REVERT)])).outcome
      ).toBe('reverted')
  })

  it('lets a revert stop the walk, so a later success cannot overwrite it', async () => {
    for (const body of [
      REVERT,
      { code: 3, message: 'error' },
      { code: 3, message: 'execution reverted: rate limited' },
      { code: -32015, message: 'VM execution error.', data: 'revert' },
      { code: -32015, message: 'VM execution error.', data: '0x08c379a0' },
      { code: -32000, message: 'Reverted 0xdeadbeef' },
      {
        code: -32015,
        message: 'VM execution error.',
        data: 'Reverted 0x08c379a0',
      },
      { code: -32000, message: 'execution failed', data: '0x08c379a0' },
    ])
      expect((await simulate([answering(body), succeeding])).outcome).toBe(
        'reverted'
      )
  })

  // Each says something about the endpoint rather than the payload: a throttle
  // or cache message that happens to contain the word, revert-shaped data on a
  // code no node uses for a revert or beside a node missing the state, and a
  // gas allowance that is the node's own cap. Read as reverts they are definite reds no chain produced.
  // viem names an HTTP failure `ExecutionRevertedError` when its body says so,
  // though no node answered.
  it('reads a gateway body that says reverted as errored', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'execution reverted' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
    try {
      const gateway = createPublicClient({
        transport: http('https://gateway.example/', { retryCount: 0 }),
      })
      expect((await simulate([gateway])).outcome).toBe('errored')
      expect((await simulate([gateway, succeeding])).outcome).toBe('succeeded')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reads endpoint-side failures that look like reverts as errored', async () => {
    for (const body of [
      { code: -32005, message: 'request reverted to cache, try later' },
      { code: -32603, message: 'backend reverted to an archive node' },
      { code: -32000, message: 'upstream timeout: revert' },
      { code: -32601, message: 'the method eth_revert does not exist' },
      { code: -32603, message: 'Internal error', data: '0xdeadbeef' },
      { code: -32000, message: 'execution failed', data: '0x' },
      { code: -32000, message: 'header not found', data: '0xdeadbeef' },
      {
        code: -32000,
        message: 'missing trie node 4a2b (path ) state 0x9c is not available',
        data: '0x08c379a0',
      },
      { code: -32000, message: 'gas required exceeds allowance (0)' },
    ]) {
      expect((await simulate([answering(body)])).outcome).toBe('errored')
      expect((await simulate([answering(body), succeeding])).outcome).toBe(
        'succeeded'
      )
    }
  })

  // The reason after `execution reverted:` is the reverting contract's own
  // string, which a proposer can word as a throttle or a cache miss.
  it('reads endpoint wording inside a revert reason as reverted', async () => {
    for (const body of [
      { code: -32000, message: 'execution reverted: rate limited' },
      { code: -32000, message: 'execution reverted: too many requests' },
      { code: -32000, message: 'execution reverted: cached response expired' },
      { code: -32000, message: 'execution reverted: header not found' },
    ])
      expect((await simulate([answering(body), succeeding])).outcome).toBe(
        'reverted'
      )
    expect(
      (
        await simulate([
          answering({ code: -32005, message: 'rate limited' }),
          succeeding,
        ])
      ).outcome
    ).toBe('succeeded')
  })
})
