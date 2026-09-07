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
