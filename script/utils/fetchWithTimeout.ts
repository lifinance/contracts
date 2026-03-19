/**
 * Default timeout in ms for external API fetch calls (10 seconds).
 * Use this constant when calling fetchWithTimeout with the default timeout.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000

/**
 * Performs fetch with a timeout using AbortController.
 * The timeout is cleared in a finally block so the timer is always released.
 *
 * Use this for all outbound HTTP requests to external APIs (e.g. 4byte, relay, explorer)
 * so that slow or hung requests do not block scripts indefinitely.
 *
 * @param url - Request URL
 * @param init - Optional RequestInit (method, headers, body). signal is overridden by the timeout controller.
 * @param timeoutMs - Timeout in milliseconds; defaults to DEFAULT_FETCH_TIMEOUT_MS (10s)
 * @returns Promise that resolves to Response, or rejects on timeout (AbortError) or network error
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}
