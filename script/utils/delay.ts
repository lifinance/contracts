import { INTER_CALL_DELAY } from './delayConstants'

/**
 * Sleeps for the specified duration
 * @param ms - Duration in milliseconds (default: INTER_CALL_DELAY = 500ms)
 * @returns Promise that resolves after the specified duration
 */
export function sleep(ms = INTER_CALL_DELAY): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
