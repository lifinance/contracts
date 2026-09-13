/**
 * Pins which endpoints a read-only client reads through.
 *
 * These reads decide whether a network can be signed at all, so reading them
 * through the primary alone made a network with a throttled primary and a
 * healthy spare unusable while the executability gate read it fine.
 */
// eslint-disable-next-line import/no-unresolved
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { getRPCEnvVarName, getRPCFallbacksEnvVarName } from '../../utils/utils'

import { buildReadOnlyClient } from './read-only-safe-client'

const NETWORK = 'arbitrum'
const PRIMARY = getRPCEnvVarName(NETWORK)
const FALLBACKS = getRPCFallbacksEnvVarName(NETWORK)

/**
 * Dummy endpoints, never contacted: every assertion below is about the
 * transport the client was built with, so nothing here makes a request.
 */
const PRIMARY_URL = 'https://primary.invalid/rpc'
const SPARE_URL = 'https://spare.invalid/rpc'
const OVERRIDE_URL = 'https://override.invalid/rpc'

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved[PRIMARY] = process.env[PRIMARY]
  saved[FALLBACKS] = process.env[FALLBACKS]
  process.env[PRIMARY] = PRIMARY_URL
  process.env[FALLBACKS] = ''
})

afterEach(() => {
  for (const name of [PRIMARY, FALLBACKS]) {
    const original = saved[name]
    // Restored to a dummy rather than unset when there was nothing to restore:
    // deleting one of these names hands the child the real value from `.env`.
    process.env[name] = original ?? PRIMARY_URL
  }
})

describe('buildReadOnlyClient', () => {
  it('reads through every configured endpoint, not just the primary', () => {
    process.env[FALLBACKS] = SPARE_URL

    expect(buildReadOnlyClient(NETWORK).transport.key).toBe('fallback')
  })

  it('uses a plain transport when the network has only one endpoint', () => {
    expect(buildReadOnlyClient(NETWORK).transport.key).toBe('http')
  })

  // An override is the caller naming one endpoint on purpose; widening it to
  // the configured set would read somewhere the caller did not ask for.
  it('honours an explicit override instead of the configured set', () => {
    process.env[FALLBACKS] = SPARE_URL
    const client = buildReadOnlyClient(NETWORK, OVERRIDE_URL)

    expect(client.transport.key).toBe('http')
    expect(client.transport.url).toBe(OVERRIDE_URL)
  })

  it('carries a caller-supplied abort signal onto the requests it makes', () => {
    const signal = AbortSignal.timeout(1_000)
    const client = buildReadOnlyClient(NETWORK, OVERRIDE_URL, { signal })

    expect(client.transport.fetchOptions?.signal).toBe(signal)
  })

  it('carries the abort signal on the configured path too, not only an override', () => {
    // The assertion above covers the `rpcUrl` branch, which builds its own
    // transport. This covers the branch that runs when no `--rpc-url` is given —
    // the default for every real confirmation run, and the one the preflight's
    // budget actually depends on. Dropping `options` from the
    // `getFallbackTransportForChain` call bounded nothing and broke no test
    // until this existed.
    const signal = AbortSignal.timeout(1_000)
    const client = buildReadOnlyClient(NETWORK, undefined, { signal })

    expect(client.transport.fetchOptions?.signal).toBe(signal)
  })
})
