/**
 * The arithmetic and the transport the refusal decision rests on.
 *
 * Reviewed as untested twice: first the pricing (four mutations survived,
 * including dropping and inverting the TRX conversion), then the retry loop
 * (deleting the retry entirely, and propagating the first error instead of the
 * last, both left the suite green). The `sleep` seam exists so these can run
 * without waiting.
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
  applyTronSafetyMargin,
  configuredTronFeeLimitSun,
  estimateTronEnergy,
  latestEnergyPriceSun,
  tronEnergyCostInSun,
  TRON_FEE_LIMIT_SUN_ENV,
} from './tron-energy-estimate'

const HOUR = 3_600_000

let originalLimit: string | undefined
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalLimit = process.env[TRON_FEE_LIMIT_SUN_ENV]
  delete process.env[TRON_FEE_LIMIT_SUN_ENV]
  originalFetch = globalThis.fetch
})

afterEach(() => {
  if (originalLimit === undefined) delete process.env[TRON_FEE_LIMIT_SUN_ENV]
  else process.env[TRON_FEE_LIMIT_SUN_ENV] = originalLimit
  globalThis.fetch = originalFetch
})

describe('latestEnergyPriceSun', () => {
  it('takes the newest price at or before now', () => {
    // Real shape, from a live `getEnergyPrices` read: `<ms>:<sunPerEnergy>`.
    const price = latestEnergyPriceSun(
      '0:100,1670133600000:420,1726747200000:210,1756468800000:100'
    )

    expect(price).toBe(100)
  })

  it('ignores an entry dated in the future', () => {
    const future = Date.now() + HOUR

    expect(latestEnergyPriceSun(`0:140,${future}:999`)).toBe(140)
  })

  it('falls back to the last entry when every price is future-dated', () => {
    const future = Date.now() + HOUR

    expect(latestEnergyPriceSun(`${future}:777`)).toBe(777)
  })

  it.each(['', '   ', 'garbage', '0:0', 'abc:def', ':', '0:'])(
    'throws on %p rather than returning a price of zero',
    (input) => {
      // The hole this closes: the devkit's parse returns `Number(undefined || 0)`
      // = 0 for these, and a node answering with an empty price string never
      // reaches its catch. Priced at 0, any batch clears any fee limit and the
      // guard becomes a no-op on exactly what it exists to stop.
      expect(() => latestEnergyPriceSun(input)).toThrow(
        /no usable energy price/i
      )
    }
  )

  it('skips a zero-priced entry but still uses an older valid one', () => {
    expect(latestEnergyPriceSun('1000:140,2000:0')).toBe(140)
  })
})

describe('tronEnergyCostInSun', () => {
  it('prices energy at the rate it read, in SUN', async () => {
    const tronWeb = { trx: { getEnergyPrices: async () => '0:100' } }

    expect(await tronEnergyCostInSun(tronWeb, 500_000n)).toBe(50_000_000n)
  })

  it('refuses rather than guessing when the price read throws', async () => {
    // Previously this went through the devkit, which caught the failure and
    // substituted 210 SUN/energy — a real Tron price, so no comparison against
    // its value could tell a fallback from a correct read.
    const tronWeb = {
      trx: {
        getEnergyPrices: async () => {
          throw new Error('getEnergyPrices unavailable')
        },
      },
    }

    expect(tronEnergyCostInSun(tronWeb, 500_000n)).rejects.toThrow(
      /getEnergyPrices unavailable/
    )
  })

  it('refuses an empty price string instead of pricing at zero', async () => {
    const tronWeb = { trx: { getEnergyPrices: async () => '' } }

    expect(tronEnergyCostInSun(tronWeb, 5_000_000n)).rejects.toThrow(
      /no usable energy price/i
    )
  })
})

describe('estimateTronEnergy transport', () => {
  const params = {
    networkKey: 'tron' as const,
    ownerBase58: 'TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    contractBase58: 'TBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    data: '0xdeadbeef' as const,
    callValue: 0n,
    sleep: async () => undefined,
  }

  const respondWith = (bodies: unknown[]): (() => number) => {
    let calls = 0
    globalThis.fetch = (async () => {
      const body = bodies[Math.min(calls, bodies.length - 1)]
      calls += 1
      if (body instanceof Error) throw body
      return {
        ok: (body as { ok?: boolean }).ok !== false,
        status: (body as { status?: number }).status ?? 200,
        text: async () => 'err',
        json: async () => body,
      } as unknown as Response
    }) as unknown as typeof globalThis.fetch
    return () => calls
  }

  it('retries a transport failure and returns a later success, with the margin', async () => {
    const calls = respondWith([
      new Error('network boom #1'),
      new Error('network boom #2'),
      { energy_used: 500_000 },
    ])

    // 500_000 * 1.2
    expect(await estimateTronEnergy(params)).toBe(600_000n)
    expect(calls()).toBe(3)
  })

  it('propagates the last error, not the first', async () => {
    // Reporting the first would tell an operator about a failure two attempts
    // stale, which may not be why it finally gave up.
    const calls = respondWith([
      new Error('boom #1'),
      new Error('boom #2'),
      new Error('boom #3'),
    ])

    const error = await estimateTronEnergy(params).then(
      () => undefined,
      (e: unknown) => e as Error
    )

    expect(error?.message).toBe('boom #3')
    expect(calls()).toBe(3)
  })

  it('does not retry a call that would revert', async () => {
    // Deterministic: asking again returns the same answer, so retrying only
    // spends the operator's time before the same refusal.
    const calls = respondWith([{ result: { result: false } }])

    await estimateTronEnergy(params).catch(() => undefined)

    expect(calls()).toBe(1)
  })

  it('refuses a zero estimate, and does not retry it', async () => {
    // A contract call always burns energy, so zero is a node answering without
    // simulating. Priced, it costs nothing and clears any fee limit.
    const calls = respondWith([{ energy_used: 0 }])

    const error = await estimateTronEnergy(params).then(
      () => undefined,
      (e: unknown) => e as Error
    )

    expect(error?.message).toMatch(/no contract call costs/)
    expect(calls()).toBe(1)
  })
})

describe('configuredTronFeeLimitSun', () => {
  it('defaults to the devkit default of 50 TRX', () => {
    expect(configuredTronFeeLimitSun()).toBe(50_000_000)
  })

  it.each(['', '   '])('treats %p as unset', (value) => {
    process.env[TRON_FEE_LIMIT_SUN_ENV] = value

    expect(configuredTronFeeLimitSun()).toBe(50_000_000)
  })

  it('reads a configured value', () => {
    process.env[TRON_FEE_LIMIT_SUN_ENV] = '150000000'

    expect(configuredTronFeeLimitSun()).toBe(150_000_000)
  })

  it('accepts exponent notation, because the devkit does', () => {
    process.env[TRON_FEE_LIMIT_SUN_ENV] = '1e9'

    expect(configuredTronFeeLimitSun()).toBe(1_000_000_000)
  })

  it.each(['0', '-1', '1.5', 'abc', 'NaN'])(
    'throws on the malformed value %p rather than falling back',
    (value) => {
      process.env[TRON_FEE_LIMIT_SUN_ENV] = value

      expect(() => configuredTronFeeLimitSun()).toThrow(
        new RegExp(TRON_FEE_LIMIT_SUN_ENV)
      )
    }
  )
})

describe('applyTronSafetyMargin', () => {
  it.each([
    [500_000, 600_000n],
    [1, 2n],
    [416_666, 500_000n],
  ])('turns %i raw energy into %s', (raw, expected) => {
    expect(applyTronSafetyMargin(raw)).toBe(expected)
  })

  it('matches the margin the devkit applies in its own estimator', () => {
    // This is the whole justification, and it is parity rather than
    // measurement: the deploy scripts price calls through the devkit's
    // `estimateContractEnergy`, which applies the same constant. If the two
    // drifted, the deploy path and this guard would disagree about what a call
    // costs.
    expect(applyTronSafetyMargin(1_000_000)).toBe(1_200_000n)
  })

  it('rounds up, never down', () => {
    expect(applyTronSafetyMargin(7)).toBe(9n)
  })
})
