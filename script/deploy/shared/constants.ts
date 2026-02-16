/**
 * Shared project-level constants
 * These constants are not network-specific and apply across the entire project
 */

/**
 * Minimum number of signatures required for Safe multisig transactions
 * This threshold ensures adequate security for critical operations
 */
export const SAFE_THRESHOLD = 3
export const CONFIRMATION_TIMEOUT = 120000 // 2 minutes
export const MAX_RETRIES = 3
export const POLL_INTERVAL = 3000 // 3 seconds

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
 * - Use INITIAL_CALL_DELAY before starting a sequence of calls
 * - Use RETRY_DELAY as the default for retryWithRateLimit and similar functions
 */

/**
 * Delay between individual RPC/contract calls to avoid rate limits
 * Used for: spacing out calls in loops, between consecutive checks
 */
export const INTER_CALL_DELAY = 500 // 500ms

/**
 * Delay before first call in a sequence to warm up rate limit windows
 * Used for: initial delay before starting RPC calls, before batch operations
 */
export const INITIAL_CALL_DELAY = 2000 // 2s

/**
 * Delay between retry attempts when rate limits are hit
 * Used for: retryWithRateLimit, execWithRateLimitRetry default delay
 */
export const RETRY_DELAY = 2000 // 2s

// File paths
export const DEPLOYMENT_FILE_SUFFIX = (environment: string) =>
  environment === 'production' ? '' : 'staging.'

// Common EVM address
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
