#!/usr/bin/env bun

/**
 * Query Safe Owners
 *
 * This script queries the Safe contract on a given network to get the list of owners.
 */

import 'dotenv/config'

import { consola } from 'consola'
import type { Address } from 'viem'

import networks from '../config/networks.json'

import { EnvironmentEnum, type SupportedChain } from './common/types'
import { setupEnvironment } from './demoScripts/utils/demoScriptHelpers'
import { getSafeInfoFromContract } from './deploy/safe/safe-utils'

// Get network from command line or default to moonriver
const networkName = (
  process.argv[2] || 'moonriver'
).toLowerCase() as SupportedChain

// Get network config
const networkConfig = networks[networkName]
if (!networkConfig) {
  consola.error(`Network '${networkName}' not found in networks.json`)
  process.exit(1)
}

// Get Safe address
const safeAddress = networkConfig.safeAddress as Address | undefined
if (!safeAddress) {
  consola.error(`No Safe address configured for network '${networkName}'`)
  process.exit(1)
}

consola.info(`Network: ${networkName}`)
consola.info(`Chain ID: ${networkConfig.chainId}`)
consola.info(`Safe Address: ${safeAddress}`)
consola.info('')

// Setup viem client using setupEnvironment
consola.info('Setting up environment...')
try {
  const { publicClient } = await setupEnvironment(
    networkName,
    null, // No facet ABI needed
    EnvironmentEnum.production
  )

  // Query Safe contract
  consola.info('Querying Safe contract for owners...')
  const safeInfo = await getSafeInfoFromContract(publicClient, safeAddress)

  consola.success(`\n✅ Safe Owners (${safeInfo.owners.length}):`)
  safeInfo.owners.forEach((owner, index) => {
    consola.info(`  ${index + 1}. ${owner}`)
  })

  consola.info(`\n📊 Threshold: ${safeInfo.threshold}`)
  consola.info(`🔢 Nonce: ${safeInfo.nonce}`)
} catch (error) {
  consola.error('Failed to query Safe contract:', error)
  process.exit(1)
}
