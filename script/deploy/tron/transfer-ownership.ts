#!/usr/bin/env bun
import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import { EnvironmentEnum } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'

import { getEnvironment, waitBetweenDeployments } from './utils.js'

/**
 * Transfer ownership of the Diamond contract
 * This is a two-step process:
 * 1. Current owner calls transferOwnership(newOwner)
 * 2. New owner calls confirmOwnershipTransfer()
 */
async function transferOwnership(options: {
  newOwner: string
  dryRun?: boolean
  confirm?: boolean
  newOwnerPrivateKey?: string
  currentOwnerPrivateKey?: string
  delaySeconds?: number
  verbose?: boolean
}) {
  try {
    // Get environment and determine network
    const environment = await getEnvironment()
    const networkName =
      environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'

    // Load deployment addresses
    const fileSuffix =
      environment === EnvironmentEnum.production ? '' : 'staging.'
    const deploymentPath = path.join(
      process.cwd(),
      'deployments',
      `${networkName}.${fileSuffix}json`
    )

    if (!fs.existsSync(deploymentPath))
      throw new Error(
        `deployments/${networkName}.${fileSuffix}json not found. Please deploy contracts first.`
      )

    const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
    const diamondAddress = deployments.LiFiDiamond

    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    // Setup TronWeb for current owner
    // Use provided currentOwnerPrivateKey if available, otherwise use deployer key
    const privateKey =
      options.currentOwnerPrivateKey || getPrivateKeyForEnvironment(environment)
    const networkConfig = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'config', 'networks.json'),
        'utf8'
      )
    )
    const fullHost =
      networkConfig[networkName]?.rpcUrl || networkConfig[networkName]?.rpc

    if (!fullHost) throw new Error('Tron RPC URL not found in networks.json')

    const tronWeb = new TronWeb({
      fullHost,
      privateKey,
    })

    if (options.currentOwnerPrivateKey) {
      consola.info(`   Using provided current owner private key`)
    }

    consola.info(` Connected to: ${fullHost}`)
    consola.info(
      `👛 Current owner (deployer): ${tronWeb.defaultAddress.base58}`
    )
    consola.info(`🔷 LiFiDiamond: ${diamondAddress}`)
    consola.info(`🎯 New owner: ${options.newOwner}`)

    // Load OwnershipFacet ABI
    const ownershipABI = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'out',
          'OwnershipFacet.sol',
          'OwnershipFacet.json'
        ),
        'utf8'
      )
    ).abi

    const diamond = tronWeb.contract(ownershipABI, diamondAddress)

    // Step 1: Check current owner
    consola.info('\n📋 Step 1: Checking current owner...')
    const currentOwnerRaw = await diamond.owner().call()

    // Convert owner address to base58 for comparison (owner() returns hex)
    let currentOwnerBase58: string
    let currentOwnerHex: string

    const ownerStr = String(currentOwnerRaw)

    // Check if it's already in base58 (starts with T)
    if (ownerStr.startsWith('T') && ownerStr.length === 34) {
      currentOwnerBase58 = ownerStr
      currentOwnerHex = tronWeb.address.toHex(ownerStr)
    } else {
      // It's in hex format - TronWeb.fromHex expects hex with 41 prefix (no 0x)
      let hexForConversion = ownerStr

      // Remove 0x prefix if present
      if (hexForConversion.startsWith('0x')) {
        hexForConversion = hexForConversion.substring(2)
      }

      // Ensure it has 41 prefix (Tron address prefix)
      if (!hexForConversion.startsWith('41')) {
        hexForConversion = '41' + hexForConversion
      }

      // Ensure it's exactly 42 characters (41 + 40 hex chars = 20 bytes)
      if (hexForConversion.length > 42) {
        hexForConversion = hexForConversion.substring(0, 42)
      } else if (hexForConversion.length < 42) {
        hexForConversion = hexForConversion.padEnd(42, '0')
      }

      // Convert to base58
      currentOwnerBase58 = tronWeb.address.fromHex(hexForConversion)
      currentOwnerHex = '0x' + hexForConversion.substring(2) // Remove 41 prefix for display
    }

    consola.info(`   Current owner (base58): ${currentOwnerBase58}`)
    if (options.verbose) {
      consola.debug(`   Current owner (hex): ${currentOwnerHex}`)
      consola.debug(`   Raw response: ${JSON.stringify(currentOwnerRaw)}`)
    }

    // Compare in base58 format
    if (currentOwnerBase58 !== tronWeb.defaultAddress.base58) {
      consola.warn(
        `   ⚠️  Warning: Deployer address (${tronWeb.defaultAddress.base58}) is not the current owner!`
      )
      consola.warn(`   Current owner is: ${currentOwnerBase58}`)

      if (!options.currentOwnerPrivateKey) {
        consola.warn(
          `   💡 Tip: Use --currentOwnerPrivateKey <key> to use the current owner's private key instead.`
        )
      }

      if (!options.dryRun) {
        const shouldContinue = await consola.prompt(
          'Continue anyway? (this will fail if you are not the owner)',
          { type: 'confirm', default: false }
        )
        if (!shouldContinue) {
          consola.info('Aborted.')
          return
        }
      }
    } else {
      consola.success(`   ✅ Deployer address matches current owner!`)
    }

    // Step 2: Validate new owner address
    if (!tronWeb.isAddress(options.newOwner)) {
      throw new Error(`Invalid new owner address: ${options.newOwner}`)
    }

    // Convert new owner to base58 if it's in hex format
    let newOwnerBase58 = options.newOwner
    if (
      options.newOwner.startsWith('0x') ||
      options.newOwner.startsWith('41')
    ) {
      newOwnerBase58 = tronWeb.address.fromHex(options.newOwner)
      consola.info(`   Converted new owner to base58: ${newOwnerBase58}`)
    }

    if (currentOwnerBase58 === newOwnerBase58) {
      throw new Error('New owner cannot be the same as current owner!')
    }

    // Step 3: Initiate ownership transfer
    consola.info('\n📤 Step 2: Initiating ownership transfer...')

    if (options.dryRun) {
      consola.info('   [DRY RUN] Would call: transferOwnership(newOwner)')
      consola.info(`   New owner: ${newOwnerBase58}`)
      consola.info(
        '\n   After this transaction, the new owner must call confirmOwnershipTransfer()'
      )
      return
    }

    // Add delay before transaction
    await waitBetweenDeployments(
      options.delaySeconds ?? 0,
      options.verbose ?? false
    )

    try {
      consola.info(`   Calling transferOwnership(${newOwnerBase58})...`)

      const tx = await diamond.transferOwnership(newOwnerBase58).send({
        feeLimit: 10_000_000, // 10 TRX
        shouldPollResponse: true,
      })

      consola.success(`   ✅ Ownership transfer initiated!`)
      consola.info(`   Transaction: ${tx}`)
      consola.info(
        `\n   ⚠️  IMPORTANT: The new owner (${newOwnerBase58}) must now call confirmOwnershipTransfer() to complete the transfer.`
      )
    } catch (error: any) {
      consola.error(`   ❌ Transfer failed: ${error.message || error}`)
      if (error.error) consola.error('   Error details:', error.error)
      throw error
    }

    // Step 4: Optionally confirm the transfer if new owner's key is provided
    if (options.confirm && options.newOwnerPrivateKey) {
      consola.info('\n📥 Step 3: Confirming ownership transfer...')

      // Create TronWeb instance for new owner
      const newOwnerTronWeb = new TronWeb({
        fullHost,
        privateKey: options.newOwnerPrivateKey,
      })

      if (newOwnerTronWeb.defaultAddress.base58 !== newOwnerBase58) {
        throw new Error(
          `Private key does not match new owner address! Expected: ${newOwnerBase58}, Got: ${newOwnerTronWeb.defaultAddress.base58}`
        )
      }

      consola.info(
        `   New owner address: ${newOwnerTronWeb.defaultAddress.base58}`
      )

      const newOwnerDiamond = newOwnerTronWeb.contract(
        ownershipABI,
        diamondAddress
      )

      await waitBetweenDeployments(
        options.delaySeconds ?? 0,
        options.verbose ?? false
      )

      try {
        consola.info('   Calling confirmOwnershipTransfer()...')

        const confirmTx = await newOwnerDiamond
          .confirmOwnershipTransfer()
          .send({
            feeLimit: 10_000_000, // 10 TRX
            shouldPollResponse: true,
          })

        consola.success(`   ✅ Ownership transfer confirmed!`)
        consola.info(`   Transaction: ${confirmTx}`)

        // Verify new owner
        const verifiedOwnerRaw = await newOwnerDiamond.owner().call()

        // Convert verified owner from hex to base58 for comparison
        let verifiedOwnerBase58: string
        const verifiedOwnerStr = String(verifiedOwnerRaw)

        if (
          verifiedOwnerStr.startsWith('T') &&
          verifiedOwnerStr.length === 34
        ) {
          verifiedOwnerBase58 = verifiedOwnerStr
        } else {
          // It's in hex format - convert to base58
          let hexForConversion = verifiedOwnerStr

          // Remove 0x prefix if present
          if (hexForConversion.startsWith('0x')) {
            hexForConversion = hexForConversion.substring(2)
          }

          // Ensure it has 41 prefix (Tron address prefix)
          if (!hexForConversion.startsWith('41')) {
            hexForConversion = '41' + hexForConversion
          }

          // Ensure it's exactly 42 characters (41 + 40 hex chars = 20 bytes)
          if (hexForConversion.length > 42) {
            hexForConversion = hexForConversion.substring(0, 42)
          } else if (hexForConversion.length < 42) {
            hexForConversion = hexForConversion.padEnd(42, '0')
          }

          // Convert to base58
          verifiedOwnerBase58 =
            newOwnerTronWeb.address.fromHex(hexForConversion)
        }

        if (verifiedOwnerBase58 === newOwnerBase58) {
          consola.success(`   ✅ Verified: New owner is ${verifiedOwnerBase58}`)
        } else {
          consola.warn(
            `   ⚠️  Warning: Owner verification failed. Expected: ${newOwnerBase58}, Got: ${verifiedOwnerBase58} (raw: ${verifiedOwnerStr})`
          )
        }
      } catch (error: any) {
        consola.error(`   ❌ Confirmation failed: ${error.message || error}`)
        if (error.error) consola.error('   Error details:', error.error)
        throw error
      }
    } else if (options.confirm && !options.newOwnerPrivateKey) {
      consola.warn(
        '\n   ⚠️  --confirm was specified but --newOwnerPrivateKey was not provided.'
      )
      consola.warn(
        '   The new owner must manually call confirmOwnershipTransfer() to complete the transfer.'
      )
    }
  } catch (error: any) {
    consola.error('Ownership transfer failed:', error.message || error)
    throw error
  }
}

// CLI handling
const main = defineCommand({
  meta: {
    name: 'transfer-ownership',
    description: 'Transfer ownership of the Tron Diamond contract',
  },
  args: {
    newOwner: {
      type: 'string',
      description: 'New owner address (base58 or hex format)',
      required: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Run in dry-run mode without sending transactions',
      default: false,
    },
    confirm: {
      type: 'boolean',
      description: 'Also confirm the transfer (requires --newOwnerPrivateKey)',
      default: false,
    },
    newOwnerPrivateKey: {
      type: 'string',
      description:
        'Private key of the new owner (required if --confirm is used)',
      default: undefined,
    },
    currentOwnerPrivateKey: {
      type: 'string',
      description:
        'Private key of the current owner (if different from deployer key)',
      default: undefined,
    },
    delaySeconds: {
      type: 'string',
      description:
        'Number of seconds to wait between transactions (default: 5)',
      default: '5',
    },
    verbose: {
      type: 'boolean',
      description: 'Enable verbose logging',
      default: false,
    },
  },
  async run({ args }) {
    const options: {
      newOwner: string
      dryRun?: boolean
      confirm?: boolean
      newOwnerPrivateKey?: string
      currentOwnerPrivateKey?: string
      delaySeconds?: number
      verbose?: boolean
    } = {
      newOwner: args.newOwner,
      dryRun: args.dryRun,
      confirm: args.confirm,
      newOwnerPrivateKey: args.newOwnerPrivateKey,
      currentOwnerPrivateKey: args.currentOwnerPrivateKey,
      delaySeconds: 5,
      verbose: args.verbose,
    }

    // Parse delaySeconds
    if (args.delaySeconds) {
      const parsed = parseInt(args.delaySeconds, 10)
      if (!isNaN(parsed) && parsed >= 0) {
        options.delaySeconds = parsed
      } else {
        consola.warn(
          `Invalid delaySeconds value: ${args.delaySeconds}, using default: 5`
        )
      }
    }

    if (args.dryRun)
      consola.info(' Running in DRY RUN mode - no transactions will be sent')

    if (args.confirm && !args.newOwnerPrivateKey) {
      consola.warn(
        '⚠️  --confirm was specified but --newOwnerPrivateKey was not provided.'
      )
      consola.warn(
        '   The new owner must manually call confirmOwnershipTransfer() after the transfer is initiated.'
      )
    }

    consola.start('Starting ownership transfer...')

    try {
      await transferOwnership(options)
      consola.success('✨ Ownership transfer complete!')
      process.exit(0)
    } catch (error) {
      consola.error(
        'Transfer failed:',
        error instanceof Error ? error.message : error
      )
      process.exit(1)
    }
  },
})

if (import.meta.main) runMain(main)

export { transferOwnership }
