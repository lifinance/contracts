#!/usr/bin/env bun

/**
 * Schedule Timelock Ownership Confirmation
 *
 * This script schedules a transaction through the LiFiTimelockController that calls confirmOwnershipTransfer
 * on the LiFiDiamond for each network that has a safeAddress configured in networks.json.
 * It proposes the transaction to the Safe using the propose-to-safe.ts script.
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createPublicClient,
  http,
  encodeFunctionData,
  Address,
  Chain,
} from 'viem'
import { consola } from 'consola'
import { defineCommand, runMain } from 'citty'
// @ts-ignore
import { $ } from 'bun'

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
}

/**
 * Main command definition for scheduling timelock ownership confirmation
 */
const main = defineCommand({
  meta: {
    name: 'schedule-confirm-timelock-ownership',
    description:
      'Schedule confirmOwnershipTransfer through timelock for networks with Safe addresses',
  },
  args: {
    privateKey: {
      type: 'string',
      description:
        'Private key to use for signing transactions (not needed if using --ledger)',
      required: false,
    },
    ledger: {
      type: 'boolean',
      description: 'Use Ledger hardware wallet for signing',
      required: false,
    },
    ledgerLive: {
      type: 'boolean',
      description: 'Use Ledger Live derivation path',
      required: false,
    },
    accountIndex: {
      type: 'string',
      description: 'Ledger account index (default: 0)',
      required: false,
    },
    derivationPath: {
      type: 'string',
      description: 'Custom derivation path for Ledger (overrides ledgerLive)',
      required: false,
    },
    dryRun: {
      type: 'boolean',
      description: 'Simulate transactions without sending them',
      required: false,
    },
    delay: {
      type: 'string',
      description:
        'Delay in seconds before the transaction can be executed (defaults to minimum delay)',
      required: false,
    },
  },
  async run({ args }) {
    const isDryRun = args.dryRun || false
    const customDelay = args.delay ? BigInt(args.delay) : undefined

    // Validate that we have either a private key or ledger
    if (!args.privateKey && !args.ledger) {
      throw new Error('Either --privateKey or --ledger must be provided')
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
      `Are you sure you want to schedule confirmOwnershipTransfer through the timelock controller on ${networksWithSafe.length} networks?`,
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
        await processNetwork(network, args, isDryRun, customDelay)
      } catch (error) {
        consola.error(`Error processing network ${network.name}:`, error)
      }
    }
  },
})

async function processNetwork(
  network: NetworkConfig,
  args: any,
  isDryRun: boolean,
  customDelay?: bigint
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

    // Create a minimal chain object with required properties
    const chain = {
      id: network.chainId,
      name: network.name,
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: [network.rpcUrl],
        },
        public: {
          http: [network.rpcUrl],
        },
      },
    } as Chain

    const publicClient = createPublicClient({
      chain,
      transport: http(network.rpcUrl),
    })

    // Get the minimum delay from the timelock controller
    const minDelay = (await publicClient.readContract({
      address: timelockAddress,
      abi: [
        {
          inputs: [],
          name: 'getMinDelay',
          outputs: [{ type: 'uint256', name: '' }],
          stateMutability: 'view',
          type: 'function',
        },
      ],
      functionName: 'getMinDelay',
    })) as bigint

    // Use custom delay if provided, otherwise use the minimum delay
    const delay = customDelay !== undefined ? customDelay : minDelay

    consola.info(
      `Using delay: ${delay} seconds (minimum delay: ${minDelay} seconds)`
    )

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

    // Generate a unique salt based on current timestamp
    const salt = `0x${Date.now()
      .toString(16)
      .padStart(64, '0')}` as `0x${string}`

    // Encode the schedule function call for the timelock controller
    // This will schedule the confirmOwnershipTransfer function on the diamond
    const scheduleCalldata = encodeFunctionData({
      abi: [
        {
          inputs: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
            { name: 'predecessor', type: 'bytes32' },
            { name: 'salt', type: 'bytes32' },
            { name: 'delay', type: 'uint256' },
          ],
          name: 'schedule',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function',
        },
      ],
      functionName: 'schedule',
      args: [
        diamondAddress,
        0n, // No ETH value
        confirmOwnershipCalldata,
        '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`, // No predecessor
        salt,
        delay,
      ],
    })

    consola.info(
      `Scheduling confirmOwnershipTransfer through timelock for network ${network.name}...`
    )

    try {
      if (isDryRun) {
        consola.info(
          `[DRY RUN] Would propose transaction to Safe on ${network.name}:`
        )
        consola.info(`  To: ${timelockAddress}`)
        consola.info(`  Calldata: ${scheduleCalldata}`)
        consola.success(
          `[DRY RUN] Transaction simulation successful for ${network.name}`
        )
      } else {
        // Build the command to call propose-to-safe.ts
        const proposeCommand = [
          'bun',
          'script/deploy/safe/propose-to-safe.ts',
          '--to',
          timelockAddress,
          '--calldata',
          scheduleCalldata,
          '--network',
          network.name,
          '--rpcUrl',
          network.rpcUrl,
        ]

        // Add signing method arguments
        if (args.ledger) {
          proposeCommand.push('--ledger')
          if (args.ledgerLive) {
            proposeCommand.push('--ledgerLive')
          }
          if (args.accountIndex) {
            proposeCommand.push('--accountIndex', args.accountIndex)
          }
          if (args.derivationPath) {
            proposeCommand.push('--derivationPath', args.derivationPath)
          }
        } else if (args.privateKey) {
          proposeCommand.push('--privateKey', args.privateKey)
        }

        // Execute the propose-to-safe command
        const result = await $`${proposeCommand}`.quiet()

        // Check if the command was successful
        if (result.exitCode === 0) {
          consola.success(
            `Successfully proposed schedule transaction for ${network.name}`
          )
          consola.info(
            `The transaction will be ready to execute after ${delay} seconds once confirmed by Safe owners`
          )
        } else {
          consola.error(
            `Failed to propose schedule transaction for ${network.name} with exit code ${result.exitCode}`
          )
          consola.error(result.stderr.toString())
        }
      }
    } catch (error) {
      consola.error(
        `Failed to propose schedule transaction for ${network.name}:`,
        error
      )
    }
  } catch (error) {
    consola.error(`Error reading deployment data for ${network.name}:`, error)
  }
}

runMain(main)
