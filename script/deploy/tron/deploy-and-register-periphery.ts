#!/usr/bin/env bun

import { resolve } from 'path'

import {
  REGISTRATION_RPC_DELAY_MS,
  TRON_ZERO_ADDRESS,
  TronContractDeployer,
  createTronWeb,
  loadForgeArtifact,
  promptEnergyRentalReminder,
  tronAddressLikeToBase58,
  tronAddressToHex,
  tronRegistrationAddressToEvmHex,
  type ITronDeploymentConfig,
  type TronTvmNetworkName,
} from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import { encodeFunctionData } from 'viem'

import type { SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import { sleep } from '../../utils/delay'
import {
  getEnvVar,
  getRPCEnvVarName,
  checkExistingDeployment,
  getContractAddress,
  getEnvironment,
  getNetworkConfig,
  logDeployment,
  readJsonFile,
  saveContractAddress,
  updateDiamondJsonPeriphery,
} from '../../utils/utils'
import { ZERO_ADDRESS } from '../shared/constants.js'
import { getContractVersion } from '../shared/getContractVersion'
import { retryWithRateLimit } from '../shared/rateLimit.js'

import { getTronCorePeriphery } from './helpers/tronContractLists.js'
import { getTronWallet } from './tronUtils.js'

const ERC20_PROXY_ABI = [
  {
    name: 'setAuthorizedCaller',
    type: 'function' as const,
    inputs: [
      { name: 'caller', type: 'address' },
      { name: 'authorized', type: 'boolean' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'authorizedCallers',
    type: 'function' as const,
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
] as const

function isVersionAtLeast(version: string, minimum: string): boolean {
  const v = version.split('.').map((part) => parseInt(part, 10))
  const m = minimum.split('.').map((part) => parseInt(part, 10))
  for (let i = 0; i < 3; i++) {
    const a = v[i] ?? 0
    const b = m[i] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return true
}

async function ensureExecutorAuthorizedOnErc20Proxy(
  tronWeb: TronWeb,
  erc20ProxyAddress: string,
  executorAddress: string,
  erc20ProxyVersion: string,
  dryRun: boolean
): Promise<void> {
  if (!isVersionAtLeast(erc20ProxyVersion, '1.2.0')) return

  const erc20ProxyBase58 = tronAddressLikeToBase58(tronWeb, erc20ProxyAddress)
  const executorBase58 = tronAddressLikeToBase58(tronWeb, executorAddress)
  const contract = tronWeb.contract(ERC20_PROXY_ABI, erc20ProxyBase58)

  const isAuthorized = await contract.authorizedCallers(executorBase58).call()
  if (isAuthorized) {
    consola.info('Executor already authorized in ERC20Proxy')
    return
  }

  if (dryRun) {
    consola.info(
      `[DRY RUN] Would authorize Executor ${executorBase58} on ERC20Proxy ${erc20ProxyBase58}`
    )
    return
  }

  consola.info(
    `Authorizing Executor ${executorBase58} on ERC20Proxy ${erc20ProxyBase58}...`
  )
  const tx = await contract
    .setAuthorizedCaller(executorBase58, true)
    .send({ feeLimit: 10_000_000, shouldPollResponse: true })
  consola.success(`Executor authorized on ERC20Proxy (tx: ${tx})`)
}

const PERIPHERY_REGISTRY_ABI = [
  {
    name: 'registerPeripheryContract',
    type: 'function' as const,
    inputs: [
      { name: '_name', type: 'string' },
      { name: '_contractAddress', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/**
 * Deploy and register periphery contracts to Tron
 */
async function deployAndRegisterPeripheryImpl(options: {
  dryRun: boolean
  verbose: boolean
  skipConfirmation: boolean
  onlyContracts?: string[]
  registerOnly?: boolean
}) {
  consola.start('TRON Periphery Contracts Deployment & Registration')

  const environment = getEnvironment()

  // Load environment variables
  const dryRun = options.dryRun
  const verbose = options.verbose
  const onlyContracts = options.onlyContracts

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

  const tvmKey = networkName as TronTvmNetworkName

  const tronWeb = createTronWeb({
    rpcUrl,
    networkKey: tvmKey,
    privateKey,
  })

  // Initialize deployer
  const config: ITronDeploymentConfig = {
    fullHost: rpcUrl,
    tvmNetworkKey: tvmKey,
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
      `   Base58: ${tronAddressLikeToBase58(tronWeb, diamondAddress)}`
    )

    // Load configurations (Tron addresses under globalConfig.tronWallets via getTronWallet)
    const globalConfig = await readJsonFile<{
      refundWallet: string
      feeCollectorOwner: string
      withdrawWallet: string
      deployerWallet?: string
      tronWallets?: {
        refundWallet?: string
        feeCollectorOwner?: string
        withdrawWallet?: string
        deployerWallet?: string
      }
    }>(resolve(process.cwd(), 'config/global.json'))
    if (!globalConfig) throw new Error('Failed to load config/global.json')

    const globalConfigRecord = globalConfig as Record<string, unknown>

    if (!options.registerOnly) {
      consola.info('\n Deployment Plan:')
      consola.info('1. Deploy ERC20Proxy')
      consola.info('2. Deploy Executor (depends on ERC20Proxy)')
      consola.info('3. Deploy FeeCollector')
      consola.info('4. Deploy FeeForwarder')
      consola.info('5. Deploy TokenWrapper')
      consola.info('6. Deploy OutputValidator')
      consola.info(
        '7. Deploy LiFiTimelockController (if tron.safeAddress set; not registered with Diamond)'
      )
      consola.info(
        '8. Register periphery contracts with PeripheryRegistryFacet\n'
      )

      if (!dryRun) await promptEnergyRentalReminder()
    } else {
      consola.info(
        '\n Register-only mode: will register contract(s) from deployments file with the Diamond.\n'
      )
    }

    // Delay before first RPC to avoid 429 rate limits
    if (!dryRun) await sleep(10000)

    if (!dryRun && !options.skipConfirmation && !options.registerOnly)
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
    const deploymentResults: Array<{
      contract: string
      address: string
      txId: string
      cost: number
      version: string
    }> = []

    if (options.registerOnly) {
      consola.info(
        'Loading deployed contract addresses from deployments file...'
      )
      const toLoad: string[] =
        onlyContracts !== undefined && onlyContracts.length > 0
          ? onlyContracts
          : getTronCorePeriphery()
      for (const name of toLoad) {
        const addr = await getContractAddress(network, name)
        if (addr) deployedContracts[name] = addr
      }
      if (Object.keys(deployedContracts).length === 0) {
        consola.error(
          'No deployed addresses found for the specified contract(s). Run deploy first or check --only.'
        )
        process.exit(1)
      }
      consola.info(
        `Loaded ${
          Object.keys(deployedContracts).length
        } contract(s) for registration.`
      )
    } else {
      // 1. Deploy ERC20Proxy
      if (!onlyContracts || onlyContracts.includes('ERC20Proxy')) {
        consola.info('\n Deploying ERC20Proxy...')

        try {
          // Check if already deployed
          const erc20Deployment = await checkExistingDeployment(
            network,
            'ERC20Proxy',
            dryRun
          )

          if (
            erc20Deployment.exists &&
            erc20Deployment.address &&
            !erc20Deployment.shouldRedeploy
          ) {
            consola.info(
              `Using existing ERC20Proxy at: ${erc20Deployment.address}`
            )
            deployedContracts['ERC20Proxy'] = erc20Deployment.address

            const version = await getContractVersion('ERC20Proxy')
            deploymentResults.push({
              contract: 'ERC20Proxy',
              address: erc20Deployment.address,
              txId: 'existing',
              cost: 0,
              version,
            })
          } else {
            // Deploy new ERC20Proxy (no existing deployment or redeploy requested)
            const artifact = await loadForgeArtifact('ERC20Proxy')
            const version = await getContractVersion('ERC20Proxy')

            const ownerHex = tronAddressToHex(tronWeb, networkInfo.address)
            const constructorArgs = [ownerHex, ZERO_ADDRESS]

            consola.info(
              ` Using owner: ${networkInfo.address} (hex: ${ownerHex})`
            )
            consola.info(
              ' Executor pre-authorization skipped at deploy (Tron); will authorize after Executor deploy'
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

            consola.success(
              ` ERC20Proxy deployed to: ${result.contractAddress}`
            )
            consola.info(`Transaction: ${result.transactionId}`)
            consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

            if (!dryRun) {
              await logDeployment(
                'ERC20Proxy',
                network,
                result.contractAddress,
                version,
                '0x',
                false
              )
              await saveContractAddress(
                network,
                'ERC20Proxy',
                result.contractAddress
              )
            }
          }

          if (!dryRun) await sleep(8000)
        } catch (error: any) {
          consola.error(` Failed to deploy ERC20Proxy:`, error.message)
          process.exit(1)
        }
      }

      // 2. Deploy Executor (depends on ERC20Proxy)
      if (!onlyContracts || onlyContracts.includes('Executor')) {
        consola.info('\n Deploying Executor...')

        try {
          // Check if already deployed
          const executorDeployment = await checkExistingDeployment(
            network,
            'Executor',
            dryRun
          )

          if (
            executorDeployment.exists &&
            executorDeployment.address &&
            !executorDeployment.shouldRedeploy
          ) {
            consola.info(
              `Using existing Executor at: ${executorDeployment.address}`
            )
            deployedContracts['Executor'] = executorDeployment.address

            const version = await getContractVersion('Executor')
            deploymentResults.push({
              contract: 'Executor',
              address: executorDeployment.address,
              txId: 'existing',
              cost: 0,
              version,
            })
          } else {
            // Deploy new Executor (no existing deployment or redeploy requested)
            const artifact = await loadForgeArtifact('Executor')
            const version = await getContractVersion('Executor')

            const erc20ProxyAddress =
              deployedContracts['ERC20Proxy'] ||
              (await getContractAddress(network, 'ERC20Proxy'))
            if (!erc20ProxyAddress)
              throw new Error('ERC20Proxy address not found')

            // Convert addresses to hex format for constructor
            const erc20ProxyHex = erc20ProxyAddress.startsWith('0x')
              ? erc20ProxyAddress
              : tronAddressToHex(tronWeb, erc20ProxyAddress)
            const refundWalletHex = tronRegistrationAddressToEvmHex(
              tronWeb,
              getTronWallet(globalConfigRecord, 'refundWallet')
            )

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
                network,
                result.contractAddress,
                version,
                '0x',
                false
              )
              await saveContractAddress(
                network,
                'Executor',
                result.contractAddress
              )
            }
          }

          const erc20ProxyAddress =
            deployedContracts['ERC20Proxy'] ||
            (await getContractAddress(network, 'ERC20Proxy'))
          const executorAddress =
            deployedContracts['Executor'] ||
            (await getContractAddress(network, 'Executor'))
          if (
            erc20ProxyAddress &&
            executorAddress &&
            executorAddress !== 'FAILED'
          ) {
            const erc20ProxyVersion = await getContractVersion('ERC20Proxy')
            await ensureExecutorAuthorizedOnErc20Proxy(
              tronWeb,
              erc20ProxyAddress,
              executorAddress,
              erc20ProxyVersion,
              dryRun
            )
          }

          if (!dryRun) await sleep(8000)
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
      }

      // 3. Deploy FeeCollector
      if (!onlyContracts || onlyContracts.includes('FeeCollector')) {
        consola.info('\n Deploying FeeCollector...')

        try {
          // Check if already deployed
          const feeCollectorDeployment = await checkExistingDeployment(
            network,
            'FeeCollector',
            dryRun
          )

          if (
            feeCollectorDeployment.exists &&
            feeCollectorDeployment.address &&
            !feeCollectorDeployment.shouldRedeploy
          ) {
            consola.info(
              `Using existing FeeCollector at: ${feeCollectorDeployment.address}`
            )
            deployedContracts['FeeCollector'] = feeCollectorDeployment.address

            const version = await getContractVersion('FeeCollector')
            deploymentResults.push({
              contract: 'FeeCollector',
              address: feeCollectorDeployment.address,
              txId: 'existing',
              cost: 0,
              version,
            })
          } else {
            // Deploy new FeeCollector (no existing deployment or redeploy requested)
            const artifact = await loadForgeArtifact('FeeCollector')
            const version = await getContractVersion('FeeCollector')

            const feeCollectorOwnerHex = tronRegistrationAddressToEvmHex(
              tronWeb,
              getTronWallet(globalConfigRecord, 'feeCollectorOwner')
            )
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
                network,
                result.contractAddress,
                version,
                '0x',
                false
              )
              await saveContractAddress(
                network,
                'FeeCollector',
                result.contractAddress
              )
            }
          }

          if (!dryRun) await sleep(8000)
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
      }

      // 4. Deploy FeeForwarder
      if (!onlyContracts || onlyContracts.includes('FeeForwarder')) {
        consola.info('\n Deploying FeeForwarder...')

        try {
          // Check if already deployed
          const feeForwarderDeployment = await checkExistingDeployment(
            network,
            'FeeForwarder',
            dryRun
          )

          if (
            feeForwarderDeployment.exists &&
            feeForwarderDeployment.address &&
            !feeForwarderDeployment.shouldRedeploy
          ) {
            consola.info(
              `Using existing FeeForwarder at: ${feeForwarderDeployment.address}`
            )
            deployedContracts['FeeForwarder'] = feeForwarderDeployment.address

            const version = await getContractVersion('FeeForwarder')
            deploymentResults.push({
              contract: 'FeeForwarder',
              address: feeForwarderDeployment.address,
              txId: 'existing',
              cost: 0,
              version,
            })
          } else {
            // Deploy new FeeForwarder (no existing deployment or redeploy requested)
            const artifact = await loadForgeArtifact('FeeForwarder')
            const version = await getContractVersion('FeeForwarder')

            const withdrawWallet = tronRegistrationAddressToEvmHex(
              tronWeb,
              getTronWallet(globalConfigRecord, 'withdrawWallet')
            )
            const constructorArgs = [withdrawWallet]

            consola.info(
              `Using withdrawWallet as contract owner: ${withdrawWallet}`
            )
            consola.info(`Version: ${version}`)

            const result = await deployer.deployContract(
              artifact,
              constructorArgs
            )

            deployedContracts['FeeForwarder'] = result.contractAddress
            deploymentResults.push({
              contract: 'FeeForwarder',
              address: result.contractAddress,
              txId: result.transactionId,
              cost: result.actualCost.trxCost,
              version,
            })

            consola.success(
              ` FeeForwarder deployed to: ${result.contractAddress}`
            )
            consola.info(`Transaction: ${result.transactionId}`)
            consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

            if (!dryRun) {
              await logDeployment(
                'FeeForwarder',
                network,
                result.contractAddress,
                version,
                '0x',
                false
              )
              await saveContractAddress(
                network,
                'FeeForwarder',
                result.contractAddress
              )
            }
          }

          if (!dryRun) await sleep(8000)
        } catch (error: any) {
          consola.error(` Failed to deploy FeeForwarder:`, error.message)
          deploymentResults.push({
            contract: 'FeeForwarder',
            address: 'FAILED',
            txId: 'FAILED',
            cost: 0,
            version: '0.0.0',
          })
        }
      }

      // 5. Deploy TokenWrapper
      if (!onlyContracts || onlyContracts.includes('TokenWrapper')) {
        consola.info('\n Deploying TokenWrapper...')

        // Check if wrapped native address is valid (not zero address)
        const wrappedNativeBase58Check = tronConfig.wrappedNativeAddress
        const wrappedNativeHexCheck = wrappedNativeBase58Check
          ? tronAddressToHex(tronWeb, wrappedNativeBase58Check)
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
            // Check if already deployed
            const tokenWrapperDeployment = await checkExistingDeployment(
              network,
              'TokenWrapper',
              dryRun
            )

            if (
              tokenWrapperDeployment.exists &&
              tokenWrapperDeployment.address &&
              !tokenWrapperDeployment.shouldRedeploy
            ) {
              consola.info(
                `Using existing TokenWrapper at: ${tokenWrapperDeployment.address}`
              )
              deployedContracts['TokenWrapper'] = tokenWrapperDeployment.address

              const version = await getContractVersion('TokenWrapper')
              deploymentResults.push({
                contract: 'TokenWrapper',
                address: tokenWrapperDeployment.address,
                txId: 'existing',
                cost: 0,
                version,
              })
            } else {
              // Deploy new TokenWrapper (no existing deployment or redeploy requested)
              const artifact = await loadForgeArtifact('TokenWrapper')
              const version = await getContractVersion('TokenWrapper')

              // Get wrapped native address from networks.json (tronConfig already loaded)
              // Use tronConfig that was already loaded at the beginning
              const wrappedNativeBase58 = tronConfig.wrappedNativeAddress
              if (!wrappedNativeBase58)
                throw new Error(
                  `wrappedNativeAddress not found for ${network} in networks.json`
                )

              // wrappedNativeAddress is already in base58 format (T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb)
              // Convert to hex, ensuring it's not the zero address
              const wrappedNativeHex = tronAddressToHex(
                tronWeb,
                wrappedNativeBase58
              )

              // Verify it's not zero address
              if (
                wrappedNativeHex ===
                '0x0000000000000000000000000000000000000000'
              )
                throw new Error(
                  `Invalid wrapped native address conversion: ${wrappedNativeBase58} -> ${wrappedNativeHex}`
                )

              const refundWalletHex = tronRegistrationAddressToEvmHex(
                tronWeb,
                getTronWallet(globalConfigRecord, 'refundWallet')
              )

              // Try to get converter address, default to zero address if not found
              const converterHex = tronConfig.converterAddress
                ? tronAddressToHex(tronWeb, tronConfig.converterAddress)
                : '0x0000000000000000000000000000000000000000'

              const constructorArgs = [
                wrappedNativeHex,
                converterHex,
                refundWalletHex,
              ]

              consola.info(
                ` Using wrappedNative: ${wrappedNativeBase58} (hex: ${wrappedNativeHex})`
              )
              consola.info(
                `Using converter: ${
                  converterHex === '0x0000000000000000000000000000000000000000'
                    ? 'None (zero address)'
                    : converterHex
                }`
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
                  network,
                  result.contractAddress,
                  version,
                  '0x',
                  false
                )
                await saveContractAddress(
                  network,
                  'TokenWrapper',
                  result.contractAddress
                )
              }
            }

            if (!dryRun) await sleep(8000)
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
      }

      // 6. Deploy OutputValidator
      if (!onlyContracts || onlyContracts.includes('OutputValidator')) {
        consola.info('\n Deploying OutputValidator...')

        try {
          const outputValidatorDeployment = await checkExistingDeployment(
            network,
            'OutputValidator',
            dryRun
          )

          if (
            outputValidatorDeployment.exists &&
            outputValidatorDeployment.address &&
            !outputValidatorDeployment.shouldRedeploy
          ) {
            consola.info(
              `Using existing OutputValidator at: ${outputValidatorDeployment.address}`
            )
            deployedContracts['OutputValidator'] =
              outputValidatorDeployment.address

            const version = await getContractVersion('OutputValidator')
            deploymentResults.push({
              contract: 'OutputValidator',
              address: outputValidatorDeployment.address,
              txId: 'existing',
              cost: 0,
              version,
            })
          } else {
            // Constructor: owner address (deployer)
            const artifact = await loadForgeArtifact('OutputValidator')
            const version = await getContractVersion('OutputValidator')
            const ownerHex = tronAddressToHex(tronWeb, networkInfo.address)
            const constructorArgs = [ownerHex]

            consola.info(
              ` Using owner: ${networkInfo.address} (hex: ${ownerHex})`
            )
            consola.info(`Version: ${version}`)

            const result = await deployer.deployContract(
              artifact,
              constructorArgs
            )

            deployedContracts['OutputValidator'] = result.contractAddress
            deploymentResults.push({
              contract: 'OutputValidator',
              address: result.contractAddress,
              txId: result.transactionId,
              cost: result.actualCost.trxCost,
              version,
            })

            consola.success(
              ` OutputValidator deployed to: ${result.contractAddress}`
            )
            consola.info(`Transaction: ${result.transactionId}`)
            consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

            if (!dryRun) {
              await logDeployment(
                'OutputValidator',
                network,
                result.contractAddress,
                version,
                '0x',
                false
              )
              await saveContractAddress(
                network,
                'OutputValidator',
                result.contractAddress
              )
            }
          }

          if (!dryRun) await sleep(8000)
        } catch (error: any) {
          consola.error(` Failed to deploy OutputValidator:`, error.message)
          deploymentResults.push({
            contract: 'OutputValidator',
            address: 'FAILED',
            txId: 'FAILED',
            cost: 0,
            version: '0.0.0',
          })
        }
      }

      // 7. Deploy LiFiTimelockController (same phase as EVM Stage 7; not registered with Diamond)
      if (!onlyContracts || onlyContracts.includes('LiFiTimelockController')) {
        consola.info(
          '\n Deploying LiFiTimelockController (if Safe configured)...'
        )
        const safeAddress = (tronConfig.safeAddress ?? '').trim()
        if (safeAddress) {
          try {
            // Check if already deployed
            const timelockDeployment = await checkExistingDeployment(
              network,
              'LiFiTimelockController',
              dryRun
            )

            if (
              timelockDeployment.exists &&
              timelockDeployment.address &&
              !timelockDeployment.shouldRedeploy
            ) {
              consola.info('Skipping LiFiTimelockController deployment.')
              deployedContracts['LiFiTimelockController'] =
                timelockDeployment.address
            } else {
              const timelockConfig = await readJsonFile<{ minDelay: number }>(
                resolve(process.cwd(), 'config/timelockController.json')
              )
              if (
                timelockConfig?.minDelay === undefined ||
                timelockConfig?.minDelay === null ||
                Number.isNaN(Number(timelockConfig.minDelay))
              ) {
                consola.warn(
                  '  config/timelockController.json missing or invalid minDelay; skipping LiFiTimelockController.'
                )
              } else {
                let cancellerWallet: string
                try {
                  cancellerWallet = getTronWallet(
                    globalConfigRecord,
                    'deployerWallet'
                  )
                } catch {
                  cancellerWallet = ''
                }
                if (!cancellerWallet) {
                  consola.warn(
                    '  global.json missing tronWallets.deployerWallet/deployerWallet; skipping LiFiTimelockController.'
                  )
                } else {
                  const safeHex = safeAddress.startsWith('T')
                    ? tronAddressToHex(tronWeb, safeAddress)
                    : safeAddress.startsWith('0x')
                    ? safeAddress
                    : '0x' + safeAddress
                  const diamondHex = diamondAddress.startsWith('T')
                    ? tronAddressToHex(tronWeb, diamondAddress)
                    : diamondAddress.startsWith('0x')
                    ? diamondAddress
                    : '0x' + diamondAddress
                  const cancellerHex = cancellerWallet.startsWith('T')
                    ? tronAddressToHex(tronWeb, cancellerWallet)
                    : cancellerWallet.startsWith('0x')
                    ? cancellerWallet
                    : '0x' + cancellerWallet
                  const minDelay = Number(timelockConfig.minDelay)
                  const proposers = [safeHex]
                  const executors = [ZERO_ADDRESS]
                  const constructorArgs = [
                    minDelay,
                    proposers,
                    executors,
                    cancellerHex,
                    safeHex,
                    diamondHex,
                  ]
                  const artifact = await loadForgeArtifact(
                    'LiFiTimelockController'
                  )
                  const version = await getContractVersion(
                    'LiFiTimelockController'
                  )
                  const result = await deployer.deployContract(
                    artifact,
                    constructorArgs
                  )
                  deployedContracts['LiFiTimelockController'] =
                    result.contractAddress
                  deploymentResults.push({
                    contract: 'LiFiTimelockController',
                    address: result.contractAddress,
                    txId: result.transactionId,
                    cost: result.actualCost.trxCost,
                    version,
                  })
                  consola.success(
                    ` LiFiTimelockController deployed: ${result.contractAddress}`
                  )
                  if (!dryRun) {
                    await logDeployment(
                      'LiFiTimelockController',
                      network,
                      result.contractAddress,
                      version,
                      '0x',
                      false
                    )
                    await saveContractAddress(
                      network,
                      'LiFiTimelockController',
                      result.contractAddress
                    )
                  }
                }
              }
            }

            const attemptedTimelockDeploy =
              !timelockDeployment.exists || timelockDeployment.shouldRedeploy
            if (attemptedTimelockDeploy && !dryRun) await sleep(8000)
          } catch (error: any) {
            consola.error(
              ` Failed to deploy LiFiTimelockController:`,
              error.message
            )
            deploymentResults.push({
              contract: 'LiFiTimelockController',
              address: 'FAILED',
              txId: 'FAILED',
              cost: 0,
              version: '0.0.0',
            })
          }
        } else {
          consola.warn(
            '  tron.safeAddress not set in config/networks.json; skipping LiFiTimelockController. Deploy Safe first (deploy-safe-tron.ts), then run this script again.'
          )
        }
      }
    }

    // Register all periphery contracts with the diamond via Safe proposals
    // (LiFiTimelockController is a governance contract and is never registered)
    consola.info(
      '\n Registering periphery contracts with PeripheryRegistryFacet (via Safe proposals)...'
    )

    // Load PeripheryRegistryFacet artifact for read-only "already registered" checks
    const peripheryRegistryArtifact = await loadForgeArtifact(
      'PeripheryRegistryFacet'
    )
    const diamond = tronWeb.contract(
      peripheryRegistryArtifact.abi,
      diamondAddress
    )

    await sleep(REGISTRATION_RPC_DELAY_MS)

    for (const [name, address] of Object.entries(deployedContracts)) {
      if (name === 'LiFiTimelockController') continue // governance contract, not registered with PeripheryRegistryFacet (same as EVM)
      if (!address || address === 'FAILED' || address === 'SKIPPED') continue

      try {
        consola.info(`\n Registering ${name}...`)

        await sleep(REGISTRATION_RPC_DELAY_MS)
        // Skip if already registered at the same address (retry on 429)
        const registered = await retryWithRateLimit(
          () => diamond.getPeripheryContract(name).call(),
          3,
          REGISTRATION_RPC_DELAY_MS,
          (attempt, delay) =>
            consola.warn(
              `Rate limit (429) or connection issue, retry ${attempt}/3 in ${
                delay / 1000
              }s...`
            )
        )

        if (
          registered &&
          typeof registered === 'string' &&
          registered !== TRON_ZERO_ADDRESS
        ) {
          const registeredBase58 = tronAddressLikeToBase58(tronWeb, registered)
          const currentBase58 = tronAddressLikeToBase58(tronWeb, address)

          if (registeredBase58 === currentBase58) {
            consola.info(`${name} already correctly registered`)
            continue
          }

          consola.warn(`  ${name} registered with different address:`)
          consola.warn(`   Current: ${registeredBase58}`)
          consola.warn(`   New: ${currentBase58}`)
        }

        const addressHex = tronRegistrationAddressToEvmHex(
          tronWeb,
          address
        ) as `0x${string}`
        const calldata = encodeFunctionData({
          abi: PERIPHERY_REGISTRY_ABI,
          functionName: 'registerPeripheryContract',
          args: [name, addressHex],
        })

        // Registration goes through the Safe → Timelock governance flow: this
        // creates a pending proposal in MongoDB rather than sending a direct tx,
        // so other Safe owners can co-sign before it executes on-chain.
        const { runPropose } = await import('./propose-to-safe-tron.js')
        await runPropose({
          network: tvmKey,
          to: diamondAddress,
          calldata,
          timelock: true,
          dryRun,
        })

        // Record the pending registration in tron.diamond.json
        await updateDiamondJsonPeriphery(
          tronAddressLikeToBase58(tronWeb, address),
          name,
          network
        )
      } catch (err: unknown) {
        consola.error(
          ` Failed to propose registration for ${name}:`,
          err instanceof Error ? err.message : err
        )
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
    only: {
      type: 'string',
      description:
        'Comma-separated contract names to deploy and register only (e.g. FeeCollector). If omitted, all periphery contracts are deployed.',
      default: undefined,
    },
    registerOnly: {
      type: 'boolean',
      description:
        'Skip deployment; only register contract(s) from deployments file with the Diamond. Use with --only to register a single contract (e.g. after a failed registration).',
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

      const onlyContracts = args.only
        ? args.only
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined

      await deployAndRegisterPeripheryImpl({
        dryRun,
        verbose,
        skipConfirmation: args.skipConfirmation,
        onlyContracts,
        registerOnly: args.registerOnly,
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
