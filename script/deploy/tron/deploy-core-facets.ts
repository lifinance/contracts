#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

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
  getCoreFacets,
  saveDiamondDeployment,
  getContractVersion,
  getEnvironment,
  getNetworkConfig,
  checkExistingDeployment,
  deployContractWithLogging,
  confirmDeployment,
  printDeploymentSummary,
  validateBalance,
  displayNetworkInfo,
  updateDiamondJsonBatch,
} from './utils.js'

/**
 * Get constructor arguments for a facet
 */
async function getConstructorArgs(
  facetName: string,
  network: string,
  privateKey: string
): Promise<any[]> {
  if (facetName === 'EmergencyPauseFacet') {
    // EmergencyPauseFacet requires pauserWallet address
    const globalConfig = await Bun.file('config/global.json').json()
    const pauserWallet = globalConfig.pauserWallet // This is 0x...

    if (!pauserWallet)
      throw new Error('pauserWallet not found in config/global.json')

    // TronWeb expects the base58 address format for constructor parameters
    // It will handle the conversion internally
    const tronWeb = (await import('tronweb')).TronWeb
    const networksConfig = await Bun.file('config/networks.json').json()
    const networkRpcUrl = networksConfig[network]?.rpcUrl
    if (!networkRpcUrl)
      throw new Error(
        `RPC URL not found for ${network} in config/networks.json`
      )
    const tronWebInstance = new tronWeb({
      fullHost: networkRpcUrl,
      privateKey,
    })
    const tronHexAddress = pauserWallet.replace('0x', '41')
    const tronBase58 = tronWebInstance.address.fromHex(tronHexAddress)

    // Use original hex format (0x...) for constructor args
    // The ABI encoder needs this format for proper encoding
    consola.info(`Using pauserWallet: ${tronBase58} (hex: ${pauserWallet})`)
    return [pauserWallet]
  } else if (facetName === 'GenericSwapFacetV3') {
    // GenericSwapFacetV3 requires native token address
    const networksConfig = await Bun.file('config/networks.json').json()
    const nativeAddress = networksConfig[network]?.nativeAddress

    if (!nativeAddress)
      throw new Error(
        'nativeAddress not found for tron in config/networks.json'
      )
    // For display purposes
    const tronWeb = (await import('tronweb')).TronWeb
    const networksConfig2 = await Bun.file('config/networks.json').json()
    const networkRpcUrl2 = networksConfig2[network]?.rpcUrl
    if (!networkRpcUrl2)
      throw new Error(
        `RPC URL not found for ${network} in config/networks.json`
      )
    const tronWebInstance = new tronWeb({
      fullHost: networkRpcUrl2,
      privateKey,
    })
    const tronNativeAddress =
      nativeAddress === '0x0000000000000000000000000000000000000000'
        ? tronWebInstance.address.fromHex(
            '410000000000000000000000000000000000000000'
          )
        : tronWebInstance.address.fromHex(nativeAddress.replace('0x', '41'))

    // Use original hex format (0x...) for constructor args
    consola.info(
      `Using nativeAddress: ${tronNativeAddress} (hex: ${nativeAddress})`
    )
    return [nativeAddress]
  }

  return []
}

/**
 * Deploy core facets implementation
 */
async function deployCoreFacetsImpl(options: {
  dryRun: boolean
  verbose: boolean
}) {
  consola.start('TRON Core Facets Deployment')

  // Get environment from config.sh
  const environment = await getEnvironment()

  // Get network configuration from networks.json
  // Use tron-shasta for staging/testnet, tron for production
  const networkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tron-shasta'
  let tronConfig
  try {
    tronConfig = getNetworkConfig(networkName as SupportedChain)
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    consola.error(errorMessage)
    consola.error(
      `Please ensure "${networkName}" network is configured in config/networks.json`
    )
    process.exit(1)
  }

  const network = networkName as SupportedChain // Use network name, not RPC URL
  const rpcUrl = tronConfig.rpcUrl // Keep RPC URL for TronWeb initialization

  // Get the correct private key based on environment
  let privateKey: string
  try {
    privateKey = getPrivateKeyForEnvironment(environment)
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    consola.error(errorMessage)
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
    verbose: options.verbose,
    dryRun: options.dryRun,
    safetyMargin: 1.5,
    maxRetries: 3,
    confirmationTimeout: 120000,
  }

  const deployer = new TronContractDeployer(config)

  // Get network info
  const networkInfo = await deployer.getNetworkInfo()
  displayNetworkInfo(networkInfo, environment, rpcUrl)

  // Initialize TronWeb for balance validation
  const { TronWeb } = await import('tronweb')
  const tronWeb = new TronWeb({
    fullHost: rpcUrl,
    privateKey,
  })

  // Validate balance
  await validateBalance(tronWeb, MIN_BALANCE_WARNING)

  // Get core facets list
  const coreFacets = getCoreFacets()

  // Add LiFiDiamond to the contracts list for confirmation
  const allContracts = [...coreFacets, 'LiFiDiamond']

  // Confirm deployment FIRST
  const shouldContinue = await confirmDeployment(
    environment,
    network,
    allContracts
  )
  if (!shouldContinue) {
    consola.info('Deployment cancelled')
    process.exit(0)
  }

  // Now check for existing deployments (sequentially to avoid event listener warnings)
  consola.info(`\nCore facets to deploy: ${coreFacets.length}`)
  coreFacets.forEach((facet, i) => {
    consola.info(`  ${i + 1}. ${facet}`)
  })

  const existingDeployments = []
  for (const facet of coreFacets) {
    const deployment = await checkExistingDeployment(
      network,
      facet,
      options.dryRun
    )
    existingDeployments.push(deployment)
  }

  const hasExisting = existingDeployments.some((d) => d.exists)
  if (hasExisting) {
    consola.info('\nExisting deployments found:')
    existingDeployments.forEach((d, index) => {
      if (d.exists) consola.info(`  ✓ ${coreFacets[index]}: ${d.address}`)
    })
  }
  // Deploy facets
  const deploymentResults: IDeploymentResult[] = []
  const facetAddresses: Record<string, { address: string; version: string }> =
    {}

  for (let i = 0; i < coreFacets.length; i++) {
    const facet = coreFacets[i]
    if (!facet) continue

    const existing = existingDeployments[i]

    // Check if already deployed and not requesting redeploy
    if (existing?.exists && existing.address && !existing.shouldRedeploy) {
      consola.info(`\n⏭️  Skipping ${facet} (already deployed)`)
      const version = await getContractVersion(facet)
      deploymentResults.push({
        contract: facet,
        address: existing.address,
        version,
        txId: '',
        cost: 0,
        status: 'existing',
      })
      facetAddresses[facet] = {
        address: existing.address,
        version,
      }
      continue
    }
    consola.info(`\n📦 Deploying ${facet}...`)

    try {
      // Get constructor arguments
      const constructorArgs = await getConstructorArgs(
        facet,
        network,
        privateKey
      )

      // Deploy the facet
      const result = await deployContractWithLogging(
        deployer,
        facet,
        constructorArgs,
        options.dryRun,
        network
      )

      deploymentResults.push(result)

      if (result.status === 'success' && result.address) 
        facetAddresses[facet] = {
          address: result.address,
          version: result.version,
        }
        // Note: deployContractWithLogging already handles saving addresses and logging
      
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(`Failed to deploy ${facet}: ${errorMessage}`)
      deploymentResults.push({
        contract: facet,
        address: '',
        version: '',
        txId: '',
        cost: 0,
        status: 'failed',
      })
    }
  }

  // Deploy LiFiDiamond
  const diamondName = 'LiFiDiamond'
  consola.info(`\n💎 Deploying ${diamondName}...`)

  const existingDiamond = await checkExistingDeployment(
    network,
    diamondName,
    options.dryRun
  )
  if (
    existingDiamond.exists &&
    existingDiamond.address &&
    !existingDiamond.shouldRedeploy
  ) {
    consola.info(`⏭️  Skipping ${diamondName} (already deployed)`)
    const version = await getContractVersion(diamondName)
    deploymentResults.push({
      contract: diamondName,
      address: existingDiamond.address,
      version,
      txId: '',
      cost: 0,
      status: 'existing',
    })
  } else
    try {
      // Get owner address (deployer address)
      const ownerAddress = networkInfo.address

      // Convert to hex format for constructor
      const { TronWeb } = await import('tronweb')
      const tronWeb = new TronWeb({
        fullHost: rpcUrl,
        privateKey,
      })
      const ownerHexRaw = tronWeb.address.toHex(ownerAddress)
      const ownerHex = ownerHexRaw.startsWith('0x')
        ? ownerHexRaw
        : `0x${ownerHexRaw}`

      consola.info(`Using owner address: ${ownerAddress} (hex: ${ownerHex})`)

      // Deploy the Diamond
      const result = await deployContractWithLogging(
        deployer,
        diamondName,
        [ownerHex], // Pass owner address as constructor argument
        options.dryRun,
        network
      )

      deploymentResults.push(result)

      if (result.status === 'success' && result.address)
        if (!options.dryRun) {
          // Note: deployContractWithLogging already handles saving addresses and logging
          // Save diamond-specific deployment info
          await saveDiamondDeployment(network, result.address, facetAddresses)

          // Update diamond JSON files
          const facetEntries = Object.entries(facetAddresses).map(
            ([name, data]) => ({
              name,
              address: data.address,
              version: data.version,
            })
          )
          await updateDiamondJsonBatch(facetEntries, network)
        }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error(`Failed to deploy ${diamondName}: ${errorMessage}`)
      deploymentResults.push({
        contract: diamondName,
        address: '',
        version: '',
        txId: '',
        cost: 0,
        status: 'failed',
      })
    }

  // If diamond already existed, still update the diamond JSON with facet addresses
  if (existingDiamond.exists && existingDiamond.address && !options.dryRun) {
    // Update diamond JSON files
    const facetEntries = Object.entries(facetAddresses).map(([name, data]) => ({
      name,
      address: data.address,
      version: data.version,
    }))
    await updateDiamondJsonBatch(facetEntries, 'tron')
  }

  // Use new utility for summary
  printDeploymentSummary(deploymentResults, options.dryRun)

  // Exit with appropriate code
  const hasFailures = deploymentResults.some((r) => r.status === 'failed')
  process.exit(hasFailures ? 1 : 0)
}

const deployCommand = defineCommand({
  meta: {
    name: 'deploy-core-facets',
    description: 'Deploy core facets to Tron network',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Simulate deployment without executing',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Enable verbose logging',
      default: true,
    },
  },
  async run({ args }) {
    try {
      // Also check environment variables for backward compatibility
      let dryRun = args.dryRun
      let verbose = args.verbose

      try {
        if (!dryRun) dryRun = getEnvVar('DRY_RUN') === 'true'
      } catch {
        // Use default value
      }

      try {
        if (!verbose) verbose = getEnvVar('VERBOSE') !== 'false'
      } catch {
        // Use default value
      }

      await deployCoreFacetsImpl({
        dryRun,
        verbose,
      })
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      const errorStack = error instanceof Error ? error.stack : undefined
      consola.error('Deployment failed:', errorMessage)
      if (errorStack) consola.error(errorStack)
      process.exit(1)
    }
  },
})

// Run the command
runMain(deployCommand)
