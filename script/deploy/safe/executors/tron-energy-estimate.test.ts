/**
 * The arithmetic the whole refusal decision rests on. Reviewed as untested:
 * four mutations to this module — dropping the TRX→SUN factor, inverting it,
 * changing the mirrored fee-limit default, and deleting the malformed-value
 * throw — all left the suite green.
 *
 * The energy estimator itself is not covered here: it needs a live
 * `triggerconstantcontract` endpoint and network-level failure injection. What
 * is covered is everything that decides the comparison once a figure exists.
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
  tronEnergyCostInSun,
  TRON_FEE_LIMIT_SUN_ENV,
} from './tron-energy-estimate'

let original: string | undefined

beforeEach(() => {
  original = process.env[TRON_FEE_LIMIT_SUN_ENV]
  delete process.env[TRON_FEE_LIMIT_SUN_ENV]
})

afterEach(() => {
  if (original === undefined) delete process.env[TRON_FEE_LIMIT_SUN_ENV]
  else process.env[TRON_FEE_LIMIT_SUN_ENV] = original
})

describe('configuredTronFeeLimitSun', () => {
  it('defaults to the devkit default of 50 TRX', () => {
    // Must equal the devkit's own default, or the guard checks a limit the
    // broadcast will not run under.
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
    // Not a curiosity: parity with the devkit's parse is the whole requirement
    // here, and `Number('1e9')` is an integer to both.
    process.env[TRON_FEE_LIMIT_SUN_ENV] = '1e9'

    expect(configuredTronFeeLimitSun()).toBe(1_000_000_000)
  })

  it.each(['0', '-1', '1.5', 'abc', ' '.repeat(0) + 'NaN'])(
    'throws on the malformed value %p rather than falling back',
    (value) => {
      // Falling back would silently compare against a different limit from the
      // one the devkit applies — and the devkit throws here too.
      process.env[TRON_FEE_LIMIT_SUN_ENV] = value

      expect(() => configuredTronFeeLimitSun()).toThrow(
        new RegExp(TRON_FEE_LIMIT_SUN_ENV)
      )
    }
  )
})

describe('tronEnergyCostInSun', () => {
  // Order matters in this block, and it is not incidental. The devkit caches a
  // successful price read for its TTL, so the unread-price case has to run
  // before anything warms that cache — afterwards every call is served from it
  // and the fallback branch is unreachable.
  it('reports an unread price as unconfirmed', async () => {
    // `getCurrentPrices` catches its own failure and returns a constant of
    // 210 SUN/energy against a live mainnet rate of 100, so a transient RPC
    // failure would otherwise make the guard refuse honest traffic while
    // quoting a cost over twice the truth as though it were measured.
    const tronWeb = {
      trx: {
        getEnergyPrices: async () => {
          throw new Error('getEnergyPrices unavailable')
        },
        getBandwidthPrices: async () => {
          throw new Error('getBandwidthPrices unavailable')
        },
      },
    } as unknown as Parameters<typeof tronEnergyCostInSun>[0]

    const { costSun, priceConfirmed } = await tronEnergyCostInSun(
      tronWeb,
      500_000n
    )

    expect(priceConfirmed).toBe(false)
    // 500k at the fallback 210 SUN/energy — the inflated figure, correctly
    // labelled rather than suppressed.
    expect(costSun).toBe(105_000_000n)
  })

  it('converts TRX pricing to SUN', async () => {
    // The devkit reports energyPrice in TRX (it divides the chain's SUN figure
    // by 1e6), so the cost has to be multiplied back up. Dropping or inverting
    // that factor is a 1e6 error in the figure the refusal compares, and it
    // survived every existing test.
    const tronWeb = {
      trx: {
        // `<timestamp>:<sunPerEnergy>`; 100 SUN/energy is the live mainnet rate.
        getEnergyPrices: async () => '0:100',
        getBandwidthPrices: async () => '0:1000',
      },
    } as unknown as Parameters<typeof tronEnergyCostInSun>[0]

    const { costSun, priceConfirmed } = await tronEnergyCostInSun(
      tronWeb,
      500_000n
    )

    expect(costSun).toBe(50_000_000n)
    expect(priceConfirmed).toBe(true)
  })
})

describe('applyTronSafetyMargin', () => {
  it.each([
    [500_000, 600_000n],
    [1, 2n],
    [0, 0n],
    [416_666, 500_000n],
  ])('turns %i raw energy into %s', (raw, expected) => {
    // The margin is not padding. `triggerconstantcontract` under-reports what
    // the broadcast is charged — the dynamic-energy penalty is not applied to
    // constant calls, and state moves between the estimate and the send — so a
    // batch just above the raw figure would clear the guard and still abort
    // part-way, which is the failure the pre-flight exists to prevent.
    expect(applyTronSafetyMargin(raw)).toBe(expected)
  })

  it('rounds up, never down', () => {
    // Rounding toward the refusal is the safe direction for a guard.
    expect(applyTronSafetyMargin(1)).toBe(2n)
    expect(applyTronSafetyMargin(7)).toBe(9n)
  })

  it('matches the margin the devkit applies in its own estimator', () => {
    // Deploy scripts price calls through the devkit's `estimateContractEnergy`,
    // which applies the same constant. If the two drifted, the deploy path and
    // this guard would disagree about what a call costs.
    expect(applyTronSafetyMargin(1_000_000)).toBe(1_200_000n)
  })
})
