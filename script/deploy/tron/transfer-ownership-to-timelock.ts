#!/usr/bin/env bun
import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { EnvironmentEnum } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import { getEnvVar, getEnvironment } from '../../utils/utils'

import { TRON_DIAMOND_CONFIRM_OWNERSHIP_SELECTOR } from './constants.js'
import { formatAddressForNetworkCliDisplay } from './helpers/formatAddressForCliDisplay.js'
import { createTronWeb } from './helpers/tronWebFactory.js'
import { runPropose } from './propose-to-safe-tron.js'
import { tronAddressLikeToBase58 } from './tronAddressHelpers.js'
import { waitBetweenDeployments } from './tronUtils.js'
import type { TronTvmNetworkName } from './types.js'

/**
 * Transfer LiFi Diamond ownership to `LiFiTimelockController` from the Tron deployments file.
 * Production: `deployments/tron.json`. Staging: `deployments/tron.staging.json`.
 *
 * - Step 1: current owner calls `transferOwnership(timelock)`
 * - Step 2: Safe proposal for Timelock to call `confirmOwnershipTransfer()` on the Diamond
 */
async function transferOwnershipToTimelock(options: {
  step?: 1 | 2
  noPropose?: boolean
  dryRun?: boolean
  confirm?: boolean
  currentOwnerPrivateKey?: string
  delaySeconds?: number
  verbose?: boolean
}) {
  const stepOnly = options.step
  const runStep1 = stepOnly === undefined || stepOnly === 1
  const runStep2 = stepOnly === undefined ? !!options.confirm : stepOnly === 2

  const environment = getEnvironment()
  const networkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'

  const deploymentFileName =
    environment === EnvironmentEnum.production
      ? 'tron.json'
      : 'tron.staging.json'
  const deploymentPath = path.join(
    process.cwd(),
    'deployments',
    deploymentFileName
  )

  if (!fs.existsSync(deploymentPath))
    throw new Error(
      `deployments/${deploymentFileName} not found. Please deploy contracts first.`
    )

  const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
  const diamondAddress = deployments.LiFiDiamond
  const timelockAddress = deployments.LiFiTimelockController

  if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')
  if (!timelockAddress || typeof timelockAddress !== 'string')
    throw new Error(
      `LiFiTimelockController not found in deployments/${deploymentFileName}`
    )

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

  // ---- Step 1: transferOwnership (current owner → Timelock from deployments) ----
  if (runStep1) {
    const privateKey =
      options.currentOwnerPrivateKey ||
      (networkName === 'tron'
        ? getEnvVar('PRIVATE_KEY_PRODUCTION')
        : getPrivateKeyForEnvironment(environment))
    const tronWeb = createTronWeb({
      rpcUrl: fullHost,
      networkKey: networkName as TronTvmNetworkName,
      privateKey,
    })

    if (options.currentOwnerPrivateKey)
      consola.info('   Using provided current owner private key')

    consola.info(`   Deployments file: deployments/${deploymentFileName}`)
    consola.info(` Connected to: ${fullHost}`)
    consola.info(`👛 Current owner (signer): ${tronWeb.defaultAddress.base58}`)
    consola.info(`🔷 LiFiDiamond: ${diamondAddress}`)
    const timelockBase58 = formatAddressForNetworkCliDisplay(
      networkName,
      timelockAddress
    )
    consola.info(`🎯 New owner (LiFiTimelockController): ${timelockBase58}`)

    const diamond = tronWeb.contract(ownershipABI, diamondAddress)

    consola.info('\n📋 Checking current owner...')
    const currentOwnerRaw = await diamond.owner().call()
    const currentOwnerBase58 = tronAddressLikeToBase58(tronWeb, currentOwnerRaw)
    consola.info(`   Current owner (base58): ${currentOwnerBase58}`)

    if (currentOwnerBase58 !== tronWeb.defaultAddress.base58) {
      consola.warn(
        `   ⚠️  Warning: Signer (${tronWeb.defaultAddress.base58}) is not the current owner (${currentOwnerBase58}).`
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
      consola.success('   ✅ Signer matches current owner.')
    }

    if (!tronWeb.isAddress(timelockBase58))
      throw new Error(
        `Invalid LiFiTimelockController in deployments: ${timelockAddress}`
      )
    if (currentOwnerBase58 === timelockBase58)
      throw new Error(
        'Diamond owner is already the Timelock; step 1 not needed.'
      )

    consola.info(
      '\n📤 Step 1: Initiating ownership transfer (transferOwnership → Timelock)...'
    )

    if (options.dryRun) {
      consola.info(
        `   [DRY RUN] Would call transferOwnership(${timelockBase58})`
      )
      consola.info(
        '   Then run with --step 2 or re-run with --confirm for step 2.'
      )
      return
    }

    await waitBetweenDeployments(
      options.delaySeconds ?? 0,
      options.verbose ?? false
    )

    try {
      const tx = await diamond.transferOwnership(timelockBase58).send({
        feeLimit: 10_000_000,
        shouldPollResponse: true,
      })
      consola.success('   ✅ Ownership transfer initiated.')
      consola.info(`   Transaction: ${tx}`)
      if (!runStep2)
        consola.info(
          `   Next: run with --step 2 (Safe proposal for Timelock → confirmOwnershipTransfer).`
        )
    } catch (error: any) {
      consola.error(`   ❌ Transfer failed: ${error.message || error}`)
      if (error.error) consola.error('   Error details:', error.error)
      throw error
    }
  }

  // ---- Step 2: Timelock must call confirmOwnershipTransfer — propose via Safe → MongoDB ----
  if (runStep2) {
    const timelockBase58 = formatAddressForNetworkCliDisplay(
      networkName,
      timelockAddress
    )

    consola.info(
      '\n📥 Step 2: confirmOwnershipTransfer (via Safe proposal for Timelock)...'
    )
    consola.info(`   Deployments file: deployments/${deploymentFileName}`)
    consola.info(`   Diamond: ${diamondAddress}`)
    consola.info(`   Expected pending owner (Timelock): ${timelockBase58}`)

    if (!options.noPropose) {
      consola.info(
        '\n   Creating Safe proposal (propose-to-safe-tron) and storing in MongoDB...'
      )
      await runPropose({ dryRun: options.dryRun })
      return
    }

    consola.info(
      '\n   Timelock must call confirmOwnershipTransfer() on the Diamond.'
    )
    consola.info(
      `   Calldata (no args): ${TRON_DIAMOND_CONFIRM_OWNERSHIP_SELECTOR} (verify: cast sig 'confirmOwnershipTransfer()')`
    )
    consola.info(
      `   (--noPropose) Propose manually: schedule Timelock operation → target: Diamond, data: ${TRON_DIAMOND_CONFIRM_OWNERSHIP_SELECTOR}, then execute after delay.`
    )
  }
}

const main = defineCommand({
  meta: {
    name: 'transfer-ownership-to-timelock',
    description:
      'Transfer Tron Diamond ownership to LiFiTimelockController from deployments/tron.json (production) or deployments/tron.staging.json (staging). Use --step 1 | 2.',
  },
  args: {
    step: {
      type: 'string',
      description:
        'Run only step 1 (transferOwnership to Timelock) or step 2 (Safe proposal for confirmOwnershipTransfer). Omit step 1 only; add --confirm to also run step 2 in one invocation.',
      default: undefined,
    },
    noPropose: {
      type: 'boolean',
      description:
        'With --step 2: skip MongoDB Safe proposal; print calldata / manual instructions only.',
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
        'When --step is omitted, also run step 2 after step 1 (Safe proposal to MongoDB).',
      default: false,
    },
    currentOwnerPrivateKey: {
      type: 'string',
      description:
        'Private key of the current Diamond owner (default: deployer from env). Used for --step 1.',
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
      step?: 1 | 2
      noPropose?: boolean
      dryRun?: boolean
      confirm?: boolean
      currentOwnerPrivateKey?: string
      delaySeconds?: number
      verbose?: boolean
    } = {
      step: stepNum,
      noPropose: args.noPropose,
      dryRun: args.dryRun,
      confirm: args.confirm,
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

    if (stepNum === 2 && !args.noPropose) {
      consola.info(
        '--step 2: creating Safe proposal in MongoDB by default (use --noPropose for instructions only).'
      )
    }

    consola.start(
      stepNum === 1
        ? 'Running step 1 (transferOwnership → Timelock)...'
        : stepNum === 2
        ? 'Running step 2 (Safe proposal: Timelock → confirmOwnershipTransfer)...'
        : 'Starting transfer of Diamond ownership to Timelock...'
    )

    try {
      await transferOwnershipToTimelock(options)
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

export { transferOwnershipToTimelock }
