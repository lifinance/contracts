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
import { encodeFunctionData } from 'viem'

import type { IDeploymentResult, SupportedChain } from '../../common/types'
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
  readJsonFile,
  updateDiamondJsonPeriphery,
} from '../../utils/utils'
import { ZERO_ADDRESS } from '../shared/constants.js'
import { getContractVersion } from '../shared/getContractVersion'
import { retryWithRateLimit } from '../shared/rateLimit.js'

import { getTronCorePeriphery } from './helpers/tronContractLists.js'
import { deployContractWithLogging, getTronWallet } from './tronUtils.js'

/**
 * Explicit constructor arg overrides for contracts whose args can't be inferred from
 * parameter names alone (e.g. a param named `_owner` that should map to a non-deployer wallet).
 *
 * Contracts NOT listed here are handled automatically via `inferConstructorArgsFromAbi`:
 * any address param defaults to `$deployer`; well-known param names (see `paramNameToSpec`)
 * resolve to their respective wallets or config values.
 *
 * Spec syntax (for override entries):
 *   $deployer                 — deployer's TVM hex address
 *   $wallet:<name>            — globalConfig.tronWallets[name] as hex
 *   $deployed:<ContractName>  — address of an already-deployed contract
 *   $network:<key>!           — tronConfig[key] as hex; skips contract if zero/missing
 *   $network:<key>?           — tronConfig[key] as hex; zero address if missing
 */
const TRON_CONSTRUCTOR_ARGS_OVERRIDES: Record<string, string[]> = {
  // _owner resolves to feeCollectorOwner, not the deployer
  FeeCollector: ['$wallet:feeCollectorOwner'],
  // _owner resolves to withdrawWallet, not the deployer
  FeeForwarder: ['$wallet:withdrawWallet'],
  // multi-arg: needs deployed ERC20Proxy address + refundWallet
  Executor: ['$deployed:ERC20Proxy', '$wallet:refundWallet'],
  // multi-arg: wrappedNative (required), converter (optional), refundWallet
  TokenWrapper: [
    '$network:wrappedNativeAddress!',
    '$network:converterAddress?',
    '$wallet:refundWallet',
  ],
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
 * Maps a constructor parameter name (after stripping leading `_` and lowercasing) to a spec string.
 * Any address param not matched here defaults to `$deployer`.
 */
function paramNameToSpec(rawName: string): string {
  const name = rawName.replace(/^_/, '').toLowerCase()
  if (/erc20proxy/.test(name)) return '$deployed:ERC20Proxy'
  if (/refundwallet/.test(name)) return '$wallet:refundWallet'
  if (/withdrawwallet/.test(name)) return '$wallet:withdrawWallet'
  if (/wrappednative/.test(name)) return '$network:wrappedNativeAddress!'
  if (/converter/.test(name)) return '$network:converterAddress?'
  return '$deployer'
}

/**
 * Infer constructor args from the contract's ABI. Only address params are supported;
 * non-address params throw so the developer knows to add an explicit override.
 */
async function inferConstructorArgsFromAbi(
  artifact: {
    abi: Array<{
      type: string
      inputs?: Array<{ name: string; type: string }>
    }>
  },
  contractName: string,
  context: IDeployContext
): Promise<{ args: unknown[]; skip: boolean; skipReason?: string }> {
  const ctorEntry = artifact.abi.find(
    (e: { type: string }) => e.type === 'constructor'
  )
  const inputs = ctorEntry?.inputs ?? []
  if (inputs.length === 0) return { args: [], skip: false }

  const argsSpec = inputs.map(
    (input: { name: string; type: string }): string => {
      if (input.type !== 'address')
        throw new Error(
          `Cannot auto-resolve non-address param "${input.name}" (type "${input.type}") ` +
            `for ${contractName}. Add an explicit entry to TRON_CONSTRUCTOR_ARGS_OVERRIDES.`
        )
      return paramNameToSpec(input.name)
    }
  )

  return resolveConstructorArgs(contractName, argsSpec, context)
}

interface IDeployContext {
  tronWeb: ReturnType<typeof createTronWeb>
  networkInfo: { address: string; balance: number; block: number }
  tronConfig: Record<string, unknown>
  globalConfig: Record<string, unknown>
  deployedContracts: Record<string, string>
  network: SupportedChain
}

/**
 * Resolve a single constructor arg spec to its runtime value.
 *
 * Spec syntax:
 *   $deployer                 — deployer's TVM hex address
 *   $wallet:<name>            — globalConfig.tronWallets[name] as hex
 *   $deployed:<ContractName>  — address of an already-deployed contract
 *   $network:<key>!           — tronConfig[key] as hex; skips contract if zero/missing
 *   $network:<key>?           — tronConfig[key] as hex; zero address if missing
 */
async function resolveArg(
  spec: string,
  context: IDeployContext
): Promise<{ value: unknown; skip: boolean; skipReason?: string }> {
  const {
    tronWeb,
    networkInfo,
    tronConfig,
    globalConfig,
    deployedContracts,
    network,
  } = context

  if (spec === '$deployer') {
    return {
      value: tronAddressToHex(tronWeb, networkInfo.address),
      skip: false,
    }
  }

  if (spec.startsWith('$wallet:')) {
    const name = spec.slice('$wallet:'.length)
    const addr = getTronWallet(globalConfig, name)
    return {
      value: tronRegistrationAddressToEvmHex(tronWeb, addr),
      skip: false,
    }
  }

  if (spec.startsWith('$deployed:')) {
    const depName = spec.slice('$deployed:'.length)
    const addr =
      deployedContracts[depName] || (await getContractAddress(network, depName))
    if (!addr) throw new Error(`${depName} address not found`)
    const hex = addr.startsWith('0x') ? addr : tronAddressToHex(tronWeb, addr)
    return { value: hex, skip: false }
  }

  if (spec.startsWith('$network:')) {
    const rest = spec.slice('$network:'.length)
    const required = rest.endsWith('!')
    const key = rest.replace(/[!?]$/, '')
    const val = tronConfig[key] as string | undefined
    const hex =
      val && val !== ZERO_ADDRESS
        ? tronAddressToHex(tronWeb, val)
        : ZERO_ADDRESS
    if (required && hex === ZERO_ADDRESS) {
      return { value: null, skip: true, skipReason: `${key} is zero/missing` }
    }
    return { value: hex, skip: false }
  }

  throw new Error(`Unknown constructor arg spec: "${spec}"`)
}

async function resolveConstructorArgs(
  contractName: string,
  argsSpec: string[],
  context: IDeployContext
): Promise<{ args: unknown[]; skip: boolean; skipReason?: string }> {
  const args: unknown[] = []
  for (const spec of argsSpec) {
    const { value, skip, skipReason } = await resolveArg(spec, context)
    if (skip)
      return {
        args: [],
        skip: true,
        skipReason: `${contractName}: ${skipReason}`,
      }
    args.push(value)
  }
  return { args, skip: false }
}

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
      const planContracts = getTronCorePeriphery().filter(
        (n) => n !== 'LiFiTimelockController'
      )
      consola.info('\n Deployment Plan:')
      planContracts.forEach((name, i) =>
        consola.info(`${i + 1}. Deploy ${name}`)
      )
      consola.info(
        `${
          planContracts.length + 1
        }. Deploy LiFiTimelockController (if tron.safeAddress set; not registered with Diamond)`
      )
      consola.info(
        `${
          planContracts.length + 2
        }. Register periphery contracts with PeripheryRegistryFacet\n`
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
    const deploymentResults: IDeploymentResult[] = []

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
      const deployContext: IDeployContext = {
        tronWeb,
        networkInfo,
        tronConfig: tronConfig as Record<string, unknown>,
        globalConfig: globalConfigRecord,
        deployedContracts,
        network,
      }

      // Generic deploy loop — add new periphery contracts to global.json only
      for (const contractName of (
        onlyContracts ?? getTronCorePeriphery()
      ).filter((n) => n !== 'LiFiTimelockController')) {
        consola.info(`\n Deploying ${contractName}...`)

        const explicitSpec = TRON_CONSTRUCTOR_ARGS_OVERRIDES[contractName]

        let resolveResult: {
          args: unknown[]
          skip: boolean
          skipReason?: string
        }

        try {
          if (explicitSpec !== undefined) {
            resolveResult = await resolveConstructorArgs(
              contractName,
              explicitSpec,
              deployContext
            )
          } else {
            const artifact = await loadForgeArtifact(contractName)
            resolveResult = await inferConstructorArgsFromAbi(
              artifact,
              contractName,
              deployContext
            )
          }
        } catch (err: unknown) {
          consola.error(
            ` Failed to resolve constructor args for ${contractName}:`,
            err instanceof Error ? err.message : err
          )
          deploymentResults.push({
            contract: contractName,
            address: 'FAILED',
            txId: 'FAILED',
            cost: 0,
            version: '0.0.0',
          })
          continue
        }

        if (resolveResult.skip) {
          consola.warn(
            `  Skipping ${contractName}: ${resolveResult.skipReason}`
          )
          deploymentResults.push({
            contract: contractName,
            address: 'SKIPPED',
            txId: 'SKIPPED',
            cost: 0,
            version: '0.0.0',
          })
          continue
        }

        const constructorArgs = resolveResult.args

        try {
          const existing = await checkExistingDeployment(
            network,
            contractName,
            dryRun
          )

          if (existing.exists && existing.address && !existing.shouldRedeploy) {
            consola.info(
              `Using existing ${contractName} at: ${existing.address}`
            )
            deployedContracts[contractName] = existing.address
            const version = await getContractVersion(contractName)
            deploymentResults.push({
              contract: contractName,
              address: existing.address,
              txId: 'existing',
              cost: 0,
              version,
              status: 'existing' as const,
            })
          } else {
            consola.info(`Constructor args: ${JSON.stringify(constructorArgs)}`)

            const result = await deployContractWithLogging(
              deployer,
              contractName,
              constructorArgs,
              dryRun,
              network
            )

            deployedContracts[contractName] = result.address
            deploymentResults.push(result)
          }

          if (!dryRun) await sleep(8000)
        } catch (err: unknown) {
          consola.error(
            ` Failed to deploy ${contractName}:`,
            err instanceof Error ? err.message : err
          )
          deploymentResults.push({
            contract: contractName,
            address: 'FAILED',
            txId: 'FAILED',
            cost: 0,
            version: '0.0.0',
          })
        }
      }

      // LiFiTimelockController: governance contract with complex multi-source constructor
      // args; not registered with the Diamond (same behaviour as EVM chains).
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
                  const result = await deployContractWithLogging(
                    deployer,
                    'LiFiTimelockController',
                    constructorArgs,
                    dryRun,
                    network
                  )
                  deployedContracts['LiFiTimelockController'] = result.address
                  deploymentResults.push(result)
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
      if (name === 'LiFiTimelockController') continue
      if (!address || address === 'FAILED' || address === 'SKIPPED') continue

      try {
        consola.info(`\n Registering ${name}...`)

        await sleep(REGISTRATION_RPC_DELAY_MS)
        // Skip if already registered at the same address
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
