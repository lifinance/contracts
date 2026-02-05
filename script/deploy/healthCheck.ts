// @ts-nocheck
import { spawn } from 'child_process'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import {
  createPublicClient,
  decodeFunctionResult,
  formatEther,
  getAddress,
  getContract,
  http,
  parseAbi,
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
import { initTronWeb } from '../troncast/utils/tronweb'
import {
  getViemChainForNetworkName,
  networks,
  type Network,
} from '../utils/viemScriptHelpers'

import { hexToTronAddress, retryWithRateLimit } from './tron/utils'

import targetState from './_targetState.json'

/**
 * Execute a command with retry logic for rate limit errors (429)
 * Uses spawn to avoid shell interpretation issues with special characters
 * @param commandParts - Array of command parts (e.g., ['bun', 'troncast', 'call', ...])
 * @param initialDelay - Initial delay before first attempt (ms)
 * @param maxRetries - Maximum number of retries
 * @param retryDelays - Array of delays for each retry attempt (ms)
 * @returns The command output string
 * @throws The last error if all retries fail
 */
export async function execWithRateLimitRetry(
  commandParts: string[],
  initialDelay = 0,
  maxRetries = 3,
  retryDelays = [1000, 2000, 3000]
): Promise<string> {
  // Initial delay before first attempt
  if (initialDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, initialDelay))
  }

  return retryWithRateLimit(
    () => {
      return new Promise<string>((resolve, reject) => {
        const [command, ...args] = commandParts
        const child = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (data) => {
          stdout += data.toString()
        })

        child.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        child.on('close', (code) => {
          if (code !== 0) {
            const error = new Error(
              `Command failed with exit code ${code}: ${stderr || stdout}`
            )
            ;(error as any).message = stderr || stdout || `Exit code ${code}`
            reject(error)
          } else {
            resolve(stdout)
          }
        })

        child.on('error', (error) => {
          reject(error)
        })
      })
    },
    maxRetries,
    retryDelays,
    (attempt, delay) => {
      consola.warn(
        `Rate limit detected (429). Retrying in ${
          delay / 1000
        }s... (attempt ${attempt}/${maxRetries})`
      )
    },
    false // Shell commands don't include connection errors in rate limit detection
  )
}
import {
  checkIsDeployedTron,
  getCoreFacets as getTronCoreFacets,
  getTronCorePeriphery,
  parseTroncastFacetsOutput,
  retryWithRateLimit,
} from './tron/utils'

/**
 * Call a Tron contract function using troncast and parse the result
 * @param contractAddress - Tron address (base58 format)
 * @param functionSignature - Function signature (e.g., "getPeripheryContract(string)")
 * @param params - Array of parameters to pass to the function
 * @param returnType - Expected return type for parsing
 * @param rpcUrl - Tron RPC URL
 * @returns Parsed result
 */
async function callTronContract(
  contractAddress: string,
  functionSignature: string,
  params: string[],
  returnType: string,
  rpcUrl: string
): Promise<string> {
  // Build troncast command arguments
  // Use spawn-style arguments to avoid shell interpretation issues with commas
  const args = [
    'run',
    'script/troncast/index.ts',
    'call',
    contractAddress,
    `${functionSignature} returns (${returnType})`,
    ...(params.length > 0 ? [params.join(',')] : []),
    '--rpc-url',
    rpcUrl,
  ]

  // Add initial delay for Tron to avoid rate limits
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // Execute with retry logic for rate limits using spawn to avoid shell issues
  const result = await retryWithRateLimit(
    () => {
      return new Promise<string>((resolve, reject) => {
        const child = spawn('bun', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (data) => {
          stdout += data.toString()
        })

        child.stderr.on('data', (data) => {
          stderr += data.toString()
        })

        child.on('close', (code) => {
          if (code !== 0) {
            const error = new Error(
              `Command failed with exit code ${code}: ${stderr || stdout}`
            )
            ;(error as any).message = stderr || stdout || `Exit code ${code}`
            reject(error)
          } else {
            resolve(stdout)
          }
        })

        child.on('error', (error) => {
          reject(error)
        })
      })
    },
    3,
    [1000, 2000, 3000],
    (attempt, delay) => {
      consola.warn(
        `Rate limit detected (429). Retrying in ${
          delay / 1000
        }s... (attempt ${attempt}/3)`
      )
    },
    false
  )

  return result.trim()
}



const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SAFE_THRESHOLD = 3

interface IWhitelistConfig {
  DEXS: Array<{
    name: string
    key: string
    contracts?: Record<
      string,
      Array<{
        address: string
        functions?: Record<string, string>
      }>
    >
  }>
  PERIPHERY?: Record<
    string,
    Array<{
      name: string
      address: string
      selectors: Array<{ selector: string; signature: string }>
    }>
  >
}

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
    const targetStateJson = await import(`./_targetState.json`)

    // Get core facets - use Tron-specific filtering if needed
    let coreFacetsToCheck: string[]
    if (isTron)
      // Use the Tron-specific utility that filters out GasZipFacet
      coreFacetsToCheck = getTronCoreFacets()
    else coreFacetsToCheck = coreFacets

    // For staging, skip targetState checks as targetState is only for production
    let nonCoreFacets: string[] = []
    if (environment === 'production') {
      if (targetStateJson[networkLower]?.production?.LiFiDiamond) {
        nonCoreFacets = Object.keys(
          targetStateJson[networkLower]['production'].LiFiDiamond
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
    const networksConfig = await import('../../config/networks.json')

    let publicClient: PublicClient | undefined
    let tronWeb: TronWeb | undefined

    if (isTron)
      tronWeb = initTronWeb(
        'mainnet',
        undefined,
        networksConfig[networkLower].rpcUrl
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
        await delayTron() // 500ms delay
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
          await delayTron() // 500ms delay
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
        const rpcUrl = networksConfig[networkLower].rpcUrl

        // Execute with retry logic for rate limits
        // TronGrid has strict rate limits, so we add initial delay and retry on 429
        const rawString = await execWithRateLimitRetry(
          [
            'bun',
            'run',
            'script/troncast/index.ts',
            'call',
            diamondAddress,
            'facets() returns ((address,bytes4[])[])',
            '--rpc-url',
            rpcUrl,
          ],
          2000, // 2 second initial delay for Tron
          3,
          [3000, 5000, 10000]
        )

        // Parse Tron output format
        const onChainFacets = parseTroncastFacetsOutput(rawString)

        if (Array.isArray(onChainFacets)) {
          // Map Tron addresses directly (deployments already use Tron format)
          const configFacetsByAddress = Object.fromEntries(
            Object.entries(deployedContracts).map(([name, address]) => {
              // Address is already in Tron format for Tron deployments
              return [address.toLowerCase(), name]
            })
          )

          registeredFacets = onChainFacets
            .map(([tronAddress]) => {
              return configFacetsByAddress[tronAddress.toLowerCase()]
            })
            .filter(Boolean)
        }
      } else if (networksConfig[networkLower].rpcUrl && publicClient) {
        // Existing EVM logic with retry for rate limits
        const rpcUrl: string = publicClient.chain.rpcUrls.default.http[0]
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
          [3000, 5000, 10000]
        )

        const jsonCompatibleString = rawString
          .replace(/\(/g, '[')
          .replace(/\)/g, ']')
          .replace(/0x[0-9a-fA-F]+/g, '"$&"')

        const onChainFacets = JSON.parse(jsonCompatibleString)

        if (Array.isArray(onChainFacets)) {
          const configFacetsByAddress = Object.fromEntries(
            Object.entries(deployedContracts).map(([name, address]) => {
              return [address.toLowerCase(), name]
            })
          )

          registeredFacets = onChainFacets.map(([address]) => {
            return configFacetsByAddress[address.toLowerCase()]
          })
        }
      }
    } catch (error: any) {
      facetCheckSkipped = true
      const errorMessage = error?.message || String(error)

      // Check if it's a rate limit error (429)
      if (
        errorMessage.includes('429') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('Too Many Requests')
      ) {
        consola.warn(
          'RPC rate limit reached (429) - skipping facet registration check'
        )
        consola.warn(
          'This is a temporary limitation from the RPC provider. The check will be skipped.'
        )
      } else {
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
          await delayTron() // 500ms delay
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
          const rpcUrl = networksConfig[networkLower].rpcUrl
          const erc20ProxyAddress = deployedContracts['ERC20Proxy']
          const executorAddress = deployedContracts['Executor']

          await delayTron()
          const isAuthorizedOutput = await callTronContract(
            erc20ProxyAddress,
            'authorizedCallers(address)',
            [executorAddress],
            'bool',
            rpcUrl
          )

          // Parse boolean result
          const isAuthorized =
            isAuthorizedOutput.trim().toLowerCase() === 'true' ||
            isAuthorizedOutput.trim() === '1'

          if (!isAuthorized) {
            logError('Executor is not authorized in ERC20Proxy')
          } else {
            consola.success('Executor is authorized in ERC20Proxy')
          }
        } catch (error: any) {
          logError(
            `Failed to check Executor authorization: ${error?.message || String(error)}`
          )
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
          const rpcUrl = networksConfig[networkLower].rpcUrl
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
              // Add delay to avoid rate limits
              await delayTron()

              // Call getPeripheryContract using troncast
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
          await checkWhitelistIntegrityTron(
            networkStr as string,
            deployedContracts,
            environment,
            whitelistConfig,
            diamondAddress,
            networksConfig[networkLower].rpcUrl,
            tronWeb
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
            onChainContracts,
            onChainSelectors
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
      const rpcUrl = networksConfig[networkLower].rpcUrl

      // Check ERC20Proxy ownership (skip for staging)
      if (environment === 'production') {
        await checkOwnershipTron(
          'ERC20Proxy',
          deployerWallet,
          deployedContracts,
          rpcUrl
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
            rpcUrl
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
        rpcUrl
      )

      // Receiver
      await checkOwnershipTron(
        'Receiver',
        refundWallet,
        deployedContracts,
        rpcUrl
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

        if (!balanceTrx || balanceTrx === '0' || balanceTrx === 0) {
          logError(`PauserWallet does not have any native balance`)
        } else {
          consola.success(`PauserWallet is funded: ${balanceTrx} TRX`)
        }
      } catch (error: any) {
        logError(
          `Failed to check pauser wallet balance: ${error?.message || String(error)}`
        )
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

      for (const selector of refundSelectors) {
        try {
          await delayTron()
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
        } catch (error: any) {
          const errorMessage = error?.message || String(error)
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
      const networkConfig: Network = networks[networkLower]
      if (!networkConfig.safeAddress)
        consola.warn('SAFE address not configured')
      else {
        const safeOwners = globalConfig.safeOwners
        const safeAddress = networkConfig.safeAddress

        try {
          // Import getSafeInfoFromContract from safe-utils.ts
          const { getSafeInfoFromContract } = await import('./safe/safe-utils')

          // Get Safe info directly from the contract
          const safeInfo = await getSafeInfoFromContract(
            publicClient,
            safeAddress
          )

          // Check that each safeOwner is in the Safe
          for (const o in safeOwners) {
            const safeOwner = getAddress(safeOwners[o])
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

/**
 * Get Tron wallet address from globalConfig, falling back to EVM format if Tron version doesn't exist
 */
const getTronWallet = (
  globalConfig: any,
  walletName: string
): string => {
  const tronKey = `${walletName}Tron`
  return (globalConfig as any)[tronKey] || globalConfig[walletName]
}

/**
 * Convert address to Tron format if it's in EVM format (0x...)
 */
const ensureTronAddress = (
  address: string,
  tronWeb: TronWeb
): string => {
  if (address.startsWith('0x')) {
    return hexToTronAddress(address, tronWeb)
  }
  return address
}

/**
 * Parse address result from callTronContract output
 */
const parseTronAddressOutput = (output: string): string => {
  return output.trim().replace(/^["']|["']$/g, '')
}

/**
 * Delay helper for Tron rate limit avoidance
 */
const delayTron = (ms = 500): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Normalize selector to Hex format (ensure 0x prefix)
 */
const normalizeSelector = (selector: string): Hex => {
  return selector.startsWith('0x') ? (selector as Hex) : (`0x${selector}` as Hex)
}

/**
 * Call Tron contract function using TronWeb and decode boolean result
 */
const callTronContractBoolean = async (
  tronWeb: TronWeb,
  contractAddress: string,
  functionSignature: string,
  params: Array<{ type: string; value: string }>,
  abiFunction: string
): Promise<boolean> => {
  const result = await retryWithRateLimit(
    () =>
      tronWeb.transactionBuilder.triggerConstantContract(
        contractAddress,
        functionSignature,
        {},
        params,
        tronWeb.defaultAddress?.base58 || tronWeb.defaultAddress?.hex || ''
      ),
    3,
    [1000, 2000, 3000]
  )

  // Check if call was successful
  if (!result?.result?.result) {
    const errorMsg = result?.constant_result?.[0]
      ? tronWeb.toUtf8(result.constant_result[0])
      : 'Unknown error'
    throw new Error(`Call failed: ${errorMsg}`)
  }

  // Decode boolean result using viem's decodeFunctionResult
  const constantResult = result.constant_result?.[0]
  if (!constantResult) {
    throw new Error('No result returned from contract call')
  }

  const decodedResult = decodeFunctionResult({
    abi: parseAbi([abiFunction]),
    functionName: functionSignature.split('(')[0],
    data: `0x${constantResult}`,
  })

  return decodedResult === true
}

const checkOwnership = async (
  name: string,
  expectedOwner: Address,
  deployedContracts: Record<string, Address>,
  publicClient: PublicClient
) => {
  if (deployedContracts[name]) {
    const contractAddress = deployedContracts[name]
    const owner = await getOwnableContract(
      contractAddress,
      publicClient
    ).read.owner()
    if (getAddress(owner) !== getAddress(expectedOwner))
      logError(
        `${name} owner is ${getAddress(owner)}, expected ${getAddress(
          expectedOwner
        )}`
      )
    else consola.success(`${name} owner is correct`)
  }
}

/**
 * Check contract ownership for Tron using troncast
 */
const checkOwnershipTron = async (
  name: string,
  expectedOwner: string,
  deployedContracts: Record<string, string>,
  rpcUrl: string
) => {
  if (deployedContracts[name]) {
    try {
      await delayTron()
      const contractAddress = deployedContracts[name]
      const ownerOutput = await callTronContract(
        contractAddress,
        'owner()',
        [],
        'address',
        rpcUrl
      )

      const ownerAddress = parseTronAddressOutput(ownerOutput)
      const expectedOwnerLower = expectedOwner.toLowerCase()
      const actualOwnerLower = ownerAddress.toLowerCase()

      if (actualOwnerLower !== expectedOwnerLower) {
        logError(
          `${name} owner is ${ownerAddress}, expected ${expectedOwner}`
        )
      } else {
        consola.success(`${name} owner is correct`)
      }
    } catch (error: any) {
      logError(
        `Failed to check ${name} ownership: ${error?.message || String(error)}`
      )
    }
  }
}

const checkIsDeployed = async (
  contract: string,
  deployedContracts: Record<string, Address>,
  publicClient: PublicClient
): Promise<boolean> => {
  if (!deployedContracts[contract]) return false

  const code = await publicClient.getCode({
    address: deployedContracts[contract],
  })
  if (code === '0x') return false

  return true
}

const getExpectedPairs = async (
  network: string,
  deployedContracts: Record<string, Address | string>,
  environment: string,
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
    if (peripheryConfig && peripheryConfig[network.toLowerCase()]) {
      const networkPeripheryContracts = peripheryConfig[network.toLowerCase()]

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

    return expectedPairs
  } catch (error) {
    logError(`Failed to get expected pairs: ${error}`)
    return []
  }
}

/**
 * Parse a string representation of a nested array (e.g. troncast output) into [array, endIndex].
 * Used when JSON.parse fails on getAllContractSelectorPairs-style output.
 */
function parseArray(str: string, start: number): [unknown[], number] {
  const result: unknown[] = []
  let i = start + 1
  let current = ''
  while (i < str.length) {
    const char = str[i]
    if (char === '[') {
      if (current.trim()) {
        result.push(current.trim())
        current = ''
      }
      const [nested, newPos] = parseArray(str, i)
      result.push(nested)
      i = newPos
    } else if (char === ']') {
      if (current.trim()) result.push(current.trim())
      return [result, i + 1]
    } else if (char === ' ' || char === '\n' || char === '\t') {
      if (current.trim()) {
        result.push(current.trim())
        current = ''
      }
      i++
    } else {
      current += char
      i++
    }
  }
  return [result, i]
}

/**
 * Check whitelist integrity for Tron network using troncast and TronWeb
 */
const checkWhitelistIntegrityTron = async (
  network: string,
  deployedContracts: Record<string, string>,
  environment: string,
  whitelistConfig: IWhitelistConfig,
  diamondAddress: string,
  rpcUrl: string,
  tronWeb: TronWeb
) => {
  consola.box('Checking Whitelist Integrity (Config vs. On-Chain State)...')

  // Get expected pairs from config
  const expectedPairs = await getExpectedPairs(
    network,
    deployedContracts,
    environment,
    whitelistConfig,
    true // isTron = true
  )

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
  consola.info(
    `Config has ${expectedPairs.length} pairs, ${uniqueContracts.size} unique contracts, and ${uniqueSelectors.size} unique selectors.`
  )

  try {
    // Get on-chain data using getAllContractSelectorPairs
    consola.start('Fetching on-chain whitelist data...')
    const onChainDataOutput = await callTronContract(
      diamondAddress,
      'getAllContractSelectorPairs()',
      [],
      'address[],bytes4[][]',
      rpcUrl
    )

    // Parse the output - troncast returns nested arrays: [[addresses...] [[selectors...]]]
    // Try JSON.parse first, fallback to simple parsing
    let parsed: unknown[]
    try {
      parsed = JSON.parse(onChainDataOutput.trim())
    } catch {
      // If JSON.parse fails, use simple recursive parser (same approach as checkWhitelistSyncStatusPerNetwork.ts)
      const trimmed = onChainDataOutput.trim()
      if (!trimmed.startsWith('[')) {
        throw new Error('Expected array format')
      }
      const [parsedArray] = parseArray(trimmed, 0)
      parsed = parsedArray as unknown[]
    }

    if (!Array.isArray(parsed) || parsed.length !== 2) {
      throw new Error('Unexpected troncast output format: expected nested arrays')
    }

    const addresses = (parsed[0] as unknown[]) || []
    const selectorsArrays = (parsed[1] as unknown[]) || []

    if (!Array.isArray(addresses) || !Array.isArray(selectorsArrays)) {
      throw new Error('Unexpected troncast output format: expected arrays')
    }

    // Build sets for quick lookup
    // For Tron, addresses are base58 and should be compared in lowercase for consistency
    const onChainPairSet = new Set<string>()
    for (let i = 0; i < addresses.length; i++) {
      const contract = String(addresses[i]).toLowerCase()
      const selectors = (selectorsArrays[i] as unknown[]) || []
      if (Array.isArray(selectors)) {
        for (const selector of selectors) {
          const selectorLower = String(selector).toLowerCase()
          onChainPairSet.add(`${contract}:${selectorLower}`)
        }
      }
    }

    consola.info(
      `On-chain has ${addresses.length} contracts with ${onChainPairSet.size} total pairs.`
    )

    // Check each expected pair using isContractSelectorWhitelisted
    // Use TronWeb directly to avoid troncast parsing issues with address+bytes4 parameters
    consola.start('Step 1/2: Checking Config vs. On-Chain Functions...')
    let granularFails = 0

    for (const expectedPair of expectedPairs) {
      try {
        // Add delay to avoid rate limits
        await delayTron()

        // Use TronWeb directly instead of troncast to avoid parameter parsing issues
        // expectedPair.contract is already in original base58 format (not lowercase) for Tron
        const isWhitelisted = await callTronContractBoolean(
          tronWeb,
          diamondAddress,
          'isContractSelectorWhitelisted(address,bytes4)',
          [
            { type: 'address', value: expectedPair.contract },
            { type: 'bytes4', value: expectedPair.selector },
          ],
          'function isContractSelectorWhitelisted(address,bytes4) external view returns (bool)'
        )

        if (!isWhitelisted) {
          logError(
            `Source of Truth FAILED: ${expectedPair.contract} / ${expectedPair.selector} is 'false'.`
          )
          granularFails++
        }
      } catch (error: any) {
        const errorMessage = error?.message || String(error)
        logError(
          `Failed to check ${expectedPair.contract}/${expectedPair.selector}: ${errorMessage}`
        )
        granularFails++
      }
    }

    if (granularFails === 0) {
      consola.success(
        'Source of Truth (isContractSelectorWhitelisted) is synced.'
      )
    }

    // Check Config vs. Getter Arrays
    consola.start('Step 2/2: Checking Config vs. Getter Arrays...')

    // Build expected pair set for comparison (use lowercase for addresses to match onChainPairSet)
    const expectedPairSet = new Set<string>()
    for (const pair of expectedPairs) {
      expectedPairSet.add(
        `${pair.contract.toLowerCase()}:${pair.selector.toLowerCase()}`
      )
    }

    // Check for missing pairs (in config but not on-chain)
    const missingPairsList: string[] = []
    for (const expectedPair of expectedPairs) {
      const key = `${expectedPair.contract.toLowerCase()}:${expectedPair.selector.toLowerCase()}`
      if (!onChainPairSet.has(key)) {
        missingPairsList.push(key)
      }
    }

    // Check for stale pairs (on-chain but not in config)
    const stalePairsList: string[] = []
    for (const onChainPair of onChainPairSet) {
      if (!expectedPairSet.has(onChainPair)) {
        stalePairsList.push(onChainPair)
      }
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
        missingPairsList.slice(0, 10).forEach((pair) => {
          const [contract, selector] = pair.split(':')
          logError(`  Missing: ${contract} / ${selector}`)
        })
        if (missingPairsList.length > 10) {
          logError(`  ... and ${missingPairsList.length - 10} more`)
        }
        consola.warn(
          `\n💡 To fix missing pairs, run: source script/tasks/diamondSyncWhitelist.sh && diamondSyncWhitelist ${network} ${environment}`
        )
      }
      if (stalePairsList.length > 0) {
        logError(
          `Pair Array has ${stalePairsList.length} stale pairs not in config:`
        )
        stalePairsList.slice(0, 10).forEach((pair) => {
          const [contract, selector] = pair.split(':')
          logError(`  Stale: ${contract} / ${selector}`)
        })
        if (stalePairsList.length > 10) {
          logError(`  ... and ${stalePairsList.length - 10} more`)
        }
        consola.warn(
          `\n💡 To fix stale pairs, run: source script/tasks/diamondSyncWhitelist.sh && diamondSyncWhitelist ${network} ${environment}`
        )
      }
    }
  } catch (error: any) {
    const errorMessage = error?.message || String(error)
    logError(`Failed during whitelist integrity checks: ${errorMessage}`)
  }
}

// Checks the config.json (source of truth) against on-chain state.
// This function handles all checks for data integrity and synchronization.
const checkWhitelistIntegrity = async (
  publicClient: PublicClient,
  diamondAddress: Address,
  whitelistManager: ReturnType<typeof getContract>,
  expectedPairs: Array<{ contract: Address; selector: Hex }>,
  onChainContracts: Address[],
  onChainSelectors: Hex[][]
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
  consola.info(
    `Config has ${expectedPairs.length} pairs, ${uniqueContracts.size} unique contracts, and ${uniqueSelectors.size} unique selectors.`
  )

  try {
    // --- 2. Check Config vs. On-Chain Contract Functions (Multicall) ---
    consola.start('Step 1/2: Checking Config vs. On-Chain Functions...')

    // Check source of truth: isContractSelectorWhitelisted
    const granularMulticall = expectedPairs.map((pair) => ({
      address: whitelistManager.address,
      abi: whitelistManager.abi,
      functionName: 'isContractSelectorWhitelisted',
      args: [pair.contract, pair.selector],
    }))
    const granularResults = await publicClient.multicall({
      contracts: granularMulticall,
      allowFailure: false,
    })

    let granularFails = 0
    granularResults.forEach((isWhitelisted, index) => {
      if (isWhitelisted === false) {
        const pair = expectedPairs[index]
        logError(
          `Source of Truth FAILED: ${pair.contract} / ${pair.selector} is 'false'.`
        )
        granularFails++
      }
    })
    if (granularFails === 0)
      consola.success(
        'Source of Truth (isContractSelectorWhitelisted) is synced.'
      )
  } catch (error) {
    logError(`Failed during functional checks: ${error.message}`)
  }

  // --- 3. Check Config vs. Getter Arrays ---
  consola.start('Step 2/2: Checking Config vs. Getter Arrays...')
  try {
    // Check pair array: getAllContractSelectorPairs
    const onChainPairSet = new Set<string>()
    for (let i = 0; i < onChainContracts.length; i++) {
      const contract = onChainContracts[i].toLowerCase()
      for (const selector of onChainSelectors[i]) {
        onChainPairSet.add(`${contract}:${selector.toLowerCase()}`)
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
  } catch (error) {
    logError(`Failed during getter array checks: ${error.message}`)
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

// Only run main if not in test environment
if (process.env.NODE_ENV !== 'test' && !process.env.BUN_TEST) {
  runMain(main)
}
