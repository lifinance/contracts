/**
 * Centralized delay constants for consistent timing across the codebase
 *
 * Policy:
 * - INTER_CALL_DELAY: Delay between individual RPC/contract calls to avoid rate limits (500ms)
 * - INITIAL_CALL_DELAY: Delay before first call in a sequence to warm up rate limit windows (2000ms)
 * - RETRY_DELAY: Delay between retry attempts when rate limits are hit (2000ms)
 *
 * Usage:
 * - Use INTER_CALL_DELAY for delays between individual checks/calls in loops
 * - Use INITIAL_CALL_DELAY before starting a sequence of calls (especially Tron)
 * - Use RETRY_DELAY as the default for retryWithRateLimit and similar functions
 */

/**
 * Delay between individual RPC/contract calls to avoid rate limits
 * Used for: spacing out calls in loops, between consecutive checks
 */
export const INTER_CALL_DELAY = 500 // 500ms

/**
 * Delay before first call in a sequence to warm up rate limit windows
 * Used for: initial delay before starting Tron RPC calls, before batch operations
 */
export const INITIAL_CALL_DELAY = 2000 // 2s

/**
 * Delay between retry attempts when rate limits are hit
 * Used for: retryWithRateLimit, execWithRateLimitRetry default delay
 */
export const RETRY_DELAY = 2000 // 2s
