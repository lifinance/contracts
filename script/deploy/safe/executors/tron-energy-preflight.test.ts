/**
 * The Tron half of S3. The EVM paths refuse to broadcast on a failed gas
 * estimate; these assert the same policy for energy, plus the case EVM does not
 * have — an estimate that succeeds but exceeds what the configured fee limit can
 * pay for, which is how a multi-call timelock batch aborts mid-SSTORE and is
 * then retried forever.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IChainSimulateResult } from '../../../common/types'

import type { ITronEnergyCost } from './tron-energy-estimate'
import { assertTronBroadcastAffordable } from './tron-energy-preflight'

/** 50 TRX, the devkit default this repo runs with. */
const FEE_LIMIT_SUN = 50_000_000
/** Tron mainnet energy price at the time of writing; only the ratio matters. */
const SUN_PER_ENERGY = 100n

const estimateOf =
  (energy: bigint): (() => Promise<IChainSimulateResult>) =>
  async () => ({
    estimatedResource: energy,
    resourceLabel: 'energy',
    estimateFailed: false,
  })

const costInSun = async (energy: bigint): Promise<ITronEnergyCost> => ({
  costSun: energy * SUN_PER_ENERGY,
  priceConfirmed: true,
})

const options = {
  networkName: 'tron',
  operation: 'timelock execution',
  feeLimitSun: FEE_LIMIT_SUN,
  costInSun,
}

let originalAllow: string | undefined

beforeEach(() => {
  originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
})

afterEach(() => {
  if (originalAllow === undefined)
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
})

describe('a failed estimate refuses rather than guessing', () => {
  it('throws, and names the network and the operation', async () => {
    const boom = async (): Promise<IChainSimulateResult> => {
      throw new Error('triggerconstantcontract failed: 503')
    }

    const error = await assertTronBroadcastAffordable(boom, options).then(
      () => undefined,
      (e: unknown) => e as Error
    )

    expect(error).toBeDefined()
    expect(error?.message).toContain('tron')
    expect(error?.message).toContain('timelock execution')
    expect(error?.message).toContain('refusing to broadcast')
  })

  it('says energy, not gas — the operator has to know which resource', async () => {
    const boom = async (): Promise<IChainSimulateResult> => {
      throw new Error('nope')
    }

    const error = await assertTronBroadcastAffordable(boom, options).then(
      () => undefined,
      (e: unknown) => e as Error
    )

    expect(error?.message).toContain('energy')
  })

  it('treats a fallback figure as a failed estimate, not an estimate', async () => {
    // `estimateFailed: true` means the number is a fixed fallback. Broadcasting
    // on it is exactly the guess this refuses.
    const fellBack = async (): Promise<IChainSimulateResult> => ({
      estimatedResource: 1_000n,
      resourceLabel: 'energy',
      estimateFailed: true,
    })

    expect(assertTronBroadcastAffordable(fellBack, options)).rejects.toThrow(
      /refusing to broadcast/
    )
  })
})

describe('an estimate the fee limit cannot pay for refuses', () => {
  it('refuses when the cost exceeds the configured fee limit', async () => {
    // 600k energy at 100 SUN each is 60 TRX, above the 50 TRX cap. Today this
    // broadcasts, runs out of energy mid-execution and is retried forever.
    const error = await assertTronBroadcastAffordable(
      estimateOf(600_000n),
      options
    ).then(
      () => undefined,
      (e: unknown) => e as Error
    )

    expect(error).toBeDefined()
    expect(error?.message).toContain('600000')
    expect(error?.message).toContain('TRON_SAFE_EXEC_FEE_LIMIT_SUN')
  })

  it('allows an estimate the fee limit covers', async () => {
    const result = await assertTronBroadcastAffordable(
      estimateOf(400_000n),
      options
    )

    expect(result.estimatedEnergy).toBe(400_000n)
    expect(result.costSun).toBe(40_000_000n)
  })

  it('allows an estimate costing exactly the fee limit', async () => {
    // The boundary is affordable, not refused: the cap is what the transaction
    // may spend, so spending all of it is within budget.
    const result = await assertTronBroadcastAffordable(
      estimateOf(500_000n),
      options
    )

    expect(result.costSun).toBe(50_000_000n)
  })
})

describe('the escape hatch is the same one the EVM paths use', () => {
  it('lets a failed estimate through when scoped to this network', async () => {
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'tron'
    const boom = async (): Promise<IChainSimulateResult> => {
      throw new Error('nope')
    }

    const result = await assertTronBroadcastAffordable(boom, options)

    expect(result.estimateFailed).toBe(true)
  })

  it('does not let another network scope through', async () => {
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'polygon'
    const boom = async (): Promise<IChainSimulateResult> => {
      throw new Error('nope')
    }

    expect(assertTronBroadcastAffordable(boom, options)).rejects.toThrow(
      /refusing to broadcast/
    )
  })

  it('lets an unaffordable estimate through when scoped, deliberately', async () => {
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'tron'

    const result = await assertTronBroadcastAffordable(
      estimateOf(600_000n),
      options
    )

    expect(result.estimatedEnergy).toBe(600_000n)
  })
})

describe('an unconfirmed energy price is labelled as such', () => {
  it('says so in the refusal instead of quoting the figure as fact', async () => {
    // `getCurrentPrices` swallows its own failure and substitutes a constant
    // above the live mainnet rate, so the guard can refuse honest traffic while
    // telling the operator to raise the limit to an inflated number. It has to
    // be able to say the price was never read.
    const error = await assertTronBroadcastAffordable(estimateOf(600_000n), {
      ...options,
      costInSun: async (energy) => ({
        costSun: energy * 210n,
        priceConfirmed: false,
      }),
    }).then(
      () => undefined,
      (e: unknown) => e as Error
    )

    expect(error?.message).toMatch(/could not be read/)
    expect(error?.message).toMatch(/unconfirmed upper bound/)
  })

  it('does not add that caveat when the price was read', async () => {
    const error = await assertTronBroadcastAffordable(
      estimateOf(600_000n),
      options
    ).then(
      () => undefined,
      (e: unknown) => e as Error
    )

    expect(error?.message).not.toMatch(/unconfirmed upper bound/)
  })

  it('refuses, redacted, when pricing itself throws', async () => {
    // Pricing sits inside the redaction boundary because the endpoint is
    // embedded in these errors and credentials ride in its query string.
    const error = await assertTronBroadcastAffordable(estimateOf(400_000n), {
      ...options,
      costInSun: async () => {
        throw new Error(
          'failed for https://api.example.com/x?apikey=SHOULDNOTAPPEAR'
        )
      },
    }).then(
      () => undefined,
      (e: unknown) => e as Error
    )

    expect(error?.message).toMatch(/refusing to broadcast/)
    expect(error?.message).not.toContain('SHOULDNOTAPPEAR')
  })
})
