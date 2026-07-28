#!/usr/bin/env bun

import {
  TronContractDeployer,
  createTronWeb,
  tronAddressToHex,
  type ITronDeploymentConfig,
  type TronTvmNetworkName,
} from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import type { IDeploymentResult, SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import {
  getEnvVar,
  getRPCEnvVarName,
  getEnvironment,
  getContractAddress,
  checkExistingDeployment,
  confirmDeployment,
  printDeploymentSummary,
  displayNetworkInfo,
  displayRegistrationInfo,
  getFacetSelectors,
} from '../../utils/utils'
import { getContractVersion } from '../shared/getContractVersion'
import { proposeDiamondCut } from '../shared/propose-diamond-cut'

import {
  ALLBRIDGE_INIT_SELECTOR,
  encodeAllBridgeInitCalldata,
  parseAllBridgeMappings,
} from './helpers/allBridgeInit'
import { deployContractWithLogging, validateBalance } from './tronUtils'

/**
 * Deploy and register AllBridgeFacet to Tron
 */
async function deployAndRegisterAllBridgeFacet(options: { dryRun?: boolean }) {
  consola.start('TRON AllBridgeFacet Deployment & Registration')

  const environment = getEnvironment()

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
    tvmNetworkKey: networkName as TronTvmNetworkName,
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
    displayNetworkInfo(networkInfo, environment, rpcUrl)

    // Initialize TronWeb
    const tronWeb = createTronWeb({
      rpcUrl,
      networkKey: networkName as TronTvmNetworkName,
      privateKey,
    })

    // Use new utility for balance validation
    // Pre-flight balance check: warn on low balances but do not abort here
    await validateBalance(tronWeb, 0)
    // Load AllBridge configuration. Kept as raw text as well, because the
    // chain-id mappings must be revived from the JSON source (see allBridgeInit)
    const allbridgeConfigJson = await Bun.file('config/allbridge.json').text()
    const allbridgeConfig = JSON.parse(allbridgeConfigJson)
    const allBridgeAddress = allbridgeConfig[network]?.allBridge

    if (!allBridgeAddress)
      throw new Error(
        `AllBridge address not found for ${network} in config/allbridge.json`
      )

    // Convert Base58 address to hex format with 0x prefix for constructor arguments
    const allBridgeAddressHex = tronAddressToHex(tronWeb, allBridgeAddress)

    // Encode the post-cut initializer up front: a malformed `mappings` array
    // should abort before anything is deployed, not after
    const chainIdMappings = parseAllBridgeMappings(allbridgeConfigJson)
    const initCalldata = encodeAllBridgeInitCalldata(chainIdMappings)

    consola.info('\nAllBridge Configuration:')
    consola.info(`AllBridge: ${allBridgeAddress} (${allBridgeAddressHex})`)
    consola.info(`Chain-id mappings to seed: ${chainIdMappings.length}`)
    for (const { chainId, allBridgeChainId } of chainIdMappings)
      consola.info(`   ${chainId} -> ${allBridgeChainId}`)

    // Prepare deployment plan
    const contracts = ['AllBridgeFacet']

    // Use new utility for confirmation
    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []

    // Deploy AllBridgeFacet
    consola.info('\nDeploying AllBridgeFacet...')

    const { exists, address, shouldRedeploy } = await checkExistingDeployment(
      network,
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
        // Constructor arguments for AllBridgeFacet - use hex format
        const constructorArgs = [allBridgeAddressHex]

        // Deploy using new utility
        const result = await deployContractWithLogging(
          deployer,
          'AllBridgeFacet',
          constructorArgs,
          dryRun,
          network
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

    consola.info('\nProposing AllBridgeFacet diamondCut to Safe...')

    const diamondAddress = await getContractAddress(network, 'LiFiDiamond')
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    // `initAllBridge` is delegatecalled by the cut and must not be registered
    // on the diamond — mirrors UpdateAllBridgeFacet.getExcludes() on EVM
    const excludeSelectors = [ALLBRIDGE_INIT_SELECTOR]

    const selectors = await getFacetSelectors(
      'AllBridgeFacet',
      excludeSelectors
    )

    displayRegistrationInfo(
      'AllBridgeFacet',
      facetAddress,
      diamondAddress,
      selectors
    )

    const facetAddressHex = tronAddressToHex(
      tronWeb,
      facetAddress
    ) as `0x${string}`

    if (!dryRun)
      await proposeDiamondCut({
        facetName: 'AllBridgeFacet',
        facetAddressHex,
        diamondAddress,
        network: network,
        excludeSelectors,
        // The initializer rides inside the cut (delegatecalled by the diamond),
        // so the facet is never live-but-uninitialised — same shape as the
        // `_init`/`_calldata` pair UpdateScriptBase passes on EVM
        init: { initAddress: facetAddressHex, initCalldata },
      })
    else
      consola.info('Dry run - skipping diamondCut proposal for AllBridgeFacet')

    printDeploymentSummary(deploymentResults, dryRun)

    consola.success(
      dryRun
        ? '\nDry run completed successfully! (no Safe tx created)'
        : '\nDeployment and proposal completed successfully!'
    )
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
