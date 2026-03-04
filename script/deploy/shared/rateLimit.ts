/**
 * Shared rate-limit and retry utilities for both Tron and EVM.
 * Used by health check, Tron deploy scripts, and any RPC-heavy flows.
 */

import { sleep } from '../../utils/delay'

import { MAX_RETRIES, RETRY_DELAY } from './constants'

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
 * Generic retry function with rate limit handling
 * @param operation - Async function to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param retryDelay - Delay in ms for all retry attempts (default: RETRY_DELAY). Can be a number or array for backward compatibility
 * @param onRetry - Optional callback called before each retry
 * @param includeConnectionErrors - Whether to include connection errors in rate limit detection (default: true)
 * @returns Result of the operation
 * @throws The last error if all retries fail
 */
export async function retryWithRateLimit<T>(
  operation: () => Promise<T>,
  maxRetries = MAX_RETRIES,
  retryDelay: number | number[] = RETRY_DELAY,
  onRetry?: (attempt: number, delay: number) => void,
  includeConnectionErrors = true
): Promise<T> {
  const retryDelays: number[] = Array.isArray(retryDelay)
    ? retryDelay
    : Array(maxRetries).fill(retryDelay)

  for (let retry = 0; retry <= maxRetries; retry++) {
    try {
      if (retry > 0) {
        const delay: number =
          retryDelays[retry - 1] ??
          retryDelays[retryDelays.length - 1] ??
          RETRY_DELAY
        if (onRetry) {
          onRetry(retry, delay)
        }
        await sleep(delay)
      }

      return await operation()
    } catch (error: unknown) {
      const isRateLimit = isRateLimitError(error, includeConnectionErrors)

      if (isRateLimit && retry < maxRetries) {
        continue
      }

      throw error
    }
  }

  throw new Error('Max retries exceeded')
}
