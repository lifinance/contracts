/**
 * Tests for the endpoint fan-out behind the sign-time quorum check.
 *
 * The grading is `rpc-quorum.ts`'s and is covered there; these pin the part
 * that decides what the grader is given — every endpoint consulted, and a
 * failing one recorded rather than dropped.
 */
import {
  afterEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { evaluateRpcQuorum } from './rpc-quorum'
import {
  codeReadLabel,
  collectProviderObservations,
  createCodeReader,
} from './rpc-quorum-collector'

/** A real 32-byte block hash: the shape a provider actually returns. */
const BLOCK_HASH = `0x${'ab'.repeat(32)}`

const answer = (value: string) => ({
  value,
  blockNumber: 100n,
  blockHash: BLOCK_HASH,
})

/**
 * Asserts a rejection without `expect(...).rejects`, which is not a real
 * Promise and trips `@typescript-eslint/await-thenable`. Same shape as
 * `parked-tasks.test.ts`.
 */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  expect(error?.message ?? '').toMatch(match)
}

describe('collectProviderObservations', () => {
  it('consults every endpoint it is given', async () => {
    const seen: string[] = []
    const observations = await collectProviderObservations(
      ['https://a.example/rpc', 'https://b.example/rpc'],
      async (endpointUrl) => {
        seen.push(endpointUrl)
        return answer('0xcode')
      }
    )

    expect(seen).toHaveLength(2)
    expect(observations).toHaveLength(2)
    expect(observations.every((entry) => entry.outcome === 'ok')).toBe(true)
    expect(evaluateRpcQuorum(observations).reachesQuorum).toBe(true)
  })

  // A dropped endpoint would shrink the denominator, turning "one of two
  // providers failed" into "the only provider agreed".
  it('records a failing endpoint rather than dropping it', async () => {
    const observations = await collectProviderObservations(
      ['https://a.example/rpc', 'https://b.example/rpc'],
      async (endpointUrl) => {
        if (endpointUrl.includes('b.example')) throw new Error('timed out')
        return answer('0xcode')
      }
    )

    expect(observations).toHaveLength(2)
    expect(observations[1]?.outcome).toBe('error')
    expect(evaluateRpcQuorum(observations).reachesQuorum).toBe(false)
  })

  it('a single-endpoint network cannot reach quorum', async () => {
    const observations = await collectProviderObservations(
      ['https://a.example/rpc'],
      async () => answer('0xcode')
    )

    const verdict = evaluateRpcQuorum(observations)
    expect(verdict.reachesQuorum).toBe(false)
    expect(verdict.status).toBe('insufficient-providers')
  })

  it('providers disagreeing on the value do not reach quorum', async () => {
    const observations = await collectProviderObservations(
      ['https://a.example/rpc', 'https://b.example/rpc'],
      async (endpointUrl) =>
        answer(endpointUrl.includes('a.example') ? '0xcode' : '0xother')
    )

    expect(evaluateRpcQuorum(observations).reachesQuorum).toBe(false)
  })

  it('carries the block each answer describes, so answers stay comparable', async () => {
    const observations = await collectProviderObservations(
      ['https://a.example/rpc'],
      async () => answer('0xcode')
    )

    expect(observations[0]?.blockNumber).toBe(100n)
    expect(observations[0]?.blockHash).toBe(BLOCK_HASH)
  })
})

describe('createCodeReader', () => {
  const ADDRESS = '0x1111111111111111111111111111111111111111'
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /** Records what the transport actually put on the wire. */
  const recordRequests = (): {
    url: string
    authorization: string | null
  }[] => {
    const seen: { url: string; authorization: string | null }[] = []

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const headers = new Headers(init?.headers ?? {})
      seen.push({
        url: String(input),
        authorization: headers.get('authorization'),
      })

      const body = JSON.parse(String(init?.body ?? '{}')) as {
        method?: string
        id?: number
      }
      const result =
        body.method === 'eth_chainId'
          ? '0x1'
          : body.method === 'eth_getBlockByNumber'
          ? { number: '0x64', hash: BLOCK_HASH }
          : '0xcode'

      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch

    return seen
  }

  // viem's own transport lifts `user:pass@` into a header, but its branch is
  // `if (url.username)`, so a password-only endpoint keeps its credential in
  // the URL and bun's `fetch` sends it with no header: the provider answers
  // 401 and this module records that 401 as its answer.
  it('sends a password-only credential as an Authorization header', async () => {
    const seen = recordRequests()

    const observed = await createCodeReader(
      ADDRESS,
      1
    )('https://:pa%3Ass@auth.example/rpc')

    expect(observed.value).toBe('0xcode')
    expect(seen.length).toBeGreaterThan(0)
    for (const request of seen) {
      expect(request.url).toBe('https://auth.example/rpc')
      expect(request.authorization).toBe(
        `Basic ${Buffer.from(':pa:ss', 'utf8').toString('base64')}`
      )
    }
  })

  // The timeout bounds one attempt, so an endpoint's own retry profile is what
  // decides how long the fan-out can hold the signer.
  it('caps the retry budget rather than inheriting the endpoint profile', async () => {
    let attempts = 0
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ): Promise<Response> => {
      attempts += 1
      const throttled = new Error('HTTP request failed: 429')
      throttled.name = 'HttpRequestError'
      throw throttled
    }) as typeof fetch

    await expectRejects(
      createCodeReader(ADDRESS, 1)('https://throttled.example/rpc'),
      /429/
    )

    // One attempt plus one retry. TronGrid's own profile would be nine.
    expect(attempts).toBe(2)
  })

  it('leaves a credential-free endpoint unauthenticated', async () => {
    const seen = recordRequests()

    await createCodeReader(ADDRESS, 1)('https://plain.example/rpc')

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((request) => request.authorization === null)).toBe(true)
  })

  // Recorded as that endpoint's `error` observation by the collector, which is
  // what keeps it in the denominator instead of silently shrinking it.
  it('refuses to carry credentials over cleartext http', async () => {
    recordRequests()

    await expectRejects(
      createCodeReader(ADDRESS, 1)('http://user:pass@auth.example/rpc'),
      /credentials over http/i
    )
  })

  it('records the cleartext refusal as an error observation', async () => {
    recordRequests()

    const observations = await collectProviderObservations(
      ['https://plain.example/rpc', 'http://user:pass@auth.example/rpc'],
      createCodeReader(ADDRESS, 1)
    )

    expect(observations).toHaveLength(2)
    expect(observations[0]?.outcome).toBe('ok')
    expect(observations[1]?.outcome).toBe('error')
  })
})

describe('codeReadLabel', () => {
  it('names what was read and where, for the operator line', () => {
    const label = codeReadLabel(
      '0x1111111111111111111111111111111111111111',
      'arbitrum'
    )

    expect(label).toContain('0x1111111111111111111111111111111111111111')
    expect(label).toContain('arbitrum')
  })
})
