/**
 * The batched facet-registration send — the diamondCut path the deploy runbook
 * actually invokes. Every case is a spy over the broadcast, since a thrown
 * error alone does not show the send was skipped.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { sendGuardedFacetRegistration } from './send-guarded-facet-registration'

const FACET = 'TVQY5uYUJHqPJ3kmpKcQmiRcaEbGvJYVfR'
/** 100 SUN per energy: the 5000 TRX fee limit buys 50,000,000 energy. */
const SUN_PER_ENERGY = 100
const FEE_LIMIT_SUN = 5_000_000_000

let sends: unknown[][]
let energyPrices: string

const diamondStub = {
  diamondCut: (...args: unknown[]) => ({
    send: async (): Promise<string> => {
      sends.push(args)
      return 'deadbeef'
    },
  }),
}

const call = (estimatedEnergy: number): Promise<string> =>
  sendGuardedFacetRegistration({
    tronWeb: { trx: { getEnergyPrices: async () => energyPrices } },
    diamond: diamondStub,
    network: 'tron',
    facetCuts: [[FACET, 0, ['0x12345678']]],
    estimatedEnergy,
    feeLimitSun: FEE_LIMIT_SUN,
  })

/**
 * Awaited, so the spy assertion that follows observes a settled call rather
 * than one that has not started yet.
 */
const refusal = (estimatedEnergy: number): Promise<Error | undefined> =>
  call(estimatedEnergy).then(
    () => undefined,
    (error: unknown) => error as Error
  )

let originalAllow: string | undefined

beforeEach(() => {
  sends = []
  energyPrices = `1:${SUN_PER_ENERGY}`
  originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
})

afterEach(() => {
  if (originalAllow === undefined)
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
})

describe('the batched facet-registration send', () => {
  it('broadcasts when the estimate fits the fee limit', async () => {
    expect(await call(200_000)).toBe('deadbeef')
    expect(sends).toHaveLength(1)
  })

  it('never reaches the send when the estimate exceeds the fee limit', async () => {
    const error = await refusal(60_000_000)

    expect(error?.message).toMatch(/exceeds the fee limit/)
    expect(sends).toEqual([])
  })

  it('never reaches the send on a zero-energy estimate', async () => {
    // A node can answer without simulating. Priced, zero clears any fee limit.
    const error = await refusal(0)

    expect(error?.message).toMatch(/no contract call costs/)
    expect(sends).toEqual([])
  })

  it('never reaches the send when the energy price is unreadable', async () => {
    energyPrices = ''

    const error = await refusal(200_000)

    expect(error?.message).toMatch(/Could not price/)
    expect(sends).toEqual([])
  })

  it('names the network and the cut in the refusal', async () => {
    const error = await refusal(60_000_000)

    expect(error?.message).toMatch(/on tron .*registering 1 facets/)
    expect(error?.message).toContain('DIAMOND_CUT_FEE_LIMIT_SUN')
  })

  it('broadcasts an unaffordable estimate when the escape hatch names the network', async () => {
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'tron'

    expect(await call(60_000_000)).toBe('deadbeef')
    expect(sends).toHaveLength(1)
  })
})
