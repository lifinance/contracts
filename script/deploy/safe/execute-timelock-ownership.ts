#!/usr/bin/env bun

/**
 * Execute Timelock Ownership Confirmation
 *
 * This script executes a transaction through the LiFiTimelockController that calls confirmOwnershipTransfer
 * on the LiFiDiamond for each network that has a safeAddress configured in networks.json.
 * It uses the PRIVATE_KEY_PRODUCTION environment variable to sign transactions.
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import consola from 'consola'
import { parseArgs } from 'util'

// Define interfaces for network configuration
interface NetworkConfig {
  name: string
  chainId: number
  safeAddress?: string
  rpcUrl: string
}

interface DeploymentData {
  LiFiDiamond?: string
  LiFiTimelockController?: string
  [key: string]: string | undefined
}

// Parse command line arguments
const { values } = parseArgs({
  options: {
    privateKey: {
      type: 'string',
      short: 'k',
    },
    help: {
      type: 'boolean',
      short: 'h',
    },
    dryRun: {
      type: 'boolean',
      short: 'd',
    },
  },
})

// Show help if requested
if (values.help) {
  console.log(`
Usage: bun execute-timelock-ownership.ts [options]

Options:
  -k, --privateKey <key>  Private key to use for signing transactions (defaults to PRIVATE_KEY_PRODUCTION env var)
  -d, --dryRun            Simulate transactions without sending them
  -h, --help              Show this help message
  `)
  process.exit(0)
}

// Main function
async function main() {
  // Get private key from command line argument or environment variable
  const privateKey = values.privateKey || process.env.PRIVATE_KEY_PRODUCTION
  const isDryRun = values.dryRun || false

  if (!privateKey) {
    consola.error(
      'No private key provided. Use --privateKey or set PRIVATE_KEY_PRODUCTION environment variable.'
    )
    process.exit(1)
  }

  // Load networks configuration
  const networksConfigPath = join(process.cwd(), 'config', 'networks.json')
  const networksConfig = JSON.parse(
    readFileSync(networksConfigPath, 'utf-8')
  ) as Record<string, NetworkConfig>

  // Filter networks that have a safeAddress configured
  const networksWithSafe = Object.values(networksConfig).filter(
    (network) => network.safeAddress && network.safeAddress.length > 0
  )

  consola.info(
    `Found ${networksWithSafe.length} networks with Safe addresses configured`
  )

  if (isDryRun) {
    consola.info('Running in DRY RUN mode - no transactions will be sent')
  }

  // Ask for confirmation before proceeding
  const confirm = await consola.prompt(
    `Are you sure you want to execute confirmOwnershipTransfer through the timelock controller on ${networksWithSafe.length} networks?`,
    {
      type: 'confirm',
    }
  )

  if (!confirm) {
    consola.info('Operation cancelled by user')
    process.exit(0)
  }

  // Process each network
  for (const network of networksWithSafe) {
    try {
      await processNetwork(network, privateKey, isDryRun)
    } catch (error) {
      consola.error(`Error processing network ${network.name}:`, error)
    }
  }
}

async function processNetwork(
  network: NetworkConfig,
  privateKey: string,
  isDryRun: boolean
) {
  consola.info(`Processing network: ${network.name}`)

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

    // Check if both LiFiDiamond and LiFiTimelockController are deployed
    if (!deploymentData.LiFiDiamond) {
      consola.warn(
        `LiFiDiamond not found in deployments for ${network.name}, skipping...`
      )
      return
    }

    if (!deploymentData.LiFiTimelockController) {
      consola.warn(
        `LiFiTimelockController not found in deployments for ${network.name}, skipping...`
      )
      return
    }

    const diamondAddress = deploymentData.LiFiDiamond as Address
    const timelockAddress = deploymentData.LiFiTimelockController as Address

    consola.info(`Diamond address: ${diamondAddress}`)
    consola.info(`Timelock address: ${timelockAddress}`)

    // Create viem clients
    const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, '')}`)

    const publicClient = createPublicClient({
      chain: {
        id: network.chainId,
      },
      transport: http(network.rpcUrl),
    })

    const walletClient = createWalletClient({
      account,
      chain: {
        id: network.chainId,
      },
      transport: http(network.rpcUrl),
    })

    // Encode the confirmOwnershipTransfer function call for the diamond
    const confirmOwnershipCalldata = encodeFunctionData({
      abi: [
        {
          inputs: [],
          name: 'confirmOwnershipTransfer',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function',
        },
      ],
      functionName: 'confirmOwnershipTransfer',
      args: [],
    })

    // Encode the execute function call for the timelock controller
    // This will execute the confirmOwnershipTransfer function on the diamond
    const executeCalldata = encodeFunctionData({
      abi: [
        {
          inputs: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
          name: 'execute',
          outputs: [],
          stateMutability: 'payable',
          type: 'function',
        },
      ],
      functionName: 'execute',
      args: [
        diamondAddress,
        0n, // No ETH value
        confirmOwnershipCalldata as `0x${string}`,
      ],
    })

    consola.info(
      `Executing confirmOwnershipTransfer through timelock for network ${network.name}...`
    )

    try {
      if (isDryRun) {
        // Simulate the transaction
        consola.info(`[DRY RUN] Would execute transaction on ${network.name}:`)
        consola.info(`  From: ${account.address}`)
        consola.info(`  To: ${timelockAddress}`)
        consola.info(`  Data: ${executeCalldata}`)

        // Try to simulate the transaction
        const gasEstimate = await publicClient.estimateGas({
          account: account.address,
          to: timelockAddress,
          data: executeCalldata,
          value: 0n,
        })

        consola.info(`  Estimated gas: ${gasEstimate}`)
        consola.success(
          `[DRY RUN] Transaction simulation successful for ${network.name}`
        )
      } else {
        // Send the actual transaction
        const hash = await walletClient.sendTransaction({
          to: timelockAddress,
          data: executeCalldata,
          value: 0n,
        })

        consola.info(`Transaction hash: ${hash}`)
        consola.info(`Waiting for transaction confirmation...`)

        const receipt = await publicClient.waitForTransactionReceipt({ hash })

        if (receipt.status === 'success') {
          consola.success(
            `Successfully executed confirmOwnershipTransfer for ${network.name}`
          )
        } else {
          consola.error(`Transaction failed for ${network.name}`)
        }
      }
    } catch (error) {
      consola.error(
        `Failed to execute confirmOwnershipTransfer for ${network.name}:`,
        error
      )
    }
  } catch (error) {
    consola.error(`Error reading deployment data for ${network.name}:`, error)
  }
}

// Run the main function
main().catch((error) => {
  consola.error('Error in main execution:', error)
  process.exit(1)
})
