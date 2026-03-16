import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from './fetchWithTimeout'

describe('fetchWithTimeout', () => {
  it('exports DEFAULT_FETCH_TIMEOUT_MS as 10_000', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(10_000)
  })

  it('returns Response for successful request', async () => {
    const res = await fetchWithTimeout(
      'https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=0xa9059cbb&filter=true'
    )
    expect(res).toBeInstanceOf(Response)
    expect(res.ok).toBe(true)
  })

  it('throws AbortError when timeout is exceeded', async () => {
    const timeoutMs = 50
    const promise = fetchWithTimeout(
      'https://httpbin.org/delay/2',
      undefined,
      timeoutMs
    )
    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
