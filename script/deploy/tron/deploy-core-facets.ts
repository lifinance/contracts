#!/usr/bin/env bun

import { consola } from 'consola'

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
  consola.start('🚀 TRON Core Facets Deployment')
  consola.info('================================\n')

  // Get environment from config.sh
  const environment = await getEnvironment()

  // Load environment variables
  const dryRun = process.env.DRY_RUN === 'true'
  const verbose = process.env.VERBOSE === 'true'

  // Get network configuration from networks.json
  let tronConfig
  try {
    tronConfig = getNetworkConfig('tron')
  } catch (error: any) {
    consola.error(`❌ ${error.message}`)
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
    consola.error(`❌ ${error.message}`)
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
    consola.info('🌐 Network Info:', {
      network: network.includes('shasta') ? 'Shasta Testnet' : 'Mainnet',
      rpcUrl: network,
      environment: environment.toUpperCase(),
      address: networkInfo.address,
      balance: `${networkInfo.balance} TRX`,
      block: networkInfo.block,
    })

    if (networkInfo.balance < 100)
      consola.warn('⚠️  Low balance detected. Deployment may fail.')

    consola.info('\n📋 Deployment Plan:')
    consola.info('1. Deploy DiamondCutFacet')
    consola.info('2. Deploy DiamondLoupeFacet')
    consola.info('3. Deploy OwnershipFacet')
    consola.info('4. Deploy LiFiDiamond with facets\n')

    if (!dryRun && environment === 'production') {
      consola.warn(
        '🚨 WARNING: This will deploy contracts to Tron mainnet in PRODUCTION!'
      )
      consola.info(
        'Press Ctrl+C to cancel, or wait 10 seconds to continue...\n'
      )
      await Bun.sleep(10000)
    } else if (!dryRun) {
      consola.warn('⚠️  This will deploy contracts to Tron mainnet in STAGING!')
      consola.info('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n')
      await Bun.sleep(5000)
    }

    // Get core facets from config
    const coreFacets = getCoreFacets()
    consola.info('📦 Core facets to deploy:', coreFacets)

    const deployedFacets: Record<string, string> = {}
    const deploymentResults = []

    // Deploy each core facet
    for (const facetName of coreFacets) {
      consola.info(`\n🔨 Deploying ${facetName}...`)

      try {
        // Check if facet is already deployed
        const existingAddress = await getContractAddress('tron', facetName)
        if (existingAddress && !dryRun) {
          consola.warn(
            `⚠️  ${facetName} is already deployed at: ${existingAddress}`
          )
          const shouldRedeploy = await consola.prompt(
            `Redeploy ${facetName}?`,
            {
              type: 'confirm',
              initial: false,
            }
          )

          if (!shouldRedeploy) {
            consola.info(`✓ Using existing ${facetName} at: ${existingAddress}`)
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

        // Get version
        const version = await getContractVersion(facetName)
        consola.info(`📌 Version: ${version}`)

        // Deploy
        const result = await deployer.deployContract(artifact, [])

        deployedFacets[facetName] = result.contractAddress
        deploymentResults.push({
          contract: facetName,
          address: result.contractAddress,
          txId: result.transactionId,
          cost: result.actualCost.trxCost,
          version,
        })

        consola.success(
          `✅ ${facetName} deployed to: ${result.contractAddress}`
        )
        consola.info(`🔗 Transaction: ${result.transactionId}`)
        consola.info(`💰 Cost: ${result.actualCost.trxCost} TRX`)

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
        consola.error(`❌ Failed to deploy ${facetName}:`, error.message)
        if (!dryRun) process.exit(1)
      }
    }

    // Deploy LiFiDiamond
    consola.info('\n🔨 Deploying LiFiDiamond...')

    try {
      // Check if LiFiDiamond is already deployed
      const existingDiamondAddress = await getContractAddress(
        'tron',
        'LiFiDiamond'
      )
      if (existingDiamondAddress && !dryRun) {
        consola.warn(
          `⚠️  LiFiDiamond is already deployed at: ${existingDiamondAddress}`
        )
        const shouldRedeploy = await consola.prompt('Redeploy LiFiDiamond?', {
          type: 'confirm',
          initial: false,
        })

        if (!shouldRedeploy) {
          consola.info(
            `✓ Using existing LiFiDiamond at: ${existingDiamondAddress}`
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
          consola.success('📄 Diamond deployment file updated')

          // Skip to summary
          consola.success('\n🎉 Deployment Complete!')
          consola.info('========================\n')
          console.table(
            deploymentResults.map((r) => ({
              Contract: r.contract,
              Address:
                r.address.length > 20
                  ? `${r.address.slice(0, 10)}...${r.address.slice(-8)}`
                  : r.address,
              Version: r.version,
              Cost:
                r.txId === 'existing' ? 'existing' : `${r.cost.toFixed(4)} TRX`,
            }))
          )

          const totalCost = deploymentResults.reduce(
            (sum, r) => sum + r.cost,
            0
          )
          consola.info(
            `\n💰 Total deployment cost: ${totalCost.toFixed(4)} TRX`
          )

          if (dryRun)
            consola.info(
              '\n🧪 This was a DRY RUN - no contracts were actually deployed'
            )

          return
        }
      }

      const diamondArtifact = await loadForgeArtifact('LiFiDiamond')
      const diamondVersion = await getContractVersion('LiFiDiamond')

      // Prepare constructor arguments
      const ownerAddress = networkInfo.address
      const diamondCutFacetAddress = deployedFacets['DiamondCutFacet']

      if (!diamondCutFacetAddress)
        throw new Error('DiamondCutFacet address not found')

      const constructorArgs = [ownerAddress, diamondCutFacetAddress]

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
        `✅ LiFiDiamond deployed to: ${diamondResult.contractAddress}`
      )
      consola.info(`🔗 Transaction: ${diamondResult.transactionId}`)
      consola.info(`💰 Cost: ${diamondResult.actualCost.trxCost} TRX`)

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
        consola.success('📄 Diamond deployment file saved')
      }
    } catch (error: any) {
      consola.error('❌ Failed to deploy LiFiDiamond:', error.message)
      if (!dryRun) process.exit(1)
    }

    // Print summary
    consola.success('\n🎉 Deployment Complete!')
    consola.info('========================\n')
    console.table(
      deploymentResults.map((r) => ({
        Contract: r.contract,
        Address:
          r.address.length > 20
            ? `${r.address.slice(0, 10)}...${r.address.slice(-8)}`
            : r.address,
        Version: r.version,
        Cost: r.txId === 'existing' ? 'existing' : `${r.cost.toFixed(4)} TRX`,
      }))
    )

    const totalCost = deploymentResults.reduce((sum, r) => sum + r.cost, 0)
    consola.info(`\n💰 Total deployment cost: ${totalCost.toFixed(4)} TRX`)

    if (dryRun)
      consola.info(
        '\n🧪 This was a DRY RUN - no contracts were actually deployed'
      )
  } catch (error: any) {
    consola.error('💥 Deployment failed:', error.message)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) deployCoreFacets().catch(consola.error)
