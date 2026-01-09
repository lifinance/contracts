/**
 * CLI wrapper for sendOrPropose function
 *
 * This script provides a command-line interface to the sendOrPropose function
 * from safeScriptHelpers.ts, with support for timelock wrapping.
 */

import 'dotenv/config'

import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { getAddress } from 'viem'

import { EnvironmentEnum } from '../../common/types'
import { sendOrPropose } from '../../safe/safeScriptHelpers'

import { wrapWithTimelockSchedule } from './safe-utils'

/**
 * Main command definition
 */
const main = defineCommand({
  meta: {
    name: 'send-or-propose',
    description:
      'Send transaction directly (staging) or propose to Safe (production)',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'Environment (production or staging)',
      required: true,
    },
    diamondAddress: {
      type: 'string',
      description: 'Diamond contract address',
      required: true,
    },
    calldata: {
      type: 'string',
      description: 'Transaction calldata (hex string starting with 0x)',
      required: true,
    },
    timelock: {
      type: 'boolean',
      description:
        'Wrap transaction in timelock schedule call (production only)',
      required: false,
    },
  },
  async run({ args }) {
    // Validate environment
    const environment = args.environment.toLowerCase()
    if (environment !== 'production' && environment !== 'staging') {
      throw new Error(
        `Invalid environment: ${args.environment}. Must be 'production' or 'staging'`
      )
    }

    const typedEnv =
      environment === 'production'
        ? EnvironmentEnum.production
        : EnvironmentEnum.staging

    // Validate calldata format
    if (!args.calldata.startsWith('0x')) {
      throw new Error('Calldata must start with 0x')
    }

    let finalCalldata = args.calldata as `0x${string}`
    let finalTarget = args.diamondAddress

    // Handle timelock wrapping if requested (production only)
    if (args.timelock && typedEnv === EnvironmentEnum.production) {
      // Get timelock controller address from deployment logs
      const deploymentPath = path.join(
        process.cwd(),
        'deployments',
        `${args.network}.json`
      )

      if (!fs.existsSync(deploymentPath)) {
        throw new Error(`Deployment file not found: ${deploymentPath}`)
      }

      const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
      const timelockAddress = deployments.LiFiTimelockController

      if (!timelockAddress || timelockAddress === '0x') {
        throw new Error(
          `LiFiTimelockController not found in deployments for network ${args.network}`
        )
      }

      consola.info(`Using timelock controller at ${timelockAddress}`)

      const wrappedTransaction = await wrapWithTimelockSchedule(
        args.network,
        '', // rpcUrl will fall back to chain.rpcUrls.default.http[0] in wrapWithTimelockSchedule
        getAddress(timelockAddress),
        getAddress(args.diamondAddress),
        finalCalldata
      )

      finalTarget = wrappedTransaction.targetAddress
      finalCalldata = wrappedTransaction.calldata
    }

    // Call sendOrPropose
    await sendOrPropose({
      calldata: finalCalldata,
      network: args.network,
      environment: typedEnv,
      diamondAddress: finalTarget,
    })
  },
})

runMain(main)
