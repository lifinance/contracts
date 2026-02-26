/**
 * Shared rate-limit utilities for both Tron and EVM.
 * Used by health check, Tron deploy scripts, and any RPC-heavy flows.
 */

/**
 * Check if an error is a rate limit error (429, rate limit, Too Many Requests).
 * @param error - The error to check
 * @returns True if the error is a rate limit error 
 */
export function isRateLimitError(error: unknown): boolean {
  const errorMessage =
    error instanceof Error ? error.message : String(error)
  const patterns = ['429', 'rate limit', 'Too Many Requests']
  return patterns.some((pattern) =>
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  )
}
