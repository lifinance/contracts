#!/usr/bin/env bun

/**
 * Execute Pending Timelock Transactions
 *
 * This script executes pending transactions in the LiFiTimelockController where the timelock period has passed.
 * It uses viem to interact with the blockchain and citty for command line argument parsing.
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatEther,
  encodeFunctionData,
} from 'viem'
import type { Address, PublicClient, WalletClient, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import data from '../../../config/networks.json'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

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
    privateKey: {
      type: 'string',
      description: 'Private key to use for signing transactions',
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
  },
  async run({ args }) {
    // Get private key from command line argument or environment variable
    const privateKey = args?.privateKey || process.env.PRIVATE_KEY_PRODUCTION
    const isDryRun = Boolean(args?.dryRun)
    const specificOperationId = args?.operationId as Hex | undefined
    const executeAll = Boolean(args?.executeAll)
    const rejectAll = Boolean(args?.rejectAll)

    // Validate conflicting flags
    if (executeAll && rejectAll) {
      consola.error(
        '❌ Cannot use both --executeAll and --rejectAll flags together'
      )
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

    if (!privateKey) {
      consola.error(
        'No private key provided. Use --privateKey or set PRIVATE_KEY_PRODUCTION environment variable.'
      )
      process.exit(1)
    }

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

    // Process each network
    for (const network of networksToProcess)
      try {
        await processNetwork(
          network,
          privateKey,
          isDryRun,
          specificOperationId,
          executeAll,
          rejectAll
        )
      } catch (error) {
        consola.error(`Error processing network ${network.name}:`, error)
      }
  },
})

async function processNetwork(
  network: INetworkConfig,
  privateKey: string,
  isDryRun: boolean,
  specificOperationId?: Hex,
  executeAll?: boolean,
  rejectAll?: boolean
) {
  consola.info(`\n📡 ${network.name} (Chain ID: ${network.chainId})`)

  // Load deployment data for the network
  const deploymentPath = join(
    process.cwd(),
    'deployments',
    `${network.name}.json`
  )

  try {
    const deploymentData = JSON.parse(
      readFileSync(deploymentPath, 'utf-8')
    ) as IDeploymentData

    // Check if LiFiTimelockController is deployed
    if (!deploymentData.LiFiTimelockController) {
      consola.warn(`⚠️  No timelock controller deployed on ${network.name}`)
      return
    }

    const timelockAddress = deploymentData.LiFiTimelockController as Address
    consola.info(`🔒 Timelock: ${timelockAddress}`)

    // Create viem clients
    const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, '')}`)

    const chain = getViemChainForNetworkName(network.name)

    const publicClient = createPublicClient({
      chain,
      transport: http(network.rpcUrl),
    })

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(network.rpcUrl),
    })

    // Get pending operations
    const pendingOperations = await getPendingOperations(
      publicClient,
      timelockAddress,
      specificOperationId,
      rejectAll
    )

    if (pendingOperations.length === 0) {
      consola.info(`✅ No pending operations found`)
      return
    }

    consola.info(
      `📋 Found ${pendingOperations.length} pending operation${
        pendingOperations.length === 1 ? '' : 's'
      }`
    )

    // Execute or reject each ready operation
    for (const operation of pendingOperations)
      if (rejectAll)
        await rejectOperation(
          publicClient,
          walletClient,
          timelockAddress,
          operation,
          isDryRun
        )
      else {
        // Determine if we should use interactive mode
        const isInteractive = !executeAll && !rejectAll

        const result = await executeOperation(
          publicClient,
          walletClient,
          timelockAddress,
          operation,
          isDryRun,
          executeAll,
          isInteractive
        )

        // Log the result for interactive mode
        if (isInteractive) consola.info(`Operation ${operation.id}: ${result}`)
      }
  } catch (error) {
    consola.error(`Error reading deployment data for ${network.name}:`, error)
  }
}

async function getPendingOperations(
  publicClient: PublicClient,
  timelockAddress: Address,
  specificOperationId?: Hex,
  includeNotReady?: boolean
) {
  // If a specific operation ID is provided, check only that one
  if (specificOperationId) {
    consola.info(`🔍 Checking operation: ${specificOperationId}`)

    const isOperation = await publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperation',
      args: [specificOperationId],
    })

    if (!isOperation) {
      consola.warn(`Operation ${specificOperationId} does not exist`)
      return []
    }

    const isPending = await publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationPending',
      args: [specificOperationId],
    })

    if (!isPending) {
      consola.warn(
        `Operation ${specificOperationId} is not pending (may be already executed)`
      )
      return []
    }

    const isReady = await publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationReady',
      args: [specificOperationId],
    })

    if (!isReady) {
      const timestamp = await publicClient.readContract({
        address: timelockAddress,
        abi: TIMELOCK_ABI,
        functionName: 'getTimestamp',
        args: [specificOperationId],
      })

      const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))
      const remainingTime = timestamp - currentTimestamp

      consola.warn(`Operation ${specificOperationId} is not ready yet`)
      consola.info(`Remaining time: ${formatTimeRemaining(remainingTime)}`)
      return []
    }

    // Get the operation details from events
    const operationDetails = await getOperationDetailsFromEvents(
      publicClient,
      timelockAddress,
      specificOperationId
    )

    if (!operationDetails) {
      consola.warn(
        `Could not find details for operation ${specificOperationId}`
      )
      return []
    }

    return [operationDetails]
  }

  // Otherwise, find all pending operations by scanning events
  consola.info('Searching for all pending operations...')

  // Get the CallScheduled events to find all operations
  const scheduledEvents = await publicClient.getLogs({
    address: timelockAddress,
    event: {
      type: 'event',
      name: 'CallScheduled',
      inputs: [
        { indexed: true, name: 'id', type: 'bytes32' },
        { indexed: true, name: 'index', type: 'uint256' },
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'predecessor', type: 'bytes32' },
        { name: 'delay', type: 'uint256' },
      ],
    },
    fromBlock: 'earliest',
    toBlock: 'latest',
  })

  consola.info(`Found ${scheduledEvents.length} scheduled operations in total`)

  // Get the CallExecuted events to find which operations have already been executed
  const executedEvents = await publicClient.getLogs({
    address: timelockAddress,
    event: {
      type: 'event',
      name: 'CallExecuted',
      inputs: [
        { indexed: true, name: 'id', type: 'bytes32' },
        { indexed: true, name: 'index', type: 'uint256' },
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
      ],
    },
    fromBlock: 'earliest',
    toBlock: 'latest',
  })

  // Create a set of executed operation IDs
  const executedOperationIds = new Set(
    executedEvents.map((event) => event.args.id)
  )

  // Get the Cancelled events to find which operations have been cancelled/rejected
  const cancelledEvents = await publicClient.getLogs({
    address: timelockAddress,
    event: {
      type: 'event',
      name: 'Cancelled',
      inputs: [{ indexed: true, name: 'id', type: 'bytes32' }],
    },
    fromBlock: 'earliest',
    toBlock: 'latest',
  })

  // Create a set of cancelled operation IDs
  const cancelledOperationIds = new Set(
    cancelledEvents.map((event) => event.args.id)
  )

  consola.info(`Found ${executedEvents.length} already executed operations`)
  consola.info(`Found ${cancelledEvents.length} cancelled operations`)

  // Filter out operations that have already been executed OR cancelled
  const pendingOperationEvents = scheduledEvents.filter(
    (event) =>
      !executedOperationIds.has(event.args.id) &&
      !cancelledOperationIds.has(event.args.id)
  )

  consola.info(`Found ${pendingOperationEvents.length} pending operations`)

  // Check which operations are ready to be executed
  const readyOperations = []

  for (const event of pendingOperationEvents) {
    const operationId = event.args.id
    if (!operationId) continue

    const isReady = await publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationReady',
      args: [operationId],
    })

    if (isReady) {
      consola.info(`✅ Operation ${operationId} is ready for execution`)
      readyOperations.push({
        id: operationId,
        target: event.args.target || '0x0',
        value: event.args.value || 0n,
        data: event.args.data || '0x',
        index: event.args.index || 0n,
        predecessor:
          event.args.predecessor ||
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        delay: event.args.delay || 0n,
      })
    } else {
      // Get the timestamp when the operation will be ready
      const timestamp = await publicClient.readContract({
        address: timelockAddress,
        abi: TIMELOCK_ABI,
        functionName: 'getTimestamp',
        args: [operationId],
      })

      const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))
      const remainingTime = timestamp - currentTimestamp

      if (includeNotReady) {
        consola.info(
          `⏰ Operation ${operationId} is pending (${formatTimeRemaining(
            remainingTime
          )} remaining) - will be cancelled`
        )
        readyOperations.push({
          id: operationId,
          target: event.args.target || '0x0',
          value: event.args.value || 0n,
          data: event.args.data || '0x',
          index: event.args.index || 0n,
          predecessor:
            event.args.predecessor ||
            '0x0000000000000000000000000000000000000000000000000000000000000000',
          delay: event.args.delay || 0n,
        })
      } else
        consola.info(
          `⏰ Operation ${operationId} not ready yet (${formatTimeRemaining(
            remainingTime
          )} remaining)`
        )
    }
  }

  if (includeNotReady)
    consola.info(
      `🚀 Found ${readyOperations.length} operation${
        readyOperations.length === 1 ? '' : 's'
      } to cancel`
    )
  else
    consola.info(
      `🚀 Found ${readyOperations.length} operation${
        readyOperations.length === 1 ? '' : 's'
      } ready to execute`
    )

  return readyOperations
}

async function getOperationDetailsFromEvents(
  publicClient: PublicClient,
  timelockAddress: Address,
  operationId: Hex
) {
  // Get the CallScheduled event for this operation
  const scheduledEvents = await publicClient.getLogs({
    address: timelockAddress,
    event: {
      type: 'event',
      name: 'CallScheduled',
      inputs: [
        { indexed: true, name: 'id', type: 'bytes32' },
        { indexed: true, name: 'index', type: 'uint256' },
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'predecessor', type: 'bytes32' },
        { name: 'delay', type: 'uint256' },
      ],
    },
    args: {
      id: operationId,
    },
    fromBlock: 'earliest',
    toBlock: 'latest',
  })

  if (scheduledEvents.length === 0) return null

  const event = scheduledEvents[0]

  if (event)
    return {
      id: operationId,
      target: event.args.target || '0x0',
      value: event.args.value || 0n,
      data: event.args.data || '0x',
      index: event.args.index || 0n,
      predecessor:
        event.args.predecessor ||
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      delay: event.args.delay || 0n,
    }

  return null
}

async function executeOperation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  timelockAddress: Address,
  operation: {
    id: Hex
    target: Address
    value: bigint
    data: Hex
    index: bigint
    predecessor: Hex
    delay: bigint
  },
  isDryRun: boolean,
  autoExecute?: boolean,
  interactive?: boolean
): Promise<'executed' | 'rejected' | 'skipped'> {
  consola.info(`\n⚡ Processing operation: ${operation.id}`)
  consola.info(`   Target: ${operation.target}`)
  consola.info(`   Value: ${formatEther(operation.value)} ETH`)
  consola.info(`   Data: ${operation.data}`)

  // If interactive mode, show choice prompt
  if (interactive && !autoExecute) {
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
    if (functionName) consola.info(`   Function: ${functionName}`)

    // Get the salt from CallSalt event
    const saltEvents = await publicClient.getLogs({
      address: timelockAddress,
      event: {
        type: 'event',
        name: 'CallSalt',
        inputs: [
          { indexed: true, name: 'id', type: 'bytes32' },
          { name: 'salt', type: 'bytes32' },
        ],
      },
      args: {
        id: operation.id,
      },
      fromBlock: 'earliest',
      toBlock: 'latest',
    })

    let salt: Hex
    if (saltEvents.length > 0)
      salt =
        saltEvents[0]?.args.salt ||
        '0x0000000000000000000000000000000000000000000000000000000000000000'
    // If no CallSalt event found, the salt was likely bytes32(0)
    else
      salt =
        '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

    if (isDryRun) {
      // Simulate the transaction
      consola.info(`🔍 [DRY RUN] Simulating execution...`)

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

      consola.info(`   Estimated gas: ${gasEstimate}`)
      consola.success(`✅ [DRY RUN] Transaction simulation successful`)
    } else {
      // Send the actual transaction
      consola.info(`📤 Submitting transaction...`)
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
      })

      consola.info(`   Transaction hash: ${hash}`)
      consola.info(`   Waiting for confirmation...`)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success')
        consola.success(`✅ Operation ${operation.id} executed successfully`)
      else consola.error(`❌ Transaction failed for operation ${operation.id}`)
    }

    return 'executed'
  } catch (error) {
    consola.error(`Failed to execute operation ${operation.id}:`, error)
    return 'executed' // Return executed even on error since we attempted execution
  }
}

async function rejectOperation(
  publicClient: PublicClient,
  walletClient: WalletClient,
  timelockAddress: Address,
  operation: {
    id: Hex
    target: Address
    value: bigint
    data: Hex
    index: bigint
    predecessor: Hex
    delay: bigint
  },
  isDryRun: boolean
) {
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
    } else {
      // Send the actual cancellation transaction
      consola.info(`📤 Submitting cancellation transaction...`)
      const hash = await walletClient.writeContract({
        address: timelockAddress,
        abi: TIMELOCK_ABI,
        functionName: 'cancel',
        args: [operation.id],
      })

      consola.info(`   Transaction hash: ${hash}`)
      consola.info(`   Waiting for confirmation...`)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success')
        consola.success(`✅ Operation ${operation.id} cancelled successfully`)
      else consola.error(`❌ Cancellation failed for operation ${operation.id}`)
    }
  } catch (error) {
    consola.error(`Failed to cancel operation ${operation.id}:`, error)
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
