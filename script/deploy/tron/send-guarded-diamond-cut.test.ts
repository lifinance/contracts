/**
 * The A0.6 bar on the Tron facet-registration send. The estimate was already
 * computed and printed here before; what was missing was the comparison, so
 * these assert that an estimate the 5000 TRX fee limit cannot pay for stops the
 * broadcast, and that an affordable one still reaches it.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { sendGuardedDiamondCut } from './tronUtils'

const DIAMOND = 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2'
const FACET = 'TVQY5uYUJHqPJ3kmpKcQmiRcaEbGvJYVfR'
const FULL_HOST = 'https://tron.invalid'

/** 100 SUN per energy: the 5000 TRX limit buys 50,000,000 energy. */
const SUN_PER_ENERGY = 100

/**
 * `estimateDiamondCutEnergy` multiplies by `DIAMOND_CUT_ENERGY_MULTIPLIER`
 * (10), so 20,000 raw becomes 200,000 energy — 20,000,000 SUN, well inside the
 * limit. 6,000,000 raw becomes 60,000,000 energy, which is not.
 */
const AFFORDABLE_ENERGY_USED = 20_000
const UNAFFORDABLE_ENERGY_USED = 6_000_000

let sends: unknown[]
let energyUsed: number | null
let energyPrices: string
let estimateRequests: number

const facetCuts = [[FACET, 0, ['0x12345678']]]

const tronWebStub = {
  utils: { abi: { encodeParams: (): string => '0xabcd' } },
  trx: { getEnergyPrices: async (): Promise<string> => energyPrices },
  defaultAddress: { base58: DIAMOND },
}

const diamondStub = {
  diamondCut: (...args: unknown[]) => ({
    send: async (): Promise<string> => {
      sends.push(args)
      return 'deadbeef'
    },
  }),
}

const call = (): Promise<string> =>
  sendGuardedDiamondCut({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tronWeb: tronWebStub as any,
    diamond: diamondStub,
    network: 'tron',
    facetName: 'OwnershipFacet',
    diamondAddress: DIAMOND,
    facetCuts,
    fullHost: FULL_HOST,
  })

/**
 * Awaited, so the spy assertion that follows observes a settled call rather
 * than one that has not started yet.
 */
const refusal = (): Promise<Error | undefined> =>
  call().then(
    () => undefined,
    (error: unknown) => error as Error
  )

/** Answers the devkit's estimate request; any other URL is a test bug. */
const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url)
  if (!target.includes('/wallet/triggerconstantcontract'))
    throw new Error(`unexpected fetch to ${target}`)

  estimateRequests += 1
  return new Response(
    JSON.stringify(
      energyUsed === null
        ? { result: { result: false, message: 'REVERT' } }
        : { result: { result: true }, energy_used: energyUsed }
    ),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

let originalFetch: typeof globalThis.fetch
let originalAllow: string | undefined

beforeEach(() => {
  sends = []
  estimateRequests = 0
  energyUsed = AFFORDABLE_ENERGY_USED
  energyPrices = `1:${SUN_PER_ENERGY}`
  originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalAllow === undefined)
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
})

describe('the diamondCut registration send', () => {
  it('broadcasts when the estimate fits the fee limit', async () => {
    expect(await call()).toBe('deadbeef')
    expect(estimateRequests).toBeGreaterThan(0)
    expect(sends).toHaveLength(1)
  })

  it('never reaches the send when estimation fails', async () => {
    energyUsed = null

    const error = await refusal()

    expect(error?.message).toMatch(/refusing to broadcast/)
    expect(estimateRequests).toBeGreaterThan(0)
    expect(sends).toEqual([])
  })

  it('never reaches the send when the estimate exceeds the fee limit', async () => {
    energyUsed = UNAFFORDABLE_ENERGY_USED

    const error = await refusal()

    expect(error?.message).toMatch(/exceeds the fee limit/)
    expect(sends).toEqual([])
  })

  it('never reaches the send when the energy price is unreadable', async () => {
    energyPrices = ''

    const error = await refusal()

    expect(error?.message).toMatch(/Could not price/)
    expect(sends).toEqual([])
  })

  it('names the network and the facet in the refusal', async () => {
    energyUsed = null

    const error = await refusal()

    expect(error?.message).toMatch(/on tron .*OwnershipFacet/)
  })

  it('broadcasts on a failed estimate when the escape hatch names the network', async () => {
    energyUsed = null
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'tron'

    expect(await call()).toBe('deadbeef')
    expect(sends).toHaveLength(1)
  })
})
