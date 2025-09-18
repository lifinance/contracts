#!/usr/bin/env bun

/**
 * Execute Pending Timelock Transactions
 *
 * This script executes pending transactions in the LiFiTimelockController where the timelock period has passed.
 * It uses viem to interact with the blockchain and citty for command line argument parsing.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { type ObjectId } from 'mongodb'
import type { Address, Hex, PublicClient, WalletClient } from 'viem'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  keccak256,
  parseAbi,
} from 'viem'

import data from '../../../config/networks.json'
import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { setupEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import { getDeployments } from '../../utils/deploymentHelpers'
import {
  SlackNotifier,
  type INetworkResult,
  type IProcessingStats,
} from '../../utils/slack-notifier'

import { getSafeMongoCollection, type ISafeTxDocument } from './safe-utils'

// Define interfaces for network configuration
interface INetworkConfig {
  name: string
  chainId: number
  safeAddress?: string
  rpcUrl: string
  status: string
}

interface IDeploymentData {
  LiFiDiamond?: string
  LiFiTimelockController?: string
  [key: string]: string | undefined
}

// TimelockController ABI for the functions we need
const TIMELOCK_ABI = parseAbi([
  'function getMinDelay() view returns (uint256)',
  'function getTimestamp(bytes32 id) view returns (uint256)',
  'function isOperation(bytes32 id) view returns (bool)',
  'function isOperationPending(bytes32 id) view returns (bool)',
  'function isOperationReady(bytes32 id) view returns (bool)',
  'function isOperationDone(bytes32 id) view returns (bool)',
  'function execute(address target, uint256 value, bytes calldata payload, bytes32 predecessor, bytes32 salt) payable returns (bytes)',
  'function cancel(bytes32 id)',
  'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
  'event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)',
  'event CallSalt(bytes32 indexed id, bytes32 salt)',
  'event Cancelled(bytes32 indexed id)',
])

// Schedule ABI for decoding Safe transaction data
const SCHEDULE_ABI = parseAbi([
  'function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay) returns (bytes32)',
])

// Extend the interface to include MongoDB's _id field and timelockIsExecuted
interface ISafeTxDocumentWithId extends ISafeTxDocument {
  _id: ObjectId
  timelockIsExecuted?: boolean
}

// Define the operation type
interface ITimelockOperation {
  id: Hex
  target: Address
  value: bigint
  data: Hex
  index: bigint
  predecessor: Hex
  delay: bigint
  salt?: Hex
  mongoId?: ObjectId
  functionName?: string | null
}

// Define the command
const cmd = defineCommand({
  meta: {
    name: 'execute-pending-timelock-tx',
    description:
      'Execute pending timelock transactions where the timelock period has passed',
  },
  args: {
    network: {
      type: 'string',
      description:
        'Network to execute transactions on (default: all active networks)',
      required: false,
    },
    dryRun: {
      type: 'boolean',
      description: 'Simulate transactions without sending them',
      required: false,
      default: false,
    },
    operationId: {
      type: 'string',
      description: 'Specific operation ID to execute (optional)',
      required: false,
    },
    executeAll: {
      type: 'boolean',
      description:
        'Auto execute all pending timelock transactions without prompts',
      required: false,
      default: false,
    },
    rejectAll: {
      type: 'boolean',
      description:
        'Auto cancel/reject all pending timelock transactions without prompts',
      required: false,
      default: false,
    },
    rpcUrl: {
      type: 'string',
      description: 'Override RPC URL for the network',
      required: false,
    },
    notify: {
      type: 'string',
      description:
        'Slack webhook URL for sending notifications (only used with --executeAll)',
      required: false,
    },
  },
  async run({ args }) {
    // setupEnvironment handles private key management internally based on environment
    const isDryRun = Boolean(args?.dryRun)
    const specificOperationId = args?.operationId as Hex | undefined
    const executeAll = Boolean(args?.executeAll)
    const rejectAll = Boolean(args?.rejectAll)
    const rpcUrlOverride = args?.rpcUrl
    const notifyWebhook = args?.notify

    // Validate conflicting flags
    if (executeAll && rejectAll) {
      consola.error(
        '❌ Cannot use both --executeAll and --rejectAll flags together'
      )
      process.exit(1)
    }

    if (rpcUrlOverride && !args?.network) {
      consola.error('❌ --rpc-url can only be used with --network')
      process.exit(1)
    }

    // Validate notify flag
    if (notifyWebhook && !executeAll) {
      consola.error('❌ --notify flag can only be used with --executeAll')
      process.exit(1)
    }

    // Initialize Slack notifier if webhook URL provided
    let slackNotifier: SlackNotifier | undefined
    if (notifyWebhook)
      try {
        new URL(notifyWebhook) // Validate webhook URL format
        slackNotifier = new SlackNotifier(notifyWebhook)
        consola.info('📢 Slack notifications enabled')
      } catch (error) {
        consola.error('❌ Invalid Slack webhook URL provided')
        process.exit(1)
      }

    // Log execution mode
    if (isDryRun)
      consola.info('🔍 Running in DRY RUN mode - no transactions will be sent')

    if (executeAll)
      consola.info(
        '🚀 AUTO EXECUTE mode - all pending operations will be executed automatically'
      )

    if (rejectAll)
      consola.info(
        '❌ AUTO REJECT mode - all pending operations will be cancelled automatically'
      )

    // Load networks configuration
    const networksConfig = data as Record<string, INetworkConfig>

    // Filter networks based on command line argument or use all active networks
    let networksToProcess: INetworkConfig[] = []
    if (args?.network) {
      const network = networksConfig[args.network.toLowerCase()]
      if (!network) {
        consola.error(`❌ Network '${args.network}' not found in configuration`)
        process.exit(1)
      }
      networksToProcess = [network]
    }
    // Use all active networks
    else
      networksToProcess = Object.values(networksConfig).filter(
        (network) => network.status === 'active'
      )

    consola.info(
      `🔍 Processing ${networksToProcess.length} network${
        networksToProcess.length === 1 ? '' : 's'
      }${args?.network ? ` (${args.network})` : ''}`
    )

    if (isDryRun)
      consola.info('Running in DRY RUN mode - no transactions will be sent')

    // Process networks - sequentially for interactive mode, parallel for auto-execute mode
    if (executeAll || rejectAll) {
      consola.info('🚀 Processing networks in parallel for auto-execution mode')

      // Send batch start notification if Slack is enabled
      if (slackNotifier)
        try {
          await slackNotifier.notifyBatchStart(
            networksToProcess.map((n) => n.name)
          )
        } catch (error) {
          consola.warn('Failed to send batch start notification:', error)
        }

      // Process all networks in parallel
      const networkPromises = networksToProcess.map(async (network) => {
        return processNetwork(
          network,
          isDryRun,
          specificOperationId,
          executeAll,
          rejectAll,
          rpcUrlOverride,
          slackNotifier
        )
      })

      // Wait for all networks to complete
      const results = await Promise.all(networkPromises)

      // Log summary
      const successfulNetworks = results.filter((r) => r.success).length
      const failedNetworks = results.filter((r) => !r.success).length
      const totalOperationsProcessed = results.reduce(
        (sum, r) => sum + (r.operationsProcessed || 0),
        0
      )
      const totalOperationsFailed = results.reduce(
        (sum, r) => sum + (r.operationsFailed || 0),
        0
      )
      const totalOperationsSucceeded = results.reduce(
        (sum, r) => sum + (r.operationsSucceeded || 0),
        0
      )

      consola.info(`\n📊 Parallel execution summary:`)
      consola.info(`   ✅ Successful networks: ${successfulNetworks}`)
      consola.info(`   ❌ Failed networks: ${failedNetworks}`)
      consola.info(`   📋 Total networks processed: ${results.length}`)
      consola.info(
        `   📝 Total operations processed: ${totalOperationsProcessed}`
      )
      consola.info(
        `   ✅ Total operations succeeded: ${totalOperationsSucceeded}`
      )
      if (totalOperationsFailed > 0)
        consola.error(`   ❌ Total operations failed: ${totalOperationsFailed}`)

      // Send batch summary notification if Slack is enabled
      if (slackNotifier)
        try {
          await slackNotifier.notifyBatchSummary(results)
        } catch (error) {
          consola.warn('Failed to send batch summary notification:', error)
        }

      // Exit with error code if there were failures
      if (failedNetworks > 0 || totalOperationsFailed > 0) {
        consola.error('\n❌ Script completed with errors')
        process.exit(1)
      }
    } else {
      consola.info('🔄 Processing networks sequentially for interactive mode')

      // Process networks sequentially for interactive mode
      let totalFailed = 0
      let totalSucceeded = 0

      for (const network of networksToProcess)
        try {
          const result = await processNetwork(
            network,
            isDryRun,
            specificOperationId,
            executeAll,
            rejectAll,
            rpcUrlOverride,
            undefined // No Slack notifier in sequential mode
          )

          if (result.success) totalSucceeded++
          else totalFailed++

          // Log individual network failures
          if (result.operationsFailed && result.operationsFailed > 0)
            consola.error(
              `[${network.name}] ❌ ${result.operationsFailed} operation(s) failed`
            )
        } catch (error) {
          consola.error(`Error processing network ${network.name}:`, error)
          totalFailed++
        }

      // Log final summary for sequential mode
      if (totalFailed > 0) {
        consola.error(
          `\n❌ Script completed with ${totalFailed} network(s) having failures`
        )
        process.exit(1)
      } else
        consola.success(
          `\n✅ All ${totalSucceeded} network(s) processed successfully`
        )
    }
  },
})

/**
 * Computes operation ID by hashing the schedule parameters (excluding delay)
 * This matches the Solidity hashOperation function
 */
function computeOperationId(
  target: string,
  value: bigint,
  data: Hex,
  predecessor: Hex,
  salt: Hex
): Hex {
  const encoded = encodeAbiParameters(
    [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'predecessor', type: 'bytes32' },
      { name: 'salt', type: 'bytes32' },
    ],
    [target as Hex, value, data, predecessor, salt]
  )

  return keccak256(encoded)
}

/**
 * Checks the status of an operation in the LiFiTimelockController
 */
async function checkOperationStatus(
  publicClient: PublicClient,
  timelockAddress: Address,
  operationId: Hex
): Promise<{
  isDone: boolean
  isPending: boolean
  isReady: boolean
}> {
  const [isDone, isPending, isReady] = await Promise.all([
    publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationDone',
      args: [operationId],
    }),
    publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationPending',
      args: [operationId],
    }),
    publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationReady',
      args: [operationId],
    }),
  ])

  return { isDone, isPending, isReady }
}

/**
 * Fetches Safe transactions with schedule data that haven't been executed in timelock
 */
async function fetchPendingTimelockTransactions(
  networkName: string
): Promise<ISafeTxDocumentWithId[]> {
  const { client, pendingTransactions } = await getSafeMongoCollection()

  try {
    const txs = await pendingTransactions
      .find({
        network: { $regex: networkName, $options: 'i' },
        'safeTx.data.data': { $regex: '^0x01d5062a' },
        status: 'executed',
        timelockIsExecuted: { $ne: true },
      })
      .toArray()

    return txs
  } finally {
    await client.close()
  }
}

async function processNetwork(
  network: INetworkConfig,
  isDryRun: boolean,
  specificOperationId?: Hex,
  executeAll?: boolean,
  rejectAll?: boolean,
  rpcUrlOverride?: string,
  slackNotifier?: SlackNotifier
): Promise<INetworkResult> {
  // Only show network header in sequential mode (when not using auto-execute flags)
  const isSequentialMode = !executeAll && !rejectAll
  if (isSequentialMode)
    consola.info(
      `\n[${network.name}] 📡 ${network.name} (Chain ID: ${network.chainId})`
    )

  try {
    // Load deployment data for the network using getDeployments
    const deploymentData = (await getDeployments(
      network.name as SupportedChain,
      EnvironmentEnum.production
    )) as IDeploymentData

    // Check if LiFiTimelockController is deployed
    if (!deploymentData.LiFiTimelockController) {
      consola.warn(
        `[${network.name}] ⚠️  No timelock controller deployed on ${network.name}`
      )

      // Send Slack notification if enabled
      if (slackNotifier)
        try {
          await slackNotifier.notifyNoOperations(network.name, 'no-timelock')
        } catch (error) {
          consola.warn('Failed to send no-timelock notification:', error)
        }

      return {
        network: network.name,
        success: true,
        operationsProcessed: 0,
      }
    }

    const timelockAddress = deploymentData.LiFiTimelockController as Address

    // Setup environment for viem clients using setupEnvironment
    // Note: setupEnvironment manages private keys internally based on environment
    const { publicClient, walletClient } = await setupEnvironment(
      network.name as SupportedChain,
      null, // No facet ABI needed for timelock operations
      EnvironmentEnum.production,
      rpcUrlOverride
    )

    // Get pending operations using new decode-based approach
    const { readyOperations, totalPendingCount } = await getPendingOperations(
      publicClient,
      timelockAddress,
      network.name,
      specificOperationId,
      rejectAll
    )

    if (readyOperations.length === 0) {
      if (totalPendingCount === 0) {
        consola.info(`[${network.name}] ✅ No pending operations found`)

        // Send Slack notification if enabled
        if (slackNotifier)
          try {
            await slackNotifier.notifyNoOperations(network.name, 'no-pending')
          } catch (error) {
            consola.warn('Failed to send no-pending notification:', error)
          }
      } else {
        consola.info(
          `[${network.name}] ✅ No operations ready for execution (${totalPendingCount} pending but not ready)`
        )

        // Send Slack notification if enabled
        if (slackNotifier)
          try {
            await slackNotifier.notifyNoOperations(
              network.name,
              'no-ready',
              totalPendingCount
            )
          } catch (error) {
            consola.warn('Failed to send no-ready notification:', error)
          }
      }

      return {
        network: network.name,
        success: true,
        operationsProcessed: 0,
      }
    }

    consola.info(
      `[${network.name}] 📋 Found ${readyOperations.length} pending operation${
        readyOperations.length === 1 ? '' : 's'
      }`
    )

    // Execute or reject each ready operation
    let operationsProcessed = 0
    let operationsSucceeded = 0
    let operationsFailed = 0
    let operationsRejected = 0
    let operationsSkipped = 0
    const totalGasUsed = 0n

    for (const operation of readyOperations)
      if (rejectAll) {
        const rejectResult = await rejectOperation(
          publicClient,
          walletClient,
          timelockAddress,
          operation,
          isDryRun
        )
        operationsProcessed++
        if (rejectResult === 'rejected') operationsRejected++
        else if (rejectResult === 'failed') operationsFailed++
      } else {
        // Determine if we should use interactive mode
        const isInteractive = !executeAll && !rejectAll

        const result = await executeOperation(
          publicClient,
          walletClient,
          timelockAddress,
          operation,
          isDryRun,
          isInteractive,
          network.name,
          slackNotifier
        )

        // Log the result for interactive mode
        if (isInteractive)
          consola.info(`[${network.name}] Operation ${operation.id}: ${result}`)

        // Track statistics
        operationsProcessed++
        if (result === 'executed') operationsSucceeded++
        else if (result === 'failed') operationsFailed++
        else if (result === 'rejected') operationsRejected++
        else if (result === 'skipped') operationsSkipped++
      }

    // Send network completion notification if Slack is enabled
    if (slackNotifier && operationsProcessed > 0)
      try {
        const stats: IProcessingStats = {
          operationsProcessed,
          operationsSucceeded,
          operationsFailed,
          totalGasUsed,
        }
        await slackNotifier.notifyNetworkProcessingComplete(network.name, stats)
      } catch (error) {
        consola.warn('Failed to send network completion notification:', error)
      }

    // Determine overall success - only true if no operations failed
    const success = operationsFailed === 0

    // Log summary for this network if there were operations
    if (operationsProcessed > 0) {
      consola.info(
        `[${network.name}] Summary: ${operationsSucceeded} executed, ${operationsRejected} rejected, ${operationsFailed} failed, ${operationsSkipped} skipped`
      )
      if (!success)
        consola.error(
          `[${network.name}] ❌ Network processing completed with ${operationsFailed} failure(s)`
        )
    }

    return {
      network: network.name,
      success,
      operationsProcessed,
      operationsFailed,
      operationsSucceeded,
      operationsRejected,
      operationsSkipped,
    }
  } catch (error) {
    consola.error(
      `[${network.name}] Error processing network ${network.name}:`,
      error
    )

    return {
      network: network.name,
      success: false,
      operationsProcessed: 0,
      operationsFailed: 0,
      operationsSucceeded: 0,
      operationsRejected: 0,
      operationsSkipped: 0,
      error,
    }
  }
}

async function getPendingOperations(
  publicClient: PublicClient,
  timelockAddress: Address,
  networkName: string,
  specificOperationId?: Hex,
  isCancellingOperations?: boolean
): Promise<{
  readyOperations: ITimelockOperation[]
  totalPendingCount: number
}> {
  // Fetch Safe transactions with schedule data from MongoDB
  consola.info(
    `[${networkName}] 🔒 Timelock: ${timelockAddress} - Fetching Safe transactions with schedule data from MongoDB...`
  )
  const safeTxs = await fetchPendingTimelockTransactions(networkName)

  if (safeTxs.length === 0) {
    consola.info(
      `[${networkName}] No Safe transactions with schedule data found`
    )
    return { readyOperations: [], totalPendingCount: 0 }
  }

  consola.info(
    `[${networkName}] Found ${safeTxs.length} Safe transaction(s) with schedule data`
  )

  const readyOperations = []
  const { client, pendingTransactions } = await getSafeMongoCollection()

  try {
    for (const tx of safeTxs)
      try {
        const dataField: Hex | undefined = tx.safeTx?.data?.data
        if (!dataField) {
          consola.warn(
            `[${networkName}] Transaction ${tx._id} has no data field; skipping.`
          )
          continue
        }

        // Decode using the schedule ABI
        const decoded = decodeFunctionData({
          abi: SCHEDULE_ABI,
          data: dataField,
        })

        // Extract the decoded parameters
        const [target, value, innerData, predecessor, salt, delay] =
          decoded.args

        // Compute the operation ID
        const opId = computeOperationId(
          target,
          value,
          innerData,
          predecessor,
          salt
        )

        // If a specific operation ID is provided, check only that one
        if (specificOperationId && opId !== specificOperationId) continue

        // Check operation status in the timelock controller
        const status = await checkOperationStatus(
          publicClient,
          timelockAddress,
          opId
        )

        if (status.isDone) {
          consola.info(
            `[${networkName}] Operation ${opId} is already executed. Marking tx ${tx._id} as timelock executed.`
          )
          await pendingTransactions.updateOne(
            { _id: tx._id },
            { $set: { timelockIsExecuted: true } }
          )
          continue
        }

        // Check if operation exists on-chain when not ready and not marked as executed
        if (!status.isPending && !status.isReady && !tx.timelockIsExecuted) {
          // Operation doesn't exist on-chain at all
          const isOperation = await publicClient.readContract({
            address: timelockAddress,
            abi: TIMELOCK_ABI,
            functionName: 'isOperation',
            args: [opId],
          })

          if (!isOperation) {
            consola.error(
              `[${networkName}] ❌ Operation ${opId} does not exist on-chain! The timelock transaction was never scheduled. Transaction ID: ${tx._id}`
            )
            consola.error(
              `[${networkName}]    This Safe transaction needs to be re-executed to schedule it in the timelock.`
            )
            continue
          }
        }

        if (status.isReady) {
          consola.info(
            `[${networkName}] ✅ Operation ${opId} is ready for execution`
          )

          // Try to decode function name
          let functionName: string | null = null
          try {
            functionName = await decodeFunctionCall(innerData)
          } catch {}

          readyOperations.push({
            id: opId,
            target: target as Address,
            value: value,
            data: innerData,
            index: 0n, // Not used in our implementation
            predecessor: predecessor,
            delay: delay,
            salt: salt, // Store the actual salt from the schedule call
            mongoId: tx._id, // Store MongoDB ID for later updates
            functionName,
          })
        } else if (isCancellingOperations && status.isPending) {
          // Get the timestamp when the operation will be ready
          const timestamp = await publicClient.readContract({
            address: timelockAddress,
            abi: TIMELOCK_ABI,
            functionName: 'getTimestamp',
            args: [opId],
          })

          const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))
          const remainingTime = timestamp - currentTimestamp

          consola.info(
            `[${networkName}] ⏰ Operation ${opId} is pending (${formatTimeRemaining(
              remainingTime
            )} remaining) - will be cancelled`
          )

          // Try to decode function name
          let functionName: string | null = null
          try {
            functionName = await decodeFunctionCall(innerData)
          } catch {}

          readyOperations.push({
            id: opId,
            target: target as Address,
            value: value,
            data: innerData,
            index: 0n,
            predecessor: predecessor,
            delay: delay,
            salt: salt, // Store the actual salt from the schedule call
            mongoId: tx._id,
            functionName,
          })
        } else if (status.isPending) {
          // Get the timestamp when the operation will be ready
          const timestamp = await publicClient.readContract({
            address: timelockAddress,
            abi: TIMELOCK_ABI,
            functionName: 'getTimestamp',
            args: [opId],
          })

          const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))
          const remainingTime = timestamp - currentTimestamp

          consola.info(
            `[${networkName}] ⏰ Operation ${opId} not ready yet (${formatTimeRemaining(
              remainingTime
            )} remaining)`
          )
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        consola.error(
          `[${networkName}] Error processing transaction ${tx._id}: ${errorMessage}`
        )
      }
  } finally {
    await client.close()
  }

  const operationAction = isCancellingOperations
    ? 'to cancel'
    : 'ready to execute'
  consola.info(
    `[${networkName}] 🚀 Found ${readyOperations.length} operation${
      readyOperations.length === 1 ? '' : 's'
    } ${operationAction}`
  )

  return { readyOperations, totalPendingCount: safeTxs.length }
}

async function executeOperation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  timelockAddress: Address,
  operation: ITimelockOperation,
  isDryRun: boolean,
  interactive?: boolean,
  networkName?: string,
  slackNotifier?: SlackNotifier
): Promise<'executed' | 'rejected' | 'skipped' | 'failed'> {
  const networkPrefix = networkName ? `[${networkName}]` : ''
  consola.info(`\n${networkPrefix} ⚡ Processing operation: ${operation.id}`)
  consola.info(`${networkPrefix}    Target: ${operation.target}`)
  consola.info(`${networkPrefix}    Value: ${formatEther(operation.value)} ETH`)
  consola.info(`${networkPrefix}    Data: ${operation.data}`)

  // If interactive mode, show choice prompt
  if (interactive) {
    const action = await consola.prompt('Select action:', {
      type: 'select',
      options: ['Execute', 'Reject', 'Skip'],
    })

    if (action === 'Skip') {
      consola.info('⏭️  Operation skipped')
      return 'skipped'
    }

    if (action === 'Reject') {
      // Call rejectOperation and return
      await rejectOperation(
        publicClient,
        walletClient,
        timelockAddress,
        operation,
        isDryRun
      )
      return 'rejected'
    }

    // If action === 'Execute', continue with execution below
  }

  try {
    // Try to decode the function call
    const functionName = await decodeFunctionCall(operation.data)
    if (functionName) {
      consola.info(`${networkPrefix}    Function: ${functionName}`)
      operation.functionName = functionName
    }

    // Use the salt from the operation if available, otherwise use default
    const salt =
      operation.salt ||
      ('0x0000000000000000000000000000000000000000000000000000000000000000' as Hex)

    if (isDryRun) {
      // Simulate the transaction
      consola.info(`${networkPrefix} 🔍 [DRY RUN] Simulating execution...`)

      // Try to simulate the transaction
      const gasEstimate = await publicClient.estimateGas({
        account: walletClient.account?.address || '0x0',
        to: timelockAddress,
        data: encodeFunctionData({
          abi: TIMELOCK_ABI,
          functionName: 'execute',
          args: [
            operation.target,
            operation.value,
            operation.data,
            operation.predecessor,
            salt,
          ],
        }),
        value: 0n,
      })

      consola.info(`${networkPrefix}    Estimated gas: ${gasEstimate}`)
      consola.success(
        `${networkPrefix} ✅ [DRY RUN] Transaction simulation successful`
      )
    } else {
      // Send the actual transaction
      consola.info(`${networkPrefix} 📤 Submitting transaction...`)
      const hash = await walletClient.writeContract({
        address: timelockAddress,
        abi: TIMELOCK_ABI,
        functionName: 'execute',
        args: [
          operation.target,
          operation.value,
          operation.data,
          operation.predecessor,
          salt,
        ],
        account: walletClient.account || null,
        chain: walletClient.chain || null,
      })

      consola.info(`${networkPrefix}    Transaction hash: ${hash}`)
      consola.info(`${networkPrefix}    Waiting for confirmation...`)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success') {
        consola.success(
          `${networkPrefix} ✅ Operation ${operation.id} executed successfully`
        )

        // Send Slack notification if enabled
        if (slackNotifier && networkName)
          try {
            await slackNotifier.notifyOperationExecuted({
              network: networkName,
              operation: {
                id: operation.id,
                target: operation.target,
                value: operation.value,
                data: operation.data,
                functionName: operation.functionName,
              },
              status: 'success',
              transactionHash: hash,
              gasUsed: receipt.gasUsed,
            })
          } catch (error) {
            consola.warn(
              'Failed to send operation success notification:',
              error
            )
          }

        // Update MongoDB to mark the operation as executed
        if (operation.mongoId)
          try {
            const { client, pendingTransactions } =
              await getSafeMongoCollection()
            try {
              await pendingTransactions.updateOne(
                { _id: operation.mongoId },
                { $set: { timelockIsExecuted: true } }
              )
              consola.info(
                `${networkPrefix} Updated MongoDB document ${operation.mongoId} to mark timelock as executed`
              )
            } finally {
              await client.close()
            }
          } catch (error) {
            consola.warn(
              `${networkPrefix} Failed to update MongoDB document: ${error}`
            )
          }
      } else
        consola.error(
          `${networkPrefix} ❌ Transaction failed for operation ${operation.id}`
        )
    }

    return 'executed'
  } catch (error) {
    consola.error(
      `${networkPrefix} Failed to execute operation ${operation.id}:`,
      error
    )

    // Send Slack notification for failure if enabled
    if (slackNotifier && networkName && !isDryRun)
      try {
        await slackNotifier.notifyOperationFailed({
          network: networkName,
          operation: {
            id: operation.id,
            target: operation.target,
            value: operation.value,
            data: operation.data,
            functionName: operation.functionName,
          },
          status: 'failed',
          error,
        })
      } catch (notifyError) {
        consola.warn(
          'Failed to send operation failure notification:',
          notifyError
        )
      }

    return 'failed'
  }
}

async function rejectOperation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  timelockAddress: Address,
  operation: ITimelockOperation,
  isDryRun: boolean
): Promise<'rejected' | 'failed'> {
  consola.info(`\n❌ Rejecting operation: ${operation.id}`)
  consola.info(`   Target: ${operation.target}`)
  consola.info(`   Value: ${formatEther(operation.value)} ETH`)
  consola.info(`   Data: ${operation.data}`)

  try {
    // Try to decode the function call
    const functionName = await decodeFunctionCall(operation.data)
    if (functionName) consola.info(`   Function: ${functionName}`)

    if (isDryRun) {
      // Simulate the cancellation
      consola.info(`🔍 [DRY RUN] Simulating cancellation...`)

      // Try to simulate the transaction
      const gasEstimate = await publicClient.estimateGas({
        account: walletClient.account?.address || '0x0',
        to: timelockAddress,
        data: encodeFunctionData({
          abi: TIMELOCK_ABI,
          functionName: 'cancel',
          args: [operation.id],
        }),
        value: 0n,
      })

      consola.info(`   Estimated gas: ${gasEstimate}`)
      consola.success(`✅ [DRY RUN] Cancellation simulation successful`)
      return 'rejected'
    } else {
      // Send the actual cancellation transaction
      consola.info(`📤 Submitting cancellation transaction...`)
      const hash = await walletClient.writeContract({
        address: timelockAddress,
        abi: TIMELOCK_ABI,
        functionName: 'cancel',
        args: [operation.id],
        account: walletClient.account || null,
        chain: null,
      })

      consola.info(`   Transaction hash: ${hash}`)
      consola.info(`   Waiting for confirmation...`)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success') {
        consola.success(`✅ Operation ${operation.id} cancelled successfully`)

        // Update MongoDB to mark the operation as executed (cancelled counts as executed)
        if (operation.mongoId)
          try {
            const { client, pendingTransactions } =
              await getSafeMongoCollection()
            try {
              await pendingTransactions.updateOne(
                { _id: operation.mongoId },
                { $set: { timelockIsExecuted: true } }
              )
              consola.info(
                `Updated MongoDB document ${operation.mongoId} to mark timelock as cancelled`
              )
            } finally {
              await client.close()
            }
          } catch (error) {
            consola.warn(`Failed to update MongoDB document: ${error}`)
          }
        return 'rejected'
      } else {
        consola.error(`❌ Cancellation failed for operation ${operation.id}`)
        return 'failed'
      }
    }
  } catch (error) {
    consola.error(`Failed to cancel operation ${operation.id}:`, error)
    return 'failed'
  }
}

// Helper function to format remaining time in a human-readable format
function formatTimeRemaining(seconds: bigint): string {
  if (seconds <= 0n) return 'Ready to execute'

  const days = seconds / 86400n
  const hours = (seconds % 86400n) / 3600n
  const minutes = (seconds % 3600n) / 60n
  const secs = seconds % 60n

  let result = ''
  if (days > 0n) result += `${days}d `
  if (hours > 0n) result += `${hours}h `
  if (minutes > 0n) result += `${minutes}m `
  result += `${secs}s`

  return result
}

// Helper function to decode a function call
async function decodeFunctionCall(data: Hex): Promise<string | null> {
  if (!data || data === '0x') return null

  try {
    const selector = data.substring(0, 10)
    const url = `https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`
    const response = await fetch(url)
    const responseData = await response.json()

    if (
      responseData.ok &&
      responseData.result &&
      responseData.result.function &&
      responseData.result.function[selector]
    )
      return responseData.result.function[selector][0].name

    return null
  } catch (error) {
    consola.warn(`Error decoding function call:`, error)
    return null
  }
}

runMain(cmd)
