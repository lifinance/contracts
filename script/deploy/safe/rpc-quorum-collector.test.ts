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
  ENDPOINT_READ_BUDGET_MS,
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
  // decides how long the fan-out can hold the signer. A real 429 response
  // rather than a thrown error, so this drives viem's retry path rather than
  // its transport-failure path — the two have different budgets.
  it('caps the retry budget rather than inheriting the endpoint profile', async () => {
    let attempts = 0
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ): Promise<Response> => {
      attempts += 1
      return new Response('rate limited', {
        status: 429,
        headers: { 'Content-Type': 'text/plain' },
      })
    }) as typeof fetch

    const started = Date.now()
    await expectRejects(
      createCodeReader(ADDRESS, 1)('https://throttled.example/rpc'),
      /429/
    )

    // One attempt plus one retry. viem's default is 3, TronGrid's profile 8.
    expect(attempts).toBe(2)
    // The retry is spaced to outlast the window that produced the 429, not
    // viem's 150ms default — a retry that fast is decorative against a limiter.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500)
  })

  // The budget is the read's, not each round trip's. This reader makes three —
  // `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode` — and a per-attempt
  // timeout bounds each of them separately, so the three multiply and the retry
  // profile multiplies again. Asserted on the signal's identity rather than on
  // elapsed wall clock: a 20s test is not a test, and viem mints a fresh signal
  // per attempt the moment the budget goes back to being `timeout` alone.
  it('bounds the whole read on one signal, not each round trip', async () => {
    const signals: (AbortSignal | null | undefined)[] = []

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      signals.push(init?.signal)

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

    await createCodeReader(ADDRESS, 1)('https://plain.example/rpc')

    // Three round trips, and the same budget across all of them.
    expect(signals).toHaveLength(3)
    const [first, second, third] = signals
    expect(first).toBeInstanceOf(AbortSignal)
    expect(second).toBe(first ?? null)
    expect(third).toBe(first ?? null)
  })

  // The half of the budget that makes it a bound at all: viem's `shouldRetry`
  // returns false for an `AbortError`, so an endpoint that overruns fails
  // immediately instead of retrying past the budget it just exhausted.
  //
  // The abort is raised here rather than waited for — a 20s test is not a test.
  // Both names are driven, because `AbortSignal.timeout` raises the one viem
  // retries and the difference is invisible in a passing read.
  it.each([
    ['AbortError', 1],
    ['TimeoutError', 2],
  ])('a %s abort costs %i attempt(s)', async (name, expected) => {
    let attempts = 0

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ): Promise<Response> => {
      attempts += 1
      throw new DOMException('The operation was aborted.', String(name))
    }) as typeof fetch

    await expectRejects(
      createCodeReader(ADDRESS, 1)('https://slow.example/rpc'),
      /abort/i
    )

    expect(attempts).toBe(expected)
  })

  // The budget driven for real against an endpoint that never answers, on a
  // lowered budget because a 20s test is not a test. This is the row that ties
  // the pair above to this file: `AbortSignal.timeout` names its abort
  // `TimeoutError`, and the read would then cost the second attempt.
  it('ends an unanswered read at its budget, without a retry', async () => {
    let attempts = 0

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      attempts += 1
      // Never answers. Rejects only when the read's own budget aborts it,
      // which is the thing under test.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason)
        )
      })
    }) as typeof fetch

    const started = Date.now()
    await expectRejects(
      createCodeReader(ADDRESS, 1, 50)('https://silent.example/rpc'),
      /no answer within 50ms/
    )

    expect(attempts).toBe(1)
    // Bounded by the budget, not by three round trips each carrying it, and
    // not by the retry delay on top.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  // Pinned by value, not by the symbol. Every other test in this file passes
  // an explicit budget, so the default the fan-out actually runs on is observed
  // nowhere else: it could be raised to ten minutes with the file green.
  it('bounds an endpoint read at twenty seconds by default', () => {
    expect(ENDPOINT_READ_BUDGET_MS).toBe(20_000)
  })

  // The budget is a bound the endpoint cannot extend. viem honours a
  // `Retry-After` header verbatim and its retry wait is only interruptible by
  // the signal `buildRequest` gets — which `createTransport` never supplies —
  // so a transport-level retry lets a throttled endpoint name how long the
  // signer waits. `collectProviderObservations` is a `Promise.all`, so one
  // endpoint answering `Retry-After: 600` would hold the whole fan-out.
  it('does not let a Retry-After header extend the budget', async () => {
    let attempts = 0

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ): Promise<Response> => {
      attempts += 1
      return new Response('rate limited', {
        status: 429,
        headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' },
      })
    }) as typeof fetch

    const started = Date.now()
    await expectRejects(
      // Below ENDPOINT_RETRY_DELAY_MS, so the retry is refused rather than
      // started: the deadline cannot absorb the wait.
      createCodeReader(ADDRESS, 1, 200)('https://throttled.example/rpc'),
      /429/
    )
    const elapsed = Date.now() - started

    expect(attempts).toBe(1)
    // Not 30s. The header is the endpoint's request, not this read's budget.
    expect(elapsed).toBeLessThan(5_000)
  })

  // The other side of the same rule: with room in the budget the retry is
  // taken, so the guard above is a deadline check and not a disabled retry.
  it('still retries a 429 when the budget can absorb the wait', async () => {
    let attempts = 0

    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ): Promise<Response> => {
      attempts += 1
      return new Response('rate limited', {
        status: 429,
        headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' },
      })
    }) as typeof fetch

    const started = Date.now()
    await expectRejects(
      createCodeReader(ADDRESS, 1, 30_000)('https://throttled.example/rpc'),
      /429/
    )
    const elapsed = Date.now() - started

    expect(attempts).toBe(2)
    // The module's own spacing, not the 30s the endpoint asked for.
    expect(elapsed).toBeGreaterThanOrEqual(1_500)
    expect(elapsed).toBeLessThan(10_000)
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
