#!/usr/bin/env bun

import { consola } from 'consola'

import { getEnvVar } from '../../demoScripts/utils/demoScriptHelpers'

import { TronContractDeployer } from './TronContractDeployer'
import type { ITronDeploymentConfig } from './types'
import {
  loadForgeArtifact,
  getCoreFacets,
  logDeployment,
  saveContractAddress,
  saveDiamondDeployment,
  getContractVersion,
  getEnvironment,
  getPrivateKey,
  getNetworkConfig,
  getContractAddress,
} from './utils.js'

/**
 * Deploy core facets to Tron
 */
async function deployCoreFacets() {
  consola.start('TRON Core Facets Deployment')
  consola.info('================================\n')

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
    consola.error(` ${error.message}`)
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
    consola.error(` ${error.message}`)
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
    consola.info('Network Info:', {
      network: network.includes('shasta') ? 'Shasta Testnet' : 'Mainnet',
      rpcUrl: network,
      environment: environment.toUpperCase(),
      address: networkInfo.address,
      balance: `${networkInfo.balance} TRX`,
      block: networkInfo.block,
    })

    if (networkInfo.balance < 100)
      consola.warn('Low balance detected. Deployment may fail.')

    consola.info('\n Deployment Plan:')
    consola.info('1. Deploy DiamondCutFacet')
    consola.info('2. Deploy DiamondLoupeFacet')
    consola.info('3. Deploy OwnershipFacet')
    consola.info('4. Deploy LiFiDiamond with facets\n')

    if (!dryRun && environment === 'production') {
      consola.warn(
        ' WARNING: This will deploy contracts to Tron mainnet in PRODUCTION!'
      )
      const shouldContinue = await consola.prompt('Do you want to continue?', {
        type: 'confirm',
        initial: false,
      })

      if (!shouldContinue) {
        consola.info('Deployment cancelled')
        process.exit(0)
      }
    } else if (!dryRun) {
      consola.warn('This will deploy contracts to Tron mainnet in STAGING!')
      const shouldContinue = await consola.prompt('Do you want to continue?', {
        type: 'confirm',
        initial: true,
      })

      if (!shouldContinue) {
        consola.info('Deployment cancelled')
        process.exit(0)
      }
    }

    // Get core facets from config
    const coreFacets = getCoreFacets()
    consola.info('Core facets to deploy:', coreFacets)

    const deployedFacets: Record<string, string> = {}
    const deploymentResults = []

    // Deploy each core facet
    for (const facetName of coreFacets) {
      consola.info(`\n Deploying ${facetName}...`)

      // Get version first (outside try block so we have it for error tracking)
      let version = '0.0.0'
      try {
        version = await getContractVersion(facetName)
      } catch {
        consola.warn(`  Could not get version for ${facetName}`)
      }

      try {
        // Check if facet is already deployed
        const existingAddress = await getContractAddress('tron', facetName)
        if (existingAddress && !dryRun) {
          consola.warn(
            `  ${facetName} is already deployed at: ${existingAddress}`
          )
          const shouldRedeploy = await consola.prompt(
            `Redeploy ${facetName}?`,
            {
              type: 'confirm',
              initial: false,
            }
          )

          if (!shouldRedeploy) {
            consola.info(`Using existing ${facetName} at: ${existingAddress}`)
            deployedFacets[facetName] = existingAddress

            // Get version for existing contract
            const version = await getContractVersion(facetName)
            deploymentResults.push({
              contract: facetName,
              address: existingAddress,
              txId: 'existing',
              cost: 0,
              version,
            })
            continue
          }
        }

        // Load artifact
        const artifact = await loadForgeArtifact(facetName)

        // Display version
        consola.info(`Version: ${version}`)

        // Prepare constructor arguments based on facet type
        let constructorArgs: any[] = []

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
          constructorArgs = [pauserWallet]
          consola.info(
            ` Using pauserWallet: ${tronBase58} (hex: ${pauserWallet})`
          )
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
              : tronWebInstance.address.fromHex(
                  nativeAddress.replace('0x', '41')
                )

          // Use original hex format (0x...) for constructor args
          constructorArgs = [nativeAddress]
          consola.info(
            ` Using nativeAddress: ${tronNativeAddress} (hex: ${nativeAddress})`
          )
        }

        // Deploy with constructor arguments
        const result = await deployer.deployContract(artifact, constructorArgs)

        deployedFacets[facetName] = result.contractAddress
        deploymentResults.push({
          contract: facetName,
          address: result.contractAddress,
          txId: result.transactionId,
          cost: result.actualCost.trxCost,
          version,
        })

        consola.success(` ${facetName} deployed to: ${result.contractAddress}`)
        consola.info(`Transaction: ${result.transactionId}`)
        consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

        // Log deployment (skip in dry run)
        if (!dryRun) {
          await logDeployment(
            facetName,
            'tron',
            result.contractAddress,
            version,
            '0x', // No constructor args for facets
            false // Tron doesn't have Etherscan-style verification
          )

          await saveContractAddress('tron', facetName, result.contractAddress)
        }

        // Wait between deployments
        if (!dryRun) await Bun.sleep(3000)
      } catch (error: any) {
        consola.error(` Failed to deploy ${facetName}:`, error.message)

        // Track failed deployment
        deploymentResults.push({
          contract: facetName,
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version,
        })

        // Continue to next facet instead of exiting
        consola.warn(`  Continuing to next facet...`)
        continue
      }
    }

    // Deploy LiFiDiamond
    consola.info('\n Deploying LiFiDiamond...')

    try {
      // Check if LiFiDiamond is already deployed
      const existingDiamondAddress = await getContractAddress(
        'tron',
        'LiFiDiamond'
      )
      if (existingDiamondAddress && !dryRun) {
        consola.warn(
          `  LiFiDiamond is already deployed at: ${existingDiamondAddress}`
        )
        const shouldRedeploy = await consola.prompt('Redeploy LiFiDiamond?', {
          type: 'confirm',
          initial: false,
        })

        if (!shouldRedeploy) {
          consola.info(
            ` Using existing LiFiDiamond at: ${existingDiamondAddress}`
          )

          // Get version for existing contract
          const diamondVersion = await getContractVersion('LiFiDiamond')
          deploymentResults.push({
            contract: 'LiFiDiamond',
            address: existingDiamondAddress,
            txId: 'existing',
            cost: 0,
            version: diamondVersion,
          })

          // Still save the diamond deployment file with current facet info
          const facetsInfo: Record<
            string,
            { address: string; version: string }
          > = {}
          for (const result of deploymentResults)
            if (result.contract.includes('Facet'))
              facetsInfo[result.contract] = {
                address: result.address,
                version: result.version,
              }

          await saveDiamondDeployment(
            'tron',
            existingDiamondAddress,
            facetsInfo
          )
          consola.success('Diamond deployment file updated')

          // Skip to summary
          consola.success('\n Deployment Complete!')
          consola.info('========================\n')

          if (dryRun)
            consola.info(
              '\n This was a DRY RUN - no contracts were actually deployed'
            )

          return
        }
      }

      const diamondArtifact = await loadForgeArtifact('LiFiDiamond')
      const diamondVersion = await getContractVersion('LiFiDiamond')

      // Prepare constructor arguments
      const ownerAddress = networkInfo.address // This is base58 format (T...)
      const diamondCutFacetAddress = deployedFacets['DiamondCutFacet'] // This is also base58

      if (!diamondCutFacetAddress)
        throw new Error('DiamondCutFacet address not found')

      // Convert base58 addresses to hex for ABI encoding
      const tronWeb = (await import('tronweb')).TronWeb
      const tronWebInstance = new tronWeb({
        fullHost: network,
        privateKey,
      })

      // Convert to hex format (0x...) for constructor args
      const ownerHex =
        '0x' + tronWebInstance.address.toHex(ownerAddress).substring(2)
      const diamondCutHex =
        '0x' +
        tronWebInstance.address.toHex(diamondCutFacetAddress).substring(2)

      const constructorArgs = [ownerHex, diamondCutHex]

      consola.info(`Using owner: ${ownerAddress} (hex: ${ownerHex})`)
      consola.info(
        ` Using DiamondCutFacet: ${diamondCutFacetAddress} (hex: ${diamondCutHex})`
      )

      const diamondResult = await deployer.deployContract(
        diamondArtifact,
        constructorArgs
      )

      deploymentResults.push({
        contract: 'LiFiDiamond',
        address: diamondResult.contractAddress,
        txId: diamondResult.transactionId,
        cost: diamondResult.actualCost.trxCost,
        version: diamondVersion,
      })

      consola.success(
        ` LiFiDiamond deployed to: ${diamondResult.contractAddress}`
      )
      consola.info(`Transaction: ${diamondResult.transactionId}`)
      consola.info(`Cost: ${diamondResult.actualCost.trxCost} TRX`)

      // Log deployment
      if (!dryRun) {
        // Encode constructor args as hex (simplified - you may need proper encoding)
        const constructorArgsHex = '0x' // TODO: Properly encode constructor args

        await logDeployment(
          'LiFiDiamond',
          'tron',
          diamondResult.contractAddress,
          diamondVersion,
          constructorArgsHex,
          false
        )

        await saveContractAddress(
          'tron',
          'LiFiDiamond',
          diamondResult.contractAddress
        )

        // Save diamond deployment file
        const facetsInfo: Record<string, { address: string; version: string }> =
          {}
        for (const result of deploymentResults)
          if (result.contract.includes('Facet'))
            facetsInfo[result.contract] = {
              address: result.address,
              version: result.version,
            }

        await saveDiamondDeployment(
          'tron',
          diamondResult.contractAddress,
          facetsInfo
        )
        consola.success('Diamond deployment file saved')
      }
    } catch (error: any) {
      consola.error('Failed to deploy LiFiDiamond:', error.message)
      if (!dryRun) process.exit(1)
    }

    // Print summary
    consola.success('\n Deployment Complete!')
    consola.info('========================\n')

    // Check for failed deployments
    const failedDeployments = deploymentResults.filter(
      (r) => r.txId === 'FAILED'
    )
    if (failedDeployments.length > 0) {
      consola.error(`\n Failed deployments (${failedDeployments.length}):`)
      failedDeployments.forEach((f) => {
        consola.error(`   - ${f.contract}`)
      })
      consola.warn(
        '\nPlease review the errors above and retry failed deployments individually.'
      )
    }

    if (dryRun)
      consola.info(
        '\n This was a DRY RUN - no contracts were actually deployed'
      )
  } catch (error: any) {
    consola.error('Deployment failed:', error.message)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) deployCoreFacets().catch(consola.error)
