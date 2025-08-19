#!/usr/bin/env bun

import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'

import { getCurrentPrices } from './price-utils.js'
import { getEnvironment, updateDiamondJsonBatch } from './utils.js'

// Verified selectors (from contract-selectors.sh)
const FACET_SELECTORS: Record<string, string[]> = {
  DiamondLoupeFacet: [
    '0xcdffacc6', // facetAddress(bytes4)
    '0x52ef6b2c', // facetAddresses()
    '0xadfca15e', // facetFunctionSelectors(address)
    '0x7a0ed627', // facets()
    '0x01ffc9a7', // supportsInterface(bytes4)
  ],
  OwnershipFacet: [
    '0x23452b9c', // cancelOwnershipTransfer()
    '0x7200b829', // confirmOwnershipTransfer()
    '0x8da5cb5b', // owner()
    '0xf2fde38b', // transferOwnership(address)
  ],
  WithdrawFacet: [
    '0x1458d7ad', // executeCallAndWithdraw()
    '0xd9caed12', // withdraw()
  ],
  DexManagerFacet: [
    '0x536db266', // addDex(address)
    '0xfbb2d381', // approvedDexs()
    '0xfcd8e49e', // batchAddDex(address[])
    '0x9afc19c7', // batchRemoveDex(address[])
    '0x44e2b18c', // batchSetFunctionApprovalBySignature(bytes4[],bool)
    '0x2d2506a9', // isFunctionApproved(bytes4)
    '0x124f1ead', // removeDex(address)
    '0xc3a6a96b', // setFunctionApprovalBySignature(bytes4,bool)
  ],
  AccessManagerFacet: [
    '0x612ad9cb', // addressCanExecuteMethod(bytes4,address)
    '0xa4c3366e', // setCanExecute(bytes4,address,bool)
  ],
  PeripheryRegistryFacet: [
    '0xa516f0f3', // getPeripheryContract(string)
    '0x5c2ed36a', // registerPeripheryContract(string,address)
  ],
  GenericSwapFacet: [
    '0x4630a0d8', // swapTokensGeneric()
  ],
  GenericSwapFacetV3: [
    '0xd5bcb610', // NATIVE_ADDRESS()
    '0x5fd9ae2e', // swapTokensMultipleV3ERC20ToERC20()
    '0x2c57e884', // swapTokensMultipleV3ERC20ToNative()
    '0x736eac0b', // swapTokensMultipleV3NativeToERC20()
    '0x4666fc80', // swapTokensSingleV3ERC20ToERC20()
    '0x733214a3', // swapTokensSingleV3ERC20ToNative()
    '0xaf7060fd', // swapTokensSingleV3NativeToERC20()
  ],
  CalldataVerificationFacet: [
    '0x7f99d7af', // extractBridgeData(bytes)
    '0x103c5200', // extractData(bytes)
    '0xc318eeda', // extractGenericSwapParameters(bytes)
    '0xee0aa320', // extractMainParameters(bytes)
    '0xdf1c3a5b', // extractNonEVMAddress(bytes)
    '0x070e81f1', // extractSwapData(bytes)
    '0xd53482cf', // validateCalldata()
    '0xf58ae2ce', // validateDestinationCalldata()
  ],
  EmergencyPauseFacet: [
    '0xf86368ae', // pauseDiamond()
    '0x5ad317a4', // pauserWallet()
    '0x0340e905', // removeFacet(address)
    '0x2fc487ae', // unpauseDiamond(address[])
  ],
}

// Facet groups for split registration if needed
const FACET_GROUPS = [
  ['DiamondLoupeFacet'], // Critical - must be first
  ['OwnershipFacet', 'WithdrawFacet', 'AccessManagerFacet'], // Core management
  ['DexManagerFacet', 'PeripheryRegistryFacet'], // Configuration
  ['GenericSwapFacet', 'GenericSwapFacetV3'], // Swap functionality
  ['CalldataVerificationFacet', 'EmergencyPauseFacet'], // Security
]

/**
 * Estimate energy for diamondCut transaction using triggerconstantcontract
 */
async function estimateDiamondCutEnergy(
  tronWeb: any,
  diamondAddress: string,
  facetCuts: any[],
  fullHost: string
): Promise<number> {
  try {
    consola.info(
      ' Calling triggerconstantcontract API for energy estimation...'
    )

    // Diamond address should stay in base58 for Tron API

    // Encode parameters (without function selector)
    // facetCuts is already formatted as arrays
    const encodedParams = tronWeb.utils.abi.encodeParams(
      ['(address,uint8,bytes4[])[]', 'address', 'bytes'],
      [facetCuts, '0x0000000000000000000000000000000000000000', '0x']
    )

    // Function selector for diamondCut
    const functionSelector =
      'diamondCut((address,uint8,bytes4[])[],address,bytes)'

    // Make API call to triggerconstantcontract
    const apiUrl =
      fullHost.replace(/\/$/, '') + '/wallet/triggerconstantcontract'

    const payload = {
      owner_address: tronWeb.defaultAddress.base58,
      contract_address: diamondAddress, // Use base58 format for Tron API
      function_selector: functionSelector,
      parameter: encodedParams.replace('0x', ''),
      fee_limit: 1000000000, // High limit for estimation only
      call_value: 0,
      visible: true,
    }

    consola.info('📤 Sending payload to:', apiUrl)
    consola.info('Payload:', {
      owner_address: payload.owner_address,
      contract_address: payload.contract_address,
      function_selector: payload.function_selector,
      parameter_length: payload.parameter.length,
      parameter_preview: payload.parameter.substring(0, 100) + '...',
      fee_limit: payload.fee_limit,
      call_value: payload.call_value,
      visible: payload.visible,
    })

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

    consola.info(' Estimation API response:', JSON.stringify(result, null, 2))

    if (result.result?.result === false)
      throw new Error(
        `Energy estimation failed: ${
          result.result?.message || JSON.stringify(result)
        }`
      )

    if (result.energy_used) {
      consola.info(` Raw energy estimate: ${result.energy_used}`)
      // The actual transaction uses much more energy than the estimate
      // Multiply by 10x for safety (actual usage was ~16x the estimate)
      const safetyMultiplier = 10
      const estimatedEnergy = Math.ceil(result.energy_used * safetyMultiplier)
      consola.info(
        ` Energy with ${safetyMultiplier}x safety margin: ${estimatedEnergy}`
      )
      consola.warn(` Note: Actual energy usage may be higher than estimate`)
      return estimatedEnergy
    }

    throw new Error(
      `No energy estimation returned. Full response: ${JSON.stringify(result)}`
    )
  } catch (error: any) {
    consola.error(' Failed to estimate energy:', error.message)
    throw error
  }
}

/**
 * Register facets to diamond in batch
 */
async function registerFacetsBatch(
  tronWeb: any,
  diamond: any,
  diamondAddress: string,
  facetNames: string[],
  deployments: Record<string, string>,
  fullHost: string,
  dryRun = false,
  network: SupportedChain = 'tron'
): Promise<boolean> {
  const facetCuts = []

  for (const facetName of facetNames) {
    const facetAddress = deployments[facetName]
    if (!facetAddress) {
      consola.warn(` ${facetName} not found in deployments, skipping`)
      continue
    }

    // Check if already registered by checking if any selectors are already registered
    let isRegistered = false
    try {
      // Get currently registered facets
      const facetsResponse = await diamond.facets().call()
      const currentFacets = Array.isArray(facetsResponse[0])
        ? facetsResponse[0]
        : facetsResponse

      // Check if this facet address is already registered
      for (const facet of currentFacets) {
        const registeredAddress = tronWeb.address.fromHex(facet[0])
        if (registeredAddress === facetAddress) {
          isRegistered = true
          break
        }
      }
    } catch (e) {
      // If facets() fails, assume not registered
    }

    if (isRegistered) {
      consola.info(` ${facetName} already registered: ${facetAddress}`)
      continue
    }

    // Convert base58 to hex for ABI encoding
    const facetAddressHex = tronWeb.address
      .toHex(facetAddress)
      .replace(/^41/, '0x')

    // Push as array for TronWeb encoding
    facetCuts.push([
      facetAddressHex, // facetAddress
      0, // action (Add)
      FACET_SELECTORS[facetName], // functionSelectors
    ])

    consola.info(
      ` Prepared ${facetName}: ${facetAddress} with ${
        FACET_SELECTORS[facetName]?.length || 0
      } selectors`
    )
  }

  if (facetCuts.length === 0) {
    consola.success('✨ All facets in this batch already registered!')
    return true
  }

  // Estimate energy
  consola.info(`⚡ Estimating energy for ${facetCuts.length} facets...`)
  let estimatedEnergy: number
  let estimatedCost: number

  try {
    estimatedEnergy = await estimateDiamondCutEnergy(
      tronWeb,
      diamondAddress,
      facetCuts,
      fullHost
    )

    // Get current energy price from the network
    const { energyPrice } = await getCurrentPrices(tronWeb)
    estimatedCost = estimatedEnergy * energyPrice
    consola.info(` Estimated cost: ${estimatedCost.toFixed(4)} TRX`)
  } catch (error: any) {
    consola.error(
      ' Energy estimation failed. Cannot proceed without estimation.'
    )
    consola.error('Error details:', error.message)
    return false
  }
  if (dryRun) {
    consola.info(' Dry run mode - not executing transaction')
    // Format for display
    const displayCuts = facetCuts.map((cut) => ({
      facetAddress: cut[0],
      action: cut[1],
      functionSelectors: cut[2],
    }))
    consola.info('FacetCuts:', JSON.stringify(displayCuts, null, 2))
    return true
  }

  // Check balance - need at least 5 TRX for safety
  const balance = await tronWeb.trx.getBalance(tronWeb.defaultAddress.base58)
  const balanceTRX = balance / 1000000
  const requiredTRX = 5 // Based on actual usage, need at least 5 TRX

  if (balanceTRX < requiredTRX)
    throw new Error(
      `Insufficient balance. Have: ${balanceTRX} TRX, Need: at least ${requiredTRX} TRX`
    )
  // Execute diamondCut
  consola.info(` Executing diamondCut for ${facetCuts.length} facets...`)

  try {
    // First, let's verify the diamond has the diamondCut function
    try {
      const testResult =
        await tronWeb.transactionBuilder.triggerConstantContract(
          diamondAddress,
          'facetAddress(bytes4)',
          {},
          [{ type: 'bytes4', value: '0x1f931c1c' }] // diamondCut selector
        )

      if (testResult.result?.result)
        consola.info(' Diamond has diamondCut function registered')
    } catch (e) {
      consola.warn(' Could not verify diamondCut function')
    }

    // TronWeb contract calls - facetCuts is already formatted as arrays
    // Use a higher fee limit - the actual transaction needs more energy than estimated
    // Based on failed tx, it needs at least 3.41763 TRX worth of energy
    // Setting to 5 TRX (5,000,000,000 SUN) to be safe
    const feeLimitInSun = 5_000_000_000 // 5 TRX in SUN

    consola.info(`💸 Using fee limit: ${feeLimitInSun / 1_000_000} TRX`)

    const tx = await diamond
      .diamondCut(facetCuts, '0x0000000000000000000000000000000000000000', '0x')
      .send({
        feeLimit: feeLimitInSun,
        shouldPollResponse: true,
      })

    consola.success(` Transaction successful: ${tx}`)

    // Update tron.diamond.json with successfully registered facets
    if (!dryRun) {
      // Verify which facets were actually registered by checking the diamond
      const facetsResponse = await diamond.facets().call()
      const registeredFacets = Array.isArray(facetsResponse[0])
        ? facetsResponse[0]
        : facetsResponse

      const facetEntries = []
      for (const facetName of facetNames) {
        const facetAddress = deployments[facetName]
        if (facetAddress && FACET_SELECTORS[facetName]) {
          // Check if this facet is actually registered
          let isRegistered = false
          for (const facet of registeredFacets) {
            const registeredAddress = tronWeb.address.fromHex(facet[0])
            if (registeredAddress === facetAddress) {
              isRegistered = true
              break
            }
          }

          if (isRegistered)
            facetEntries.push({
              address: facetAddress,
              name: facetName,
            })
        }
      }

      if (facetEntries.length > 0)
        await updateDiamondJsonBatch(facetEntries, network)
    }

    return true
  } catch (error: any) {
    consola.error(' diamondCut failed:', error.message || error)

    // Log more details about the error
    if (error.error) consola.error('Error details:', error.error)

    if (error.output)
      consola.error('Output:', JSON.stringify(error.output, null, 2))

    if (error.transaction)
      consola.error('Transaction:', JSON.stringify(error.transaction, null, 2))

    // If it's a revert, try to decode the error
    if (
      error.error?.includes('REVERT') ||
      error.output?.contractResult?.[0] === 'REVERT'
    )
      consola.error('Contract reverted')

    return false
  }
}

/**
 * Main function to register facets to diamond
 */
async function registerFacetsToDiamond(
  options: {
    dryRun?: boolean
    splitMode?: boolean
  } = {}
) {
  try {
    // Get environment and determine network
    const environment = await getEnvironment()
    const networkName =
      environment === EnvironmentEnum.production ? 'tron' : 'tron-shasta'

    // 1. Load deployment addresses from network-specific file
    const fileSuffix =
      environment === EnvironmentEnum.production ? '' : 'staging.'
    const deploymentPath = path.join(
      process.cwd(),
      'deployments',
      `${networkName}.${fileSuffix}json`
    )

    if (!fs.existsSync(deploymentPath))
      throw new Error(
        `deployments/${networkName}.${fileSuffix}json not found. Please deploy contracts first.`
      )

    const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))

    // 2. Setup TronWeb
    const privateKey = getPrivateKeyForEnvironment(environment)
    const networkConfig = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'config', 'networks.json'),
        'utf8'
      )
    )
    const fullHost =
      networkConfig[networkName]?.rpcUrl || networkConfig[networkName]?.rpc

    if (!fullHost) throw new Error('Tron RPC URL not found in networks.json')

    const tronWeb = new TronWeb({
      fullHost,
      privateKey,
    })

    consola.info(` Connected to: ${fullHost}`)
    consola.info(`👛 Deployer: ${tronWeb.defaultAddress.base58}`)

    // 3. Get LiFiDiamond contract
    const diamondAddress = deployments.LiFiDiamond
    if (!diamondAddress) throw new Error('LiFiDiamond not found in deployments')

    consola.info(`🔷 LiFiDiamond: ${diamondAddress}`)

    // Load DiamondCutFacet ABI for the diamondCut function
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

    // Load DiamondLoupeFacet ABI for checking facets
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

    // Load OwnershipFacet ABI for owner function
    const ownershipABI = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'out',
          'OwnershipFacet.sol',
          'OwnershipFacet.json'
        ),
        'utf8'
      )
    ).abi

    // Combine ABIs for full diamond functionality
    const combinedABI = [...diamondCutABI, ...diamondLoupeABI, ...ownershipABI]

    // Get diamond contract instance with combined ABI
    const diamond = tronWeb.contract(combinedABI, diamondAddress)

    // 4. Check if DiamondLoupe already exists
    let loupeExists = false
    try {
      // Try to call facets() - if it works, DiamondLoupe is registered
      const facetsResponse = await diamond.facets().call()
      const facets = Array.isArray(facetsResponse[0])
        ? facetsResponse[0]
        : facetsResponse
      loupeExists = true
      consola.success(
        ` DiamondLoupe already registered, found ${facets.length} facets`
      )

      // List existing facets
      for (const facet of facets) {
        const facetHex = facet[0]
        const selectors = facet[1]

        let facetBase58: string
        try {
          facetBase58 = tronWeb.address.fromHex(facetHex)
        } catch {
          facetBase58 = facetHex
        }

        const facetName = Object.entries(deployments).find(
          ([_, addr]) => addr === facetBase58
        )?.[0]
        if (facetName)
          consola.info(
            `  - ${facetName}: ${facetBase58} (${selectors.length} selectors)`
          )
      }
    } catch (error) {
      consola.info(' DiamondLoupe not registered yet')
    }

    // 5. Determine registration strategy
    if (options.splitMode) {
      // Register in groups
      consola.info(' Using split registration mode...')

      for (let i = 0; i < FACET_GROUPS.length; i++) {
        const group = FACET_GROUPS[i]
        if (!group) continue

        // Skip DiamondLoupe group if already exists
        if (i === 0 && loupeExists) {
          consola.info(' Skipping DiamondLoupe group (already registered)')
          continue
        }

        consola.info(
          `\n Processing group ${i + 1}/${FACET_GROUPS.length}: ${group.join(
            ', '
          )}`
        )

        const success = await registerFacetsBatch(
          tronWeb,
          diamond,
          diamondAddress,
          group,
          deployments,
          fullHost,
          options.dryRun,
          networkName as SupportedChain
        )

        if (!success && !options.dryRun)
          throw new Error(`Failed to register group: ${group.join(', ')}`)

        // Small delay between groups
        if (i < FACET_GROUPS.length - 1 && !options.dryRun) {
          consola.info(' Waiting 3 seconds before next group...')
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      }
    } else {
      // Register all at once
      consola.info(' Using batch registration mode...')

      const allFacets = [
        'DiamondLoupeFacet',
        'OwnershipFacet',
        'WithdrawFacet',
        'DexManagerFacet',
        'AccessManagerFacet',
        'PeripheryRegistryFacet',
        'GenericSwapFacet',
        'GenericSwapFacetV3',
        'CalldataVerificationFacet',
        'EmergencyPauseFacet',
      ]

      // Remove DiamondLoupe if already exists
      const facetsToRegister = loupeExists
        ? allFacets.filter((f) => f !== 'DiamondLoupeFacet')
        : allFacets

      const success = await registerFacetsBatch(
        tronWeb,
        diamond,
        diamondAddress,
        facetsToRegister,
        deployments,
        fullHost,
        options.dryRun,
        networkName as SupportedChain
      )

      if (!success && !options.dryRun) {
        consola.warn(' Batch registration failed. Try using --split mode.')
        throw new Error('Batch registration failed')
      }
    }

    // 6. Final verification (if not dry run)
    if (!options.dryRun) {
      consola.info('\n Verifying final facet registration...')

      try {
        // Call facets() to get the full list with selectors
        const facetsResponse = await diamond.facets().call()

        // The response is nested - extract the actual facets array
        const facets = Array.isArray(facetsResponse[0])
          ? facetsResponse[0]
          : facetsResponse

        consola.success(` Total registered facets: ${facets.length}`)

        // Map addresses to names and display
        const facetList: string[] = []
        for (const facet of facets) {
          // Each facet is [address, selectors[]]
          const facetHex = facet[0]
          const selectors = facet[1]

          let facetBase58: string
          try {
            facetBase58 = tronWeb.address.fromHex(facetHex)
          } catch {
            // If conversion fails, show the hex
            facetBase58 = facetHex
          }

          const facetName = Object.entries(deployments).find(
            ([_, addr]) => addr === facetBase58
          )?.[0]

          if (facetName) {
            facetList.push(facetName)
            consola.info(
              `   ${facetName}: ${facetBase58} (${selectors.length} functions)`
            )
          } else consola.warn(`   Unknown facet: ${facetBase58}`)
        }

        // Check if all expected facets are registered
        // Include DiamondCutFacet which is registered during diamond deployment
        const expectedFacets = [
          'DiamondCutFacet',
          ...Object.keys(FACET_SELECTORS),
        ]
        const missingFacets = expectedFacets.filter(
          (f) => !facetList.includes(f)
        )

        if (missingFacets.length > 0)
          consola.warn(` Missing facets: ${missingFacets.join(', ')}`)
        else consola.success('✨ All expected facets are registered!')

        // Test a basic function call
        consola.info('\n Testing basic function calls...')

        try {
          const owner = await diamond.owner().call()
          consola.success(`   owner(): ${owner}`)
        } catch (error) {
          consola.warn(
            '   Could not call owner() - OwnershipFacet might not be registered'
          )
        }
      } catch (error: any) {
        consola.error(' Verification failed:', error.message)
      }
    }
  } catch (error: any) {
    consola.error(' Registration failed:', error.message || error)
    throw error
  }
}

// CLI handling
const main = defineCommand({
  meta: {
    name: 'register-facets-to-diamond',
    description: 'Register facets to the Tron Diamond contract',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Run in dry-run mode without sending transactions',
      default: false,
    },
    split: {
      type: 'boolean',
      description: 'Use split mode to register facets in groups',
      default: false,
    },
  },
  async run({ args }) {
    const options = {
      dryRun: args.dryRun,
      splitMode: args.split,
    }

    if (args.dryRun)
      consola.info(' Running in DRY RUN mode - no transactions will be sent')

    if (args.split)
      consola.info(' Using SPLIT mode - facets will be registered in groups')

    consola.start('Starting facet registration...')

    try {
      await registerFacetsToDiamond(options)
      consola.success('✨ Facet registration complete!')
      process.exit(0)
    } catch (error) {
      consola.error(
        ' Registration failed:',
        error instanceof Error ? error.message : error
      )
      process.exit(1)
    }
  },
})

if (import.meta.main) runMain(main)

export { registerFacetsToDiamond }
