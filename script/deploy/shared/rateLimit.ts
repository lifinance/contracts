/**
 * Shared rate-limit and retry utilities for both Tron and EVM.
 * Used by health check, Tron deploy scripts, and any RPC-heavy flows.
 * Call sites implement their own retry loop using getRetryDelays and isRateLimitError
 * (no functions passed as parameters per project convention).
 */

import { RETRY_DELAY } from './constants'

export { MAX_RETRIES, RETRY_DELAY } from './constants'

/**
 * Check if an error is a rate limit or connection error
 * @param error - The error to check
 * @param includeConnectionErrors - Whether to include connection errors (ECONNREFUSED, ETIMEDOUT)
 * @returns True if the error is a rate limit or connection error
 */
export function isRateLimitError(
  error: unknown,
  includeConnectionErrors = true
): boolean {
  const errorMessage =
    error instanceof Error ? error.message : String(error)
  const rateLimitPatterns = ['429', 'rate limit', 'Too Many Requests']

  if (includeConnectionErrors) {
    rateLimitPatterns.push('ECONNREFUSED', 'ETIMEDOUT')
  }

  return rateLimitPatterns.some((pattern) =>
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  )
}

/**
 * Build delay array for retry attempts (one delay before each retry, indexed by attempt).
 * Used by call sites that implement their own retry loop without passing functions.
 * @param maxRetries - Maximum number of retries
 * @param retryDelay - Delay in ms (number or array for per-attempt delays)
 * @returns Array of delays; length is maxRetries, use index [retry - 1] before attempt retry
 */
export function getRetryDelays(
  maxRetries: number,
  retryDelay: number | number[] = RETRY_DELAY
): number[] {
  return Array.isArray(retryDelay)
    ? retryDelay
    : Array(maxRetries).fill(retryDelay)
}
