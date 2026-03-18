#!/usr/bin/env bun
import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import { EnvironmentEnum } from '../../common/types'
import {
  getEnvVar,
  getPrivateKeyForEnvironment,
} from '../../demoScripts/utils/demoScriptHelpers'

import { runPropose } from './propose-to-safe-tron.js'
import { getEnvironment, waitBetweenDeployments } from './utils.js'

/** Normalize raw owner response from contract to base58. */
function ownerRawToBase58(tronWeb: TronWeb, ownerRaw: unknown): string {
  const ownerStr = String(ownerRaw)
  if (ownerStr.startsWith('T') && ownerStr.length === 34) return ownerStr
  let hexForConversion = ownerStr
  if (hexForConversion.startsWith('0x'))
    hexForConversion = hexForConversion.substring(2)
  if (!hexForConversion.startsWith('41'))
    hexForConversion = '41' + hexForConversion
  if (hexForConversion.length > 42)
    hexForConversion = hexForConversion.substring(0, 42)
  else if (hexForConversion.length < 42)
    hexForConversion = hexForConversion.padEnd(42, '0')
  return tronWeb.address.fromHex(hexForConversion)
}

/** Normalize address (hex or base58) to base58. */
function normalizeNewOwner(tronWeb: TronWeb, newOwner: string): string {
  if (!newOwner.startsWith('0x') && !newOwner.startsWith('41')) return newOwner
  const hexAddr = newOwner.startsWith('0x')
    ? '41' + newOwner.substring(2)
    : newOwner
  return tronWeb.address.fromHex(hexAddr)
}

/**
 * Transfer ownership of the Diamond contract.
 * Two-step process:
 * - Step 1: Current owner calls transferOwnership(newOwner)
 * - Step 2: New owner (pending owner) calls confirmOwnershipTransfer()
 * Use --step 1 or --step 2 to run only one step.
 */
async function transferOwnership(options: {
  newOwner: string
  step?: 1 | 2
  noPropose?: boolean
  dryRun?: boolean
  confirm?: boolean
  newOwnerPrivateKey?: string
  currentOwnerPrivateKey?: string
  delaySeconds?: number
  verbose?: boolean
}) {
  const stepOnly = options.step
  const runStep1 = stepOnly === undefined || stepOnly === 1
  const runStep2 = stepOnly === undefined ? !!options.confirm : stepOnly === 2

  const environment = await getEnvironment()
  const networkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'

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
  const timelockAddress = deployments.LiFiTimelockController

  if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

  const networkConfig = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config', 'networks.json'), 'utf8')
  )
  const fullHost =
    networkConfig[networkName]?.rpcUrl || networkConfig[networkName]?.rpc
  if (!fullHost) throw new Error('Tron RPC URL not found in networks.json')

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

  // ---- Step 1: transferOwnership (current owner) ----
  if (runStep1) {
    // Use PRIVATE_KEY_PRODUCTION from .env for production Tron (mainnet)
    const privateKey =
      options.currentOwnerPrivateKey ||
      (networkName === 'tron'
        ? getEnvVar('PRIVATE_KEY_PRODUCTION')
        : getPrivateKeyForEnvironment(environment))
    const tronWeb = new TronWeb({ fullHost, privateKey })

    if (options.currentOwnerPrivateKey)
      consola.info('   Using provided current owner private key')

    consola.info(` Connected to: ${fullHost}`)
    consola.info(
      `👛 Current owner (deployer): ${tronWeb.defaultAddress.base58}`
    )
    consola.info(`🔷 LiFiDiamond: ${diamondAddress}`)
    consola.info(`🎯 New owner: ${options.newOwner}`)

    const diamond = tronWeb.contract(ownershipABI, diamondAddress)

    consola.info('\n📋 Checking current owner...')
    const currentOwnerRaw = await diamond.owner().call()
    const currentOwnerBase58 = ownerRawToBase58(tronWeb, currentOwnerRaw)
    consola.info(`   Current owner (base58): ${currentOwnerBase58}`)

    if (currentOwnerBase58 !== tronWeb.defaultAddress.base58) {
      consola.warn(
        `   ⚠️  Warning: Deployer (${tronWeb.defaultAddress.base58}) is not the current owner (${currentOwnerBase58}).`
      )
      if (!options.currentOwnerPrivateKey)
        consola.warn(
          '   💡 Use --currentOwnerPrivateKey <key> to use the current owner key.'
        )
      if (!options.dryRun) {
        const shouldContinue = await consola.prompt(
          'Continue anyway? (will fail if you are not the owner)',
          { type: 'confirm', default: false }
        )
        if (!shouldContinue) {
          consola.info('Aborted.')
          return
        }
      }
    } else {
      consola.success('   ✅ Deployer matches current owner.')
    }

    const newOwnerBase58 = normalizeNewOwner(tronWeb, options.newOwner)
    if (!tronWeb.isAddress(newOwnerBase58))
      throw new Error(`Invalid new owner address: ${options.newOwner}`)
    if (currentOwnerBase58 === newOwnerBase58)
      throw new Error('New owner cannot be the same as current owner.')

    consola.info(
      '\n📤 Step 1: Initiating ownership transfer (transferOwnership)...'
    )

    if (options.dryRun) {
      consola.info(
        `   [DRY RUN] Would call transferOwnership(${newOwnerBase58})`
      )
      consola.info(
        '   Then run with --step 2 (and --newOwnerPrivateKey if new owner is EOA).'
      )
      return
    }

    await waitBetweenDeployments(
      options.delaySeconds ?? 0,
      options.verbose ?? false
    )

    try {
      const tx = await diamond.transferOwnership(newOwnerBase58).send({
        feeLimit: 10_000_000,
        shouldPollResponse: true,
      })
      consola.success('   ✅ Ownership transfer initiated.')
      consola.info(`   Transaction: ${tx}`)
      if (!runStep2)
        consola.info(
          `   Next: run with --step 2. New owner (${newOwnerBase58}) must call confirmOwnershipTransfer().`
        )
    } catch (error: any) {
      consola.error(`   ❌ Transfer failed: ${error.message || error}`)
      if (error.error) consola.error('   Error details:', error.error)
      throw error
    }
  }

  // ---- Step 2: confirmOwnershipTransfer (new owner) ----
  if (runStep2) {
    const tronWebForDiamond = new TronWeb({
      fullHost,
      privateKey:
        options.newOwnerPrivateKey || getPrivateKeyForEnvironment(environment),
    })
    const pendingOwnerHint = normalizeNewOwner(
      tronWebForDiamond,
      options.newOwner
    )

    consola.info(
      '\n📥 Step 2: Confirming ownership transfer (confirmOwnershipTransfer)...'
    )
    consola.info(`   Diamond: ${diamondAddress}`)
    consola.info(
      `   Caller (must be pending owner): ${tronWebForDiamond.defaultAddress.base58}`
    )
    consola.info(`   Expected pending owner: ${pendingOwnerHint}`)

    // If new owner is a contract (e.g. Timelock), we cannot sign; by default create Safe proposal in MongoDB
    if (
      !options.newOwnerPrivateKey &&
      timelockAddress &&
      pendingOwnerHint === (timelockAddress as string)
    ) {
      if (!options.noPropose) {
        consola.info(
          '\n   Creating Safe proposal (propose-to-safe-tron) and storing in MongoDB...'
        )
        await runPropose({ dryRun: options.dryRun })
        return
      }
      const selector = '0x13af4035' // confirmOwnershipTransfer() selector
      consola.info(
        '\n   New owner is the Timelock contract; it must call confirmOwnershipTransfer().'
      )
      consola.info(`   Calldata (no args): ${selector}`)
      consola.info(
        '   (--noPropose: only instructions.) Propose manually: schedule Timelock operation → target: Diamond, data: 0x13af4035, then execute after delay.'
      )
      return
    }

    if (!options.newOwnerPrivateKey) {
      consola.warn(
        '   ⚠️  No --newOwnerPrivateKey. For EOA new owner, pass the key. For Timelock, propose the call via Safe.'
      )
      return
    }

    const newOwnerTronWeb = new TronWeb({
      fullHost,
      privateKey: options.newOwnerPrivateKey,
    })
    if (newOwnerTronWeb.defaultAddress.base58 !== pendingOwnerHint) {
      throw new Error(
        `Private key does not match new owner. Expected: ${pendingOwnerHint}, Got: ${newOwnerTronWeb.defaultAddress.base58}`
      )
    }

    const newOwnerDiamond = newOwnerTronWeb.contract(
      ownershipABI,
      diamondAddress
    )

    if (options.dryRun) {
      consola.info('   [DRY RUN] Would call confirmOwnershipTransfer()')
      return
    }

    await waitBetweenDeployments(
      options.delaySeconds ?? 0,
      options.verbose ?? false
    )

    try {
      const confirmTx = await newOwnerDiamond.confirmOwnershipTransfer().send({
        feeLimit: 10_000_000,
        shouldPollResponse: true,
      })
      consola.success('   ✅ Ownership transfer confirmed.')
      consola.info(`   Transaction: ${confirmTx}`)

      const verifiedOwnerRaw = await newOwnerDiamond.owner().call()
      const verifiedOwnerBase58 = ownerRawToBase58(
        newOwnerTronWeb,
        verifiedOwnerRaw
      )
      if (verifiedOwnerBase58 === pendingOwnerHint)
        consola.success(`   ✅ Verified: owner is ${verifiedOwnerBase58}`)
      else
        consola.warn(
          `   ⚠️  Verification: expected ${pendingOwnerHint}, got ${verifiedOwnerBase58}`
        )
    } catch (error: any) {
      consola.error(`   ❌ Confirmation failed: ${error.message || error}`)
      if (error.error) consola.error('   Error details:', error.error)
      throw error
    }
  }
}

// CLI handling
const main = defineCommand({
  meta: {
    name: 'transfer-ownership',
    description:
      'Transfer ownership of the Tron Diamond (two-step: transferOwnership then confirmOwnershipTransfer). Use --step to run one step only.',
  },
  args: {
    newOwner: {
      type: 'string',
      description:
        'New owner address (base58 or hex). For step 2, the pending owner (e.g. Timelock).',
      required: true,
    },
    step: {
      type: 'string',
      description:
        'Run only step 1 (transferOwnership) or step 2 (confirmOwnershipTransfer). Omit to run both (step 2 only if --confirm and --newOwnerPrivateKey).',
      default: undefined,
    },
    noPropose: {
      type: 'boolean',
      description:
        'When --step 2 and new owner is Timelock: skip creating the Safe proposal in MongoDB (default is to propose).',
      default: false,
    },
    dryRun: {
      type: 'boolean',
      description: 'Run in dry-run mode without sending transactions',
      default: false,
    },
    confirm: {
      type: 'boolean',
      description:
        'When --step is not set, also run step 2 (requires --newOwnerPrivateKey for EOA new owner)',
      default: false,
    },
    newOwnerPrivateKey: {
      type: 'string',
      description:
        'Private key of the new owner. Required for --step 2 when new owner is an EOA. Not used when new owner is Timelock (propose via Safe).',
      default: undefined,
    },
    currentOwnerPrivateKey: {
      type: 'string',
      description:
        'Private key of the current owner (default: deployer from env). Used for --step 1.',
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
    const stepNum =
      args.step !== undefined
        ? args.step === '1'
          ? 1
          : args.step === '2'
          ? 2
          : undefined
        : undefined
    if (args.step !== undefined && stepNum === undefined) {
      consola.error('Invalid --step. Use 1 or 2.')
      process.exit(1)
    }

    const options: {
      newOwner: string
      step?: 1 | 2
      noPropose?: boolean
      dryRun?: boolean
      confirm?: boolean
      newOwnerPrivateKey?: string
      currentOwnerPrivateKey?: string
      delaySeconds?: number
      verbose?: boolean
    } = {
      newOwner: args.newOwner,
      step: stepNum,
      noPropose: args.noPropose,
      dryRun: args.dryRun,
      confirm: args.confirm,
      newOwnerPrivateKey: args.newOwnerPrivateKey,
      currentOwnerPrivateKey: args.currentOwnerPrivateKey,
      delaySeconds: 5,
      verbose: args.verbose,
    }

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

    if (stepNum === 2 && !args.newOwnerPrivateKey) {
      consola.info(
        '--step 2 with no --newOwnerPrivateKey: if new owner is Timelock, Safe proposal is created in MongoDB by default (use --noPropose for calldata-only).'
      )
    }

    consola.start(
      stepNum === 1
        ? 'Running step 1 (transferOwnership)...'
        : stepNum === 2
        ? 'Running step 2 (confirmOwnershipTransfer)...'
        : 'Starting ownership transfer...'
    )

    try {
      await transferOwnership(options)
      consola.success('✨ Done.')
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
