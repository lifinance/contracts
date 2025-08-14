#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import type { SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import {
  getEnvVar,
  getPrivateKeyForEnvironment,
} from '../../demoScripts/utils/demoScriptHelpers'

import { TronContractDeployer } from './TronContractDeployer'
import { MIN_BALANCE_WARNING } from './constants'
import type { ITronDeploymentConfig, IDeploymentResult } from './types'
import {
  getContractVersion,
  getEnvironment,
  getNetworkConfig,
  getContractAddress,
  checkExistingDeployment,
  deployContractWithLogging,
  registerFacetToDiamond,
  confirmDeployment,
  printDeploymentSummary,
  validateBalance,
  displayNetworkInfo,
  displayRegistrationInfo,
  getFacetSelectors,
  hexToTronAddress,
} from './utils.js'

/**
 * Deploy and register AllBridgeFacet to Tron
 */
async function deployAndRegisterAllBridgeFacet(options: { dryRun?: boolean }) {
  consola.start('TRON AllBridgeFacet Deployment & Registration')

  // Get environment from config.sh
  const environment = await getEnvironment()

  // Load environment variables
  const dryRun = options.dryRun ?? false
  let verbose = true

  try {
    verbose = getEnvVar('VERBOSE') !== 'false'
  } catch (error) {
    // Use default value when environment variable is not set
    consola.debug('VERBOSE environment variable not set, using default value')
  }

  // Get network configuration from networks.json
  // Use tron-shasta for staging/testnet, tron for production
  const networkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tron-shasta'
  let tronConfig
  try {
    tronConfig = getNetworkConfig(networkName as SupportedChain)
  } catch (error: any) {
    consola.error(error.message)
    consola.error(
      `Please ensure "${networkName}" network is configured in config/networks.json`
    )
    process.exit(1)
  }

  const network = networkName as SupportedChain
  const rpcUrl = tronConfig.rpcUrl

  // Get the correct private key based on environment
  let privateKey: string
  try {
    privateKey = getPrivateKeyForEnvironment(environment)
  } catch (error: any) {
    consola.error(error.message)
    consola.error(
      `Please ensure ${
        environment === EnvironmentEnum.production
          ? 'PRIVATE_KEY_PRODUCTION'
          : 'PRIVATE_KEY'
      } is set in your .env file`
    )
    process.exit(1)
  }

  // Initialize deployer
  const config: ITronDeploymentConfig = {
    fullHost: rpcUrl,
    privateKey,
    verbose,
    dryRun,
    safetyMargin: 1.5,
    maxRetries: 3,
    confirmationTimeout: 120000,
  }

  const deployer = new TronContractDeployer(config)

  try {
    // Get network info
    const networkInfo = await deployer.getNetworkInfo()

    // Use new utility for network info display
    displayNetworkInfo(networkInfo, environment, network)

    // Initialize TronWeb
    const tronWeb = new TronWeb({
      fullHost: rpcUrl,
      privateKey,
    })

    // Use new utility for balance validation
    await validateBalance(tronWeb, MIN_BALANCE_WARNING)

    // Load AllBridge configuration
    const allbridgeConfig = await Bun.file('config/allbridge.json').json()
    const allBridgeAddress = allbridgeConfig.tron?.allBridge

    if (!allBridgeAddress)
      throw new Error(
        'AllBridge address not found for tron in config/allbridge.json'
      )

    // Convert address to Tron format for display
    const allBridgeTron = hexToTronAddress(allBridgeAddress, tronWeb)

    consola.info('\nAllBridge Configuration:')
    consola.info(`AllBridge: ${allBridgeTron} (hex: ${allBridgeAddress})`)

    // Prepare deployment plan
    const contracts = ['AllBridgeFacet']

    // Use new utility for confirmation
    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []

    // Deploy AllBridgeFacet
    consola.info('\nDeploying AllBridgeFacet...')

    const { exists, address, shouldRedeploy } = await checkExistingDeployment(
      'tron',
      'AllBridgeFacet',
      dryRun
    )

    let facetAddress: string
    if (exists && !shouldRedeploy && address) {
      facetAddress = address
      deploymentResults.push({
        contract: 'AllBridgeFacet',
        address: address,
        txId: 'existing',
        cost: 0,
        version: await getContractVersion('AllBridgeFacet'),
        status: 'existing',
      })
    } else
      try {
        // Constructor arguments for AllBridgeFacet
        const constructorArgs = [allBridgeAddress]

        // Deploy using new utility
        const result = await deployContractWithLogging(
          deployer,
          'AllBridgeFacet',
          constructorArgs,
          dryRun
        )

        facetAddress = result.address
        deploymentResults.push(result)
      } catch (error: any) {
        consola.error('Failed to deploy AllBridgeFacet:', error.message)
        deploymentResults.push({
          contract: 'AllBridgeFacet',
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version: '0.0.0',
          status: 'failed',
        })
        printDeploymentSummary(deploymentResults, dryRun)
        process.exit(1)
      }

    // Register to Diamond
    consola.info('\nRegistering AllBridgeFacet to Diamond...')

    // Get diamond address
    const diamondAddress = await getContractAddress('tron', 'LiFiDiamond')
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    // Get selectors for display
    const selectors = await getFacetSelectors('AllBridgeFacet')

    // Display registration info
    displayRegistrationInfo(
      'AllBridgeFacet',
      facetAddress,
      diamondAddress,
      selectors
    )

    // Register using new utility
    const registrationResult = await registerFacetToDiamond(
      'AllBridgeFacet',
      facetAddress,
      tronWeb,
      network,
      dryRun
    )

    if (registrationResult.success) {
      consola.success('AllBridgeFacet registered successfully!')
      if (registrationResult.transactionId)
        consola.info(`Transaction: ${registrationResult.transactionId}`)
    } else {
      consola.error(
        'Failed to register AllBridgeFacet:',
        registrationResult.error
      )
      process.exit(1)
    }

    // Print summary
    printDeploymentSummary(deploymentResults, dryRun)

    consola.success('\nDeployment and registration completed successfully!')
  } catch (error: any) {
    consola.error('Deployment failed:', error.message)
    if (error.stack) consola.error(error.stack)
    process.exit(1)
  }
}

// Define CLI command
const main = defineCommand({
  meta: {
    name: 'deploy-and-register-allbridge-facet',
    description: 'Deploy and register AllBridgeFacet to Tron Diamond',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
      default: false,
    },
  },
  async run({ args }) {
    await deployAndRegisterAllBridgeFacet({
      dryRun: args.dryRun,
    })
  },
})

// Run the command
runMain(main)
