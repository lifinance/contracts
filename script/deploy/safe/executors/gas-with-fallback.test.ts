/**
 * Tests for `getGasWithFallback`: multiplier resolution from env and
 * fallback-on-throw behaviour. Each test isolates `GAS_ESTIMATE_MULTIPLIER` so
 * suite ordering is irrelevant.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { getGasWithFallback } from './gas-with-fallback'

describe('getGasWithFallback', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.GAS_ESTIMATE_MULTIPLIER
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GAS_ESTIMATE_MULTIPLIER
    else process.env.GAS_ESTIMATE_MULTIPLIER = originalEnv
  })

  it('applies the default 130% multiplier when env var is unset', async () => {
    delete process.env.GAS_ESTIMATE_MULTIPLIER
    const gas = await getGasWithFallback(async () => 100_000n)
    expect(gas).toBe(130_000n)
  })

  it('uses GAS_ESTIMATE_MULTIPLIER from env when valid', async () => {
    process.env.GAS_ESTIMATE_MULTIPLIER = '200'
    const gas = await getGasWithFallback(async () => 100_000n)
    expect(gas).toBe(200_000n)
  })

  it('trims whitespace in env var', async () => {
    process.env.GAS_ESTIMATE_MULTIPLIER = '  150  '
    const gas = await getGasWithFallback(async () => 100_000n)
    expect(gas).toBe(150_000n)
  })

  it('falls back to 130% when env var is empty', async () => {
    process.env.GAS_ESTIMATE_MULTIPLIER = ''
    const gas = await getGasWithFallback(async () => 100_000n)
    expect(gas).toBe(130_000n)
  })

  it('falls back to 130% when env var is whitespace-only', async () => {
    process.env.GAS_ESTIMATE_MULTIPLIER = '   '
    const gas = await getGasWithFallback(async () => 100_000n)
    expect(gas).toBe(130_000n)
  })

  it('falls back to 130% when env var is non-numeric (e.g. 1.3)', async () => {
    process.env.GAS_ESTIMATE_MULTIPLIER = '1.3'
    const gas = await getGasWithFallback(async () => 100_000n)
    expect(gas).toBe(130_000n)
  })

  it('falls back to 130% when env var contains non-digit chars', async () => {
    process.env.GAS_ESTIMATE_MULTIPLIER = '130%'
    const gas = await getGasWithFallback(async () => 100_000n)
    expect(gas).toBe(130_000n)
  })

  it('falls back to 130% when env var is zero', async () => {
    process.env.GAS_ESTIMATE_MULTIPLIER = '0'
    const gas = await getGasWithFallback(async () => 100_000n)
    expect(gas).toBe(130_000n)
  })

  it('falls back to 130% when env var is negative', async () => {
    process.env.GAS_ESTIMATE_MULTIPLIER = '-10'
    const gas = await getGasWithFallback(async () => 100_000n)
    expect(gas).toBe(130_000n)
  })

  it('returns default fallback (500_000) when estimation throws', async () => {
    delete process.env.GAS_ESTIMATE_MULTIPLIER
    const gas = await getGasWithFallback(async () => {
      throw new Error('estimateGas reverted')
    })
    expect(gas).toBe(500_000n)
  })

  it('returns custom fallback when estimation throws', async () => {
    delete process.env.GAS_ESTIMATE_MULTIPLIER
    const gas = await getGasWithFallback(async () => {
      throw new Error('estimateGas reverted')
    }, 750_000n)
    expect(gas).toBe(750_000n)
  })

  it('still applies multiplier on a small estimate (rounds via integer div)', async () => {
    process.env.GAS_ESTIMATE_MULTIPLIER = '130'
    const gas = await getGasWithFallback(async () => 7n)
    // (7 * 130) / 100 = 910 / 100 = 9 (integer division)
    expect(gas).toBe(9n)
  })
})
