#!/usr/bin/env bun

import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import { getEnvVar } from '../../demoScripts/utils/demoScriptHelpers'

import { TronContractDeployer } from './TronContractDeployer'
import type { ITronDeploymentConfig } from './types'
import {
  loadForgeArtifact,
  logDeployment,
  saveContractAddress,
  getContractVersion,
  getEnvironment,
  getPrivateKey,
  getNetworkConfig,
  getContractAddress,
  ENERGY_PRICE,
  updateDiamondJson,
  getFacetSelectors,
} from './utils.js'

/**
 * Estimate energy for diamondCut transaction
 */
async function estimateDiamondCutEnergy(
  tronWeb: TronWeb,
  diamondAddress: string,
  facetCuts: unknown[],
  fullHost: string
): Promise<number> {
  try {
    consola.info('⚡ Estimating energy for diamondCut...')

    const encodedParams = tronWeb.utils.abi.encodeParams(
      ['(address,uint8,bytes4[])[]', 'address', 'bytes'],
      [facetCuts, '0x0000000000000000000000000000000000000000', '0x']
    )

    const functionSelector =
      'diamondCut((address,uint8,bytes4[])[],address,bytes)'
    const apiUrl =
      fullHost.replace(/\/$/, '') + '/wallet/triggerconstantcontract'

    const payload = {
      owner_address: tronWeb.defaultAddress.base58,
      contract_address: diamondAddress,
      function_selector: functionSelector,
      parameter: encodedParams.replace('0x', ''),
      fee_limit: 1000000000,
      call_value: 0,
      visible: true,
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`API call failed: ${response.status} - ${errorText}`)
    }

    const result = await response.json()

    if (result.result?.result === false)
      throw new Error(
        `Energy estimation failed: ${
          result.result?.message || JSON.stringify(result)
        }`
      )

    if (result.energy_used) {
      const safetyMultiplier = 10
      const estimatedEnergy = Math.ceil(result.energy_used * safetyMultiplier)
      consola.info(
        `⚡ Energy estimate: ${result.energy_used} (with ${safetyMultiplier}x safety: ${estimatedEnergy})`
      )
      return estimatedEnergy
    }

    throw new Error('No energy estimation returned')
  } catch (error) {
    consola.error(
      '❌ Failed to estimate energy:',
      error instanceof Error ? error.message : String(error)
    )
    throw error
  }
}

/**
 * Register SymbiosisFacet to Diamond
 */
async function registerSymbiosisFacetToDiamond(
  symbiosisFacetAddress: string,
  tronWeb: TronWeb,
  fullHost: string,
  dryRun = false
) {
  try {
    // Load deployment addresses
    const deploymentPath = path.join(process.cwd(), 'deployments', 'tron.json')
    const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))

    const diamondAddress = deployments.LiFiDiamond
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    consola.info(`🔷 LiFiDiamond: ${diamondAddress}`)

    // Load required ABIs
    const diamondCutABI = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'out',
          'DiamondCutFacet.sol',
          'DiamondCutFacet.json'
        ),
        'utf8'
      )
    ).abi

    const diamondLoupeABI = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'out',
          'DiamondLoupeFacet.sol',
          'DiamondLoupeFacet.json'
        ),
        'utf8'
      )
    ).abi

    const combinedABI = [...diamondCutABI, ...diamondLoupeABI]
    const diamond = tronWeb.contract(combinedABI, diamondAddress)

    // Get function selectors dynamically
    consola.info('\n📋 Extracting function selectors for SymbiosisFacet...')
    const selectors = await getFacetSelectors('SymbiosisFacet')

    consola.info(`📌 Found ${selectors.length} function selectors:`)
    selectors.forEach((selector: string) => {
      consola.info(`   - ${selector}`)
    })

    // Check if already registered
    let isRegistered = false
    try {
      const facetsResponse = await diamond.facets().call()
      const currentFacets = Array.isArray(facetsResponse[0])
        ? facetsResponse[0]
        : facetsResponse

      for (const facet of currentFacets) {
        const registeredAddress = tronWeb.address.fromHex(facet[0])
        if (registeredAddress === symbiosisFacetAddress) {
          isRegistered = true
          break
        }
      }
    } catch (e) {
      // If facets() fails, assume not registered
    }

    if (isRegistered) {
      consola.success('✅ SymbiosisFacet is already registered!')
      return
    }

    // Prepare facetCut
    const facetAddressHex = tronWeb.address
      .toHex(symbiosisFacetAddress)
      .replace(/^41/, '0x')
    const facetCuts = [[facetAddressHex, 0, selectors]]

    consola.info('\n📦 Preparing facetCut:')
    consola.info(`   Address: ${symbiosisFacetAddress}`)
    consola.info(`   Action: Add (0)`)
    consola.info(`   Selectors: ${selectors.length}`)

    // Estimate energy
    const estimatedEnergy = await estimateDiamondCutEnergy(
      tronWeb,
      diamondAddress,
      facetCuts,
      fullHost
    )
    const estimatedCost = (estimatedEnergy * ENERGY_PRICE) / 1000000
    consola.info(
      `💰 Estimated registration cost: ${estimatedCost.toFixed(4)} TRX`
    )

    if (dryRun) {
      consola.info('\n📌 Dry run mode - not executing registration')
      consola.info('FacetCut details:', JSON.stringify(facetCuts, null, 2))
      return
    }

    // Check balance
    const balance = await tronWeb.trx.getBalance(tronWeb.defaultAddress.base58)
    const balanceTRX = balance / 1000000
    if (balanceTRX < 5)
      throw new Error(
        `Insufficient balance. Have: ${balanceTRX} TRX, Need: at least 5 TRX`
      )

    // Execute diamondCut
    consola.info(`\n🚀 Executing diamondCut...`)
    const feeLimitInSun = 5_000_000_000 // 5 TRX

    const tx = await diamond
      .diamondCut(facetCuts, '0x0000000000000000000000000000000000000000', '0x')
      .send({
        feeLimit: feeLimitInSun,
        shouldPollResponse: true,
      })

    consola.success(`✅ Registration transaction successful: ${tx}`)

    // Verify registration
    consola.info('\n🔍 Verifying registration...')
    const facetsResponse = await diamond.facets().call()
    const facets = Array.isArray(facetsResponse[0])
      ? facetsResponse[0]
      : facetsResponse

    let found = false
    for (const facet of facets) {
      const facetBase58 = tronWeb.address.fromHex(facet[0])
      if (facetBase58 === symbiosisFacetAddress) {
        found = true
        consola.success(
          `✅ SymbiosisFacet registered successfully with ${facet[1].length} functions`
        )
        break
      }
    }

    if (!found) throw new Error('SymbiosisFacet not found in registered facets')
  } catch (error) {
    consola.error(
      '❌ Registration failed:',
      error instanceof Error ? error.message : String(error)
    )
    throw error
  }
}
/**
 * Helper function to deploy SymbiosisFacet
 */
async function deploySymbiosisFacet(
  deployer: TronContractDeployer,
  tronWeb: TronWeb,
  tronSymbiosisConfig: { metaRouter: string; gateway: string },
  options: { dryRun?: boolean }
): Promise<{
  address: string
  cost: number
}> {
  // Load artifact
  const artifact = await loadForgeArtifact('SymbiosisFacet')

  // Get version
  const version = await getContractVersion('SymbiosisFacet')
  consola.info(`📌 Version: ${version}`)

  // Prepare constructor arguments
  const metaRouterHex = tronSymbiosisConfig.metaRouter
  const gatewayHex = tronSymbiosisConfig.gateway

  // For display purposes - show Tron base58 format
  const metaRouterTron = tronWeb.address.fromHex(
    metaRouterHex.replace('0x', '41')
  )
  const gatewayTron = tronWeb.address.fromHex(gatewayHex.replace('0x', '41'))

  consola.info(`🔧 Constructor Arguments:`)
  consola.info(`   metaRouter: ${metaRouterTron} (hex: ${metaRouterHex})`)
  consola.info(`   gateway: ${gatewayTron} (hex: ${gatewayHex})`)

  // Use original hex format (0x...) for constructor args
  const constructorArgs = [metaRouterHex, gatewayHex]

  // Deploy contract
  consola.info('\n🚀 Deploying SymbiosisFacet...')
  const result = await deployer.deployContract(artifact, constructorArgs)

  consola.success(`✅ SymbiosisFacet deployed to: ${result.contractAddress}`)
  consola.info(`📝 Transaction: ${result.transactionId}`)
  consola.info(`💰 Cost: ${result.actualCost.trxCost} TRX`)

  // Save deployment info (skip in dry run)
  if (!options.dryRun) {
    // Encode constructor args as hex
    const ethers = await import('ethers')
    const abiCoder = new ethers.utils.AbiCoder()
    const constructorArgsHex = abiCoder.encode(
      ['address', 'address'],
      constructorArgs
    )

    await logDeployment(
      'SymbiosisFacet',
      'tron',
      result.contractAddress,
      version,
      constructorArgsHex,
      false
    )

    await saveContractAddress('tron', 'SymbiosisFacet', result.contractAddress)
    consola.success('💾 Deployment info saved')
  }

  return {
    address: result.contractAddress,
    cost: result.actualCost.trxCost,
  }
}

/**
 * Deploy and register SymbiosisFacet to Tron
 */
async function deployAndRegisterSymbiosisFacet(
  options: { dryRun?: boolean } = {}
) {
  consola.start('TRON SymbiosisFacet Deployment & Registration')
  consola.info('============================================\n')

  // Get environment from config.sh
  const environment = await getEnvironment()

  // Load environment variables
  let verbose = true
  try {
    verbose = getEnvVar('VERBOSE') !== 'false'
  } catch {
    // Use default value
  }

  // Get network configuration
  let tronConfig
  try {
    tronConfig = getNetworkConfig('tron')
  } catch (error) {
    consola.error(
      `❌ ${error instanceof Error ? error.message : String(error)}`
    )
    consola.error(
      'Please ensure "tron" network is configured in config/networks.json'
    )
    process.exit(1)
  }

  const network = tronConfig.rpcUrl

  // Get the correct private key based on environment
  let privateKey: string
  try {
    privateKey = await getPrivateKey()
  } catch (error) {
    consola.error(
      `❌ ${error instanceof Error ? error.message : String(error)}`
    )
    consola.error(
      `Please ensure ${
        environment === 'production' ? 'PRIVATE_KEY_PRODUCTION' : 'PRIVATE_KEY'
      } is set in your .env file`
    )
    process.exit(1)
  }

  // Load Symbiosis configuration
  const symbiosisConfigPath = path.join(
    process.cwd(),
    'config',
    'symbiosis.json'
  )
  if (!fs.existsSync(symbiosisConfigPath)) {
    consola.error('❌ config/symbiosis.json not found')
    process.exit(1)
  }

  const symbiosisConfig = JSON.parse(
    fs.readFileSync(symbiosisConfigPath, 'utf8')
  )
  const tronSymbiosisConfig = symbiosisConfig.tron

  if (!tronSymbiosisConfig) {
    consola.error('❌ Tron configuration not found in symbiosis.json')
    process.exit(1)
  }

  // Validate required addresses
  if (!tronSymbiosisConfig.metaRouter || !tronSymbiosisConfig.gateway) {
    consola.error('❌ Missing required addresses in Tron Symbiosis config')
    consola.error('Required: metaRouter and gateway')
    process.exit(1)
  }

  // Initialize deployer
  const config: ITronDeploymentConfig = {
    fullHost: network,
    privateKey,
    verbose,
    dryRun: options.dryRun || false,
    safetyMargin: 1.5,
    maxRetries: 3,
    confirmationTimeout: 120000,
  }

  const deployer = new TronContractDeployer(config)

  // Initialize TronWeb for address conversion and Diamond interaction
  const tronWeb = new TronWeb({
    fullHost: network,
    privateKey,
  })

  try {
    // Get network info
    const networkInfo = await deployer.getNetworkInfo()
    consola.info('📍 Network Info:', {
      network: network.includes('shasta') ? 'Shasta Testnet' : 'Mainnet',
      rpcUrl: network,
      environment: environment.toUpperCase(),
      address: networkInfo.address,
      balance: `${networkInfo.balance} TRX`,
      block: networkInfo.block,
    })

    if (networkInfo.balance < 10)
      consola.warn('⚠️  Low balance detected. Deployment may fail.')

    consola.info('\n📋 Deployment & Registration Plan:')
    consola.info('1. Deploy SymbiosisFacet with constructor arguments')
    consola.info('   - metaRouter:', tronSymbiosisConfig.metaRouter)
    consola.info('   - gateway:', tronSymbiosisConfig.gateway)
    consola.info('2. Register SymbiosisFacet to LiFiDiamond')
    consola.info('   - Add facet with function selectors')
    consola.info('   - Verify registration')

    if (!options.dryRun && environment === 'production') {
      consola.warn(
        '⚠️  WARNING: This will deploy and register SymbiosisFacet to Tron mainnet in PRODUCTION!'
      )
      const shouldContinue = await consola.prompt('Do you want to continue?', {
        type: 'confirm',
        initial: false,
      })

      if (!shouldContinue) {
        consola.info('Deployment cancelled')
        process.exit(0)
      }
    } else if (!options.dryRun) {
      consola.warn(
        '⚠️  This will deploy and register SymbiosisFacet to Tron mainnet in STAGING!'
      )
      const shouldContinue = await consola.prompt('Do you want to continue?', {
        type: 'confirm',
        initial: true,
      })

      if (!shouldContinue) {
        consola.info('Deployment cancelled')
        process.exit(0)
      }
    }

    // STEP 1: DEPLOY SYMBIOSISFACET
    consola.info('\n=== STEP 1: Deploy SymbiosisFacet ===')

    let symbiosisFacetAddress: string
    let deploymentCost = 0

    // Check if already deployed
    const existingAddress = await getContractAddress('tron', 'SymbiosisFacet')
    if (existingAddress && !options.dryRun) {
      consola.warn(
        `⚠️  SymbiosisFacet is already deployed at: ${existingAddress}`
      )
      const shouldRedeploy = await consola.prompt('Redeploy SymbiosisFacet?', {
        type: 'confirm',
        initial: false,
      })

      if (!shouldRedeploy) {
        consola.info(`✅ Using existing SymbiosisFacet at: ${existingAddress}`)
        symbiosisFacetAddress = existingAddress
      } else {
        // Deploy new instance
        const deployResult = await deploySymbiosisFacet(
          deployer,
          tronWeb,
          tronSymbiosisConfig,
          options
        )
        symbiosisFacetAddress = deployResult.address
        deploymentCost = deployResult.cost
      }
    } else {
      // Deploy new instance
      const deployResult = await deploySymbiosisFacet(
        deployer,
        tronWeb,
        tronSymbiosisConfig,
        options
      )
      symbiosisFacetAddress = deployResult.address
      deploymentCost = deployResult.cost
    }

    // STEP 2: REGISTER TO DIAMOND
    consola.info('\n=== STEP 2: Register to Diamond ===')
    await registerSymbiosisFacetToDiamond(
      symbiosisFacetAddress,
      tronWeb,
      network,
      options.dryRun
    )

    // Update tron.diamond.json after successful registration
    if (!options.dryRun)
      await updateDiamondJson(symbiosisFacetAddress, 'SymbiosisFacet')

    // Print final summary
    consola.success('\n✨ Deployment & Registration Complete!')
    consola.info('=====================================\n')
    consola.info('Contract: SymbiosisFacet')
    consola.info(`Address: ${symbiosisFacetAddress}`)
    consola.info(`Environment: ${environment.toUpperCase()}`)
    if (deploymentCost > 0)
      consola.info(`Deployment Cost: ${deploymentCost.toFixed(4)} TRX`)

    consola.info('Status: Deployed and Registered to Diamond')

    if (options.dryRun)
      consola.info(
        '\n📌 This was a DRY RUN - no actual deployment or registration occurred'
      )
  } catch (error) {
    consola.error(
      '❌ Deployment failed:',
      error instanceof Error ? error.message : String(error)
    )
    process.exit(1)
  }
}

// CLI handling
const main = defineCommand({
  meta: {
    name: 'deploy-and-register-symbiosis-facet',
    description:
      'Deploy and register SymbiosisFacet to the Tron Diamond contract',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Run in dry-run mode without sending transactions',
      default: false,
    },
  },
  async run({ args }) {
    const options = {
      dryRun: args.dryRun,
    }

    if (args.dryRun)
      consola.info('🏃 Running in DRY RUN mode - no transactions will be sent')

    try {
      await deployAndRegisterSymbiosisFacet(options)
      process.exit(0)
    } catch (error) {
      consola.error(
        '❌ Failed:',
        error instanceof Error ? error.message : error
      )
      process.exit(1)
    }
  },
})

if (import.meta.main) runMain(main)

export { deployAndRegisterSymbiosisFacet }
