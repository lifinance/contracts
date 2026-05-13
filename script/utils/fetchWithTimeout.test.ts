import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from './fetchWithTimeout'

const originalFetch = globalThis.fetch

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    // Restore before each test so we can set a fresh mock
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('exports DEFAULT_FETCH_TIMEOUT_MS as 10_000', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(10_000)
  })

  it('returns Response for successful request', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('', { status: 200 })
      )) as unknown as typeof globalThis.fetch
    const res = await fetchWithTimeout('https://example.com/api')
    expect(res).toBeInstanceOf(Response)
    expect(res.ok).toBe(true)
  })

  it('throws AbortError when timeout is exceeded', async () => {
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        signal?.addEventListener?.('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })) as unknown as typeof globalThis.fetch
    const timeoutMs = 10
    const promise = fetchWithTimeout(
      'https://example.com/slow',
      undefined,
      timeoutMs
    )
    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
