#!/usr/bin/env bun

/**
 * Propose Timelock Ownership
 *
 * This script proposes transferring ownership of the LiFiDiamond to the LiFiTimelockController
 * across all supported networks that have a safeAddress configured.
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Address, encodeFunctionData } from 'viem'
import consola from 'consola'
import { $ } from 'bun'
import { parseArgs } from 'util'

// Define interfaces for network configuration
interface NetworkConfig {
  name: string
  chainId: number
  safeAddress?: string
  safeApiUrl?: string
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
  },
})

// Show help if requested
if (values.help) {
  console.log(`
Usage: bun propose-timelock-ownership.ts [options]

Options:
  -k, --privateKey <key>  Private key to use for signing transactions
  -h, --help              Show this help message
  `)
  process.exit(0)
}

// Main function
async function main() {
  // Get private key from command line argument or environment variable
  const privateKey = values.privateKey || process.env.SAFE_SIGNER_PRIVATE_KEY

  if (!privateKey) {
    consola.error(
      'No private key provided. Use --privateKey or set SAFE_SIGNER_PRIVATE_KEY environment variable.'
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

  // Ask for confirmation before proceeding
  const confirm = await consola.prompt(
    `Are you sure you want to propose transferring ownership to the timelock controller on ${networksWithSafe.length} networks?`,
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
      await processNetwork(network, privateKey)
    } catch (error) {
      consola.error(`Error processing network ${network.name}:`, error)
    }
  }
}

async function processNetwork(network: NetworkConfig, privateKey: string) {
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

    const diamondAddress = deploymentData.LiFiDiamond
    const timelockAddress = deploymentData.LiFiTimelockController

    consola.info(`Diamond address: ${diamondAddress}`)
    consola.info(`Timelock address: ${timelockAddress}`)

    // Encode the transferOwnership function call
    const calldata = encodeFunctionData({
      abi: [
        {
          inputs: [{ name: '_newOwner', type: 'address' }],
          name: 'transferOwnership',
          outputs: [],
          stateMutability: 'nonpayable',
          type: 'function',
        },
      ],
      functionName: 'transferOwnership',
      args: [timelockAddress as Address],
    })

    // Propose the transaction to the Safe using Bun's $ helper
    consola.info(
      `Proposing transferOwnership to timelock for network ${network.name}...`
    )

    try {
      // Using Bun's $ helper for shell commands with explicit privateKey argument
      console.log(calldata)
      const result =
        await $`bun script/deploy/safe/propose-to-safe.ts --to ${diamondAddress} --calldata ${calldata} --network ${network.name} --rpcUrl ${network.rpcUrl} --privateKey ${privateKey}`.quiet()

      // Check if the command was successful
      if (result.exitCode === 0) {
        consola.success(
          `Successfully proposed transferOwnership for ${network.name}`
        )
      } else {
        consola.error(
          `Failed to propose transferOwnership for ${network.name} with exit code ${result.exitCode}`
        )
        consola.error(result.stderr.toString())
      }
    } catch (error) {
      consola.error(
        `Failed to propose transferOwnership for ${network.name}:`,
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
