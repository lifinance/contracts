/**
 * The seam itself: the broadcast callback runs only after the pre-flight
 * passes, and the selector-form estimate refuses the answers a node gives when
 * it has not simulated.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  estimateTronEnergyBySelector,
  sendGuardedTronContractCall,
  type ITronConstantContractCaller,
} from './tron-guarded-send'

/** 100 SUN per energy, so 500,000 energy is exactly a 50 TRX limit. */
const SUN_PER_ENERGY = 100n
const FEE_LIMIT_SUN = 50_000_000

const costInSun = async (energy: bigint): Promise<bigint> =>
  energy * SUN_PER_ENERGY

let broadcasts: number

const guardedSend = (estimateEnergy: () => Promise<bigint>): Promise<string> =>
  sendGuardedTronContractCall({
    networkName: 'tron',
    operation: 'a contract call',
    feeLimitSun: FEE_LIMIT_SUN,
    estimateEnergy,
    costInSun,
    broadcast: async () => {
      broadcasts += 1
      return 'deadbeef'
    },
  })

/**
 * Awaited, so the broadcast-count assertion that follows observes a settled
 * call rather than one that has not started yet.
 */
const refusal = (
  estimateEnergy: () => Promise<bigint>
): Promise<Error | undefined> =>
  guardedSend(estimateEnergy).then(
    () => undefined,
    (error: unknown) => error as Error
  )

/** The rejection of a bare estimate, awaited for the same reason. */
const estimateRejection = (
  run: () => Promise<bigint>
): Promise<Error | undefined> =>
  run().then(
    () => undefined,
    (error: unknown) => error as Error
  )

/** Builds a stub whose `triggerConstantContract` returns `answer`. */
const callerReturning = (answer: {
  energy_used?: number
  result?: { result?: boolean; message?: string }
}): ITronConstantContractCaller => ({
  transactionBuilder: { triggerConstantContract: async () => answer },
})

let originalAllow: string | undefined

beforeEach(() => {
  broadcasts = 0
  originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
})

afterEach(() => {
  if (originalAllow === undefined)
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
})

describe('the broadcast runs only after the pre-flight passes', () => {
  it('broadcasts and returns its value on an affordable estimate', async () => {
    expect(await guardedSend(async () => 400_000n)).toBe('deadbeef')
    expect(broadcasts).toBe(1)
  })

  it('does not broadcast when the estimate throws', async () => {
    const error = await refusal(async () => {
      throw new Error('triggerconstantcontract failed: 503')
    })

    expect(error?.message).toMatch(/refusing to broadcast/)
    expect(broadcasts).toBe(0)
  })

  it('does not broadcast when the estimate exceeds the fee limit', async () => {
    const error = await refusal(async () => 600_000n)

    expect(error?.message).toMatch(/exceeds the fee limit/)
    expect(broadcasts).toBe(0)
  })

  it('does not broadcast on a zero-energy estimate', async () => {
    const error = await refusal(async () => 0n)

    expect(error?.message).toMatch(/no contract call costs/)
    expect(broadcasts).toBe(0)
  })
})

describe('the selector-form estimate', () => {
  const params = {
    contractAddress: 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2',
    functionSelector: 'transferOwnership(address)',
    parameters: [
      { type: 'address', value: 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2' },
    ],
  }

  it('applies the devkit safety margin to the raw figure', async () => {
    const energy = await estimateTronEnergyBySelector({
      ...params,
      tronWeb: callerReturning({
        result: { result: true },
        energy_used: 10_000,
      }),
    })

    // The devkit's 1.2 margin, so the guard and the deploy path agree on cost.
    expect(energy).toBe(12_000n)
  })

  it('throws when the node reports the call would revert', async () => {
    const error = await estimateRejection(() =>
      estimateTronEnergyBySelector({
        ...params,
        tronWeb: callerReturning({
          result: { result: false, message: 'REVERT' },
        }),
      })
    )

    expect(error?.message).toMatch(
      /Tron simulation failed for transferOwnership\(address\)/
    )
  })

  it('throws when the node returns no energy figure at all', async () => {
    const error = await estimateRejection(() =>
      estimateTronEnergyBySelector({
        ...params,
        tronWeb: callerReturning({ result: { result: true } }),
      })
    )

    expect(error?.message).toMatch(/Tron simulation failed/)
  })

  /**
   * Errors shaped as the real path produces them. TronWeb reaches the node
   * through axios and raises the node's own message as a plain `Error` before
   * any result object gets back to the caller, so a fixture that *returns*
   * `{ result: { result: false } }` for a revert is testing a shape the
   * transport never hands over.
   */
  const axiosFailure = (status?: number): Error =>
    Object.assign(new Error(`request failed${status ? `: ${status}` : ''}`), {
      isAxiosError: true,
      ...(status === undefined ? {} : { response: { status } }),
    })

  const throwingCaller = (
    error: Error,
    countAttempt: () => number
  ): ITronConstantContractCaller => ({
    transactionBuilder: {
      triggerConstantContract: async () => {
        if (countAttempt() > 1)
          return { result: { result: true }, energy_used: 10_000 }
        throw error
      },
    },
  })

  it.each([
    ['a request that never got an answer', undefined],
    ['a TronGrid 429', 429],
    ['a node 502', 502],
  ])(
    'retries %s, because the estimate is mandatory',
    async (_label, status) => {
      // The pre-flight is fail-closed, so a blip refuses the send outright — a
      // single one must not stop a call the operator can pay for.
      let attempts = 0
      const energy = await estimateTronEnergyBySelector({
        ...params,
        tronWeb: throwingCaller(axiosFailure(status), () => (attempts += 1)),
        sleep: async () => undefined,
      })

      expect(attempts).toBe(2)
      expect(energy).toBe(12_000n)
    }
  )

  it('does not retry the revert TronWeb raises as a plain error', async () => {
    // What a reverting call actually looks like from here. Deterministic: a
    // second ask returns the same refusal, and retrying only spends the
    // operator's time.
    let attempts = 0
    const error = await estimateRejection(() =>
      estimateTronEnergyBySelector({
        ...params,
        tronWeb: throwingCaller(
          new Error('REVERT opcode executed'),
          () => (attempts += 1)
        ),
        sleep: async () => undefined,
      })
    )

    expect(attempts).toBe(1)
    expect(error?.message).toMatch(/REVERT opcode executed/)
  })

  it('does not retry a status the node chose deliberately', async () => {
    let attempts = 0
    await estimateRejection(() =>
      estimateTronEnergyBySelector({
        ...params,
        tronWeb: throwingCaller(axiosFailure(400), () => (attempts += 1)),
        sleep: async () => undefined,
      })
    )

    expect(attempts).toBe(1)
  })

  it('does not retry a node that answers that the call would revert', async () => {
    let attempts = 0
    const error = await estimateRejection(() =>
      estimateTronEnergyBySelector({
        ...params,
        tronWeb: {
          transactionBuilder: {
            triggerConstantContract: async () => {
              attempts += 1
              return { result: { result: false, message: 'REVERT' } }
            },
          },
        },
        sleep: async () => undefined,
      })
    )

    expect(attempts).toBe(1)
    expect(error?.message).toMatch(/Tron simulation failed/)
  })

  it('refuses a call value that cannot be estimated without rounding', async () => {
    const error = await estimateRejection(() =>
      estimateTronEnergyBySelector({
        ...params,
        tronWeb: callerReturning({
          result: { result: true },
          energy_used: 10_000,
        }),
        callValueSun: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      })
    )

    expect(error?.message).toMatch(/MAX_SAFE_INTEGER/)
  })
})
