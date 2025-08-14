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
 * Deploy and register SymbiosisFacet to Tron
 */
async function deployAndRegisterSymbiosisFacet(options: { dryRun?: boolean }) {
  consola.start('TRON SymbiosisFacet Deployment & Registration')

  // Get environment from config.sh
  const environment = await getEnvironment()

  // Load environment variables
  const dryRun = options.dryRun ?? false
  let verbose = true

  try {
    verbose = getEnvVar('VERBOSE') !== 'false'
  } catch {
    // Use default value
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

    // Load Symbiosis configuration
    const symbiosisConfig = await Bun.file('config/symbiosis.json').json()
    const tronSymbiosisConfig = symbiosisConfig.tron

    if (!tronSymbiosisConfig)
      throw new Error('Tron configuration not found in config/symbiosis.json')

    const metaRouter = tronSymbiosisConfig.metaRouter
    const gateway = tronSymbiosisConfig.gateway

    if (!metaRouter || !gateway)
      throw new Error(
        'Symbiosis metaRouter or gateway not found for tron in config/symbiosis.json'
      )

    // Convert addresses to Tron format for display
    const metaRouterTron = hexToTronAddress(metaRouter, tronWeb)
    const gatewayTron = hexToTronAddress(gateway, tronWeb)

    consola.info('\nSymbiosis Configuration:')
    consola.info(`MetaRouter: ${metaRouterTron} (hex: ${metaRouter})`)
    consola.info(`Gateway: ${gatewayTron} (hex: ${gateway})`)

    // Prepare deployment plan
    const contracts = ['SymbiosisFacet']

    // Use new utility for confirmation
    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []

    // Deploy SymbiosisFacet
    consola.info('\nDeploying SymbiosisFacet...')

    const { exists, address, shouldRedeploy } = await checkExistingDeployment(
      'tron',
      'SymbiosisFacet',
      dryRun
    )

    let facetAddress: string
    if (exists && !shouldRedeploy && address) {
      facetAddress = address
      deploymentResults.push({
        contract: 'SymbiosisFacet',
        address: address,
        txId: 'existing',
        cost: 0,
        version: await getContractVersion('SymbiosisFacet'),
        status: 'existing',
      })
    } else
      try {
        // Constructor arguments for SymbiosisFacet
        const constructorArgs = [metaRouter, gateway]

        // Deploy using new utility
        const result = await deployContractWithLogging(
          deployer,
          'SymbiosisFacet',
          constructorArgs,
          dryRun
        )

        facetAddress = result.address
        deploymentResults.push(result)
      } catch (error: any) {
        consola.error('Failed to deploy SymbiosisFacet:', error.message)
        deploymentResults.push({
          contract: 'SymbiosisFacet',
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
    consola.info('\nRegistering SymbiosisFacet to Diamond...')

    // Get diamond address
    const diamondAddress = await getContractAddress('tron', 'LiFiDiamond')
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    // Get selectors for display
    const selectors = await getFacetSelectors('SymbiosisFacet')

    // Display registration info
    displayRegistrationInfo(
      'SymbiosisFacet',
      facetAddress,
      diamondAddress,
      selectors
    )

    // Register using new utility
    const registrationResult = await registerFacetToDiamond(
      'SymbiosisFacet',
      facetAddress,
      tronWeb,
      network,
      dryRun
    )

    if (registrationResult.success) {
      consola.success('SymbiosisFacet registered successfully!')
      if (registrationResult.transactionId)
        consola.info(`Transaction: ${registrationResult.transactionId}`)
    } else {
      consola.error(
        'Failed to register SymbiosisFacet:',
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
    name: 'deploy-and-register-symbiosis-facet',
    description: 'Deploy and register SymbiosisFacet to Tron Diamond',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
      default: false,
    },
  },
  async run({ args }) {
    await deployAndRegisterSymbiosisFacet({
      dryRun: args.dryRun,
    })
  },
})

// Run the command
runMain(main)
