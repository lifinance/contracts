/**
 * The direct-EOA `transferOwnership` send. Every case is a spy over the
 * broadcast, since a thrown error alone does not show the send was skipped.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { sendTransferOwnership } from './transfer-ownership-to-timelock'

const DIAMOND = 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2'
const TIMELOCK = 'TVQY5uYUJHqPJ3kmpKcQmiRcaEbGvJYVfR'

/** 100 SUN per energy: the 20 TRX fee limit buys 200,000 energy. */
const SUN_PER_ENERGY = 100

let sends: string[]
let energyUsed: number | null
let energyPrices: string

const tronWebStub = {
  transactionBuilder: {
    triggerConstantContract: async () =>
      energyUsed === null
        ? { result: { result: false, message: 'REVERT' } }
        : { result: { result: true }, energy_used: energyUsed },
  },
  trx: { getEnergyPrices: async (): Promise<string> => energyPrices },
}

const diamondStub = {
  transferOwnership: (to: string) => ({
    send: async (): Promise<string> => {
      sends.push(to)
      return 'deadbeef'
    },
  }),
}

const call = (): Promise<string> =>
  sendTransferOwnership({
    tronWeb: tronWebStub,
    diamond: diamondStub,
    networkName: 'tron',
    diamondAddress: DIAMOND,
    timelockBase58: TIMELOCK,
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

let originalAllow: string | undefined

beforeEach(() => {
  sends = []
  energyUsed = 20_000
  energyPrices = `1:${SUN_PER_ENERGY}`
  originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
})

afterEach(() => {
  if (originalAllow === undefined)
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
})

describe('transferOwnership on Tron', () => {
  it('broadcasts when the estimate fits the fee limit', async () => {
    expect(await call()).toBe('deadbeef')
    expect(sends).toEqual([TIMELOCK])
  })

  it('never reaches the send when estimation fails', async () => {
    energyUsed = null

    const error = await refusal()

    expect(error?.message).toMatch(/refusing to broadcast/)
    expect(sends).toEqual([])
  })

  it('never reaches the send when the estimate exceeds the fee limit', async () => {
    // 20,000 raw becomes 24,000 energy after the 1.2 margin — 2,400,000 SUN,
    // inside the 20 TRX limit. 200,000 raw is not.
    energyUsed = 200_000

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

  it('names the network and the operation in the refusal', async () => {
    energyUsed = null

    const error = await refusal()

    expect(error?.message).toMatch(
      new RegExp(`on tron .*transferOwnership\\(${TIMELOCK}\\)`)
    )
  })
})
