#!/usr/bin/env bun

import { consola } from 'consola'

import { getEnvVar } from '../../demoScripts/utils/demoScriptHelpers'

import { TronContractDeployer } from './TronContractDeployer'
import { MIN_BALANCE_WARNING } from './constants'
import type { ITronDeploymentConfig, IDeploymentResult } from './types'
import {
  loadForgeArtifact,
  getCoreFacets,
  saveDiamondDeployment,
  getContractVersion,
  getEnvironment,
  getPrivateKey,
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
    const tronWebInstance = new tronWeb({
      fullHost: network,
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
    const nativeAddress = networksConfig.tron?.nativeAddress

    if (!nativeAddress)
      throw new Error(
        'nativeAddress not found for tron in config/networks.json'
      )

    // For display purposes
    const tronWeb = (await import('tronweb')).TronWeb
    const tronWebInstance = new tronWeb({
      fullHost: network,
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
 * Deploy core facets to Tron
 */
async function deployCoreFacets() {
  consola.start('TRON Core Facets Deployment')

  // Get environment from config.sh
  const environment = await getEnvironment()

  // Load environment variables
  let dryRun = false
  let verbose = true // Default to true for debugging

  try {
    dryRun = getEnvVar('DRY_RUN') === 'true'
  } catch {
    // Use default value
  }

  try {
    verbose = getEnvVar('VERBOSE') !== 'false'
  } catch {
    // Use default value
  }

  // Get network configuration from networks.json
  let tronConfig
  try {
    tronConfig = getNetworkConfig('tron')
  } catch (error: any) {
    consola.error(error.message)
    consola.error(
      'Please ensure "tron" network is configured in config/networks.json'
    )
    process.exit(1)
  }

  const network = tronConfig.rpcUrl // Get the correct private key based on environment
  let privateKey: string
  try {
    privateKey = await getPrivateKey()
  } catch (error: any) {
    consola.error(error.message)
    consola.error(
      `Please ensure ${
        environment === 'production' ? 'PRIVATE_KEY_PRODUCTION' : 'PRIVATE_KEY'
      } is set in your .env file`
    )
    process.exit(1)
  }

  // Initialize deployer
  const config: ITronDeploymentConfig = {
    fullHost: network,
    privateKey,
    verbose,
    dryRun,
    // Energy configuration:
    // - feeLimit: Will be dynamically calculated per contract
    // - originEnergyLimit: Will be dynamically calculated per contract
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

    // Use new utility for balance validation
    const tronWeb = (await import('tronweb')).TronWeb
    const tronWebInstance = new tronWeb({
      fullHost: network,
      privateKey,
    })
    await validateBalance(tronWebInstance, MIN_BALANCE_WARNING)

    // Get core facets from config
    // Filter out GasZipFacet as it's not needed for Tron deployment
    const coreFacets = getCoreFacets().filter(
      (facet) => facet !== 'GasZipFacet'
    )

    // Prepare deployment plan
    const contracts = [...coreFacets, 'LiFiDiamond']

    // Use new utility for confirmation
    if (!(await confirmDeployment(environment, network, contracts)))
      process.exit(0)

    const deploymentResults: IDeploymentResult[] = []
    const deployedFacets: Record<string, string> = {}

    // Deploy each core facet
    for (const facetName of coreFacets) {
      consola.info(`\nDeploying ${facetName}...`)

      const { exists, address, shouldRedeploy } = await checkExistingDeployment(
        'tron',
        facetName,
        dryRun
      )

      if (exists && !shouldRedeploy && address) {
        deployedFacets[facetName] = address
        deploymentResults.push({
          contract: facetName,
          address: address,
          txId: 'existing',
          cost: 0,
          version: await getContractVersion(facetName),
          status: 'existing',
        })
        continue
      }

      try {
        // Get constructor arguments
        const constructorArgs = await getConstructorArgs(
          facetName,
          network,
          privateKey
        )

        // Deploy using new utility
        const result = await deployContractWithLogging(
          deployer,
          facetName,
          constructorArgs,
          dryRun
        )

        deployedFacets[facetName] = result.address
        deploymentResults.push(result)

        // Wait between deployments
        if (!dryRun) await Bun.sleep(3000)
      } catch (error: any) {
        consola.error(`Failed to deploy ${facetName}:`, error.message)
        deploymentResults.push({
          contract: facetName,
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version: '0.0.0',
          status: 'failed',
        })
        continue
      }
    }

    // Deploy LiFiDiamond
    consola.info('\nDeploying LiFiDiamond...')

    const { exists, address, shouldRedeploy } = await checkExistingDeployment(
      'tron',
      'LiFiDiamond',
      dryRun
    )

    if (!exists || shouldRedeploy)
      try {
        // Prepare facet cuts for diamond initialization
        const tronWeb = (await import('tronweb')).TronWeb
        const tronWebInstance = new tronWeb({
          fullHost: network,
          privateKey,
        })

        const facetCuts = []
        for (const [facetName, facetAddress] of Object.entries(
          deployedFacets
        )) {
          if (facetAddress === 'FAILED') continue

          const artifact = await loadForgeArtifact(facetName)
          const selectors = Object.values(
            artifact.methodIdentifiers as Record<string, string>
          ).map((selector) => '0x' + selector)

          // Convert Tron address to hex format for constructor
          const facetAddressHex = tronWebInstance.address
            .toHex(facetAddress)
            .replace(/^41/, '0x')

          facetCuts.push([facetAddressHex, 0, selectors])
        }

        // Get owner address
        const ownerAddress = tronWebInstance.defaultAddress.base58
        if (!ownerAddress)
          throw new Error('No default address found in TronWeb instance')

        const ownerHex = tronWebInstance.address
          .toHex(ownerAddress)
          .replace(/^41/, '0x')

        // Deploy diamond with facets
        const diamondArgs = [ownerHex, facetCuts]

        const result = await deployContractWithLogging(
          deployer,
          'LiFiDiamond',
          diamondArgs,
          dryRun
        )

        deploymentResults.push(result)

        // Save diamond deployment info
        if (!dryRun) {
          const facetsWithVersions: Record<
            string,
            { address: string; version: string }
          > = {}
          for (const [facetName, facetAddress] of Object.entries(
            deployedFacets
          ))
            if (facetAddress !== 'FAILED') {
              const version = await getContractVersion(facetName)
              facetsWithVersions[facetName] = {
                address: facetAddress,
                version,
              }
            }

          await saveDiamondDeployment(
            'tron',
            result.address,
            facetsWithVersions
          )

          // Update diamond.json with all facets
          const facetEntries = Object.entries(deployedFacets)
            .filter(([_, address]) => address !== 'FAILED')
            .map(([name, address]) => ({ name, address }))

          await updateDiamondJsonBatch(facetEntries)
        }
      } catch (error: any) {
        consola.error('Failed to deploy LiFiDiamond:', error.message)
        deploymentResults.push({
          contract: 'LiFiDiamond',
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version: '0.0.0',
          status: 'failed',
        })
      }
    else if (address)
      deploymentResults.push({
        contract: 'LiFiDiamond',
        address: address,
        txId: 'existing',
        cost: 0,
        version: await getContractVersion('LiFiDiamond'),
        status: 'existing',
      })

    // Use new utility for summary
    printDeploymentSummary(deploymentResults, dryRun)

    // Exit with appropriate code
    const hasFailures = deploymentResults.some((r) => r.status === 'failed')
    process.exit(hasFailures ? 1 : 0)
  } catch (error: any) {
    consola.error('Deployment failed:', error.message)
    if (error.stack) consola.error(error.stack)
    process.exit(1)
  }
}

// Run deployment
deployCoreFacets().catch((error) => {
  consola.error('Unexpected error:', error)
  process.exit(1)
})
