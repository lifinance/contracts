/**
 * Event Scanner Utility
 *
 * A generic utility for scanning blockchain events with robust error handling and retry logic.
 * This utility is designed to handle various network conditions and RPC limitations when
 * fetching blockchain events.
 *
 * Key Features:
 * - Generic event type support for any blockchain event
 * - Configurable chunk sizes to handle RPC limitations
 * - Smart retry mechanism with different backoff strategies:
 *   - Exponential backoff for rate limits
 *   - Linear backoff for timeouts and RPC errors
 * - Detailed error categorization and handling
 * - Progress tracking and comprehensive statistics
 * - Timeout protection for unresponsive RPCs
 *
 * Usage Example:
 * ```typescript
 * const result = await scanEventsInChunks({
 *   publicClient,
 *   address,
 *   event: {
 *     type: 'event',
 *     name: 'Transfer',
 *     inputs: [
 *       { indexed: true, name: 'from', type: 'address' },
 *       { indexed: true, name: 'to', type: 'address' },
 *       { indexed: false, name: 'value', type: 'uint256' }
 *     ]
 *   },
 *   fromBlock,
 *   toBlock,
 *   networkName: 'ethereum',
 *   chunkSize: 10000n
 * })
 * ```
 */

import { consola } from 'consola'
import { type Address, type PublicClient } from 'viem'

export interface IEventScannerConfig {
  publicClient: PublicClient
  address: Address
  event: {
    type: 'event'
    name: string
    inputs: Array<{
      indexed?: boolean
      name: string
      type: string
    }>
  }
  fromBlock: bigint
  toBlock: bigint
  networkName: string
  chunkSize: bigint
  // Optional configuration parameters
  maxRetries?: number
  baseRetryDelay?: number // in milliseconds
  timeoutMs?: number // in milliseconds
}

export interface IEventScanResult<T> {
  events: T[]
  scanStats: {
    totalBlocks: bigint
    processedBlocks: bigint
    duration: number
    startTime: number
    endTime: number
  }
}

export async function scanEventsInChunks<T>(
  config: IEventScannerConfig
): Promise<IEventScanResult<T>> {
  const {
    publicClient,
    address,
    event,
    fromBlock,
    toBlock,
    networkName,
    chunkSize,
    maxRetries = 10,
    baseRetryDelay = 5000,
    timeoutMs = 60000,
  } = config

  const startTime = Date.now()
  const events: T[] = []
  let currentFromBlock = fromBlock
  const totalBlocks = toBlock - fromBlock + 1n
  let processedBlocks = 0n

  consola.info(
    `🔍 [${networkName}] Total blocks to scan: ${totalBlocks.toString()}`
  )
  consola.info(
    `🔧 [${networkName}] Using chunk size: ${chunkSize.toString()} blocks`
  )

  while (currentFromBlock <= toBlock) {
    const currentToBlock =
      currentFromBlock + chunkSize - 1n > toBlock
        ? toBlock
        : currentFromBlock + chunkSize - 1n

    const progress = Math.min(
      100,
      Number((processedBlocks * 100n) / totalBlocks)
    )
    consola.info(
      `   [${networkName}] [${progress.toFixed(
        0
      )}%] Fetching events from block ${currentFromBlock} to ${currentToBlock}`
    )

    let retryCount = 0
    let success = false

    while (!success && retryCount <= maxRetries) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)

        const chunkEvents = await publicClient
          .getLogs({
            address,
            event,
            fromBlock: currentFromBlock,
            toBlock: currentToBlock,
          })
          .finally(() => clearTimeout(timeout))

        const blocksCovered = currentToBlock - currentFromBlock + 1n
        processedBlocks += blocksCovered
        events.push(...(chunkEvents as T[]))
        consola.info(
          `   [${networkName}] Found ${chunkEvents.length} events in this chunk`
        )
        success = true
      } catch (error: any) {
        retryCount++

        const errorMessage = error.message?.toLowerCase() || ''
        const errorType = categorizeError(error, errorMessage)

        if (retryCount > maxRetries) {
          consola.error(
            `❌ [${networkName}] Error fetching chunk ${currentFromBlock}-${currentToBlock} after ${maxRetries} retries:`,
            error
          )
          throw error
        }

        const waitTime = calculateRetryDelay(
          errorType,
          retryCount,
          baseRetryDelay
        )

        consola.warn(
          `⚠️  [${networkName}] ${errorType} fetching chunk ${currentFromBlock}-${currentToBlock}, retry ${retryCount}/${maxRetries} in ${
            waitTime / 1000
          }s...`
        )
        await new Promise((resolve) => setTimeout(resolve, waitTime))
      }
    }

    currentFromBlock = currentToBlock + 1n
  }

  const endTime = Date.now()
  const duration = (endTime - startTime) / 1000

  consola.success(
    `✅ [${networkName}] Completed scanning ${totalBlocks.toString()} blocks, found ${
      events.length
    } total events (took ${duration.toFixed(2)}s)`
  )

  console.log('return')
  console.log({
    events,
    scanStats: {
      totalBlocks,
      processedBlocks,
      duration,
      startTime,
      endTime,
    },
  })

  return {
    events,
    scanStats: {
      totalBlocks,
      processedBlocks,
      duration,
      startTime,
      endTime,
    },
  }
}

// Helper functions for error handling
function categorizeError(error: any, errorMessage: string): string {
  if (
    error.name === 'AbortError' ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('network error') ||
    errorMessage.includes('request timed out') ||
    errorMessage.includes('took too long')
  ) {
    return 'Timeout'
  }

  if (
    error.status === 429 ||
    errorMessage.includes('too many requests') ||
    errorMessage.includes('rate limit')
  ) {
    return 'Rate Limited'
  }

  if (
    errorMessage.includes('block range') ||
    errorMessage.includes('too many blocks') ||
    errorMessage.includes('maximum') ||
    errorMessage.includes('exceeded')
  ) {
    return 'Block Range Error'
  }

  if (
    error.status >= 500 ||
    errorMessage.includes('internal error') ||
    errorMessage.includes('service unavailable') ||
    errorMessage.includes('bad gateway')
  ) {
    return 'RPC Error'
  }

  return 'Network Error'
}

function calculateRetryDelay(
  errorType: string,
  retryCount: number,
  baseDelay: number
): number {
  let waitTime = baseDelay

  switch (errorType) {
    case 'Rate Limited':
      // Exponential backoff for rate limits
      waitTime = baseDelay * Math.pow(2, retryCount)
      break
    case 'Timeout':
    case 'RPC Error':
      // Linear increase for timeouts/RPC errors
      waitTime = baseDelay * (retryCount + 1)
      break
    case 'Block Range Error':
      throw new Error('Block range error - consider reducing chunk size')
    default:
      // Linear increase for unknown errors
      waitTime = baseDelay * (retryCount + 1)
  }

  // Cap maximum wait time at 60 seconds
  return Math.min(waitTime, 60000)
}
