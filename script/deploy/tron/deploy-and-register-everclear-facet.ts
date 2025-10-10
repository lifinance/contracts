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
import { getRPCEnvVarName } from '../../utils/network'

import { TronContractDeployer } from './TronContractDeployer'
import { MIN_BALANCE_WARNING } from './constants'
import type { ITronDeploymentConfig, IDeploymentResult } from './types'
import {
  getContractVersion,
  getEnvironment,
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
} from './utils'

/**
 * Deploy and register EverclearFacet to Tron
 */
async function deployAndRegisterEverclearFacet(options: { dryRun?: boolean }) {
  consola.start('TRON EverclearFacet Deployment & Registration')

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
  // Use tronshasta for staging/testnet, tron for production
  const networkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'

  const network = networkName as SupportedChain

  // Get RPC URL from environment variable
  const envVarName = getRPCEnvVarName(network)
  const rpcUrl = getEnvVar(envVarName)

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

    // Load Everclear configuration
    const everclearConfig = await Bun.file('config/everclear.json').json()

    // For Tron, we need to check if there's a specific config or use mainnet as fallback
    const tronEverclearConfig = everclearConfig.tron || everclearConfig.mainnet

    if (!tronEverclearConfig)
      throw new Error('Tron configuration not found in config/everclear.json')

    const feeAdapter = tronEverclearConfig.feeAdapter

    if (!feeAdapter)
      throw new Error(
        'Everclear feeAdapter not found for tron in config/everclear.json'
      )

    // Convert address to Tron format for display
    const feeAdapterTron = hexToTronAddress(feeAdapter, tronWeb)

    consola.info('\nEverclear Configuration:')
    consola.info(`FeeAdapter: ${feeAdapterTron} (hex: ${feeAdapter})`)

    // Prepare deployment plan
    const contracts = ['EverclearFacet']

    // Use new utility for confirmation
    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []

    // Deploy EverclearFacet
    consola.info('\nDeploying EverclearFacet...')

    const { exists, address, shouldRedeploy } = await checkExistingDeployment(
      network,
      'EverclearFacet',
      dryRun
    )

    let facetAddress: string
    if (exists && !shouldRedeploy && address) {
      facetAddress = address
      deploymentResults.push({
        contract: 'EverclearFacet',
        address: address,
        txId: 'existing',
        cost: 0,
        version: await getContractVersion('EverclearFacet'),
        status: 'existing',
      })
    } else
      try {
        // Constructor arguments for EverclearFacet
        const constructorArgs = [feeAdapter]

        // Deploy using new utility
        const result = await deployContractWithLogging(
          deployer,
          'EverclearFacet',
          constructorArgs,
          dryRun,
          network
        )

        facetAddress = result.address
        deploymentResults.push(result)
      } catch (error: any) {
        consola.error('Failed to deploy EverclearFacet:', error.message)
        deploymentResults.push({
          contract: 'EverclearFacet',
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
    consola.info('\nRegistering EverclearFacet to Diamond...')

    // Get diamond address
    const diamondAddress = await getContractAddress(network, 'LiFiDiamond')
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    // Get selectors for display
    const selectors = await getFacetSelectors('EverclearFacet')

    // Display registration info
    displayRegistrationInfo(
      'EverclearFacet',
      facetAddress,
      diamondAddress,
      selectors
    )

    // Register using new utility
    const registrationResult = await registerFacetToDiamond(
      'EverclearFacet',
      facetAddress,
      tronWeb,
      rpcUrl,
      dryRun,
      network
    )

    if (registrationResult.success) {
      consola.success('EverclearFacet registered successfully!')
      if (registrationResult.transactionId)
        consola.info(`Transaction: ${registrationResult.transactionId}`)
    } else {
      consola.error(
        'Failed to register EverclearFacet:',
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
    name: 'deploy-and-register-everclear-facet',
    description: 'Deploy and register EverclearFacet to Tron Diamond',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
      default: false,
    },
  },
  async run({ args }) {
    await deployAndRegisterEverclearFacet({
      dryRun: args.dryRun,
    })
  },
})

// Run the command
runMain(main)
