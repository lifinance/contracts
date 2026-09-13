/**
 * Which endpoints each read-only client actually reads through.
 *
 * The distinction is the whole point of there being two builders, and it is
 * invisible in every other test: both return a `PublicClient` and both answer
 * the same calls. Asserted on `transport.type`, which is the one place the
 * difference surfaces without a network.
 *
 * The environment is set rather than deleted and restored by value: `delete`
 * makes bun resolve the variable from the loaded `.env` again, which would make
 * these assertions depend on whatever this machine happens to have configured.
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
  buildFallbackReadClient,
  buildReadOnlyClient,
} from './read-only-safe-client'

const NETWORK = 'arbitrum'
const PRIMARY = 'https://primary.invalid/rpc'
const FALLBACKS =
  'https://fallback-one.invalid/rpc,https://fallback-two.invalid/rpc'
const EXPLICIT = 'https://explicit.invalid/rpc'

const PRIMARY_VAR = `ETH_NODE_URI_${NETWORK.toUpperCase()}`
const FALLBACKS_VAR = `${PRIMARY_VAR}_FALLBACKS`

describe('buildFallbackReadClient', () => {
  let priorPrimary: string | undefined
  let priorFallbacks: string | undefined

  beforeEach(() => {
    priorPrimary = process.env[PRIMARY_VAR]
    priorFallbacks = process.env[FALLBACKS_VAR]
    process.env[PRIMARY_VAR] = PRIMARY
    process.env[FALLBACKS_VAR] = FALLBACKS
  })

  afterEach(() => {
    process.env[PRIMARY_VAR] = priorPrimary ?? ''
    process.env[FALLBACKS_VAR] = priorFallbacks ?? ''
  })

  it('reads through the fallbacks, where buildReadOnlyClient reads only the primary', () => {
    // Both halves, so this cannot pass by the fallback builder having quietly
    // become the same thing as the other one.
    expect(buildFallbackReadClient(NETWORK).transport.type).toBe('fallback')
    expect(buildReadOnlyClient(NETWORK).transport.type).toBe('http')
  })

  it('honours an explicit endpoint alone, bypassing the configured fallbacks', () => {
    // An operator naming one endpoint is telling the run to read that one, so
    // failing over to the configured list would ignore the instruction.
    expect(buildFallbackReadClient(NETWORK, EXPLICIT).transport.type).toBe(
      'http'
    )
  })

  it('still builds a usable client when no fallbacks are configured', () => {
    process.env[FALLBACKS_VAR] = ''

    // A one-endpoint network is not an error, and it is not wrapped either:
    // `getFallbackTransportForChain` returns the single transport rather than a
    // failover around it. The property that matters is that the preflight can
    // still probe such a network at all.
    expect(buildFallbackReadClient(NETWORK).transport.type).toBe('http')
  })

  it('throws rather than reading an unconfigured network', () => {
    process.env[PRIMARY_VAR] = ''
    process.env[FALLBACKS_VAR] = ''

    // The refusal the preflight turns into "the variable is not set". Pinned
    // because the alternative — a client with no endpoint — would fail later,
    // per read, as a network problem rather than a configuration one.
    expect(() => buildFallbackReadClient(NETWORK)).toThrow(
      new RegExp(PRIMARY_VAR, 'u')
    )
  })
})
