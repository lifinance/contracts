import { consola } from 'consola'
import type { Address, Hex } from 'viem'
import { formatEther } from 'viem'

import networksConfig from '../../config/networks.json'
import type { SupportedChain } from '../common/types'

interface ISlackMessage {
  text: string
  blocks?: Record<string, unknown>[]
  attachments?: Record<string, unknown>[]
}

interface IOperationDetails {
  id: Hex
  target: Address
  value: bigint
  data: Hex
  functionName?: string | null
}

interface INotificationContext {
  network: string
  operation: IOperationDetails
  status: 'success' | 'failed' | 'pending' | 'cancelled'
  error?: unknown
  transactionHash?: string
  gasUsed?: bigint
  timestamp?: Date
}

interface INetworkResult {
  network: string
  success: boolean
  operationsProcessed?: number
  operationsFailed?: number
  operationsSucceeded?: number
  operationsRejected?: number
  operationsSkipped?: number
  error?: unknown
}

interface IProcessingStats {
  operationsProcessed: number
  operationsSucceeded?: number
  operationsFailed?: number
  totalGasUsed?: bigint
  duration?: number
}

export class SlackNotifier {
  private webhookUrl: string
  private startTime: Date

  public constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl
    this.startTime = new Date()
  }

  /**
   * Send a raw Slack message with timeout handling
   */
  public async sendNotification(message: ISlackMessage): Promise<void> {
    // Create an AbortController for timeout handling
    const controller = new AbortController()
    const timeoutMs = 10000 // 10 seconds timeout

    // Set up timeout to abort the request
    const timeoutId = setTimeout(() => {
      controller.abort()
    }, timeoutMs)

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
        signal: controller.signal, // Pass the abort signal to fetch
      })

      // Clear the timeout on successful fetch
      clearTimeout(timeoutId)

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Slack API error: ${response.status} - ${text}`)
      }
    } catch (error) {
      // Clear the timeout in error cases
      clearTimeout(timeoutId)

      // Check if error is due to abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        consola.warn(
          `Slack notification timed out after ${timeoutMs / 1000} seconds`
        )
        throw new Error(
          `Slack webhook request timed out after ${timeoutMs / 1000} seconds`
        )
      }

      // Log other errors
      consola.warn('Failed to send Slack notification:', error)
      throw error
    }
  }

  /**
   * Send notification with retry logic
   */
  public async sendNotificationWithRetry(
    message: ISlackMessage,
    maxRetries = 3
  ): Promise<void> {
    for (let i = 0; i < maxRetries; i++)
      try {
        await this.sendNotification(message)
        return
      } catch (error) {
        if (i === maxRetries - 1)
          consola.warn(
            'Failed to send Slack notification after retries:',
            error
          )
        else await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)))
      }
  }

  /**
   * Notify when batch processing starts
   */
  public async notifyBatchStart(networks: string[]): Promise<void> {
    const message: ISlackMessage = {
      text: '🚀 Timelock batch execution started',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🚀 Timelock Batch Execution Started',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Networks to process:* ${
              networks.length
            }\n*Networks:* ${networks.join(
              ', '
            )}\n*Start time:* ${this.startTime.toISOString()}`,
          },
        },
      ],
    }

    await this.sendNotificationWithRetry(message)
  }

  /**
   * Notify when an operation is successfully executed
   */
  public async notifyOperationExecuted(
    context: INotificationContext
  ): Promise<void> {
    const explorerUrl = this.getExplorerUrl(
      context.network,
      context.transactionHash
    )

    const message: ISlackMessage = {
      text: `✅ Timelock operation executed successfully on ${context.network}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '✅ Timelock Operation Executed',
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Network:*\n${context.network}`,
            },
            {
              type: 'mrkdwn',
              text: `*Operation ID:*\n\`${this.truncateHash(
                context.operation.id
              )}\``,
            },
            {
              type: 'mrkdwn',
              text: `*Target:*\n\`${this.truncateAddress(
                context.operation.target
              )}\``,
            },
            {
              type: 'mrkdwn',
              text: `*Function:*\n${
                context.operation.functionName || 'Unknown'
              }`,
            },
            {
              type: 'mrkdwn',
              text: `*Value:*\n${formatEther(context.operation.value)} ETH`,
            },
          ],
        },
      ],
    }

    if (context.gasUsed && message.blocks?.[1]) {
      const section = message.blocks[1] as Record<string, unknown>
      const fields = section.fields as Record<string, unknown>[]
      fields.push({
        type: 'mrkdwn',
        text: `*Gas Used:*\n${context.gasUsed.toLocaleString()}`,
      })
    }

    if (context.transactionHash && explorerUrl && message.blocks)
      message.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Transaction:* <${explorerUrl}|View on Explorer>`,
        },
      })
    else if (context.transactionHash && message.blocks)
      message.blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Transaction Hash:* \`${context.transactionHash}\``,
        },
      })

    await this.sendNotificationWithRetry(message)
  }

  /**
   * Notify when an operation fails
   */
  public async notifyOperationFailed(
    context: INotificationContext
  ): Promise<void> {
    const errorMessage = this.extractErrorMessage(context.error)

    const message: ISlackMessage = {
      text: `❌ Timelock operation failed on ${context.network}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '❌ Timelock Operation Failed',
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Network:*\n${context.network}`,
            },
            {
              type: 'mrkdwn',
              text: `*Operation ID:*\n\`${this.truncateHash(
                context.operation.id
              )}\``,
            },
            {
              type: 'mrkdwn',
              text: `*Target:*\n\`${this.truncateAddress(
                context.operation.target
              )}\``,
            },
            {
              type: 'mrkdwn',
              text: `*Function:*\n${
                context.operation.functionName || 'Unknown'
              }`,
            },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Error:*\n\`\`\`${errorMessage}\`\`\``,
          },
        },
      ],
    }

    await this.sendNotificationWithRetry(message)
  }

  /**
   * Notify when processing for a network is complete
   */
  public async notifyNetworkProcessingComplete(
    network: string,
    stats: IProcessingStats
  ): Promise<void> {
    const statusEmoji = stats.operationsFailed ? '⚠️' : '✅'
    const statusText = stats.operationsFailed
      ? 'completed with errors'
      : 'completed successfully'

    const message: ISlackMessage = {
      text: `${statusEmoji} Network ${network} processing ${statusText}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${statusEmoji} *${network}* processing ${statusText}`,
          },
          fields: [
            {
              type: 'mrkdwn',
              text: `*Operations Processed:*\n${stats.operationsProcessed}`,
            },
          ],
        },
      ],
    }

    if (stats.operationsSucceeded !== undefined && message.blocks?.[0]) {
      const section = message.blocks[0] as Record<string, unknown>
      const fields = section.fields as Record<string, unknown>[]
      fields.push({
        type: 'mrkdwn',
        text: `*Succeeded:*\n${stats.operationsSucceeded}`,
      })
    }

    if (stats.operationsFailed && message.blocks?.[0]) {
      const section = message.blocks[0] as Record<string, unknown>
      const fields = section.fields as Record<string, unknown>[]
      fields.push({
        type: 'mrkdwn',
        text: `*Failed:*\n${stats.operationsFailed}`,
      })
    }

    if (stats.totalGasUsed && message.blocks?.[0]) {
      const section = message.blocks[0] as Record<string, unknown>
      const fields = section.fields as Record<string, unknown>[]
      fields.push({
        type: 'mrkdwn',
        text: `*Total Gas Used:*\n${stats.totalGasUsed.toLocaleString()}`,
      })
    }

    await this.sendNotificationWithRetry(message)
  }

  /**
   * Notify batch execution summary
   */
  public async notifyBatchSummary(results: INetworkResult[]): Promise<void> {
    const endTime = new Date()
    const duration = Math.floor(
      (endTime.getTime() - this.startTime.getTime()) / 1000
    )
    const durationFormatted = this.formatDuration(duration)

    const successfulNetworks = results.filter((r) => r.success)
    const failedNetworks = results.filter((r) => !r.success)
    const totalOperations = results.reduce(
      (sum, r) => sum + (r.operationsProcessed || 0),
      0
    )

    const statusEmoji = failedNetworks.length > 0 ? '⚠️' : '✅'
    const statusText =
      failedNetworks.length > 0
        ? 'completed with some failures'
        : 'completed successfully'

    const message: ISlackMessage = {
      text: `📊 Timelock batch execution ${statusText}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '📊 Batch Execution Summary',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${statusEmoji} Batch execution ${statusText}`,
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Duration:*\n${durationFormatted}`,
            },
            {
              type: 'mrkdwn',
              text: `*Networks Processed:*\n${results.length}`,
            },
            {
              type: 'mrkdwn',
              text: `*Total Operations:*\n${totalOperations}`,
            },
          ],
        },
        {
          type: 'divider',
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*✅ Successful:*\n${successfulNetworks.length} networks`,
            },
            {
              type: 'mrkdwn',
              text: `*❌ Failed:*\n${failedNetworks.length} networks`,
            },
          ],
        },
      ],
    }

    // Add details about successful networks with operations
    const networksWithOps = successfulNetworks.filter(
      (r) => r.operationsProcessed && r.operationsProcessed > 0
    )
    if (networksWithOps.length > 0) {
      const successDetails = networksWithOps
        .map((r) => `• ${r.network}: ${r.operationsProcessed} operations`)
        .join('\n')

      if (message.blocks)
        message.blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Successful Operations:*\n${successDetails}`,
          },
        })
    }

    // Add failed network details
    if (failedNetworks.length > 0) {
      const failureDetails = failedNetworks
        .map((r) => {
          const errorMsg = this.extractErrorMessage(r.error)
          return `• ${r.network}: ${errorMsg}`
        })
        .join('\n')

      if (message.blocks)
        message.blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Failed Networks:*\n${failureDetails}`,
          },
        })
    }

    await this.sendNotificationWithRetry(message)
  }

  /**
   * Notify when no operations are found for a network
   */
  public async notifyNoOperations(
    network: string,
    reason: 'no-pending' | 'no-ready' | 'no-timelock',
    pendingCount?: number
  ): Promise<void> {
    let text = ''
    switch (reason) {
      case 'no-pending':
        text = `✅ ${network}: No pending operations found`
        break
      case 'no-ready':
        text = `⏰ ${network}: ${pendingCount} pending operations, none ready for execution`
        break
      case 'no-timelock':
        text = `⚠️ ${network}: No timelock controller deployed`
        break
      default:
        text = `${network}: Unknown status`
        break
    }

    const message: ISlackMessage = {
      text,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text,
          },
        },
      ],
    }

    await this.sendNotificationWithRetry(message)
  }

  /**
   * Helper to get explorer URL for a transaction
   * Dynamically pulls explorer URL from networks.json configuration
   */
  private getExplorerUrl(network: string, txHash?: string): string | undefined {
    if (!txHash) return undefined

    // Try to find the network in the config (case-insensitive)
    const networkKey = Object.keys(networksConfig).find(
      (key) => key.toLowerCase() === network.toLowerCase()
    ) as SupportedChain | undefined

    if (!networkKey) {
      consola.debug(`Network ${network} not found in networks.json`)
      return undefined
    }

    const networkConfig = networksConfig[networkKey]
    if (!networkConfig.explorerUrl) {
      consola.debug(`No explorer URL configured for ${network}`)
      return undefined
    }

    // Construct the transaction URL based on the explorer type
    const baseUrl = networkConfig.explorerUrl.replace(/\/$/, '') // Remove trailing slash if present

    // Different explorers have different URL patterns
    // Most use /tx/ but some might use different patterns
    if (networkConfig.verificationType === 'oklink')
      // OKLink explorers use a different pattern
      return `${baseUrl}/tx/${txHash}`
    else if (networkConfig.verificationType === 'blockscout')
      // Blockscout explorers typically use /tx/
      return `${baseUrl}/tx/${txHash}`
    else if (networkConfig.verificationType === 'tronscan')
      // Tronscan uses a different pattern
      return `${baseUrl}/#/transaction/${txHash}`
    else if (networkConfig.verificationType === 'vicscan')
      // Vicscan might use a different pattern
      return `${baseUrl}/tx/${txHash}`
    // Default pattern for Etherscan and most other explorers
    else return `${baseUrl}/tx/${txHash}`
  }

  /**
   * Helper to truncate hash for display
   */
  private truncateHash(hash: string): string {
    if (hash.length <= 10) return hash
    return `${hash.slice(0, 6)}...${hash.slice(-4)}`
  }

  /**
   * Helper to truncate address for display
   */
  private truncateAddress(address: string): string {
    if (address.length <= 10) return address
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }

  /**
   * Helper to extract error message from various error types
   */
  private extractErrorMessage(error: unknown): string {
    if (!error) return 'Unknown error'

    if (typeof error === 'string') return error

    const errorObj = error as Record<string, unknown>

    if (errorObj.message && typeof errorObj.message === 'string')
      return errorObj.message

    if (errorObj.reason && typeof errorObj.reason === 'string')
      return errorObj.reason

    if (errorObj.shortMessage && typeof errorObj.shortMessage === 'string')
      return errorObj.shortMessage

    if (errorObj.details && typeof errorObj.details === 'string')
      return errorObj.details

    return JSON.stringify(error).slice(0, 500)
  }

  /**
   * Helper to format duration in human-readable format
   */
  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    const parts = []
    if (hours > 0) parts.push(`${hours}h`)
    if (minutes > 0) parts.push(`${minutes}m`)
    parts.push(`${secs}s`)

    return parts.join(' ')
  }
}

export type {
  ISlackMessage,
  INotificationContext,
  INetworkResult,
  IProcessingStats,
}
