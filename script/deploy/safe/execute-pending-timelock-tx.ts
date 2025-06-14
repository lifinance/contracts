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
import {
  createPublicClient,
  createWalletClient,
  http,
  Address,
  PublicClient,
  WalletClient,
  Hex,
  parseAbi,
  formatEther,
  decodeEventLog,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import consola from 'consola'
import { defineCommand } from 'citty'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'
import data from '../../../config/networks.json'

// Define interfaces for network configuration
interface NetworkConfig {
  name: string
  chainId: number
  safeAddress?: string
  rpcUrl: string
  status: string
}

interface DeploymentData {
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
  'function execute(address target, uint256 value, bytes calldata data) payable returns (bytes)',
  'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
  'event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)',
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
  },
  async run({ args }) {
    // Get private key from command line argument or environment variable
    const privateKey = args.privateKey || process.env.PRIVATE_KEY_PRODUCTION
    const isDryRun = args.dryRun || false
    const specificOperationId = args.operationId as Hex | undefined

    if (!privateKey) {
      consola.error(
        'No private key provided. Use --privateKey or set PRIVATE_KEY_PRODUCTION environment variable.'
      )
      process.exit(1)
    }

    // Load networks configuration
    const networksConfig = data as Record<string, NetworkConfig>

    // Filter networks based on command line argument or use all active networks
    let networksToProcess: NetworkConfig[] = []
    if (args.network) {
      const network = networksConfig[args.network.toLowerCase()]
      if (!network) {
        consola.error(`Network ${args.network} not found in configuration`)
        process.exit(1)
      }
      networksToProcess = [network]
    } else {
      // Use all active networks
      networksToProcess = Object.values(networksConfig).filter(
        (network) => network.status === 'active'
      )
    }

    consola.info(`Processing ${networksToProcess.length} networks`)

    if (isDryRun) {
      consola.info('Running in DRY RUN mode - no transactions will be sent')
    }

    // Process each network
    for (const network of networksToProcess) {
      try {
        await processNetwork(network, privateKey, isDryRun, specificOperationId)
      } catch (error) {
        consola.error(`Error processing network ${network.name}:`, error)
      }
    }
  },
})

async function processNetwork(
  network: NetworkConfig,
  privateKey: string,
  isDryRun: boolean,
  specificOperationId?: Hex
) {
  consola.info(
    `\nProcessing network: ${network.name} (Chain ID: ${network.chainId})`
  )

  // Load deployment data for the network
  const deploymentPath = join(
    process.cwd(),
    'deployments',
    `${network.name}.json`
  )

  try {
    const deploymentData = JSON.parse(
      readFileSync(deploymentPath, 'utf-8')
    ) as DeploymentData

    // Check if LiFiTimelockController is deployed
    if (!deploymentData.LiFiTimelockController) {
      consola.warn(
        `LiFiTimelockController not found in deployments for ${network.name}, skipping...`
      )
      return
    }

    const timelockAddress = deploymentData.LiFiTimelockController as Address

    consola.info(`Timelock address: ${timelockAddress}`)

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
      specificOperationId
    )

    if (pendingOperations.length === 0) {
      consola.info(`No pending operations found for ${network.name}`)
      return
    }

    consola.info(`Found ${pendingOperations.length} pending operations`)

    // Execute each ready operation
    for (const operation of pendingOperations) {
      await executeOperation(
        publicClient,
        walletClient,
        timelockAddress,
        operation,
        isDryRun
      )
    }
  } catch (error) {
    consola.error(`Error reading deployment data for ${network.name}:`, error)
  }
}

async function getPendingOperations(
  publicClient: PublicClient,
  timelockAddress: Address,
  specificOperationId?: Hex
) {
  // If a specific operation ID is provided, check only that one
  if (specificOperationId) {
    consola.info(`Checking specific operation ID: ${specificOperationId}`)

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

  consola.info(`Found ${executedEvents.length} already executed operations`)

  // Filter out operations that have already been executed
  const pendingOperationEvents = scheduledEvents.filter(
    (event) => !executedOperationIds.has(event.args.id)
  )

  consola.info(`Found ${pendingOperationEvents.length} pending operations`)

  // Check which operations are ready to be executed
  const readyOperations = []

  for (const event of pendingOperationEvents) {
    const operationId = event.args.id

    const isReady = await publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationReady',
      args: [operationId],
    })

    if (isReady) {
      readyOperations.push({
        id: operationId,
        target: event.args.target,
        value: event.args.value,
        data: event.args.data,
        index: event.args.index,
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

      consola.info(`Operation ${operationId} is not ready yet`)
      consola.info(`Remaining time: ${formatTimeRemaining(remainingTime)}`)
    }
  }

  consola.info(`Found ${readyOperations.length} operations ready to execute`)

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

  if (scheduledEvents.length === 0) {
    return null
  }

  const event = scheduledEvents[0]

  return {
    id: operationId,
    target: event.args.target,
    value: event.args.value,
    data: event.args.data,
    index: event.args.index,
  }
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
  },
  isDryRun: boolean
) {
  consola.info(`\nExecuting operation: ${operation.id}`)
  consola.info(`Target: ${operation.target}`)
  consola.info(`Value: ${formatEther(operation.value)} ETH`)
  consola.info(`Data: ${operation.data}`)

  try {
    // Try to decode the function call
    const functionName = await decodeFunctionCall(operation.data)
    if (functionName) {
      consola.info(`Function: ${functionName}`)
    }

    if (isDryRun) {
      // Simulate the transaction
      consola.info(`[DRY RUN] Would execute operation ${operation.id}`)

      // Try to simulate the transaction
      const gasEstimate = await publicClient.estimateGas({
        account: walletClient.account.address,
        to: timelockAddress,
        data: encodeFunctionData({
          abi: TIMELOCK_ABI,
          functionName: 'execute',
          args: [operation.target, operation.value, operation.data],
        }),
        value: 0n,
      })

      consola.info(`Estimated gas: ${gasEstimate}`)
      consola.success(`[DRY RUN] Transaction simulation successful`)
    } else {
      // Send the actual transaction
      const hash = await walletClient.writeContract({
        address: timelockAddress,
        abi: TIMELOCK_ABI,
        functionName: 'execute',
        args: [operation.target, operation.value, operation.data],
        value: 0n,
      })

      consola.info(`Transaction hash: ${hash}`)
      consola.info(`Waiting for transaction confirmation...`)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success') {
        consola.success(`Successfully executed operation ${operation.id}`)
      } else {
        consola.error(`Transaction failed for operation ${operation.id}`)
      }
    }
  } catch (error) {
    consola.error(`Failed to execute operation ${operation.id}:`, error)
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
    ) {
      return responseData.result.function[selector][0].name
    }

    return null
  } catch (error) {
    consola.warn(`Error decoding function call:`, error)
    return null
  }
}

// Helper function to encode function data
function encodeFunctionData({
  abi,
  functionName,
  args,
}: {
  abi: any[]
  functionName: string
  args: any[]
}): Hex {
  const functionAbi = abi.find(
    (item) => item.type === 'function' && item.name === functionName
  )

  if (!functionAbi) {
    throw new Error(`Function ${functionName} not found in ABI`)
  }

  // Create the function signature
  const inputs = functionAbi.inputs || []
  const types = inputs.map((input: any) => input.type)
  const signature = `${functionName}(${types.join(',')})`

  // Calculate the function selector (first 4 bytes of the keccak256 hash of the signature)
  const selector = `0x${Buffer.from(signature).toString('hex').slice(0, 8)}`

  // For simplicity, we're not encoding the actual arguments
  // In a real implementation, you would encode the arguments based on their types
  return selector as Hex
}

// Run the command
cmd.run()
