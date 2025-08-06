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
  updateDiamondJson,
} from './utils.js'

// Preloaded function selectors for AllbridgeFacet
const ALLBRIDGE_FACET_SELECTORS = [
  '0x6a51e9a9', // startBridgeTokensViaAllBridge
  '0x63267469', // swapAndStartBridgeTokensViaAllBridge
]

/**
 * Estimate energy for diamondCut transaction
 */
async function estimateDiamondCutEnergy(
  tronWeb: TronWeb,
  diamondAddress: string,
  facetCuts: Array<[string, number, string[]]>,
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
      error instanceof Error ? error.message : error
    )
    throw error
  }
}

/**
 * Register AllbridgeFacet to Diamond
 */
async function registerAllbridgeFacetToDiamond(
  allbridgeFacetAddress: string,
  tronWeb: TronWeb,
  fullHost: string,
  dryRun = false
): Promise<void> {
  try {
    // Load deployment addresses
    const deploymentPath = path.join(process.cwd(), 'deployments', 'tron.json')
    const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))

    const diamondAddress = deployments.LiFiDiamond
    if (!diamondAddress) 
      throw new Error('LiFiDiamond not found in deployments')
    

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

    // Use preloaded function selectors
    consola.info(
      '\n📋 Using preloaded function selectors for AllbridgeFacet...'
    )
    const selectors = ALLBRIDGE_FACET_SELECTORS

    consola.info(`📌 Found ${selectors.length} function selectors:`)
    selectors.forEach((selector) => {
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
        if (registeredAddress === allbridgeFacetAddress) {
          isRegistered = true
          break
        }
      }
    } catch (e) {
      // If facets() fails, assume not registered
    }

    if (isRegistered) {
      consola.success('✅ AllbridgeFacet is already registered!')
      return
    }

    // Prepare facetCut
    const facetAddressHex = tronWeb.address
      .toHex(allbridgeFacetAddress)
      .replace(/^41/, '0x')
    const facetCuts: Array<[string, number, string[]]> = [
      [facetAddressHex, 0, selectors],
    ]

    consola.info('\n📦 Preparing facetCut:')
    consola.info(`   Address: ${allbridgeFacetAddress}`)
    consola.info(`   Action: Add (0)`)
    consola.info(`   Selectors: ${selectors.length}`)

    // Estimate energy
    await estimateDiamondCutEnergy(tronWeb, diamondAddress, facetCuts, fullHost)

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
      if (facetBase58 === allbridgeFacetAddress) {
        found = true
        consola.success(
          `✅ AllbridgeFacet registered successfully with ${facet[1].length} functions`
        )
        break
      }
    }

    if (!found) 
      throw new Error('AllbridgeFacet not found in registered facets')
    
  } catch (error) {
    consola.error(
      '❌ Registration failed:',
      error instanceof Error ? error.message : error
    )
    throw error
  }
}

/**
 * Deploy AllbridgeFacet
 */
async function deployAllbridgeFacet(
  deployer: TronContractDeployer,
  tronWeb: TronWeb,
  allBridgeAddress: string,
  dryRun: boolean
): Promise<{
  address: string
}> {
  // Load artifact
  const artifact = await loadForgeArtifact('AllBridgeFacet')

  // Get version
  const version = await getContractVersion('AllBridgeFacet')
  consola.info(`📌 Version: ${version}`)

  // Prepare constructor arguments
  const allBridgeHex = allBridgeAddress

  // For display purposes - show Tron base58 format
  const allBridgeTron = tronWeb.address.fromHex(
    allBridgeHex.replace('0x', '41')
  )

  consola.info(`🔧 Constructor Arguments:`)
  consola.info(`   allBridge: ${allBridgeTron} (hex: ${allBridgeHex})`)

  // Use original hex format (0x...) for constructor args
  const constructorArgs = [allBridgeHex]

  // Deploy contract
  consola.info('\n🚀 Deploying AllbridgeFacet...')
  const result = await deployer.deployContract(artifact, constructorArgs)

  consola.success(`✅ AllbridgeFacet deployed to: ${result.contractAddress}`)
  consola.info(`📝 Transaction: ${result.transactionId}`)

  // Save deployment info (skip in dry run)
  if (!dryRun) {
    // Encode constructor args as hex
    const ethers = await import('ethers')
    const abiCoder = new ethers.utils.AbiCoder()
    const constructorArgsHex = abiCoder.encode(['address'], constructorArgs)

    await logDeployment(
      'AllBridgeFacet',
      'tron',
      result.contractAddress,
      version,
      constructorArgsHex,
      false
    )

    await saveContractAddress('tron', 'AllBridgeFacet', result.contractAddress)
    consola.success('💾 Deployment info saved')
  }

  return {
    address: result.contractAddress,
  }
}

/**
 * Deploy and register AllbridgeFacet to Tron
 */
async function deployAndRegisterAllbridgeFacet(
  options: { dryRun?: boolean } = {}
) {
  consola.start('TRON AllbridgeFacet Deployment & Registration')
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
    consola.error(`❌ ${error instanceof Error ? error.message : error}`)
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
    consola.error(`❌ ${error instanceof Error ? error.message : error}`)
    consola.error(
      `Please ensure ${
        environment === 'production' ? 'PRIVATE_KEY_PRODUCTION' : 'PRIVATE_KEY'
      } is set in your .env file`
    )
    process.exit(1)
  }

  // Load Allbridge configuration
  const allbridgeConfigPath = path.join(
    process.cwd(),
    'config',
    'allbridge.json'
  )
  if (!fs.existsSync(allbridgeConfigPath)) {
    consola.error('❌ config/allbridge.json not found')
    process.exit(1)
  }

  const allbridgeConfig = JSON.parse(
    fs.readFileSync(allbridgeConfigPath, 'utf8')
  )
  const tronAllbridgeConfig = allbridgeConfig.tron

  if (!tronAllbridgeConfig) {
    consola.error('❌ Tron configuration not found in allbridge.json')
    process.exit(1)
  }

  // Validate required address
  if (!tronAllbridgeConfig.allBridge) {
    consola.error('❌ Missing required address in Tron Allbridge config')
    consola.error('Required: allBridge')
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
    consola.info('1. Deploy AllbridgeFacet with constructor arguments')
    consola.info('   - allBridge:', tronAllbridgeConfig.allBridge)
    consola.info('2. Register AllbridgeFacet to LiFiDiamond')
    consola.info('   - Add facet with function selectors')
    consola.info('   - Verify registration')

    if (!options.dryRun && environment === 'production') {
      consola.warn(
        '⚠️  WARNING: This will deploy and register AllbridgeFacet to Tron mainnet in PRODUCTION!'
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
        '⚠️  This will deploy and register AllbridgeFacet to Tron mainnet in STAGING!'
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

    // STEP 1: DEPLOY ALLBRIDGEFACET
    consola.info('\n=== STEP 1: Deploy AllbridgeFacet ===')

    let allbridgeFacetAddress: string

    // Check if already deployed
    const existingAddress = await getContractAddress('tron', 'AllBridgeFacet')
    if (existingAddress && !options.dryRun) {
      consola.warn(
        `⚠️  AllbridgeFacet is already deployed at: ${existingAddress}`
      )
      const shouldRedeploy = await consola.prompt('Redeploy AllbridgeFacet?', {
        type: 'confirm',
        initial: false,
      })

      if (!shouldRedeploy) {
        consola.info(`✅ Using existing AllbridgeFacet at: ${existingAddress}`)
        allbridgeFacetAddress = existingAddress
      } else {
        // Deploy new instance
        const deployResult = await deployAllbridgeFacet(
          deployer,
          tronWeb,
          tronAllbridgeConfig.allBridge,
          options.dryRun || false
        )
        allbridgeFacetAddress = deployResult.address
      }
    } else {
      // Deploy new instance
      const deployResult = await deployAllbridgeFacet(
        deployer,
        tronWeb,
        tronAllbridgeConfig.allBridge,
        options.dryRun || false
      )
      allbridgeFacetAddress = deployResult.address
    }

    // STEP 2: REGISTER TO DIAMOND
    consola.info('\n=== STEP 2: Register to Diamond ===')
    await registerAllbridgeFacetToDiamond(
      allbridgeFacetAddress,
      tronWeb,
      network,
      options.dryRun
    )

    // Update tron.diamond.json after successful registration
    if (!options.dryRun) {
      await updateDiamondJson(allbridgeFacetAddress, 'AllBridgeFacet')
      consola.success('💾 Updated tron.diamond.json')
    }

    // Print final summary
    consola.success('\n✨ Deployment & Registration Complete!')
    consola.info('=====================================\n')
    consola.info('Contract: AllbridgeFacet')
    consola.info(`Address: ${allbridgeFacetAddress}`)
    consola.info(`Environment: ${environment.toUpperCase()}`)
    consola.info('Status: Deployed and Registered to Diamond')

    if (options.dryRun) 
      consola.info(
        '\n📌 This was a DRY RUN - no actual deployment or registration occurred'
      )
    
  } catch (error) {
    consola.error(
      '❌ Deployment failed:',
      error instanceof Error ? error.message : error
    )
    process.exit(1)
  }
}

// CLI handling
const main = defineCommand({
  meta: {
    name: 'deploy-and-register-allbridge-facet',
    description:
      'Deploy and register AllbridgeFacet to the Tron Diamond contract',
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
      await deployAndRegisterAllbridgeFacet(options)
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

if (import.meta.main) 
  runMain(main)


export { deployAndRegisterAllbridgeFacet }
