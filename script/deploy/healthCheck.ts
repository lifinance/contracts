import type { Buffer } from 'buffer'
import { spawn } from 'child_process'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import {
  createPublicClient,
  formatEther,
  getAddress,
  getContract,
  http,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import {
  coreFacets,
  corePeriphery,
  pauserWallet,
  whitelistPeripheryFunctions,
} from '../../config/global.json'
import type { IWhitelistConfig } from '../common/types'
import { getEnvVar } from '../demoScripts/utils/demoScriptHelpers'
import { initTronWeb } from '../troncast/utils/tronweb'
import { sleep } from '../utils/delay'
import { getRPCEnvVarName } from '../utils/network'
import {
  getViemChainForNetworkName,
  networks,
} from '../utils/viemScriptHelpers'

import targetStateImport from './_targetState.json'
import {
  callTronContract,
  callTronContractBoolean,
  ensureTronAddress,
  getTronWallet,
  normalizeSelector,
  checkOwnershipTron,
  checkWhitelistIntegrityTron,
} from './healthCheckTronUtils'
import {
  INITIAL_CALL_DELAY,
  INTER_CALL_DELAY,
  RETRY_DELAY,
} from './tron/constants'
import {
  checkIsDeployedTron,
  getCoreFacets as getTronCoreFacets,
  getTronCorePeriphery,
  isRateLimitError,
  parseTroncastFacetsOutput,
  retryWithRateLimit,
} from './tron/utils'

// Type for target state JSON structure
type TargetState = Record<
  string,
  {
    production?: {
      LiFiDiamond?: Record<string, string>
      [key: string]: Record<string, string> | undefined
    }
    staging?: {
      LiFiDiamond?: Record<string, string>
      [key: string]: Record<string, string> | undefined
    }
  }
>

const targetState = targetStateImport as TargetState

/**
 * Execute a command with retry logic for rate limit errors (429)
 * Uses spawn to avoid shell interpretation issues with special characters
 * @param commandParts - Array of command parts (e.g., ['bun', 'troncast', 'call', ...])
 * @param initialDelay - Initial delay before first attempt (ms)
 * @param maxRetries - Maximum number of retries
 * @param retryDelay - Delay in ms for all retry attempts (default: RETRY_DELAY)
 * @returns The command output string
 * @throws The last error if all retries fail
 */
export async function execWithRateLimitRetry(
  commandParts: string[],
  initialDelay = 0,
  maxRetries = 3,
  retryDelay = RETRY_DELAY
): Promise<string> {
  // Initial delay before first attempt
  if (initialDelay > 0) {
    await sleep(initialDelay)
  }

  return retryWithRateLimit(
    () => {
      return new Promise<string>((resolve, reject) => {
        const [command, ...args] = commandParts
        if (!command) {
          reject(new Error('No command provided'))
          return
        }
        
        const child = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        child.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        child.on('close', (code: number | null) => {
          if (code !== 0) {
            const error = new Error(
              `Command failed with exit code ${code}: ${stderr || stdout}`
            )
            ;(error as Error & { message: string }).message = stderr || stdout || `Exit code ${code}`
            reject(error)
          } else {
            resolve(stdout)
          }
        })

        child.on('error', (error: Error) => {
          reject(error)
        })
      })
    },
    maxRetries,
    retryDelay,
    (attempt: number, delay: number) => {
      consola.warn(
        `Rate limit detected (429). Retrying in ${
          delay / 1000
        }s... (attempt ${attempt}/${maxRetries})`
      )
    },
    false // Shell commands don't include connection errors in rate limit detection
  )
}

const SAFE_THRESHOLD = 3

const errors: string[] = []
const main = defineCommand({
  meta: {
    name: 'LIFI Diamond Health Check',
    description: 'Check that the diamond is configured correctly',
  },
  args: {
    network: {
      type: 'string',
      description: 'EVM network to check',
      required: true,
    },
    environment: {
      type: 'string',
      description: 'Environment to check (production or staging)',
      default: 'production',
    },
  },
  async run({ args }) {
    const { network, environment } = args
    const networkStr = Array.isArray(network) ? network[0] : network
    const networkLower = (networkStr as string).toLowerCase()

    // Skip tronshasta testnet but allow tron mainnet
    if (networkLower === 'tronshasta') {
      consola.info('Health checks are not implemented for Tron Shasta testnet.')
      consola.info('Skipping all tests.')
      process.exit(0)
    }

    // Determine if we're working with Tron mainnet
    const isTron = networkLower === 'tron'

    const { default: deployedContracts } = await import(
      `../../deployments/${networkLower}${
        environment === 'staging' ? '.staging' : ''
      }.json`
    )

    // Get core facets - use Tron-specific filtering if needed
    let coreFacetsToCheck: string[]
    if (isTron)
      // Use the Tron-specific utility that filters out GasZipFacet
      coreFacetsToCheck = getTronCoreFacets()
    else coreFacetsToCheck = coreFacets

    // For staging, skip targetState checks as targetState is only for production
    let nonCoreFacets: string[] = []
    if (environment === 'production') {
      if (targetState[networkLower]?.production?.LiFiDiamond) {
        nonCoreFacets = Object.keys(
          targetState[networkLower].production!.LiFiDiamond
        ).filter((k) => {
          return (
            !coreFacetsToCheck.includes(k) &&
            !corePeriphery.includes(k) &&
            k !== 'LiFiDiamond' &&
            k.includes('Facet')
          )
        })
      }
    }

    const globalConfig = await import('../../config/global.json')

    let publicClient: PublicClient | undefined
    let tronWeb: TronWeb | undefined

    const networkConfig = networks[networkLower]
    if (!networkConfig) {
      throw new Error(`Network config not found for ${networkLower}`)
    }

    if (isTron)
      tronWeb = initTronWeb(
        'mainnet',
        undefined,
        networkConfig.rpcUrl
      )
    else {
      const chain = getViemChainForNetworkName(networkLower)
      publicClient = createPublicClient({
        batch: { multicall: true },
        chain,
        transport: http(),
      })
    }

    consola.info('Running post deployment checks...\n')

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check Diamond Contract                   │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking diamond Contract...')
    let diamondDeployed: boolean
    if (isTron && tronWeb)
      diamondDeployed = await checkIsDeployedTron(
        'LiFiDiamond',
        deployedContracts,
        tronWeb
      )
    else if (publicClient)
      diamondDeployed = await checkIsDeployed(
        'LiFiDiamond',
        deployedContracts,
        publicClient
      )
    else diamondDeployed = false

    if (!diamondDeployed) {
      logError(`LiFiDiamond not deployed`)
      finish()
    } else consola.success('LiFiDiamond deployed')

    const diamondAddress = deployedContracts['LiFiDiamond']

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                    Check core facets                    │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking Core Facets...')
    for (const facet of coreFacetsToCheck) {
      let isDeployed: boolean
      if (isTron && tronWeb) {
        // Add small delay between Tron RPC calls to avoid rate limits
        await sleep(INTER_CALL_DELAY) // Delay between calls to avoid rate limits
        isDeployed = await checkIsDeployedTron(
          facet,
          deployedContracts,
          tronWeb
        )
      } else if (publicClient)
        isDeployed = await checkIsDeployed(
          facet,
          deployedContracts,
          publicClient
        )
      else isDeployed = false

      if (!isDeployed) {
        logError(`Facet ${facet} not deployed`)
        continue
      }
      consola.success(`Facet ${facet} deployed`)
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │         Check that non core facets are deployed         │
    //          ╰─────────────────────────────────────────────────────────────╯
    if (environment === 'production') {
      consola.box('Checking Non-Core facets...')
      for (const facet of nonCoreFacets) {
        let isDeployed: boolean
        if (isTron && tronWeb) {
          // Add small delay between Tron RPC calls to avoid rate limits
          await sleep(INTER_CALL_DELAY) // Delay between calls to avoid rate limits
          isDeployed = await checkIsDeployedTron(
            facet,
            deployedContracts,
            tronWeb
          )
        } else if (publicClient)
          isDeployed = await checkIsDeployed(
            facet,
            deployedContracts,
            publicClient
          )
        else isDeployed = false

        if (!isDeployed) {
          logError(`Facet ${facet} not deployed`)
          continue
        }
        consola.success(`Facet ${facet} deployed`)
      }
    } else {
      consola.info('Skipping non-core facet checks for staging environment')
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │          Check that all facets are registered           │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking facets registered in diamond...')

    let registeredFacets: string[] = []
    let facetCheckSkipped = false
    try {
      if (isTron) {
        // Use troncast for Tron
        // Diamond address in deployments is already in Tron format
        // Get RPC URL from environment variable first, fallback to networks.json
        const envVarName = getRPCEnvVarName(networkLower)
        const rpcUrl = getEnvVar(envVarName) || networkConfig.rpcUrl

        // Execute with retry logic for rate limits
        // TronGrid has strict rate limits, so we add initial delay and retry on 429
        const rawString = await execWithRateLimitRetry(
          [
            'bun',
            'run',
            'troncast',
            'call',
            diamondAddress,
            'facets() returns ((address,bytes4[])[])',
            '--rpc-url',
            rpcUrl,
          ],
          INITIAL_CALL_DELAY, // Initial delay before Tron calls to avoid rate limits
          3,
          RETRY_DELAY
        )

        // Parse Tron output format
        const onChainFacets = parseTroncastFacetsOutput(rawString)

        if (Array.isArray(onChainFacets)) {
          // Map Tron addresses directly (deployments already use Tron format)
          const configFacetsByAddress = Object.fromEntries(
            Object.entries(deployedContracts).map(([name, address]: [string, unknown]) => {
              // Address is already in Tron format for Tron deployments
              const addressStr = String(address)
              return [addressStr.toLowerCase(), name]
            })
          )

          registeredFacets = onChainFacets
            .map(([tronAddress]: [string, unknown]) => {
              return configFacetsByAddress[tronAddress.toLowerCase()]
            })
            .filter((name): name is string => typeof name === 'string')
        }
      } else if (networkConfig.rpcUrl && publicClient && publicClient.chain) {
        // Existing EVM logic with retry for rate limits
        const rpcUrl: string = publicClient.chain.rpcUrls.default.http[0] || networkConfig.rpcUrl
        const rawString = await execWithRateLimitRetry(
          [
            'cast',
            'call',
            diamondAddress,
            'facets() returns ((address,bytes4[])[])',
            '--rpc-url',
            rpcUrl,
          ],
          0, // No initial delay for EVM (can be adjusted if needed)
          3,
          RETRY_DELAY
        )

        const jsonCompatibleString = rawString
          .replace(/\(/g, '[')
          .replace(/\)/g, ']')
          .replace(/0x[0-9a-fA-F]+/g, '"$&"')

        const onChainFacets = JSON.parse(jsonCompatibleString)

        if (Array.isArray(onChainFacets)) {
          const configFacetsByAddress = Object.fromEntries(
            Object.entries(deployedContracts).map(([name, address]: [string, unknown]) => {
              const addressStr = String(address)
              return [addressStr.toLowerCase(), name]
            })
          )

          registeredFacets = onChainFacets
            .map(([address]: [string, unknown]) => {
              return configFacetsByAddress[address.toLowerCase()]
            })
            .filter((name): name is string => typeof name === 'string')
        }
      }
    } catch (error: unknown) {
      facetCheckSkipped = true

      // Check if it's a rate limit error (429)
      if (isRateLimitError(error, false)) {
        consola.warn(
          'RPC rate limit reached (429) - skipping facet registration check'
        )
        consola.warn(
          'This is a temporary limitation from the RPC provider. The check will be skipped.'
        )
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error)
        consola.warn(
          'Unable to parse output - skipping facet registration check'
        )
        consola.warn('Error:', errorMessage)
      }
    }

    // Only check facet registration if we successfully retrieved the data
    // If the check was skipped due to an error (e.g. RPC rate limit), don't mark all facets as "not registered"
    if (!facetCheckSkipped) {
      for (const facet of [...coreFacetsToCheck, ...nonCoreFacets])
        if (!registeredFacets.includes(facet))
          logError(
            `Facet ${facet} not registered in Diamond or possibly unverified`
          )
        else consola.success(`Facet ${facet} registered in Diamond`)
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │      Check that core periphery contracts are deployed   │
    //          ╰─────────────────────────────────────────────────────────╯
    if (environment === 'production') {
      consola.box('Checking deploy status of periphery contracts...')

      // Filter periphery contracts for Tron if needed
      const peripheryToCheck = isTron ? getTronCorePeriphery() : corePeriphery

      for (const contract of peripheryToCheck) {
        let isDeployed: boolean
        if (isTron && tronWeb) {
          // Add small delay between Tron RPC calls to avoid rate limits
          await sleep(INTER_CALL_DELAY) // Delay between calls to avoid rate limits
          isDeployed = await checkIsDeployedTron(
            contract,
            deployedContracts,
            tronWeb
          )
        } else if (publicClient)
          isDeployed = await checkIsDeployed(
            contract,
            deployedContracts,
            publicClient
          )
        else isDeployed = false

        if (!isDeployed) {
          logError(`Periphery contract ${contract} not deployed`)
          continue
        }
        consola.success(`Periphery contract ${contract} deployed`)
      }
    } else {
      consola.info(
        'Skipping core periphery deployment checks for staging environment'
      )
    }

    // Load whitelist config (staging or production)
    const whitelistConfig = await import(
      `../../config/whitelist${
        environment === 'staging' ? '.staging' : ''
      }.json`
    )

    // Check Executor authorization in ERC20Proxy
    if (environment === 'production') {
      if (isTron && tronWeb) {
        try {
          const erc20ProxyAddress = deployedContracts['ERC20Proxy']
          const executorAddress = deployedContracts['Executor']

          // Use callTronContractBoolean for proper boolean decoding
          const isAuthorized = await callTronContractBoolean(
            tronWeb,
            erc20ProxyAddress,
            'authorizedCallers(address)',
            [{ type: 'address', value: executorAddress }],
            'function authorizedCallers(address) external view returns (bool)'
          )

          if (!isAuthorized) {
            logError('Executor is not authorized in ERC20Proxy')
          } else {
            consola.success('Executor is authorized in ERC20Proxy')
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          logError(`Failed to check Executor authorization: ${errorMessage}`)
        }
      } else if (publicClient) {
        const erc20Proxy = getContract({
          address: deployedContracts['ERC20Proxy'],
          abi: parseAbi([
            'function authorizedCallers(address) external view returns (bool)',
            'function owner() external view returns (address)',
          ]),
          client: publicClient,
        })

        const executorAddress = deployedContracts['Executor']
        const isExecutorAuthorized = await erc20Proxy.read.authorizedCallers([
          executorAddress,
        ])

        if (!isExecutorAuthorized)
          logError('Executor is not authorized in ERC20Proxy')
        else consola.success('Executor is authorized in ERC20Proxy')
      }
    } else {
      consola.info(
        'Skipping Executor authorization check for staging environment because Executor is not deployed'
      )
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │          Check registered periphery contracts           │
    //          ╰─────────────────────────────────────────────────────────╯
    if (environment === 'production') {
      consola.box(
        'Checking periphery registration in diamond (PeripheryRegistry)...'
      )

      // Only check contracts that are expected to be deployed according to target state
      const targetStateContracts =
        targetState[networkLower]?.production?.LiFiDiamond || {}
      const contractsToCheck = Object.keys(targetStateContracts).filter(
        (contract) =>
          (isTron ? getTronCorePeriphery() : corePeriphery).includes(
            contract
          ) || Object.keys(whitelistPeripheryFunctions).includes(contract)
      )

      if (contractsToCheck.length > 0) {
        if (isTron && tronWeb) {
          // Tron implementation using troncast
          // Get RPC URL from environment variable first, fallback to networks.json
          const envVarName = getRPCEnvVarName(networkLower)
          const rpcUrl = getEnvVar(envVarName) || networkConfig.rpcUrl
          const diamondAddress = deployedContracts['LiFiDiamond']

          for (const periphery of contractsToCheck) {
            const peripheryAddress = deployedContracts[periphery]
            if (!peripheryAddress) {
              logError(`Periphery contract ${periphery} not deployed`)
              continue
            }

            // Skip LiFiTimelockController (no need to register it)
            if (periphery === 'LiFiTimelockController') continue

            try {
              // Call getPeripheryContract using troncast
              // callTronContract handles INITIAL_CALL_DELAY internally
              const registeredAddressOutput = await callTronContract(
                diamondAddress,
                'getPeripheryContract(string)',
                [periphery],
                'address',
                rpcUrl
              )

              // Parse Tron address from output (base58 format starting with T)
              const cleanedAddress = registeredAddressOutput.trim().replace(/^["']|["']$/g, '')
              const registeredAddress = cleanedAddress.startsWith('T') && cleanedAddress.length === 34
                ? cleanedAddress
                : null
              const expectedAddress = peripheryAddress.toLowerCase()

              if (!registeredAddress || registeredAddress.toLowerCase() !== expectedAddress) {
                logError(
                  `Periphery contract ${periphery} not registered in Diamond (expected: ${peripheryAddress}, got: ${registeredAddress || 'null'})`
                )
              } else {
                consola.success(
                  `Periphery contract ${periphery} registered in Diamond`
                )
              }
            } catch (error: any) {
              const errorMessage = error?.message || String(error)
              logError(
                `Failed to check periphery registration for ${periphery}: ${errorMessage}`
              )
            }
          }
        } else if (publicClient) {
          // EVM implementation using viem
          const peripheryRegistry = getContract({
            address: deployedContracts['LiFiDiamond'],
            abi: parseAbi([
              'function getPeripheryContract(string) external view returns (address)',
            ]),
            client: publicClient,
          })

          const addresses = await Promise.all(
            contractsToCheck.map((c) =>
              peripheryRegistry.read.getPeripheryContract([c])
            )
          )

          for (const periphery of contractsToCheck) {
            const peripheryAddress = deployedContracts[periphery]
            if (!peripheryAddress)
              logError(`Periphery contract ${periphery} not deployed `)
            else if (!addresses.includes(getAddress(peripheryAddress))) {
              // skip the registration check for LiFiTimelockController (no need to register it)
              if (periphery === 'LiFiTimelockController') continue
              logError(
                `Periphery contract ${periphery} not registered in Diamond`
              )
            } else
              consola.success(
                `Periphery contract ${periphery} registered in Diamond`
              )
          }
        }
      }
    } else {
      consola.info(
        'Skipping periphery registration checks for staging environment'
      )
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                   Check whitelisted addresses           │
    //          ╰─────────────────────────────────────────────────────────╯
    // Check if whitelist configuration exists for this network
    try {
      const hasDexWhitelistConfig =
        (
          whitelistConfig.DEXS as Array<{
            contracts?: Record<string, unknown[]>
          }>
        )?.some(
          (dex) =>
            dex.contracts?.[networkLower] &&
            dex.contracts[networkLower].length > 0
        ) ?? false

      const hasPeripheryWhitelistConfig =
        (whitelistConfig.PERIPHERY?.[networkLower]?.length ?? 0) > 0

      const hasWhitelistConfig =
        hasDexWhitelistConfig || hasPeripheryWhitelistConfig

      if (hasWhitelistConfig) {
        if (isTron && tronWeb) {
          // Tron implementation using troncast and TronWeb
          // Get RPC URL from environment variable first, fallback to networks.json
          const envVarName = getRPCEnvVarName(networkLower)
          const rpcUrl = getEnvVar(envVarName) || networkConfig.rpcUrl
          await checkWhitelistIntegrityTron(
            networkStr as string,
            deployedContracts,
            environment,
            whitelistConfig,
            diamondAddress,
            rpcUrl,
            tronWeb,
            logError,
            getExpectedPairs
          )
        } else if (publicClient) {
          // EVM implementation using viem
          const whitelistManager = getContract({
            address: deployedContracts['LiFiDiamond'],
            abi: parseAbi([
              'function isContractSelectorWhitelisted(address,bytes4) external view returns (bool)',
              'function getAllContractSelectorPairs() external view returns (address[],bytes4[][])',
            ]),
            client: publicClient,
          })

          // Get expected pairs from whitelist.json or whitelist.staging.json file
          const expectedPairs = await getExpectedPairs(
            networkStr as string,
            deployedContracts,
            environment,
            whitelistConfig,
            false // isTron = false for EVM
          )

          // Get on-chain data once and use for all checks
          const [onChainContracts, onChainSelectors] =
            await whitelistManager.read.getAllContractSelectorPairs()

          await checkWhitelistIntegrity(
            publicClient,
            diamondAddress,
            whitelistManager,
            expectedPairs,
            onChainContracts as readonly Address[],
            onChainSelectors as unknown as readonly Hex[][]
          )
        }
      } else {
        consola.info(
          'No whitelist configuration found for this network, skipping whitelist checks'
        )
      }
    } catch (error) {
      logError('Whitelist configuration not available')
    }

    // Get wallet addresses (Tron or EVM format)
    let deployerWallet: string
    let refundWallet: string
    let feeCollectorOwner: string
    let pauserWalletAddress: string

    if (isTron) {
      // Use Tron wallets if available, fallback to EVM wallets (will need conversion)
      deployerWallet = getTronWallet(globalConfig, 'deployerWallet')
      refundWallet = getTronWallet(globalConfig, 'refundWallet')
      feeCollectorOwner = getTronWallet(globalConfig, 'feeCollectorOwner')
      pauserWalletAddress = getTronWallet(globalConfig, 'pauserWallet')
    } else {
      deployerWallet = getAddress(
        environment === 'staging'
          ? globalConfig.devWallet
          : globalConfig.deployerWallet
      )
      refundWallet = getAddress(globalConfig.refundWallet)
      feeCollectorOwner = getAddress(globalConfig.feeCollectorOwner)
      pauserWalletAddress = pauserWallet
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check contract ownership                 │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking ownership...')

    if (isTron && tronWeb) {
      // Get RPC URL from environment variable first, fallback to networks.json
      const envVarName = getRPCEnvVarName(networkLower)
      const rpcUrl = getEnvVar(envVarName) || networkConfig.rpcUrl

      // Check ERC20Proxy ownership (skip for staging)
      if (environment === 'production') {
        await checkOwnershipTron(
          'ERC20Proxy',
          deployerWallet,
          deployedContracts,
          rpcUrl,
          tronWeb,
          logError
        )
      } else {
        consola.info(
          'Skipping ERC20Proxy ownership check for staging environment'
        )
      }

      // Check that Diamond is owned by Timelock (skip for staging)
      if (environment === 'production') {
        if (deployedContracts.LiFiTimelockController) {
          const timelockAddress = deployedContracts.LiFiTimelockController
          await checkOwnershipTron(
            'LiFiDiamond',
            timelockAddress,
            deployedContracts,
            rpcUrl,
            tronWeb,
            logError
          )
        } else {
          consola.error(
            'LiFiTimelockController not deployed, so diamond ownership cannot be verified'
          )
        }
      } else {
        consola.info('Skipping diamond ownership check for staging environment')
      }

      // FeeCollector
      await checkOwnershipTron(
        'FeeCollector',
        feeCollectorOwner,
        deployedContracts,
        rpcUrl,
        tronWeb,
        logError
      )

      // Receiver
      await checkOwnershipTron(
        'Receiver',
        refundWallet,
        deployedContracts,
        rpcUrl,
        tronWeb,
        logError
      )
    } else if (publicClient) {
      // EVM implementation
      // Check ERC20Proxy ownership (skip for staging)
      if (environment === 'production') {
        const erc20ProxyContract = getContract({
          address: deployedContracts['ERC20Proxy'],
          abi: parseAbi(['function owner() external view returns (address)']),
          client: publicClient,
        })
        const erc20ProxyOwner = await erc20ProxyContract.read.owner()
        if (getAddress(erc20ProxyOwner) !== getAddress(deployerWallet))
          logError(
            `ERC20Proxy owner is ${getAddress(
              erc20ProxyOwner
            )}, expected ${getAddress(deployerWallet)}`
          )
        else consola.success('ERC20Proxy owner is correct')
      } else {
        consola.info(
          'Skipping ERC20Proxy ownership check for staging environment'
        )
      }

      // Check that Diamond is owned by Timelock (skip for staging)
      if (environment === 'production') {
        if (deployedContracts.LiFiTimelockController) {
          const timelockAddress = deployedContracts.LiFiTimelockController

          await checkOwnership(
            'LiFiDiamond',
            timelockAddress,
            deployedContracts,
            publicClient
          )
        } else
          consola.error(
            'LiFiTimelockController not deployed, so diamond ownership cannot be verified'
          )
      } else {
        consola.info('Skipping diamond ownership check for staging environment')
      }

      // FeeCollector
      await checkOwnership(
        'FeeCollector',
        feeCollectorOwner,
        deployedContracts,
        publicClient
      )

      // Receiver
      await checkOwnership(
        'Receiver',
        refundWallet,
        deployedContracts,
        publicClient
      )
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check emergency pause config             │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking funding of pauser wallet...')

    if (isTron && tronWeb) {
      try {
        // Convert EVM address to Tron if needed
        const pauserTronAddress = ensureTronAddress(
          pauserWalletAddress,
          tronWeb
        )

        const balanceSun = await tronWeb.trx.getBalance(pauserTronAddress)
        const balanceTrx = tronWeb.fromSun(balanceSun)
        const balanceStr = String(balanceTrx)

        if (!balanceTrx || balanceStr === '0') {
          logError(`PauserWallet does not have any native balance`)
        } else {
          consola.success(`PauserWallet is funded: ${balanceTrx} TRX`)
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logError(`Failed to check pauser wallet balance: ${errorMessage}`)
      }
    } else if (publicClient) {
      const pauserBalance = formatEther(
        await publicClient.getBalance({
          address: pauserWalletAddress as Address,
        })
      )

      if (!pauserBalance || pauserBalance === '0')
        logError(`PauserWallet does not have any native balance`)
      else consola.success(`PauserWallet is funded: ${pauserBalance}`)
    }

    //          ╭─────────────────────────────────────────────────────────╮
    //          │                Check access permissions                 │
    //          ╰─────────────────────────────────────────────────────────╯
    consola.box('Checking access permissions...')

    const refundSelectors = globalConfig.approvedSelectorsForRefundWallet as {
      selector: Hex
      name: string
    }[]

    if (isTron && tronWeb) {
      const diamondAddress = deployedContracts['LiFiDiamond']

      // Convert refund wallet to Tron format if needed
      const refundTronAddress = ensureTronAddress(refundWallet, tronWeb)

      // Add delay before starting loop to avoid rate limits
      await sleep(INITIAL_CALL_DELAY)

      for (const selector of refundSelectors) {
        try {
          const normalizedSelector = normalizeSelector(selector.selector)

          const canExecute = await callTronContractBoolean(
            tronWeb,
            diamondAddress,
            'addressCanExecuteMethod(bytes4,address)',
            [
              { type: 'bytes4', value: normalizedSelector },
              { type: 'address', value: refundTronAddress },
            ],
            'function addressCanExecuteMethod(bytes4,address) external view returns (bool)'
          )

          if (!canExecute) {
            logError(
              `Refund wallet ${refundTronAddress} cannot execute ${selector.name} (${normalizedSelector})`
            )
          } else {
            consola.success(
              `Refund wallet ${refundTronAddress} can execute ${selector.name} (${normalizedSelector})`
            )
          }
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          logError(
            `Failed to check access permission for ${selector.name}: ${errorMessage}`
          )
        }
      }
    } else if (publicClient) {
      const accessManager = getContract({
        address: deployedContracts['LiFiDiamond'],
        abi: parseAbi([
          'function addressCanExecuteMethod(bytes4,address) external view returns (bool)',
        ]),
        client: publicClient,
      })

      for (const selector of refundSelectors) {
        const normalizedSelector = normalizeSelector(selector.selector)

        if (
          !(await accessManager.read.addressCanExecuteMethod([
            normalizedSelector,
            refundWallet as Address,
          ]))
        )
          logError(
            `Refund wallet ${refundWallet} cannot execute ${selector.name} (${normalizedSelector})`
          )
        else
          consola.success(
            `Refund wallet ${refundWallet} can execute ${selector.name} (${normalizedSelector})`
          )
      }
    }

    if (environment === 'production') {
      //          ╭─────────────────────────────────────────────────────────╮
      //          │                   SAFE Configuration                    │
      //          ╰─────────────────────────────────────────────────────────╯
      consola.box('Checking SAFE configuration...')
      if (!networkConfig.safeAddress)
        consola.warn('SAFE address not configured')
      else if (publicClient) {
        const safeOwners = globalConfig.safeOwners
        const safeAddress = networkConfig.safeAddress

        try {
          // Import getSafeInfoFromContract from safe-utils.ts
          const { getSafeInfoFromContract } = await import('./safe/safe-utils')

          // Get Safe info directly from the contract
          const safeInfo = await getSafeInfoFromContract(
            publicClient,
            safeAddress as Address
          )

          // Check that each safeOwner is in the Safe
          for (const o in safeOwners) {
            const safeOwnerAddr = safeOwners[o]
            if (!safeOwnerAddr) continue
            const safeOwner = getAddress(safeOwnerAddr)
            const isOwner = safeInfo.owners.some(
              (owner) => getAddress(owner) === safeOwner
            )

            if (!isOwner)
              logError(`SAFE owner ${safeOwner} not in SAFE configuration`)
            else
              consola.success(
                `SAFE owner ${safeOwner} is in SAFE configuration`
              )
          }

          // Check that threshold is correct
          if (safeInfo.threshold < BigInt(SAFE_THRESHOLD))
            logError(
              `SAFE signature threshold is ${safeInfo.threshold}, expected at least ${SAFE_THRESHOLD}`
            )
          else
            consola.success(`SAFE signature threshold is ${safeInfo.threshold}`)

          // Show current nonce
          consola.info(`Current SAFE nonce: ${safeInfo.nonce}`)
        } catch (error) {
          logError(`Failed to get SAFE information: ${error}`)
        }
      }
    } else {
      consola.info('Skipping SAFE checks for staging environment')
    }

    finish()
  },
})

const logError = (msg: string) => {
  consola.error(msg)
  errors.push(msg)
}

const getOwnableContract = (address: Address, client: PublicClient) => {
  return getContract({
    address,
    abi: parseAbi(['function owner() external view returns (address)']),
    client,
  })
}


const checkOwnership = async (
  name: string,
  expectedOwner: Address | string,
  deployedContracts: Record<string, Address | string>,
  publicClient: PublicClient
) => {
  const contractAddress = deployedContracts[name]
  if (contractAddress) {
    const owner = await getOwnableContract(
      contractAddress as Address,
      publicClient
    ).read.owner()
    if (getAddress(owner) !== getAddress(expectedOwner as Address))
      logError(
        `${name} owner is ${getAddress(owner)}, expected ${getAddress(
          expectedOwner as Address
        )}`
      )
    else consola.success(`${name} owner is correct`)
  }
}

const checkIsDeployed = async (
  contract: string,
  deployedContracts: Record<string, Address | string>,
  publicClient: PublicClient
): Promise<boolean> => {
  const address = deployedContracts[contract]
  if (!address) return false

  const code = await publicClient.getCode({
    address: address as Address,
  })
  if (code === '0x') return false

  return true
}

const getExpectedPairs = async (
  network: string,
  deployedContracts: Record<string, Address | string>,
  _environment: string,
  whitelistConfig: IWhitelistConfig,
  isTron = false
): Promise<Array<{ contract: string; selector: Hex }>> => {
  try {
    const expectedPairs: Array<{ contract: string; selector: Hex }> = []

    // Both staging and production have the same structure: DEXS at root with contracts nested under network
    for (const dex of (whitelistConfig.DEXS as Array<{
      contracts?: Record<
        string,
        Array<{ address: string; functions?: Record<string, string> }>
      >
    }>) || []) {
      for (const contract of dex.contracts?.[network.toLowerCase()] || []) {
        // For Tron, addresses are already in base58 format, for EVM use getAddress
        const contractAddr = isTron
          ? contract.address
          : getAddress(contract.address)
        const functions = contract.functions || {}

        if (Object.keys(functions).length === 0) {
          // Contract with no specific functions uses ApproveTo-Only Selector (0xffffffff)
          expectedPairs.push({
            contract: isTron ? contractAddr : contractAddr.toLowerCase(),
            selector: '0xffffffff' as Hex,
          })
        } else {
          // Contract with specific function selectors
          for (const selector of Object.keys(functions)) {
            expectedPairs.push({
              contract: isTron ? contractAddr : contractAddr.toLowerCase(),
              selector: selector.toLowerCase() as Hex,
            })
          }
        }
      }
    }

    // Add periphery contracts from config
    const peripheryConfig = whitelistConfig.PERIPHERY
    if (peripheryConfig) {
      const networkPeripheryContracts = peripheryConfig[network.toLowerCase()]
      if (networkPeripheryContracts) {
        for (const peripheryContract of networkPeripheryContracts) {
          const contractAddr = deployedContracts[peripheryContract.name]
          if (contractAddr) {
            // Use the actual selectors from config instead of ApproveTo-Only Selector (0xffffffff) selector
            for (const selectorInfo of peripheryContract.selectors || []) {
              expectedPairs.push({
                contract: isTron
                  ? String(contractAddr) // Keep original case for Tron base58 addresses
                  : getAddress(contractAddr as Address).toLowerCase(),
                selector: selectorInfo.selector.toLowerCase() as Hex,
              })
            }
          }
        }
      }
    }

    return expectedPairs
  } catch (error) {
    logError(`Failed to get expected pairs: ${error}`)
    return []
  }
}

// Checks the config.json (source of truth) against on-chain state.
// This function handles all checks for data integrity and synchronization.
const checkWhitelistIntegrity = async (
  publicClient: PublicClient,
  _diamondAddress: Address,
  whitelistManager: ReturnType<typeof getContract>,
  expectedPairs: Array<{ contract: string; selector: Hex }>,
  onChainContracts: readonly Address[],
  onChainSelectors: readonly Hex[][]
) => {
  consola.box('Checking Whitelist Integrity (Config vs. On-Chain State)...')

  if (expectedPairs.length === 0) {
    consola.warn('No expected pairs in config. Skipping all checks.')
    return
  }

  // --- 1. Preparation ---
  consola.info('Preparing expected data sets from config...')
  const uniqueContracts = new Set(
    expectedPairs.map((p) => p.contract.toLowerCase())
  )
  const uniqueSelectors = new Set(
    expectedPairs.map((p) => p.selector.toLowerCase())
  )
  const expectedPairSet = new Set(
    expectedPairs.map((p) => `${p.contract.toLowerCase()}:${p.selector.toLowerCase()}`)
  )
  consola.info(
    `Config has ${expectedPairs.length} pairs, ${uniqueContracts.size} unique contracts, and ${uniqueSelectors.size} unique selectors.`
  )

  try {
    // --- 2. Check Config vs. On-Chain Contract Functions (Multicall) ---
    consola.start('Step 1/2: Checking Config vs. On-Chain Functions...')

    // Check if multicall3 is available on this chain
    const hasMulticall3 =
      publicClient.chain?.contracts?.multicall3 !== undefined

    let granularResults: boolean[]
    if (hasMulticall3) {
      // Use multicall if available
      const granularMulticall = expectedPairs.map((pair) => ({
        address: whitelistManager.address,
        abi: whitelistManager.abi as Abi,
        functionName: 'isContractSelectorWhitelisted',
        args: [pair.contract as Address, pair.selector],
      }))
      const multicallResults = await publicClient.multicall({
        contracts: granularMulticall,
        allowFailure: false,
      })
      granularResults = (multicallResults as unknown[]).map(result => result as boolean)
    } else {
      // Fallback to individual calls if multicall3 is not available
      consola.info(
        'Multicall3 not available on this chain, using individual calls...'
      )
      const manager = whitelistManager as unknown as { 
        read: { isContractSelectorWhitelisted: (args: [Address, Hex]) => Promise<boolean> }
      }
      granularResults = await Promise.all(
        expectedPairs.map((pair) =>
          manager.read.isContractSelectorWhitelisted([
            pair.contract as Address,
            pair.selector,
          ])
        )
      )
    }

    let granularFails = 0
    granularResults.forEach((isWhitelisted, index) => {
      if (isWhitelisted === false) {
        const pair = expectedPairs[index]
        if (pair) {
          logError(
            `Source of Truth FAILED: ${pair.contract} / ${pair.selector} is 'false'.`
          )
          granularFails++
        }
      }
    })
    if (granularFails === 0)
      consola.success(
        'Source of Truth (isContractSelectorWhitelisted) is synced.'
      )
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logError(`Failed during functional checks: ${errorMessage}`)
  }

  // --- 3. Check Config vs. Getter Arrays ---
  consola.start('Step 2/2: Checking Config vs. Getter Arrays...')
  try {
    // Check pair array: getAllContractSelectorPairs
    const onChainPairSet = new Set<string>()
    for (let i = 0; i < onChainContracts.length; i++) {
      const contract = onChainContracts[i]?.toLowerCase()
      const selectors = onChainSelectors[i]
      if (contract && selectors) {
        for (const selector of selectors) {
          onChainPairSet.add(`${contract}:${selector.toLowerCase()}`)
        }
      }
    }
    const missingPairsList: string[] = []
    const stalePairsList: string[] = []
    for (const expected of expectedPairSet) {
      if (!onChainPairSet.has(expected)) missingPairsList.push(expected)
    }
    for (const onChain of onChainPairSet) {
      if (!expectedPairSet.has(onChain)) stalePairsList.push(onChain)
    }
    if (missingPairsList.length === 0 && stalePairsList.length === 0) {
      consola.success(
        `Pair Array (getAllContractSelectorPairs) is synced. (${onChainPairSet.size} pairs)`
      )
    } else {
      if (missingPairsList.length > 0) {
        logError(
          `Pair Array is missing ${missingPairsList.length} pairs from config:`
        )
        missingPairsList.forEach((pair) => {
          const [contract, selector] = pair.split(':')
          consola.error(`  Missing: ${contract} / ${selector}`)
        })
        consola.info(`\n💡 To fix run diamondSyncWhitelist script`)
      }
      if (stalePairsList.length > 0) {
        logError(
          `Pair Array has ${stalePairsList.length} stale pairs not in config:`
        )
        stalePairsList.forEach((pair) => {
          const [contract, selector] = pair.split(':')
          consola.error(`  Stale: ${contract} / ${selector}`)
        })
        consola.info(
          `\n💡 To fix stale pairs, run: source script/tasks/diamondSyncWhitelist.sh && diamondSyncWhitelist <network> <environment>`
        )
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logError(`Failed during getter array checks: ${errorMessage}`)
  }
}

const finish = () => {
  // this line ensures that all logs are actually written before the script ends
  process.stdout.write('', () => process.stdout.end())
  if (errors.length) {
    consola.error(`${errors.length} Errors found in deployment`)
    process.exit(1)
  } else {
    consola.success('Deployment checks passed')
    process.exit(0)
  }
}

runMain(main)
