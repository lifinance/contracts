/**
 * Shared rate-limit utilities for both Tron and EVM.
 * Used by health check, Tron deploy scripts, and any RPC-heavy flows.
 */

import { sleep } from '../../utils/delay'

/**
 * Check if an error is a rate limit error (429, rate limit, Too Many Requests).
 * @param error - The error to check
 * @returns True if the error is a rate limit error
 */
export function isRateLimitError(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const patterns = ['429', 'rate limit', 'Too Many Requests']
  return patterns.some((pattern) =>
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  )
}

/**
 * Invokes an async function, retrying only on rate-limit–style errors.
 * @param fn - Async work to run
 * @param maxAttempts - Total attempts (must be >= 1)
 * @param retryDelayMs - Wait between retries (passed to {@link onRetry} as second argument)
 * @param onRetry - Optional hook before sleeping (1-based attempt index, delay ms)
 */
export async function retryWithRateLimit<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  retryDelayMs: number,
  onRetry?: (attempt: number, delayMs: number) => void
): Promise<T> {
  if (maxAttempts < 1)
    throw new Error('retryWithRateLimit: maxAttempts must be at least 1')

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error: unknown) {
      const canRetry = isRateLimitError(error) && attempt < maxAttempts
      if (!canRetry) throw error
      onRetry?.(attempt, retryDelayMs)
      await sleep(retryDelayMs)
    }
  }

  // Unreachable: loop returns or throws
  throw new Error('retryWithRateLimit: exhausted attempts')
}
