#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { TronWeb } from 'tronweb'

// Import utilities from existing scripts
import type { SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import {
  getEnvVar,
  getPrivateKeyForEnvironment,
} from '../../demoScripts/utils/demoScriptHelpers'
import { getRPCEnvVarName } from '../../utils/network'

import { TronContractDeployer } from './TronContractDeployer'
import type { ITronDeploymentConfig } from './types'
import {
  loadForgeArtifact,
  getContractVersion,
  getEnvironment,
  getNetworkConfig,
  getContractAddress,
  saveContractAddress,
  logDeployment,
  updateDiamondJsonPeriphery,
} from './utils.js'

// Periphery contracts to deploy
const PERIPHERY_CONTRACTS = [
  'ERC20Proxy',
  'Executor',
  'FeeCollector',
  'TokenWrapper',
]

/**
 * Deploy and register periphery contracts to Tron
 */
async function deployAndRegisterPeripheryImpl(options: {
  dryRun: boolean
  verbose: boolean
  skipConfirmation: boolean
}) {
  consola.start('TRON Periphery Contracts Deployment & Registration')

  // Get environment from config.sh
  const environment = await getEnvironment()

  // Load environment variables
  const dryRun = options.dryRun
  const verbose = options.verbose

  // Get network configuration from networks.json
  // Use tronshasta for staging/testnet, tron for production
  const networkName =
    environment === EnvironmentEnum.production ? 'tron' : 'tronshasta'
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

  // Get RPC URL from environment variable
  let rpcUrl: string
  try {
    const envVarName = getRPCEnvVarName(networkName)
    rpcUrl = getEnvVar(envVarName)
  } catch (error: any) {
    consola.error(
      `Failed to get RPC URL from environment variable: ${error.message}`
    )
    consola.error(
      `Please ensure the RPC URL environment variable is set for ${networkName}`
    )
    process.exit(1)
  }

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

  // Initialize TronWeb with RPC from networks.json
  const tronWeb = new TronWeb({
    fullHost: rpcUrl,
    privateKey,
  })

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
    consola.info('Network Info:', {
      network: network.includes('shasta') ? 'Shasta Testnet' : 'Mainnet',
      rpcUrl: network,
      environment:
        environment === EnvironmentEnum.production ? 'PRODUCTION' : 'STAGING',
      address: networkInfo.address,
      balance: `${networkInfo.balance} TRX`,
      block: networkInfo.block,
    })

    if (networkInfo.balance < 100)
      consola.warn('Low balance detected. Deployment may fail.')

    // Check if LiFiDiamond exists
    const diamondAddress = await getContractAddress(network, 'LiFiDiamond')
    if (!diamondAddress) {
      consola.error('LiFiDiamond not found in deployment file')
      consola.error(
        'Please deploy core facets first using deploy-core-facets.ts'
      )
      process.exit(1)
    }

    consola.info(`\n LiFiDiamond address: ${diamondAddress}`)
    consola.info(
      `   Base58: ${tronWeb.address.fromHex(
        diamondAddress.replace('0x', '41')
      )}`
    )

    // Load configurations
    const globalConfig = await Bun.file('config/global.json').json()

    consola.info('\n Deployment Plan:')
    consola.info('1. Deploy ERC20Proxy')
    consola.info('2. Deploy Executor (depends on ERC20Proxy)')
    consola.info('3. Deploy FeeCollector')
    consola.info('4. Deploy TokenWrapper')
    consola.info('5. Register all contracts with PeripheryRegistryFacet\n')

    if (!dryRun && !options.skipConfirmation)
      if (environment === EnvironmentEnum.production) {
        consola.warn(
          ' WARNING: This will deploy contracts to Tron mainnet in PRODUCTION!'
        )
        const shouldContinue = await consola.prompt(
          'Do you want to continue?',
          {
            type: 'confirm',
            initial: false,
          }
        )

        if (!shouldContinue) {
          consola.info('Deployment cancelled')
          process.exit(0)
        }
      } else {
        consola.warn('This will deploy contracts to Tron mainnet in STAGING!')
        const shouldContinue = await consola.prompt(
          'Do you want to continue?',
          {
            type: 'confirm',
            initial: true,
          }
        )

        if (!shouldContinue) {
          consola.info('Deployment cancelled')
          process.exit(0)
        }
      }

    const deployedContracts: Record<string, string> = {}
    const deploymentResults = []

    // 1. Deploy ERC20Proxy
    consola.info('\n Deploying ERC20Proxy...')

    try {
      // Check if already deployed
      const existingAddress = await getContractAddress('tron', 'ERC20Proxy')
      if (existingAddress && !dryRun) {
        consola.warn(`  ERC20Proxy is already deployed at: ${existingAddress}`)
        const shouldRedeploy = await consola.prompt('Redeploy ERC20Proxy?', {
          type: 'confirm',
          initial: false,
        })

        if (!shouldRedeploy) {
          consola.info(`Using existing ERC20Proxy at: ${existingAddress}`)
          deployedContracts['ERC20Proxy'] = existingAddress

          const version = await getContractVersion('ERC20Proxy')
          deploymentResults.push({
            contract: 'ERC20Proxy',
            address: existingAddress,
            txId: 'existing',
            cost: 0,
            version,
          })
        } else {
          // Deploy new ERC20Proxy
          const artifact = await loadForgeArtifact('ERC20Proxy')
          const version = await getContractVersion('ERC20Proxy')

          // Constructor: owner address (deployer)
          const ownerHex =
            '0x' + tronWeb.address.toHex(networkInfo.address).substring(2)
          const constructorArgs = [ownerHex]

          consola.info(
            ` Using owner: ${networkInfo.address} (hex: ${ownerHex})`
          )
          consola.info(`Version: ${version}`)

          const result = await deployer.deployContract(
            artifact,
            constructorArgs
          )

          deployedContracts['ERC20Proxy'] = result.contractAddress
          deploymentResults.push({
            contract: 'ERC20Proxy',
            address: result.contractAddress,
            txId: result.transactionId,
            cost: result.actualCost.trxCost,
            version,
          })

          consola.success(` ERC20Proxy deployed to: ${result.contractAddress}`)
          consola.info(`Transaction: ${result.transactionId}`)
          consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

          if (!dryRun) {
            await logDeployment(
              'ERC20Proxy',
              'tron',
              result.contractAddress,
              version,
              '0x',
              false
            )
            await saveContractAddress(
              'tron',
              'ERC20Proxy',
              result.contractAddress
            )
          }
        }
      } else if (!existingAddress) {
        // Deploy new ERC20Proxy (no existing deployment)
        const artifact = await loadForgeArtifact('ERC20Proxy')
        const version = await getContractVersion('ERC20Proxy')

        const ownerHex =
          '0x' + tronWeb.address.toHex(networkInfo.address).substring(2)
        const constructorArgs = [ownerHex]

        consola.info(` Using owner: ${networkInfo.address} (hex: ${ownerHex})`)
        consola.info(`Version: ${version}`)

        const result = await deployer.deployContract(artifact, constructorArgs)

        deployedContracts['ERC20Proxy'] = result.contractAddress
        deploymentResults.push({
          contract: 'ERC20Proxy',
          address: result.contractAddress,
          txId: result.transactionId,
          cost: result.actualCost.trxCost,
          version,
        })

        consola.success(`ERC20Proxy deployed to: ${result.contractAddress}`)
        consola.info(`Transaction: ${result.transactionId}`)
        consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

        if (!dryRun) {
          await logDeployment(
            'ERC20Proxy',
            'tron',
            result.contractAddress,
            version,
            '0x',
            false
          )
          await saveContractAddress(
            'tron',
            'ERC20Proxy',
            result.contractAddress
          )
        }
      }

      if (!dryRun) await Bun.sleep(3000)
    } catch (error: any) {
      consola.error(` Failed to deploy ERC20Proxy:`, error.message)
      process.exit(1)
    }

    // 2. Deploy Executor (depends on ERC20Proxy)
    consola.info('\n Deploying Executor...')

    try {
      const existingAddress = await getContractAddress('tron', 'Executor')
      if (existingAddress && !dryRun) {
        consola.warn(`  Executor is already deployed at: ${existingAddress}`)
        const shouldRedeploy = await consola.prompt('Redeploy Executor?', {
          type: 'confirm',
          initial: false,
        })

        if (!shouldRedeploy) {
          consola.info(`Using existing Executor at: ${existingAddress}`)
          deployedContracts['Executor'] = existingAddress

          const version = await getContractVersion('Executor')
          deploymentResults.push({
            contract: 'Executor',
            address: existingAddress,
            txId: 'existing',
            cost: 0,
            version,
          })
        } else {
          // Deploy new Executor
          const artifact = await loadForgeArtifact('Executor')
          const version = await getContractVersion('Executor')

          const erc20ProxyAddress =
            deployedContracts['ERC20Proxy'] ||
            (await getContractAddress('tron', 'ERC20Proxy'))
          if (!erc20ProxyAddress)
            throw new Error('ERC20Proxy address not found')

          // Convert addresses to hex format for constructor
          const erc20ProxyHex = erc20ProxyAddress.startsWith('0x')
            ? erc20ProxyAddress
            : '0x' + tronWeb.address.toHex(erc20ProxyAddress).substring(2)
          const refundWalletHex = globalConfig.refundWallet

          const constructorArgs = [erc20ProxyHex, refundWalletHex]

          consola.info(`Using ERC20Proxy: ${erc20ProxyAddress}`)
          consola.info(`Using refundWallet: ${refundWalletHex}`)
          consola.info(`Version: ${version}`)

          const result = await deployer.deployContract(
            artifact,
            constructorArgs
          )

          deployedContracts['Executor'] = result.contractAddress
          deploymentResults.push({
            contract: 'Executor',
            address: result.contractAddress,
            txId: result.transactionId,
            cost: result.actualCost.trxCost,
            version,
          })

          consola.success(`Executor deployed to: ${result.contractAddress}`)
          consola.info(`Transaction: ${result.transactionId}`)
          consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

          if (!dryRun) {
            await logDeployment(
              'Executor',
              'tron',
              result.contractAddress,
              version,
              '0x',
              false
            )
            await saveContractAddress(
              'tron',
              'Executor',
              result.contractAddress
            )
          }
        }
      } else if (!existingAddress) {
        // Deploy new Executor (no existing deployment)
        const artifact = await loadForgeArtifact('Executor')
        const version = await getContractVersion('Executor')

        const erc20ProxyAddress =
          deployedContracts['ERC20Proxy'] ||
          (await getContractAddress('tron', 'ERC20Proxy'))
        if (!erc20ProxyAddress) throw new Error('ERC20Proxy address not found')

        const erc20ProxyHex = erc20ProxyAddress.startsWith('0x')
          ? erc20ProxyAddress
          : '0x' + tronWeb.address.toHex(erc20ProxyAddress).substring(2)
        const refundWalletHex = globalConfig.refundWallet

        const constructorArgs = [erc20ProxyHex, refundWalletHex]

        consola.info(`Using ERC20Proxy: ${erc20ProxyAddress}`)
        consola.info(`Using refundWallet: ${refundWalletHex}`)
        consola.info(`Version: ${version}`)

        const result = await deployer.deployContract(artifact, constructorArgs)

        deployedContracts['Executor'] = result.contractAddress
        deploymentResults.push({
          contract: 'Executor',
          address: result.contractAddress,
          txId: result.transactionId,
          cost: result.actualCost.trxCost,
          version,
        })

        consola.success(`Executor deployed to: ${result.contractAddress}`)
        consola.info(`Transaction: ${result.transactionId}`)
        consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

        if (!dryRun) {
          await logDeployment(
            'Executor',
            'tron',
            result.contractAddress,
            version,
            '0x',
            false
          )
          await saveContractAddress('tron', 'Executor', result.contractAddress)
        }
      }

      if (!dryRun) await Bun.sleep(3000)
    } catch (error: any) {
      consola.error(` Failed to deploy Executor:`, error.message)
      deploymentResults.push({
        contract: 'Executor',
        address: 'FAILED',
        txId: 'FAILED',
        cost: 0,
        version: '0.0.0',
      })
    }

    // 3. Deploy FeeCollector
    consola.info('\n Deploying FeeCollector...')

    try {
      const existingAddress = await getContractAddress('tron', 'FeeCollector')
      if (existingAddress && !dryRun) {
        consola.warn(
          `  FeeCollector is already deployed at: ${existingAddress}`
        )
        const shouldRedeploy = await consola.prompt('Redeploy FeeCollector?', {
          type: 'confirm',
          initial: false,
        })

        if (!shouldRedeploy) {
          consola.info(`Using existing FeeCollector at: ${existingAddress}`)
          deployedContracts['FeeCollector'] = existingAddress

          const version = await getContractVersion('FeeCollector')
          deploymentResults.push({
            contract: 'FeeCollector',
            address: existingAddress,
            txId: 'existing',
            cost: 0,
            version,
          })
        } else {
          // Deploy new FeeCollector
          const artifact = await loadForgeArtifact('FeeCollector')
          const version = await getContractVersion('FeeCollector')

          const feeCollectorOwnerHex = globalConfig.feeCollectorOwner
          const constructorArgs = [feeCollectorOwnerHex]

          consola.info(`Using feeCollectorOwner: ${feeCollectorOwnerHex}`)
          consola.info(`Version: ${version}`)

          const result = await deployer.deployContract(
            artifact,
            constructorArgs
          )

          deployedContracts['FeeCollector'] = result.contractAddress
          deploymentResults.push({
            contract: 'FeeCollector',
            address: result.contractAddress,
            txId: result.transactionId,
            cost: result.actualCost.trxCost,
            version,
          })

          consola.success(
            ` FeeCollector deployed to: ${result.contractAddress}`
          )
          consola.info(`Transaction: ${result.transactionId}`)
          consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

          if (!dryRun) {
            await logDeployment(
              'FeeCollector',
              'tron',
              result.contractAddress,
              version,
              '0x',
              false
            )
            await saveContractAddress(
              'tron',
              'FeeCollector',
              result.contractAddress
            )
          }
        }
      } else if (!existingAddress) {
        // Deploy new FeeCollector (no existing deployment)
        const artifact = await loadForgeArtifact('FeeCollector')
        const version = await getContractVersion('FeeCollector')

        const feeCollectorOwnerHex = globalConfig.feeCollectorOwner
        const constructorArgs = [feeCollectorOwnerHex]

        consola.info(`Using feeCollectorOwner: ${feeCollectorOwnerHex}`)
        consola.info(`Version: ${version}`)

        const result = await deployer.deployContract(artifact, constructorArgs)

        deployedContracts['FeeCollector'] = result.contractAddress
        deploymentResults.push({
          contract: 'FeeCollector',
          address: result.contractAddress,
          txId: result.transactionId,
          cost: result.actualCost.trxCost,
          version,
        })

        consola.success(` FeeCollector deployed to: ${result.contractAddress}`)
        consola.info(`Transaction: ${result.transactionId}`)
        consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

        if (!dryRun) {
          await logDeployment(
            'FeeCollector',
            'tron',
            result.contractAddress,
            version,
            '0x',
            false
          )
          await saveContractAddress(
            'tron',
            'FeeCollector',
            result.contractAddress
          )
        }
      }

      if (!dryRun) await Bun.sleep(3000)
    } catch (error: any) {
      consola.error(` Failed to deploy FeeCollector:`, error.message)
      deploymentResults.push({
        contract: 'FeeCollector',
        address: 'FAILED',
        txId: 'FAILED',
        cost: 0,
        version: '0.0.0',
      })
    }

    // 4. Deploy TokenWrapper
    consola.info('\n Deploying TokenWrapper...')

    // Check if wrapped native address is valid (not zero address)
    const wrappedNativeBase58Check = tronConfig.wrappedNativeAddress
    const wrappedNativeHexCheck = wrappedNativeBase58Check
      ? '0x' + tronWeb.address.toHex(wrappedNativeBase58Check).substring(2)
      : '0x0000000000000000000000000000000000000000'

    if (
      wrappedNativeHexCheck === '0x0000000000000000000000000000000000000000'
    ) {
      consola.warn(
        '  Wrapped native address is zero address. Skipping TokenWrapper deployment.'
      )
      consola.warn(
        '   Please update networks.json with a valid wrapped TRX address.'
      )
      deploymentResults.push({
        contract: 'TokenWrapper',
        address: 'SKIPPED',
        txId: 'SKIPPED',
        cost: 0,
        version: '0.0.0',
      })
    } else
      try {
        const existingAddress = await getContractAddress('tron', 'TokenWrapper')
        if (existingAddress && !dryRun) {
          consola.warn(
            `  TokenWrapper is already deployed at: ${existingAddress}`
          )
          const shouldRedeploy = await consola.prompt(
            'Redeploy TokenWrapper?',
            {
              type: 'confirm',
              initial: false,
            }
          )

          if (!shouldRedeploy) {
            consola.info(`Using existing TokenWrapper at: ${existingAddress}`)
            deployedContracts['TokenWrapper'] = existingAddress

            const version = await getContractVersion('TokenWrapper')
            deploymentResults.push({
              contract: 'TokenWrapper',
              address: existingAddress,
              txId: 'existing',
              cost: 0,
              version,
            })
          } else {
            // Deploy new TokenWrapper
            const artifact = await loadForgeArtifact('TokenWrapper')
            const version = await getContractVersion('TokenWrapper')

            // Get wrapped native address from networks.json (tronConfig already loaded)
            const wrappedNativeBase58 = tronConfig.wrappedNativeAddress
            if (!wrappedNativeBase58)
              throw new Error(
                'wrappedNativeAddress not found for tron in networks.json'
              )

            // wrappedNativeAddress is already in base58 format (T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb)
            // Convert to hex, ensuring it's not the zero address
            const wrappedNativeHex =
              '0x' + tronWeb.address.toHex(wrappedNativeBase58).substring(2)

            // Verify it's not zero address
            if (
              wrappedNativeHex === '0x0000000000000000000000000000000000000000'
            )
              throw new Error(
                `Invalid wrapped native address conversion: ${wrappedNativeBase58} -> ${wrappedNativeHex}`
              )

            const refundWalletHex = globalConfig.refundWallet

            const constructorArgs = [wrappedNativeHex, refundWalletHex]

            consola.info(
              ` Using wrappedNative: ${wrappedNativeBase58} (hex: ${wrappedNativeHex})`
            )
            consola.info(`Using refundWallet: ${refundWalletHex}`)
            consola.info(`Version: ${version}`)

            const result = await deployer.deployContract(
              artifact,
              constructorArgs
            )

            deployedContracts['TokenWrapper'] = result.contractAddress
            deploymentResults.push({
              contract: 'TokenWrapper',
              address: result.contractAddress,
              txId: result.transactionId,
              cost: result.actualCost.trxCost,
              version,
            })

            consola.success(
              ` TokenWrapper deployed to: ${result.contractAddress}`
            )
            consola.info(`Transaction: ${result.transactionId}`)
            consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

            if (!dryRun) {
              await logDeployment(
                'TokenWrapper',
                'tron',
                result.contractAddress,
                version,
                '0x',
                false
              )
              await saveContractAddress(
                'tron',
                'TokenWrapper',
                result.contractAddress
              )
            }
          }
        } else if (!existingAddress) {
          // Deploy new TokenWrapper (no existing deployment)
          const artifact = await loadForgeArtifact('TokenWrapper')
          const version = await getContractVersion('TokenWrapper')

          // Use tronConfig that was already loaded at the beginning
          const wrappedNativeBase58 = tronConfig.wrappedNativeAddress
          if (!wrappedNativeBase58)
            throw new Error(
              'wrappedNativeAddress not found for tron in networks.json'
            )

          // wrappedNativeAddress is already in base58 format (T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb)
          // Convert to hex, ensuring it's not the zero address
          const wrappedNativeHex =
            '0x' + tronWeb.address.toHex(wrappedNativeBase58).substring(2)

          // Verify it's not zero address
          if (wrappedNativeHex === '0x0000000000000000000000000000000000000000')
            throw new Error(
              `Invalid wrapped native address conversion: ${wrappedNativeBase58} -> ${wrappedNativeHex}`
            )

          const refundWalletHex = globalConfig.refundWallet

          const constructorArgs = [wrappedNativeHex, refundWalletHex]

          consola.info(
            ` Using wrappedNative: ${wrappedNativeBase58} (hex: ${wrappedNativeHex})`
          )
          consola.info(`Using refundWallet: ${refundWalletHex}`)
          consola.info(`Version: ${version}`)

          const result = await deployer.deployContract(
            artifact,
            constructorArgs
          )

          deployedContracts['TokenWrapper'] = result.contractAddress
          deploymentResults.push({
            contract: 'TokenWrapper',
            address: result.contractAddress,
            txId: result.transactionId,
            cost: result.actualCost.trxCost,
            version,
          })

          consola.success(
            ` TokenWrapper deployed to: ${result.contractAddress}`
          )
          consola.info(`Transaction: ${result.transactionId}`)
          consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

          if (!dryRun) {
            await logDeployment(
              'TokenWrapper',
              'tron',
              result.contractAddress,
              version,
              '0x',
              false
            )
            await saveContractAddress(
              'tron',
              'TokenWrapper',
              result.contractAddress
            )
          }
        }

        if (!dryRun) await Bun.sleep(3000)
      } catch (error: any) {
        consola.error(` Failed to deploy TokenWrapper:`, error.message)
        deploymentResults.push({
          contract: 'TokenWrapper',
          address: 'FAILED',
          txId: 'FAILED',
          cost: 0,
          version: '0.0.0',
        })
      }

    // Register all periphery contracts with the diamond
    consola.info(
      '\n Registering periphery contracts with PeripheryRegistryFacet...'
    )

    if (!dryRun) {
      // Load the PeripheryRegistryFacet ABI to interact with the diamond
      const peripheryRegistryArtifact = await loadForgeArtifact(
        'PeripheryRegistryFacet'
      )
      const diamond = tronWeb.contract(
        peripheryRegistryArtifact.abi,
        diamondAddress
      )

      for (const [name, address] of Object.entries(deployedContracts))
        if (address && address !== 'FAILED')
          try {
            consola.info(`\n Registering ${name}...`)

            // Check if already registered
            const registered = await diamond.getPeripheryContract(name).call()

            if (
              registered &&
              registered !== '410000000000000000000000000000000000000000'
            ) {
              const registeredBase58 = tronWeb.address.fromHex(registered)
              const currentBase58 = tronWeb.address.fromHex(
                address.replace('0x', '41')
              )

              if (registeredBase58 === currentBase58) {
                consola.info(`${name} already correctly registered`)
                continue
              } else {
                consola.warn(`  ${name} registered with different address:`)
                consola.warn(`   Current: ${registeredBase58}`)
                consola.warn(`   New: ${currentBase58}`)

                const shouldUpdate = await consola.prompt(
                  `Update registration for ${name}?`,
                  {
                    type: 'confirm',
                    initial: true,
                  }
                )

                if (!shouldUpdate) {
                  consola.info(`Keeping existing registration for ${name}`)
                  continue
                }
              }
            }

            // Register the contract
            const tx = await diamond
              .registerPeripheryContract(name, address)
              .send({
                feeLimit: 1_000_000_000, // 1000 TRX
                shouldPollResponse: true,
              })

            consola.success(`${name} registered successfully`)
            // TronWeb returns the transaction ID directly when shouldPollResponse is true
            const txId =
              typeof tx === 'string'
                ? tx
                : tx.txid || tx.transaction?.txID || tx
            consola.info(`   Transaction: ${txId}`)
          } catch (error: any) {
            consola.error(` Failed to register ${name}:`, error.message)
          }

      // Verify registrations
      consola.info('\n Verifying registrations...')

      for (const name of PERIPHERY_CONTRACTS)
        try {
          const registered = await diamond.getPeripheryContract(name).call()

          if (
            registered &&
            registered !== '410000000000000000000000000000000000000000'
          ) {
            const registeredBase58 = tronWeb.address.fromHex(registered)
            consola.success(`${name}: ${registeredBase58}`)

            // Update tron.diamond.json with successfully registered periphery contract
            const deployedAddress = deployedContracts[name]
            if (deployedAddress && deployedAddress !== 'FAILED') {
              // Convert to base58 if needed
              const addressToSave = deployedAddress.startsWith('T')
                ? deployedAddress
                : tronWeb.address.fromHex(deployedAddress.replace('0x', '41'))

              await updateDiamondJsonPeriphery(addressToSave, name)
            }
          } else consola.warn(`  ${name}: Not registered`)
        } catch (error: any) {
          consola.error(` Failed to verify ${name}:`, error.message)
        }
    }

    // Print summary
    consola.success('\n Deployment Complete!')
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

const deployCommand = defineCommand({
  meta: {
    name: 'deploy-and-register-periphery',
    description: 'Deploy and register periphery contracts to Tron',
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
    skipConfirmation: {
      type: 'boolean',
      description: 'Skip confirmation prompts',
      default: false,
    },
  },
  async run({ args }) {
    try {
      // Also check environment variables for backward compatibility
      let dryRun = args.dryRun
      let verbose = args.verbose

      try {
        const envDryRun = getEnvVar('DRY_RUN')
        if (!dryRun && envDryRun === 'true') dryRun = true
      } catch (error) {
        // Use default value when environment variable is not set
        consola.debug(
          'DRY_RUN environment variable not set, using default value'
        )
      }

      try {
        const envVerbose = getEnvVar('VERBOSE')
        if (envVerbose === 'false') verbose = false
      } catch (error) {
        // Use default value when environment variable is not set
        consola.debug(
          'VERBOSE environment variable not set, using default value'
        )
      }

      await deployAndRegisterPeripheryImpl({
        dryRun,
        verbose,
        skipConfirmation: args.skipConfirmation,
      })
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      consola.error('Deployment failed:', errorMessage)
      process.exit(1)
    }
  },
})

// Run the command
runMain(deployCommand)
