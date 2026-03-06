import { readFileSync } from 'fs'
import { join } from 'path'

import { consola } from 'consola'
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  formatEther,
  type Address,
} from 'viem'

import 'dotenv/config'

import networksConfig from '../../../config/networks.json'
import {
  EnvironmentEnum,
  type INetwork,
  type SupportedChain,
} from '../../common/types'
import { initTronWeb } from '../../troncast/utils/tronweb'
import { getDeployments } from '../../utils/deploymentHelpers'
import { getRPCEnvVarName } from '../../utils/network'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

// ABI for EmergencyPauseFacet
const EMERGENCY_PAUSE_FACET_ABI = parseAbi([
  'function pauserWallet() view returns (address)',
])

// ABI for Diamond Loupe (to check if selector is registered)
const DIAMOND_LOUPE_ABI = parseAbi([
  'function facetAddress(bytes4) view returns (address)',
])

// Selectors for all EmergencyPauseFacet external/public functions
// Calculated using: cast sig "functionName(...)"
const PAUSE_DIAMOND_SELECTOR = '0xf86368ae' as `0x${string}` // pauseDiamond()
const REMOVE_FACET_SELECTOR = '0x0340e905' as `0x${string}` // removeFacet(address)
const UNPAUSE_DIAMOND_SELECTOR = '0x2fc487ae' as `0x${string}` // unpauseDiamond(address[])
const PAUSER_WALLET_SELECTOR = '0x5ad317a4' as `0x${string}` // pauserWallet()

// All selectors that should be registered for EmergencyPauseFacet
const EMERGENCY_PAUSE_FACET_SELECTORS = [
  PAUSE_DIAMOND_SELECTOR,
  REMOVE_FACET_SELECTOR,
  UNPAUSE_DIAMOND_SELECTOR,
  PAUSER_WALLET_SELECTOR,
] as const

interface IPauserWalletStatus {
  network: string
  environment: 'production' | 'staging'
  diamondAddress: Address | null
  pauserWalletOnChain: Address | null
  pauserWalletInConfig: Address
  addressesMatch: boolean | null
  hasEmergencyPauseFacet: boolean | null
  registeredSelectors: {
    pauseDiamond: boolean
    removeFacet: boolean
    unpauseDiamond: boolean
    pauserWallet: boolean
  } | null
  balance: string | null
  formattedBalance: string | null
  nativeCurrency: string | null
  balanceError: string | null
  errors: string[]
}

// Helper function to sleep for specified milliseconds
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Helper function to load pauser wallet from global.json
function getPauserWalletFromConfig(): Address {
  const globalConfigPath = join(process.cwd(), 'config', 'global.json')
  const globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf8'))
  const pauserWallet = globalConfig.pauserWallet
  if (!pauserWallet) {
    throw new Error('pauserWallet not found in config/global.json')
  }
  return getAddress(pauserWallet) as Address
}

// Helper function to get balance for EVM chains
async function getEvmBalance(
  publicClient: ReturnType<typeof createPublicClient>,
  address: Address
): Promise<{ balance: string; formattedBalance: string }> {
  const balance = await publicClient.getBalance({ address })
  const formattedBalance = formatEther(balance)
  return {
    balance: balance.toString(),
    formattedBalance,
  }
}

// Helper function to get balance for Tron chains
async function getTronBalance(
  networkName: string,
  address: Address
): Promise<{ balance: string; formattedBalance: string }> {
  const env: 'mainnet' | 'testnet' =
    networkName === 'tron' ? 'mainnet' : 'testnet'
  const tronWeb = initTronWeb(env, undefined)

  // Convert EVM address to Tron address if needed
  const tronAddress = address.startsWith('0x')
    ? tronWeb.address.fromHex(address)
    : address

  // Get TRX balance (in SUN, 1 TRX = 1,000,000 SUN)
  const balanceInSun = await tronWeb.trx.getBalance(tronAddress)
  const balanceInTrx = balanceInSun / 1_000_000

  return {
    balance: balanceInSun.toString(),
    formattedBalance: balanceInTrx.toFixed(6),
  }
}

// Helper function to check if all EmergencyPauseFacet selectors are registered on the diamond
async function checkEmergencyPauseFacetRegistered(
  publicClient: ReturnType<typeof createPublicClient>,
  diamondAddress: Address
): Promise<{
  allRegistered: boolean
  registeredSelectors: {
    pauseDiamond: boolean
    removeFacet: boolean
    unpauseDiamond: boolean
    pauserWallet: boolean
  }
}> {
  const registeredSelectors = {
    pauseDiamond: false,
    removeFacet: false,
    unpauseDiamond: false,
    pauserWallet: false,
  }

  // Check each selector with 3 second delay between calls
  for (let i = 0; i < EMERGENCY_PAUSE_FACET_SELECTORS.length; i++) {
    const selector = EMERGENCY_PAUSE_FACET_SELECTORS[i]
    try {
      const facetAddress = await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_LOUPE_ABI,
        functionName: 'facetAddress',
        args: [selector as `0x${string}`],
      })
      // If facetAddress is not zero address, the selector is registered
      const isRegistered =
        facetAddress !== undefined &&
        facetAddress !== '0x0000000000000000000000000000000000000000'

      // Map selector to property name
      if (selector === PAUSE_DIAMOND_SELECTOR) {
        registeredSelectors.pauseDiamond = isRegistered
      } else if (selector === REMOVE_FACET_SELECTOR) {
        registeredSelectors.removeFacet = isRegistered
      } else if (selector === UNPAUSE_DIAMOND_SELECTOR) {
        registeredSelectors.unpauseDiamond = isRegistered
      } else if (selector === PAUSER_WALLET_SELECTOR) {
        registeredSelectors.pauserWallet = isRegistered
      }
    } catch (error) {
      // If call fails, assume not registered (don't set to true)
    }

    // Wait 3 seconds after each call (except after the last one)
    if (i < EMERGENCY_PAUSE_FACET_SELECTORS.length - 1) {
      await sleep(3000)
    }
  }

  // All selectors must be registered for the facet to be considered fully attached
  const allRegistered =
    registeredSelectors.pauseDiamond &&
    registeredSelectors.removeFacet &&
    registeredSelectors.unpauseDiamond &&
    registeredSelectors.pauserWallet

  return { allRegistered, registeredSelectors }
}

async function checkNetworkPauserWallet(
  networkName: SupportedChain,
  networkConfig: INetwork,
  environment: 'production' | 'staging',
  expectedPauserWallet: Address
): Promise<IPauserWalletStatus | null> {
  const status: IPauserWalletStatus = {
    network: networkName,
    environment,
    diamondAddress: null,
    pauserWalletOnChain: null,
    pauserWalletInConfig: expectedPauserWallet,
    addressesMatch: null,
    hasEmergencyPauseFacet: null,
    registeredSelectors: null,
    balance: null,
    formattedBalance: null,
    nativeCurrency: networkConfig.nativeCurrency || null,
    balanceError: null,
    errors: [],
  }

  try {
    // Skip inactive networks
    if (networkConfig.status !== 'active') {
      status.errors.push(`Network is ${networkConfig.status}`)
      return status
    }

    // Get deployment addresses
    let diamondAddress: Address | null = null

    try {
      const deployments = await getDeployments(
        networkName,
        environment === 'production'
          ? EnvironmentEnum.production
          : EnvironmentEnum.staging
      )
      diamondAddress = deployments.LiFiDiamond
        ? (getAddress(deployments.LiFiDiamond) as Address)
        : null
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      status.errors.push(`Failed to load deployments: ${errorMessage}`)
    }

    if (!diamondAddress) {
      // Skip networks without deployed diamond - return null to filter out
      return null
    }

    status.diamondAddress = diamondAddress

    // Get RPC URL
    const rpcEnvVarName = getRPCEnvVarName(networkName)
    const premiumRpcUrl = process.env[rpcEnvVarName]
    const rpcUrl = premiumRpcUrl || networkConfig.rpcUrl

    if (!rpcUrl) {
      status.errors.push('No RPC URL configured')
      return status
    }

    // Create public client
    const chain = getViemChainForNetworkName(networkName)
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    // Check if EmergencyPauseFacet is registered (check all selectors)
    try {
      const facetCheck = await checkEmergencyPauseFacetRegistered(
        publicClient,
        diamondAddress
      )
      status.hasEmergencyPauseFacet = facetCheck.allRegistered
      status.registeredSelectors = facetCheck.registeredSelectors
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      status.errors.push(`Failed to check EmergencyPauseFacet: ${errorMessage}`)
      status.hasEmergencyPauseFacet = false
      status.registeredSelectors = {
        pauseDiamond: false,
        removeFacet: false,
        unpauseDiamond: false,
        pauserWallet: false,
      }
    }

    // Wait 3 seconds before next call
    await sleep(3000)

    // Call pauserWallet() on the diamond
    try {
      const pauserWalletOnChain = await publicClient.readContract({
        address: diamondAddress,
        abi: EMERGENCY_PAUSE_FACET_ABI,
        functionName: 'pauserWallet',
      })

      status.pauserWalletOnChain = getAddress(pauserWalletOnChain) as Address

      // Compare addresses (case-insensitive)
      const addressesMatch =
        status.pauserWalletOnChain.toLowerCase() ===
        expectedPauserWallet.toLowerCase()
      status.addressesMatch = addressesMatch

      if (addressesMatch) {
        console.log(
          `[${networkName} (${environment})] ✅ Pauser wallet matches config: ${status.pauserWalletOnChain}`
        )
      } else {
        console.log(
          `[${networkName} (${environment})] ⚠️  Pauser wallet DOES NOT MATCH config`
        )
        console.log(`  On-chain: ${status.pauserWalletOnChain}`)
        console.log(`  Config:   ${expectedPauserWallet}`)
      }

      // Wait 3 seconds before checking balance
      await sleep(3000)

      // Check balance for the pauser wallet
      try {
        if (networkName === 'tron' || networkName === 'tronshasta') {
          const balanceResult = await getTronBalance(
            networkName,
            status.pauserWalletOnChain
          )
          status.balance = balanceResult.balance
          status.formattedBalance = balanceResult.formattedBalance
        } else {
          const balanceResult = await getEvmBalance(
            publicClient,
            status.pauserWalletOnChain
          )
          status.balance = balanceResult.balance
          status.formattedBalance = balanceResult.formattedBalance
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        status.balanceError = errorMessage
        status.balance = '0'
        status.formattedBalance = '0'
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      const conciseError = extractConciseError(errorMessage)
      status.errors.push(`Failed to call pauserWallet(): ${conciseError}`)
      status.addressesMatch = false
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    status.errors.push(`Network check failed: ${errorMessage}`)
  }

  return status
}

function formatStatus(value: boolean | null): string {
  if (value === null) return '❓'
  return value ? '✅' : '❌'
}

function extractConciseError(errorMessage: string): string {
  if (errorMessage.includes('Unauthorized')) {
    return 'RPC auth required'
  }
  if (errorMessage.includes('HTTP request failed')) {
    if (errorMessage.includes('403')) {
      return 'RPC unavailable (403)'
    }
    if (errorMessage.includes('Blast API')) {
      return 'RPC deprecated'
    }
    return 'RPC request failed'
  }
  if (errorMessage.includes('Unexpected end of JSON')) {
    return 'RPC response error'
  }
  if (errorMessage.includes('fetch failed')) {
    return 'Network error'
  }
  if (errorMessage.includes('execution reverted')) {
    return 'Contract call reverted'
  }
  if (errorMessage.includes('function does not exist')) {
    return 'EmergencyPauseFacet not deployed'
  }
  return errorMessage.length > 60
    ? `${errorMessage.substring(0, 57)}...`
    : errorMessage
}

function getColorCode(color: 'red' | 'green' | 'yellow' | 'reset'): string {
  const codes = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    reset: '\x1b[0m',
  }
  return codes[color]
}

function printTable(results: IPauserWalletStatus[]) {
  // Calculate column widths
  const networkWidth = Math.max(
    'Network'.length,
    ...results.map((r) => `${r.network} (${r.environment})`.length)
  )
  const diamondWidth = Math.max(
    'Diamond Address'.length,
    ...results.map((r) => (r.diamondAddress || 'N/A').length)
  )
  const pauserWidth = Math.max(
    'Pauser Wallet'.length,
    ...results.map((r) => (r.pauserWalletOnChain || 'N/A').length)
  )
  const matchWidth = 8
  const facetWidth = 8
  const selectorsWidth = 50
  const balanceWidth = Math.max(
    'Balance'.length,
    ...results.map((r) => {
      if (!r.formattedBalance || !r.nativeCurrency) return 'N/A'.length
      return `${r.formattedBalance} ${r.nativeCurrency}`.length
    })
  )

  // Header
  const headerLine = `${'Network'.padEnd(
    networkWidth
  )} | ${'Diamond Address'.padEnd(diamondWidth)} | ${'Pauser Wallet'.padEnd(
    pauserWidth
  )} | ${'Match'.padEnd(matchWidth)} | ${'Facet'.padEnd(
    facetWidth
  )} | ${'Selectors'.padEnd(selectorsWidth)} | ${'Balance'.padEnd(
    balanceWidth
  )}`
  console.log('\n')
  console.log('Legend:')
  console.log('  Match: Pauser wallet matches config')
  console.log('  Facet: All EmergencyPauseFacet selectors are registered')
  console.log(
    '  Selectors: pauseDiamond, removeFacet, unpauseDiamond, pauserWallet'
  )
  console.log('  Balance: Native token balance of pauser wallet')
  console.log('')
  console.log(headerLine)
  console.log('-'.repeat(headerLine.length))

  // Rows
  for (const result of results) {
    const allDone = result.addressesMatch === true && result.errors.length === 0

    const networkColor = allDone
      ? 'green'
      : result.errors.length > 0
      ? 'red'
      : 'yellow'
    const networkName = `${result.network} (${result.environment})`.padEnd(
      networkWidth
    )

    const diamondAddress = (result.diamondAddress || 'N/A').padEnd(diamondWidth)
    const pauserWallet = (result.pauserWalletOnChain || 'N/A').padEnd(
      pauserWidth
    )
    const match = formatStatus(result.addressesMatch).padEnd(matchWidth)
    const facet = formatStatus(result.hasEmergencyPauseFacet).padEnd(facetWidth)

    // Format selectors status
    let selectorsStatus = 'N/A'
    if (result.registeredSelectors) {
      const s = result.registeredSelectors
      selectorsStatus = `${formatStatus(s.pauseDiamond)} ${formatStatus(
        s.removeFacet
      )} ${formatStatus(s.unpauseDiamond)} ${formatStatus(s.pauserWallet)}`
    }
    const selectors = selectorsStatus.padEnd(selectorsWidth)

    // Format balance
    let balanceDisplay = 'N/A'
    let balanceColor: 'red' | 'green' | 'yellow' | 'reset' = 'reset'
    if (result.formattedBalance && result.nativeCurrency) {
      const balance = parseFloat(result.formattedBalance)
      balanceDisplay = `${result.formattedBalance} ${result.nativeCurrency}`
      balanceColor = balance === 0 ? 'red' : 'green'
    } else if (result.balanceError) {
      balanceDisplay = 'Error'
      balanceColor = 'red'
    }
    const balance = balanceDisplay.padEnd(balanceWidth)

    const line = `${getColorCode(networkColor)}${networkName}${getColorCode(
      'reset'
    )} | ${diamondAddress} | ${pauserWallet} | ${match} | ${facet} | ${selectors} | ${getColorCode(
      balanceColor
    )}${balance}${getColorCode('reset')}`

    console.log(line)
  }

  // Summary
  const allMatchCount = results.filter(
    (r) => r.addressesMatch === true && r.errors.length === 0
  ).length
  const hasFacetCount = results.filter(
    (r) => r.hasEmergencyPauseFacet === true
  ).length
  const missingFacetCount = results.filter(
    (r) => r.hasEmergencyPauseFacet === false && r.errors.length === 0
  ).length

  console.log('-'.repeat(headerLine.length))
  console.log('')
  console.log('Summary:')
  console.log(
    `  ${getColorCode(
      'green'
    )}✅ Pauser wallet matches config: ${allMatchCount}${getColorCode('reset')}`
  )
  console.log(
    `  ${getColorCode('yellow')}⚠️  Pauser wallet does not match: ${
      results.length - allMatchCount
    }${getColorCode('reset')}`
  )
  console.log('')
  console.log(
    `  ${getColorCode(
      'green'
    )}✅ EmergencyPauseFacet registered: ${hasFacetCount}${getColorCode(
      'reset'
    )}`
  )
  console.log(
    `  ${getColorCode(
      'yellow'
    )}⚠️  EmergencyPauseFacet missing: ${missingFacetCount}${getColorCode(
      'reset'
    )}`
  )
  console.log('')
  const nonZeroBalances = results.filter(
    (r) =>
      r.formattedBalance &&
      !r.balanceError &&
      parseFloat(r.formattedBalance) > 0
  )
  const zeroBalances = results.filter(
    (r) =>
      r.formattedBalance &&
      !r.balanceError &&
      parseFloat(r.formattedBalance) === 0
  )
  console.log(
    `  ${getColorCode('green')}✅ Pauser wallet with balance > 0: ${
      nonZeroBalances.length
    }${getColorCode('reset')}`
  )
  console.log(
    `  ${getColorCode('yellow')}⚠️  Pauser wallet with balance = 0: ${
      zeroBalances.length
    }${getColorCode('reset')}`
  )

  // Show networks with errors separately
  const networksWithErrors = results.filter((r) => r.errors.length > 0)
  if (networksWithErrors.length > 0) {
    console.log(
      `  ${getColorCode('red')}❓ With errors: ${
        networksWithErrors.length
      }${getColorCode('reset')}`
    )
    console.log('')
    console.log(
      'Networks with errors (check RPC connectivity or EmergencyPauseFacet deployment):'
    )
    for (const result of networksWithErrors) {
      const firstError = result.errors[0]
      if (firstError) {
        const conciseError = extractConciseError(firstError)
        console.log(
          `  ${getColorCode('red')}${result.network} (${
            result.environment
          }): ${conciseError}${getColorCode('reset')}`
        )
      }
    }
  }

  // Show networks with mismatched addresses
  const networksWithMismatch = results.filter(
    (r) => r.addressesMatch === false && r.errors.length === 0
  )
  if (networksWithMismatch.length > 0) {
    console.log('')
    console.log('Networks with mismatched pauser wallet addresses:')
    for (const result of networksWithMismatch) {
      console.log(
        `  ${getColorCode('yellow')}${result.network} (${
          result.environment
        }):${getColorCode('reset')}`
      )
      console.log(`    On-chain: ${result.pauserWalletOnChain}`)
      console.log(`    Config:   ${result.pauserWalletInConfig}`)
    }
  }

  // Show networks missing EmergencyPauseFacet or with partial selectors
  const networksMissingFacet = results.filter(
    (r) => r.hasEmergencyPauseFacet === false && r.errors.length === 0
  )
  if (networksMissingFacet.length > 0) {
    console.log('')
    console.log(
      'Networks missing EmergencyPauseFacet or with partial selectors:'
    )
    for (const result of networksMissingFacet) {
      console.log(
        `  ${getColorCode('yellow')}${result.network} (${
          result.environment
        }):${getColorCode('reset')}`
      )
      console.log(`    Diamond: ${result.diamondAddress}`)
      if (result.registeredSelectors) {
        const s = result.registeredSelectors
        const missing: string[] = []
        if (!s.pauseDiamond) missing.push('pauseDiamond')
        if (!s.removeFacet) missing.push('removeFacet')
        if (!s.unpauseDiamond) missing.push('unpauseDiamond')
        if (!s.pauserWallet) missing.push('pauserWallet')
        if (missing.length > 0) {
          console.log(`    Missing selectors: ${missing.join(', ')}`)
        }
      }
    }
  }

  // Show networks with zero balances
  const networksWithZeroBalance = results.filter(
    (r) =>
      r.formattedBalance &&
      !r.balanceError &&
      parseFloat(r.formattedBalance) === 0 &&
      r.errors.length === 0
  )
  if (networksWithZeroBalance.length > 0) {
    console.log('')
    console.log('Networks with zero balance:')
    for (const result of networksWithZeroBalance) {
      console.log(
        `  ${getColorCode('yellow')}${result.network} (${
          result.environment
        }):${getColorCode('reset')}`
      )
      console.log(`    Pauser wallet: ${result.pauserWalletOnChain || 'N/A'}`)
      console.log(
        `    Balance: ${result.formattedBalance} ${result.nativeCurrency || ''}`
      )
    }
  }

  // Show networks with balance errors
  const networksWithBalanceErrors = results.filter(
    (r) => r.balanceError && r.errors.length === 0
  )
  if (networksWithBalanceErrors.length > 0) {
    console.log('')
    console.log('Networks with balance check errors:')
    for (const result of networksWithBalanceErrors) {
      console.log(
        `  ${getColorCode('red')}${result.network} (${
          result.environment
        }):${getColorCode('reset')}`
      )
      console.log(`    Error: ${result.balanceError}`)
    }
  }

  console.log('')
  console.log(
    `Expected pauser wallet from config/global.json: ${
      results[0]?.pauserWalletInConfig || 'N/A'
    }`
  )
  console.log('\n')
}

async function main() {
  consola.info('Starting pauser wallet address check...')

  // Load expected pauser wallet from config
  const expectedPauserWallet = getPauserWalletFromConfig()
  consola.info(`Expected pauser wallet from config: ${expectedPauserWallet}`)

  const networks = networksConfig as Record<string, Partial<INetwork>>
  const results: IPauserWalletStatus[] = []

  // Filter to only valid SupportedChain networks
  const validNetworkNames = Object.keys(networks).filter(
    (name): name is SupportedChain => name in networks
  )

  // Process networks in parallel with concurrency limit
  const networkNames = validNetworkNames.filter(
    (name) => networks[name]?.status === 'active'
  )

  consola.info(
    `Checking ${networkNames.length} active networks (production + staging)...`
  )

  // Process all networks for both production and staging
  const networkPromises: Promise<IPauserWalletStatus | null>[] = []

  for (const networkName of networkNames) {
    const networkConfig = networks[networkName]
    if (!networkConfig) {
      // Skip networks without config - they won't have deployed diamond anyway
      // Don't add them to promises
    } else {
      networkPromises.push(
        checkNetworkPauserWallet(
          networkName as SupportedChain,
          networkConfig as INetwork,
          'production',
          expectedPauserWallet
        )
      )
      networkPromises.push(
        checkNetworkPauserWallet(
          networkName as SupportedChain,
          networkConfig as INetwork,
          'staging',
          expectedPauserWallet
        )
      )
    }
  }

  const networkResults = await Promise.all(networkPromises)
  // Filter out null results (networks without deployed diamond)
  const validResults = networkResults.filter(
    (r): r is IPauserWalletStatus => r !== null
  )
  results.push(...validResults)

  // Sort results: non-matching first (to show issues), then by network name, then by environment
  results.sort((a, b) => {
    const aMatch = a.addressesMatch === true && a.errors.length === 0
    const bMatch = b.addressesMatch === true && b.errors.length === 0

    if (aMatch !== bMatch) return aMatch ? 1 : -1
    if (a.network !== b.network) return a.network.localeCompare(b.network)
    if (a.environment !== b.environment) {
      return a.environment === 'production' ? -1 : 1
    }
    return 0
  })

  printTable(results)
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    consola.error('Fatal error:', error)
    process.exit(1)
  })
