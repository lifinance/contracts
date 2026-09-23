import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { checkSourcifyVerification } from './sourcifyVerification'

const originalFetch = globalThis.fetch

const CHAIN_ID = 1
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const FACET_A = '0x00000000000000000000000000000000000000a1'
const FACET_B = '0x00000000000000000000000000000000000000b2'
const NESTED = '0x00000000000000000000000000000000000000c3'
const OPTIONS = { retryDelayMs: 0 }

type Route = () => Response

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

function proxyOf(...implementations: Array<[string, string]>): Response {
  return json(200, {
    proxyResolution: {
      isProxy: true,
      implementations: implementations.map(([address, name]) => ({
        address,
        name,
      })),
      proxyResolutionError: null,
    },
  })
}

async function expectRejects(
  promise: Promise<unknown>,
  match: string
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  expect(error?.message).toContain(match)
}

const plain = (): Response =>
  json(200, { proxyResolution: { isProxy: false, implementations: [] } })
const notFound = (): Response =>
  json(404, { customCode: 'not_found', message: 'not verified' })

/**
 * Serves each address from `routes`. A route may be an array of responses,
 * consumed one per call, to script retries. Records every requested URL.
 */
function stubSourcify(routes: Record<string, Route | Route[]>): {
  urls: string[]
} {
  const urls: string[] = []
  globalThis.fetch = ((url: string) => {
    urls.push(url)
    const address = new URL(url).pathname.split('/').at(-1) ?? ''
    const route = routes[address]
    if (!route) throw new Error(`unexpected request: ${url}`)
    const next = Array.isArray(route) ? route.shift() : route
    if (!next) throw new Error(`route exhausted: ${url}`)
    return Promise.resolve(next())
  }) as unknown as typeof globalThis.fetch
  return { urls }
}

describe('checkSourcifyVerification', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('is verified when the diamond and every facet are verified', async () => {
    const { urls } = stubSourcify({
      [DIAMOND]: () =>
        proxyOf([FACET_A, 'DiamondCutFacet'], [FACET_B, 'OwnershipFacet']),
      [FACET_A]: plain,
      [FACET_B]: plain,
    })

    const result = await checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS)

    expect(result).toEqual({ status: 'verified' })
    expect(urls[0]).toBe(
      `https://sourcify.dev/server/v2/contract/1/${DIAMOND}?fields=proxyResolution`
    )
    expect(urls).toHaveLength(3)
  })

  it('is verified for a non-proxy contract without further lookups', async () => {
    const { urls } = stubSourcify({ [DIAMOND]: plain })

    const result = await checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS)

    expect(result).toEqual({ status: 'verified' })
    expect(urls).toHaveLength(1)
  })

  it('reports the diamond itself when Sourcify does not know it', async () => {
    stubSourcify({ [DIAMOND]: notFound })

    const result = await checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS)

    expect(result).toEqual({
      status: 'unverified',
      contracts: [{ address: DIAMOND }],
    })
  })

  it('reports every unverified facet by name', async () => {
    stubSourcify({
      [DIAMOND]: () =>
        proxyOf([FACET_A, 'DiamondCutFacet'], [FACET_B, 'OwnershipFacet']),
      [FACET_A]: notFound,
      [FACET_B]: notFound,
    })

    const result = await checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS)

    expect(result).toEqual({
      status: 'unverified',
      contracts: [
        { address: FACET_A, name: 'DiamondCutFacet' },
        { address: FACET_B, name: 'OwnershipFacet' },
      ],
    })
  })

  it('follows nested proxies and checks each address once', async () => {
    const { urls } = stubSourcify({
      [DIAMOND]: () => proxyOf([FACET_A, 'A'], [FACET_A, 'A']),
      [FACET_A]: () => proxyOf([NESTED, 'Nested'], [DIAMOND, 'Loop']),
      [NESTED]: notFound,
    })

    const result = await checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS)

    expect(result).toEqual({
      status: 'unverified',
      contracts: [{ address: NESTED, name: 'Nested' }],
    })
    expect(urls).toHaveLength(3)
  })

  it('reports an unsupported chain', async () => {
    stubSourcify({
      [DIAMOND]: () =>
        json(400, { customCode: 'unsupported_chain', message: 'Chain 5031' }),
    })

    const result = await checkSourcifyVerification(5031, DIAMOND, OPTIONS)

    expect(result).toEqual({ status: 'unsupported_chain' })
  })

  it('throws on any other 400 rather than reading it as unverified', async () => {
    stubSourcify({
      [DIAMOND]: () =>
        json(400, { customCode: 'invalid_parameter', message: 'bad' }),
    })

    await expectRejects(
      checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS),
      'invalid_parameter'
    )
  })

  it('throws on a 400 whose body is not JSON', async () => {
    stubSourcify({
      [DIAMOND]: () => new Response('Bad Gateway', { status: 400 }),
    })

    await expectRejects(
      checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS),
      'no error code'
    )
  })

  it('retries a network error, then succeeds', async () => {
    const { urls } = stubSourcify({
      [DIAMOND]: [
        () => {
          throw new TypeError('fetch failed')
        },
        plain,
      ],
    })

    const result = await checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS)

    expect(result).toEqual({ status: 'verified' })
    expect(urls).toHaveLength(2)
  })

  it('throws when Sourcify cannot resolve the proxy', async () => {
    stubSourcify({
      [DIAMOND]: () =>
        json(200, {
          proxyResolution: {
            isProxy: false,
            implementations: [],
            proxyResolutionError: { message: 'RPC unavailable' },
          },
        }),
    })

    await expectRejects(
      checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS),
      'RPC unavailable'
    )
  })

  it('retries rate limiting and server errors, then succeeds', async () => {
    const { urls } = stubSourcify({
      [DIAMOND]: [() => json(429, {}), () => json(502, {}), plain],
    })

    const result = await checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS)

    expect(result).toEqual({ status: 'verified' })
    expect(urls).toHaveLength(3)
  })

  it('throws once retries are exhausted', async () => {
    stubSourcify({ [DIAMOND]: () => json(429, {}) })

    await expectRejects(
      checkSourcifyVerification(CHAIN_ID, DIAMOND, OPTIONS),
      'HTTP 429'
    )
  })
})
