import { consola } from 'consola'
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
} from 'viem'

import 'dotenv/config'

import globalConfig from '../../../config/global.json'
import networksConfig from '../../../config/networks.json'
import {
  EnvironmentEnum,
  type INetwork,
  type SupportedChain,
} from '../../common/types'
import { SAFE_SINGLETON_ABI } from '../../deploy/safe/config'
import { getDeployments } from '../../utils/deploymentHelpers'
import { getRPCEnvVarName } from '../../utils/network'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

// Old addresses (hardcoded - these should be removed)
const EDMUND_SAFE_SIGNER =
  '0x1cEC0F949D04b809ab26c1001C9aEf75b1a28eeb' as Address
const OLD_DEPLOYER = '0x11F1022cA6AdEF6400e5677528a80d49a069C00c' as Address
const OLD_SC_DEV_WALLET =
  '0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62' as Address

// New addresses (from global.json)
const NEW_DEPLOYER = getAddress(globalConfig.deployerWallet) as Address
const NEW_SC_DEV_WALLET = getAddress(globalConfig.devWallet) as Address

// Function selector for batchSetContractSelectorWhitelist
const BATCH_SET_CONTRACT_SELECTOR_WHITELIST_SELECTOR =
  '0x1171c007' as `0x${string}`

// ABI for TimelockController
const TIMELOCK_ABI = parseAbi([
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function CANCELLER_ROLE() view returns (bytes32)',
])

// ABI for AccessManagerFacet
const ACCESS_MANAGER_ABI = parseAbi([
  'function addressCanExecuteMethod(bytes4 _selector, address _executor) view returns (bool)',
])

// ABI for OwnershipFacet
const OWNERSHIP_FACET_ABI = parseAbi([
  'function owner() view returns (address)',
])

interface INetworkStatus {
  network: string
  edmundRemoved: boolean | null
  oldDeployerRemoved: boolean | null
  newDeployerAdded: boolean | null
  oldDeployerCancellerRemoved: boolean | null
  newDeployerCancellerGranted: boolean | null
  oldDeployerWhitelistRemoved: boolean | null
  newDeployerWhitelistGranted: boolean | null
  stagingDiamondOwnershipTransferred: boolean | null
  errors: string[]
  excluded?: boolean // Mark networks that are excluded from checks
}

async function checkNetworkStatus(
  networkName: SupportedChain,
  networkConfig: INetwork
): Promise<INetworkStatus> {
  const status: INetworkStatus = {
    network: networkName,
    edmundRemoved: null,
    oldDeployerRemoved: null,
    newDeployerAdded: null,
    oldDeployerCancellerRemoved: null,
    newDeployerCancellerGranted: null,
    oldDeployerWhitelistRemoved: null,
    newDeployerWhitelistGranted: null,
    stagingDiamondOwnershipTransferred: null,
    errors: [],
  }

  try {
    // Skip networks without safeAddress
    if (!networkConfig.safeAddress || networkConfig.safeAddress === '') {
      status.errors.push('No safeAddress configured')
      return status
    }

    // Skip inactive networks
    if (networkConfig.status !== 'active') {
      status.errors.push(`Network is ${networkConfig.status}`)
      return status
    }

    const safeAddress = getAddress(networkConfig.safeAddress)

    // Use premium RPC from .env if available, fallback to networks.json
    // getRPCEnvVarName handles hyphen-to-underscore conversion (e.g., moon-beam -> ETH_NODE_URI_MOON_BEAM)
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

    // Check Safe owners
    try {
      const owners = (await publicClient.readContract({
        address: safeAddress,
        abi: SAFE_SINGLETON_ABI,
        functionName: 'getOwners',
      })) as Address[]

      const ownersLower = owners.map((o) => o.toLowerCase())
      status.edmundRemoved = !ownersLower.includes(
        EDMUND_SAFE_SIGNER.toLowerCase()
      )
      status.oldDeployerRemoved = !ownersLower.includes(
        OLD_DEPLOYER.toLowerCase()
      )
      status.newDeployerAdded = ownersLower.includes(NEW_DEPLOYER.toLowerCase())
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      // Extract a concise error message
      const conciseError = extractConciseError(errorMessage)
      status.errors.push(`Safe check: ${conciseError}`)
    }

    // Get deployment addresses
    let timelockAddress: Address | null = null
    let diamondAddress: Address | null = null

    try {
      const deployments = await getDeployments(
        networkName,
        EnvironmentEnum.production
      )
      timelockAddress = deployments.LiFiTimelockController
        ? (getAddress(deployments.LiFiTimelockController) as Address)
        : null
      diamondAddress = deployments.LiFiDiamond
        ? (getAddress(deployments.LiFiDiamond) as Address)
        : null
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      status.errors.push(`Failed to load deployments: ${errorMessage}`)
    }

    // Check TimelockController CANCELLER_ROLE
    if (timelockAddress) {
      try {
        // Get CANCELLER_ROLE constant from contract
        const cancellerRole = await publicClient.readContract({
          address: timelockAddress,
          abi: TIMELOCK_ABI,
          functionName: 'CANCELLER_ROLE',
        })

        const oldDeployerHasRole = await publicClient.readContract({
          address: timelockAddress,
          abi: TIMELOCK_ABI,
          functionName: 'hasRole',
          args: [cancellerRole, OLD_DEPLOYER],
        })
        status.oldDeployerCancellerRemoved = !oldDeployerHasRole

        const newDeployerHasRole = await publicClient.readContract({
          address: timelockAddress,
          abi: TIMELOCK_ABI,
          functionName: 'hasRole',
          args: [cancellerRole, NEW_DEPLOYER],
        })
        status.newDeployerCancellerGranted = newDeployerHasRole
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        const conciseError = extractConciseError(errorMessage)
        status.errors.push(`Timelock check: ${conciseError}`)
      }
    } else {
      status.errors.push('LiFiTimelockController not deployed')
    }

    // Check AccessManagerFacet permissions
    if (diamondAddress) {
      try {
        const oldDeployerCanExecute = await publicClient.readContract({
          address: diamondAddress,
          abi: ACCESS_MANAGER_ABI,
          functionName: 'addressCanExecuteMethod',
          args: [BATCH_SET_CONTRACT_SELECTOR_WHITELIST_SELECTOR, OLD_DEPLOYER],
        })
        status.oldDeployerWhitelistRemoved = !oldDeployerCanExecute

        const newDeployerCanExecute = await publicClient.readContract({
          address: diamondAddress,
          abi: ACCESS_MANAGER_ABI,
          functionName: 'addressCanExecuteMethod',
          args: [BATCH_SET_CONTRACT_SELECTOR_WHITELIST_SELECTOR, NEW_DEPLOYER],
        })
        // We want new deployer to NOT have whitelist permission (moved to multisig)
        status.newDeployerWhitelistGranted = !newDeployerCanExecute
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        const conciseError = extractConciseError(errorMessage)
        status.errors.push(`AccessManager check: ${conciseError}`)
      }
    } else {
      status.errors.push('LiFiDiamond not deployed')
    }

    // Check staging diamond ownership (if staging deployment exists)
    try {
      const stagingDeployments = await getDeployments(
        networkName,
        EnvironmentEnum.staging
      )
      const stagingDiamondAddress = stagingDeployments.LiFiDiamond
        ? (getAddress(stagingDeployments.LiFiDiamond) as Address)
        : null

      if (stagingDiamondAddress) {
        try {
          const currentOwner = await publicClient.readContract({
            address: stagingDiamondAddress,
            abi: OWNERSHIP_FACET_ABI,
            functionName: 'owner',
          })

          const ownerLower = currentOwner.toLowerCase()
          const devWalletLower = NEW_SC_DEV_WALLET.toLowerCase()

          // Check: owner matches the dev wallet from global.json
          // This will be green if owner matches devWallet, regardless of whether it's old or new
          status.stagingDiamondOwnershipTransferred =
            ownerLower === devWalletLower
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          const conciseError = extractConciseError(errorMessage)
          status.errors.push(`Staging diamond ownership check: ${conciseError}`)
        }
      }
      // If no staging diamond, leave as null (not applicable)
    } catch (error: unknown) {
      // Staging deployment doesn't exist - this is fine, leave as null
      // Only log if it's an unexpected error
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      if (!errorMessage.includes('not found')) {
        status.errors.push(
          `Staging deployment check: ${extractConciseError(errorMessage)}`
        )
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    status.errors.push(`Network check failed: ${errorMessage}`)
  }

  return status
}

function formatStatus(value: boolean | null, excluded = false): string {
  if (excluded) return '-'
  if (value === null) return '❓'
  return value ? '✅' : '❌'
}

function extractConciseError(errorMessage: string): string {
  // Extract the most relevant part of the error message
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
  // Return first 60 chars if no pattern matches
  return errorMessage.length > 60
    ? `${errorMessage.substring(0, 57)}...`
    : errorMessage
}

function getColorCode(color: 'red' | 'green' | 'reset'): string {
  const codes = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    reset: '\x1b[0m',
  }
  return codes[color]
}

function printTable(results: INetworkStatus[]) {
  // Calculate column widths
  const networkWidth = Math.max(
    'Network'.length,
    ...results.map((r) => r.network.length)
  )
  const colWidth = 5 // Width to match emoji display (emoji + spaces)

  // Legend above table
  console.log('\n')
  console.log('Legend:')
  console.log(
    `  1: Edmund safe signer (${EDMUND_SAFE_SIGNER}) removed from multisig`
  )
  console.log(`  2: Old deployer (${OLD_DEPLOYER}) removed from multisig`)
  console.log(`  3: New deployer (${NEW_DEPLOYER}) added to multisig`)
  console.log(
    `  4: Old deployer (${OLD_DEPLOYER}) CANCELLER_ROLE removed from Timelock`
  )
  console.log(
    `  5: New deployer (${NEW_DEPLOYER}) CANCELLER_ROLE granted in Timelock`
  )
  console.log(
    `  6: Old deployer (${OLD_DEPLOYER}) whitelist permission removed`
  )
  console.log(
    `  7: New deployer (${NEW_DEPLOYER}) whitelist permission NOT granted (whitelisting moved to multisig)`
  )
  console.log(
    `  8: Staging diamond ownership transferred from old SC dev wallet (${OLD_SC_DEV_WALLET}) to new SC dev wallet (${NEW_SC_DEV_WALLET})`
  )
  console.log('')
  console.log(
    'Note: Networks "tron" and "tronshasta" are excluded from checks (marked as "-")'
  )
  console.log(
    '      as they are non-EVM chains that do not support standard EVM contract checks.'
  )
  console.log('')

  // Header - always 8 columns now
  const numColumns = 8
  // Helper to center-align content in column
  // For emojis, we need to account for their visual width (2 chars) vs string length (1 char)
  const centerInColumn = (
    content: string,
    width: number,
    isEmoji = false
  ): string => {
    // Emojis visually take 2 character cells but have string length 1
    const visualWidth = isEmoji ? 2 : content.length
    const padding = width - visualWidth
    const leftPad = Math.floor(padding / 2)
    const rightPad = padding - leftPad
    return ' '.repeat(leftPad) + content + ' '.repeat(rightPad)
  }

  const headerCols = Array.from({ length: numColumns }, (_, i) =>
    centerInColumn(String(i + 1), colWidth, false)
  ).join(' | ')
  const headerLine = `${'Network'.padEnd(networkWidth)} | ${headerCols}`
  console.log(headerLine)
  // Use actual header line length for separator to ensure perfect alignment
  console.log('-'.repeat(headerLine.length))

  // Rows
  for (const result of results) {
    // Excluded networks are not considered "done" or "not done" - they're just excluded
    const isExcluded = result.excluded === true
    const baseChecksDone =
      !isExcluded &&
      result.edmundRemoved === true &&
      result.oldDeployerRemoved === true &&
      result.newDeployerAdded === true &&
      result.oldDeployerCancellerRemoved === true &&
      result.newDeployerCancellerGranted === true &&
      result.oldDeployerWhitelistRemoved === true &&
      result.newDeployerWhitelistGranted === true

    // Staging diamond check: if staging diamond exists, it must be transferred; if it doesn't exist, it's N/A (null)
    const stagingCheckDone =
      isExcluded ||
      result.stagingDiamondOwnershipTransferred === null ||
      result.stagingDiamondOwnershipTransferred === true

    const allDone = baseChecksDone && stagingCheckDone

    // Excluded networks use default color (no special highlighting)
    const networkColor = isExcluded ? 'reset' : allDone ? 'green' : 'red'
    const networkName = result.network.padEnd(networkWidth)

    // Center-align the status emojis in their columns (emojis have visual width 2)
    const edmund = centerInColumn(
      formatStatus(result.edmundRemoved, isExcluded),
      colWidth,
      !isExcluded
    )
    const oldDep = centerInColumn(
      formatStatus(result.oldDeployerRemoved, isExcluded),
      colWidth,
      !isExcluded
    )
    const newDep = centerInColumn(
      formatStatus(result.newDeployerAdded, isExcluded),
      colWidth,
      !isExcluded
    )
    const oldCan = centerInColumn(
      formatStatus(result.oldDeployerCancellerRemoved, isExcluded),
      colWidth,
      !isExcluded
    )
    const newCan = centerInColumn(
      formatStatus(result.newDeployerCancellerGranted, isExcluded),
      colWidth,
      !isExcluded
    )
    const oldWht = centerInColumn(
      formatStatus(result.oldDeployerWhitelistRemoved, isExcluded),
      colWidth,
      !isExcluded
    )
    const newWht = centerInColumn(
      formatStatus(result.newDeployerWhitelistGranted, isExcluded),
      colWidth,
      !isExcluded
    )
    const stagingOwnership = centerInColumn(
      formatStatus(result.stagingDiamondOwnershipTransferred, isExcluded),
      colWidth,
      !isExcluded
    )

    // Print network name in color - only one line per network
    const line = `${getColorCode(networkColor)}${networkName}${getColorCode(
      'reset'
    )} | ${edmund} | ${oldDep} | ${newDep} | ${oldCan} | ${newCan} | ${oldWht} | ${newWht} | ${stagingOwnership}`

    console.log(line)
  }

  // Summary (exclude excluded networks from counts)
  const allDoneCount = results.filter((r) => {
    if (r.excluded === true) return false // Don't count excluded networks
    const baseChecksDone =
      r.edmundRemoved === true &&
      r.oldDeployerRemoved === true &&
      r.newDeployerAdded === true &&
      r.oldDeployerCancellerRemoved === true &&
      r.newDeployerCancellerGranted === true &&
      r.oldDeployerWhitelistRemoved === true &&
      r.newDeployerWhitelistGranted === true
    const stagingCheckDone =
      r.stagingDiamondOwnershipTransferred === null ||
      r.stagingDiamondOwnershipTransferred === true
    return baseChecksDone && stagingCheckDone
  }).length

  const excludedCount = results.filter((r) => r.excluded === true).length
  const checkedNetworksCount = results.length - excludedCount

  // Use same header line for bottom separator
  console.log('-'.repeat(headerLine.length))
  console.log('')
  console.log('Legend:')
  console.log(
    `  1: Edmund safe signer (${EDMUND_SAFE_SIGNER}) removed from multisig`
  )
  console.log(`  2: Old deployer (${OLD_DEPLOYER}) removed from multisig`)
  console.log(`  3: New deployer (${NEW_DEPLOYER}) added to multisig`)
  console.log(
    `  4: Old deployer (${OLD_DEPLOYER}) CANCELLER_ROLE removed from Timelock`
  )
  console.log(
    `  5: New deployer (${NEW_DEPLOYER}) CANCELLER_ROLE granted in Timelock`
  )
  console.log(
    `  6: Old deployer (${OLD_DEPLOYER}) whitelist permission removed`
  )
  console.log(
    `  7: New deployer (${NEW_DEPLOYER}) whitelist permission NOT granted (whitelisting moved to multisig)`
  )
  console.log(
    `  8: Staging diamond ownership transferred from old SC dev wallet (${OLD_SC_DEV_WALLET}) to new SC dev wallet (${NEW_SC_DEV_WALLET})`
  )
  console.log('')
  console.log('Summary:')
  console.log(
    `  ${getColorCode(
      'green'
    )}✅ Fully completed: ${allDoneCount}${getColorCode('reset')}`
  )
  console.log(
    `  ${getColorCode('red')}❌ Incomplete: ${
      checkedNetworksCount - allDoneCount
    }${getColorCode('reset')}`
  )
  if (excludedCount > 0) {
    console.log(
      `  ${getColorCode('reset')}➖ Excluded: ${excludedCount}${getColorCode(
        'reset'
      )}`
    )
  }

  // Show networks with errors separately
  const networksWithErrors = results.filter((r) => r.errors.length > 0)
  if (networksWithErrors.length > 0) {
    console.log(
      `  ${getColorCode('red')}❓ With errors: ${
        networksWithErrors.length
      }${getColorCode('reset')}`
    )
    console.log('')
    console.log('Networks with errors (check RPC connectivity):')
    for (const result of networksWithErrors) {
      const firstError = result.errors[0]
      if (firstError) {
        const conciseError = extractConciseError(firstError)
        console.log(
          `  ${getColorCode('red')}${
            result.network
          }: ${conciseError}${getColorCode('reset')}`
        )
      }
    }
  }
  console.log('\n')
}

async function main() {
  consola.info('Starting network status check...')

  const networks = networksConfig as Record<string, Partial<INetwork>>
  const results: INetworkStatus[] = []

  // Filter to only valid SupportedChain networks
  const validNetworkNames = Object.keys(networks).filter(
    (name): name is SupportedChain => name in networks
  )

  // Excluded networks (non-EVM chains that don't support standard checks)
  const EXCLUDED_NETWORKS = ['tron', 'tronshasta']

  // Process networks in parallel with concurrency limit
  const networkNames = validNetworkNames.filter(
    (name) => networks[name]?.status === 'active'
  )

  // Separate excluded networks
  const excludedNetworks = networkNames.filter((name) =>
    EXCLUDED_NETWORKS.includes(name)
  )
  const networksToCheck = networkNames.filter(
    (name) => !EXCLUDED_NETWORKS.includes(name)
  )

  consola.info(
    `Checking ${networksToCheck.length} active networks (${
      excludedNetworks.length
    } excluded: ${excludedNetworks.join(', ')})...`
  )

  // Add excluded networks to results with special marker
  for (const excludedNetwork of excludedNetworks) {
    results.push({
      network: excludedNetwork,
      edmundRemoved: null,
      oldDeployerRemoved: null,
      newDeployerAdded: null,
      oldDeployerCancellerRemoved: null,
      newDeployerCancellerGranted: null,
      oldDeployerWhitelistRemoved: null,
      newDeployerWhitelistGranted: null,
      stagingDiamondOwnershipTransferred: null,
      errors: [],
      excluded: true,
    })
  }

  // Process all networks in parallel
  const networkResults = await Promise.all(
    networksToCheck.map((networkName) => {
      const networkConfig = networks[networkName]
      if (!networkConfig) {
        const errorStatus: INetworkStatus = {
          network: networkName,
          edmundRemoved: null,
          oldDeployerRemoved: null,
          newDeployerAdded: null,
          oldDeployerCancellerRemoved: null,
          newDeployerCancellerGranted: null,
          oldDeployerWhitelistRemoved: null,
          newDeployerWhitelistGranted: null,
          stagingDiamondOwnershipTransferred: null,
          errors: ['Network config not found'],
        }
        return errorStatus
      }
      return checkNetworkStatus(
        networkName as SupportedChain,
        networkConfig as INetwork
      )
    })
  )

  results.push(...networkResults)

  // Sort results: completed first, then by network name (excluded networks at the end)
  results.sort((a, b) => {
    // Excluded networks go to the end
    if (a.excluded !== b.excluded) {
      return a.excluded ? 1 : -1
    }

    // If both are excluded, sort by name
    if (a.excluded && b.excluded) {
      return a.network.localeCompare(b.network)
    }

    // For non-excluded networks, sort by completion status, then by name
    const aBaseDone =
      a.edmundRemoved === true &&
      a.oldDeployerRemoved === true &&
      a.newDeployerAdded === true &&
      a.oldDeployerCancellerRemoved === true &&
      a.newDeployerCancellerGranted === true &&
      a.oldDeployerWhitelistRemoved === true &&
      a.newDeployerWhitelistGranted === true
    const aStagingDone =
      a.stagingDiamondOwnershipTransferred === null ||
      a.stagingDiamondOwnershipTransferred === true
    const aDone = aBaseDone && aStagingDone

    const bBaseDone =
      b.edmundRemoved === true &&
      b.oldDeployerRemoved === true &&
      b.newDeployerAdded === true &&
      b.oldDeployerCancellerRemoved === true &&
      b.newDeployerCancellerGranted === true &&
      b.oldDeployerWhitelistRemoved === true &&
      b.newDeployerWhitelistGranted === true
    const bStagingDone =
      b.stagingDiamondOwnershipTransferred === null ||
      b.stagingDiamondOwnershipTransferred === true
    const bDone = bBaseDone && bStagingDone

    if (aDone !== bDone) return aDone ? 1 : -1
    return a.network.localeCompare(b.network)
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
