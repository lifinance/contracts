/**
 * The sign-time retry cap, and the reads that are supposed to carry it.
 *
 * Two halves, because either alone passes while the hazard is live: the cap
 * itself is driven for real, and the four sign-time reads are asserted on their
 * source to have gone through it. A read that reverts to
 * `getTransportConfigFromRpcUrl` inherits TronGrid's 8-retry profile again, and
 * nothing about the returned config says which caller it was built for.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import networksConfig from '../../../config/networks.json'
import { getTransportConfigFromRpcUrl } from '../../utils/viemScriptHelpers'

import {
  getSignTimeTransportConfig,
  SIGN_TIME_RETRY_COUNT,
  SIGN_TIME_RETRY_DELAY_MS,
} from './sign-time-transport'

/**
 * Read from the fleet's own config rather than written out here.
 *
 * Both TronGrid hosts are values in `.env`, which the pre-commit secret scanner
 * refuses to see in committed source — and this is the stronger assertion
 * anyway: it pins the profile against the endpoint a signer is really pointed
 * at, not against a URL chosen to make the test pass.
 */
const TRONGRID_RPC = (networksConfig as Record<string, { rpcUrl?: string }>)
  .tron?.rpcUrl

describe('getSignTimeTransportConfig', () => {
  // The premise the cap rests on, pinned against the dependency rather than
  // described: if `@lifi/tron-devkit` ever stops carrying this profile, the cap
  // is still correct but this file should stop claiming it prevents ten minutes.
  // Guarded, not assumed: if tron ever leaves `networks.json`, this file should
  // say so rather than quietly test `getTransportConfigFromRpcUrl(undefined)`.
  it('has a tron endpoint to measure the hazard against', () => {
    expect(TRONGRID_RPC).toBeTypeOf('string')
  })

  it('is capping a profile that is really there', () => {
    const uncapped = getTransportConfigFromRpcUrl(TRONGRID_RPC ?? '')

    expect(uncapped.retryCount).toBe(8)
    expect(uncapped.retryDelay).toBe(2_000)

    // viem's backoff is `~~(1 << count) * retryDelay`, so 8 retries is this
    // much sleep alone, before any attempt's own timeout.
    const backoffMs = Array.from(
      { length: uncapped.retryCount ?? 0 },
      (_unused, count) => (1 << count) * (uncapped.retryDelay ?? 0)
    ).reduce((total, wait) => total + wait, 0)
    expect(backoffMs).toBe(510_000)
  })

  it('replaces the endpoint profile with the sign-time budget', () => {
    const capped = getSignTimeTransportConfig(TRONGRID_RPC ?? '')

    expect(capped.retryCount).toBe(SIGN_TIME_RETRY_COUNT)
    expect(capped.retryDelay).toBe(SIGN_TIME_RETRY_DELAY_MS)

    const backoffMs = Array.from(
      { length: capped.retryCount },
      (_unused, count) => (1 << count) * capped.retryDelay
    ).reduce((total, wait) => total + wait, 0)
    expect(backoffMs).toBe(3_000)
  })

  // Pinned by value, not by the symbol: an assertion written as
  // `toBe(SIGN_TIME_RETRY_COUNT)` moves with the constant, so a cap lowered to
  // 1 — which turns one 429 on a fallback-less chain into a refusal to sign —
  // would pass everything above.
  it('keeps a retry, so one 429 is not a refusal to sign', () => {
    expect(SIGN_TIME_RETRY_COUNT).toBe(2)
    expect(SIGN_TIME_RETRY_DELAY_MS).toBe(1_000)
  })

  // Only the retry profile is the caller's business. Everything about reaching
  // the endpoint has to survive, or a password-only endpoint answers 401 and
  // that 401 is recorded as chain state.
  it('keeps the rewritten url and the credential header', () => {
    const capped = getSignTimeTransportConfig(
      'https://:pa%3Ass@auth.example/rpc'
    )

    expect(capped.url).toBe('https://auth.example/rpc')
    expect(capped.fetchOptions?.headers?.['Authorization']).toBe(
      `Basic ${Buffer.from(':pa:ss', 'utf8').toString('base64')}`
    )
  })

  it('still refuses credentials over cleartext http', () => {
    expect(() =>
      getSignTimeTransportConfig('http://user:pass@auth.example/rpc')
    ).toThrow(/credentials over http/i)
  })
})

/**
 * The reads a signer waits on, and what each one stalls.
 *
 * Asserted on the source because none of these can be driven without a chain:
 * `confirm-safe-tx.ts` calls `runMain` at module scope, and the other two build
 * their clients inside functions that immediately go to the network.
 */
describe('sign-time reads carry the cap', () => {
  const SIGN_TIME_READERS = [
    // The gate that refuses a signature: a stall here holds the signature itself.
    'codehash-sign-gate-deps.ts',
    // Reached from `getNetworksWithActionableTransactions`, so a stall lands
    // before the signer is shown a network list at all.
    'read-only-safe-client.ts',
    // The `--rpcUrl` override and the executability simulators.
    'confirm-safe-tx.ts',
  ] as const

  for (const file of SIGN_TIME_READERS)
    it(`${file} builds its transport through the cap`, () => {
      const source = readFileSync(join(import.meta.dir, file), 'utf8')

      expect(source).toContain('getSignTimeTransportConfig')
      // Not "does the capped call exist" — that passes with an uncapped call
      // sitting next to it, which is the state this change started from.
      expect(source).not.toContain('getTransportConfigFromRpcUrl')
    })
})
