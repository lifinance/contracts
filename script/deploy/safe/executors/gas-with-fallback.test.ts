/**
 * Tests for `getGasWithFallback`: multiplier resolution from env, and what
 * happens when estimation throws — which differs by call site. Each test
 * isolates the env vars it reads so suite ordering is irrelevant.
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
  fallbackExplicitlyAllowed,
  getGasWithFallback,
} from './gas-with-fallback'

const throwingEstimate = async (): Promise<bigint> => {
  throw new Error('execution reverted: eth_estimateGas failed')
}

/** Bun's `.rejects` is not a real Promise; see 402-typescript-tests [CONV:TEST-ASSERT-REJECTS]. */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp
): Promise<string> {
  try {
    await promise
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(match)
    return message
  }
  throw new Error('expected the promise to reject, but it resolved')
}

describe('getGasWithFallback', () => {
  let originalMultiplier: string | undefined
  let originalAllow: string | undefined

  beforeEach(() => {
    originalMultiplier = process.env.GAS_ESTIMATE_MULTIPLIER
    originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  })

  afterEach(() => {
    if (originalMultiplier === undefined)
      delete process.env.GAS_ESTIMATE_MULTIPLIER
    else process.env.GAS_ESTIMATE_MULTIPLIER = originalMultiplier
    if (originalAllow === undefined)
      delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
  })

  describe('multiplier resolution (estimation succeeds)', () => {
    it('applies the default 130% multiplier when env var is unset', async () => {
      delete process.env.GAS_ESTIMATE_MULTIPLIER
      expect(
        await getGasWithFallback(async () => 100_000n, {
          onEstimateFailure: 'refuse',
        })
      ).toBe(130_000n)
    })

    it('uses GAS_ESTIMATE_MULTIPLIER from env when valid', async () => {
      process.env.GAS_ESTIMATE_MULTIPLIER = '200'
      expect(
        await getGasWithFallback(async () => 100_000n, {
          onEstimateFailure: 'refuse',
        })
      ).toBe(200_000n)
    })

    it('trims whitespace in env var', async () => {
      process.env.GAS_ESTIMATE_MULTIPLIER = '  150  '
      expect(
        await getGasWithFallback(async () => 100_000n, {
          onEstimateFailure: 'refuse',
        })
      ).toBe(150_000n)
    })

    it.each([
      ['empty', ''],
      ['whitespace-only', '   '],
      ['non-numeric', '1.3'],
      ['non-digit chars', '130%'],
      ['zero', '0'],
      ['negative', '-10'],
    ])('falls back to 130%% when env var is %s', async (_label, value) => {
      process.env.GAS_ESTIMATE_MULTIPLIER = value
      expect(
        await getGasWithFallback(async () => 100_000n, {
          onEstimateFailure: 'refuse',
        })
      ).toBe(130_000n)
    })

    it('still applies multiplier on a small estimate (integer division)', async () => {
      process.env.GAS_ESTIMATE_MULTIPLIER = '130'
      // (7 * 130) / 100 = 910 / 100 = 9
      expect(
        await getGasWithFallback(async () => 7n, {
          onEstimateFailure: 'refuse',
        })
      ).toBe(9n)
    })
  })

  describe("onEstimateFailure: 'refuse' — every path that broadcasts", () => {
    it('rejects rather than returning a guessed gas limit', async () => {
      const message = await expectRejects(
        getGasWithFallback(throwingEstimate, { onEstimateFailure: 'refuse' }),
        /gas estimation failed/i
      )
      expect(message).toMatch(/refusing/i)
    })

    it('names the network and the operation so the refusal is actionable', async () => {
      const message = await expectRejects(
        getGasWithFallback(throwingEstimate, {
          onEstimateFailure: 'refuse',
          networkName: 'jovay',
          operation: 'Safe execTransaction',
        }),
        /jovay/
      )
      expect(message).toMatch(/Safe execTransaction/)
    })

    it('surfaces the underlying estimation error rather than swallowing it', async () => {
      const message = await expectRejects(
        getGasWithFallback(throwingEstimate, { onEstimateFailure: 'refuse' }),
        /execution reverted/
      )
      expect(message).toMatch(/eth_estimateGas failed/)
    })

    it('names the escape hatch so the operator knows the deliberate override', async () => {
      await expectRejects(
        getGasWithFallback(throwingEstimate, { onEstimateFailure: 'refuse' }),
        /ALLOW_GAS_ESTIMATE_FALLBACK/
      )
    })
  })

  describe('ALLOW_GAS_ESTIMATE_FALLBACK escape hatch', () => {
    it.each([['true'], ['1'], ['yes']])(
      'downgrades refuse to fallback when set to %p',
      async (value) => {
        process.env.ALLOW_GAS_ESTIMATE_FALLBACK = value
        expect(
          await getGasWithFallback(throwingEstimate, {
            onEstimateFailure: 'refuse',
          })
        ).toBe(500_000n)
      }
    )

    it('honours a custom fallback when the hatch is open', async () => {
      process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'true'
      expect(
        await getGasWithFallback(throwingEstimate, {
          onEstimateFailure: 'refuse',
          fallbackGas: 750_000n,
        })
      ).toBe(750_000n)
    })

    it.each([['false'], ['0'], ['no'], ['']])(
      'still refuses when set to %p — only an affirmative value opens it',
      async (value) => {
        process.env.ALLOW_GAS_ESTIMATE_FALLBACK = value
        await expectRejects(
          getGasWithFallback(throwingEstimate, { onEstimateFailure: 'refuse' }),
          /gas estimation failed/i
        )
      }
    )
  })

  describe("onEstimateFailure: 'fallback' — dry-run paths only", () => {
    it('returns the default fallback so a simulation can still report a figure', async () => {
      expect(
        await getGasWithFallback(throwingEstimate, {
          onEstimateFailure: 'fallback',
        })
      ).toBe(500_000n)
    })

    it('returns a custom fallback', async () => {
      expect(
        await getGasWithFallback(throwingEstimate, {
          onEstimateFailure: 'fallback',
          fallbackGas: 750_000n,
        })
      ).toBe(750_000n)
    })

    it('does not need the escape hatch — a dry run broadcasts nothing', async () => {
      delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
      expect(
        await getGasWithFallback(throwingEstimate, {
          onEstimateFailure: 'fallback',
        })
      ).toBe(500_000n)
    })
  })
})

describe('the refusal never leaks a credentialed endpoint', () => {
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

  // viem embeds the full request URL, query string included, in error.message —
  // and that is exactly where dRPC / Alchemy keys live.
  const LEAKY = [
    'HTTP request failed.\n\nURL: https://lb.drpc.org/ogrpc?network=jovay&dkey=DRPCKEY_AAAA1111',
    'HTTP request failed.\n\nURL: https://eth-mainnet.g.alchemy.com/v2/ALCHEMYKEY_BBBB2222',
  ]

  it.each(LEAKY)('strips the endpoint out of the refusal', async (raw) => {
    const message = await expectRejects(
      getGasWithFallback(
        async () => {
          throw new Error(raw)
        },
        { onEstimateFailure: 'refuse', networkName: 'jovay' }
      ),
      /refusing to broadcast/i
    )

    expect(message).not.toContain('DRPCKEY_AAAA1111')
    expect(message).not.toContain('ALCHEMYKEY_BBBB2222')
    expect(message).not.toContain('drpc.org')
    expect(message).not.toContain('alchemy.com')
    expect(message).not.toMatch(/https?:\/\//)
    expect(message).toContain('[redacted-url]')
  })
})

describe('fallbackExplicitlyAllowed — scoping', () => {
  let originalAllow: string | undefined

  beforeEach(() => {
    originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
  })

  afterEach(() => {
    if (originalAllow === undefined)
      delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
  })

  const withValue = (value: string | undefined, network?: string): boolean => {
    if (value === undefined) delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = value
    return fallbackExplicitlyAllowed(network)
  }

  it('is closed when unset or empty', () => {
    expect(withValue(undefined, 'jovay')).toBe(false)
    expect(withValue('', 'jovay')).toBe(false)
    expect(withValue('   ', 'jovay')).toBe(false)
  })

  it.each([['true'], ['TRUE'], ['True'], [' true '], ['1'], ['yes'], ['on']])(
    'opens for every network on the affirmative value %p',
    (value) => {
      expect(withValue(value, 'jovay')).toBe(true)
      expect(withValue(value, 'mainnet')).toBe(true)
      expect(withValue(value, undefined)).toBe(true)
    }
  )

  it.each([
    ['false'],
    ['0'],
    ['no'],
    ['off'],
    ['2'],
    ['-1'],
    ['01'],
    ['enabled'],
  ])('stays closed on %p', (value) => {
    expect(withValue(value, 'jovay')).toBe(false)
  })

  it('scopes to a single named network', () => {
    expect(withValue('jovay', 'jovay')).toBe(true)
    expect(withValue('jovay', 'mainnet')).toBe(false)
  })

  it('scopes to a comma-separated list, tolerating spaces and case', () => {
    expect(withValue('jovay, Mainnet', 'mainnet')).toBe(true)
    expect(withValue('jovay, Mainnet', 'JOVAY')).toBe(true)
    expect(withValue('jovay, Mainnet', 'arbitrum')).toBe(false)
  })

  it('a scoped value cannot be satisfied by an unscoped caller', () => {
    // The executors fan out with Promise.all across networks; a caller that
    // cannot name its network must not inherit another network's exemption.
    expect(withValue('jovay', undefined)).toBe(false)
  })
})
