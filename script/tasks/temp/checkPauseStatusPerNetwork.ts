/**
 * Checks the pause status of all production LiFiDiamond contracts across EVM networks.
 * Use before/after emergency pause operations to confirm the expected state.
 * Columns per network:
 *   - Pause status (owner() call): NOT PAUSED ✓ | PAUSED ⛔ | ERROR
 *   - EmergencyPauseFacet installed (DiamondLoupe.facetAddress on-chain): ✓ / ✗ NOT INSTALLED
 *   - Pauser wallet (on-chain pauserWallet()): address + ✓/✗ match against config/global.json
 */

import { consola } from 'consola'
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  toFunctionSelector,
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
import { isTronNetworkKey } from '../../deploy/shared/tron-network-keys'
import { getDeployments } from '../../utils/deploymentHelpers'
import { getRPCEnvVarName } from '../../utils/utils'
import {
  getViemChainForNetworkName,
  isTestnetNetwork,
} from '../../utils/viemScriptHelpers'

const OWNER_ABI = parseAbi(['function owner() view returns (address)'])
const PAUSER_WALLET_ABI = parseAbi([
  'function pauserWallet() view returns (address)',
])
const DIAMOND_LOUPE_ABI = parseAbi([
  'function facetAddress(bytes4 _functionSelector) view returns (address facetAddress_)',
])

// DiamondIsPaused() custom error selector
const DIAMOND_IS_PAUSED_SELECTOR = '0x0149422e'

// Selector of pauserWallet() — used to probe DiamondLoupe for EmergencyPauseFacet installation
const PAUSER_WALLET_SELECTOR = toFunctionSelector('pauserWallet()')

const EXPECTED_PAUSER_WALLET = getAddress(globalConfig.pauserWallet)

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

type PauseStatus = 'PAUSED' | 'NOT_PAUSED' | 'NO_DIAMOND' | 'ERROR'

interface IPauseStatusResult {
  network: string
  chainId: number
  diamondAddress: string | null
  status: PauseStatus
  emergencyPauseFacetInstalled: boolean | null
  pauserWallet: string | null
  pauserWalletMatchesGlobal: boolean | null
  error?: string
}

function getColorCode(
  color: 'red' | 'green' | 'yellow' | 'reset' | 'dim'
): string {
  const codes: Record<string, string> = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    reset: '\x1b[0m',
    dim: '\x1b[2m',
  }
  return codes[color] ?? ''
}

/**
 * Checks whether the production diamond on a single network is paused,
 * whether EmergencyPauseFacet is installed, and whether the registered
 * pauserWallet matches config/global.json.
 * Returns null for inactive or testnet networks.
 * @param networkName - The network key from networks.json
 * @param networkConfig - The network configuration object
 */
async function checkNetworkPauseStatus(
  networkName: SupportedChain,
  networkConfig: INetwork
): Promise<IPauseStatusResult | null> {
  if (networkConfig.status !== 'active') return null
  // Skip testnets — production diamonds only
  if (isTestnetNetwork(networkName)) return null
  // Skip Tron — needs separate tooling (troncast), not viem
  if (isTronNetworkKey(networkName)) return null

  let diamondAddress: string | null = null

  try {
    const deployments = await getDeployments(
      networkName,
      EnvironmentEnum.production
    )
    diamondAddress = (deployments.LiFiDiamond as string | undefined) ?? null
  } catch {
    // No deployment file → no diamond on this network
  }

  if (!diamondAddress) {
    return {
      network: networkName,
      chainId: networkConfig.chainId,
      diamondAddress: null,
      status: 'NO_DIAMOND',
      emergencyPauseFacetInstalled: null,
      pauserWallet: null,
      pauserWalletMatchesGlobal: null,
    }
  }

  const checksummedAddress = getAddress(diamondAddress) as Address
  const rpcEnvVarName = getRPCEnvVarName(networkName)
  const rpcUrl = process.env[rpcEnvVarName] ?? networkConfig.rpcUrl

  if (!rpcUrl) {
    return {
      network: networkName,
      chainId: networkConfig.chainId,
      diamondAddress: checksummedAddress,
      status: 'ERROR',
      emergencyPauseFacetInstalled: null,
      pauserWallet: null,
      pauserWalletMatchesGlobal: null,
      error: 'No RPC URL',
    }
  }

  const chain = getViemChainForNetworkName(networkName)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

  // Check on-chain whether EmergencyPauseFacet is installed by asking
  // DiamondLoupe if the pauserWallet() selector has a registered facet.
  let emergencyPauseFacetInstalled: boolean | null = null
  try {
    const facetAddr = await publicClient.readContract({
      address: checksummedAddress,
      abi: DIAMOND_LOUPE_ABI,
      functionName: 'facetAddress',
      args: [PAUSER_WALLET_SELECTOR as `0x${string}`],
    })
    emergencyPauseFacetInstalled =
      (facetAddr as string).toLowerCase() !== ZERO_ADDRESS
  } catch {
    // DiamondLoupe call failed — treat as unknown
  }

  // Read pauserWallet() — only meaningful when EmergencyPauseFacet is installed
  let pauserWallet: string | null = null
  let pauserWalletMatchesGlobal: boolean | null = null
  if (emergencyPauseFacetInstalled) {
    try {
      const raw = await publicClient.readContract({
        address: checksummedAddress,
        abi: PAUSER_WALLET_ABI,
        functionName: 'pauserWallet',
      })
      pauserWallet = getAddress(raw as string)
      pauserWalletMatchesGlobal =
        pauserWallet.toLowerCase() === EXPECTED_PAUSER_WALLET.toLowerCase()
    } catch {
      // Unexpected — facet is installed but call reverted (e.g. diamond paused)
    }
  }

  try {
    await publicClient.readContract({
      address: checksummedAddress,
      abi: OWNER_ABI,
      functionName: 'owner',
    })

    return {
      network: networkName,
      chainId: networkConfig.chainId,
      diamondAddress: checksummedAddress,
      status: 'NOT_PAUSED',
      emergencyPauseFacetInstalled,
      pauserWallet,
      pauserWalletMatchesGlobal,
    }
  } catch (error: unknown) {
    const errStr = String(error)
    if (
      errStr.includes(DIAMOND_IS_PAUSED_SELECTOR) ||
      errStr.toLowerCase().includes('diamondispaused')
    ) {
      return {
        network: networkName,
        chainId: networkConfig.chainId,
        diamondAddress: checksummedAddress,
        status: 'PAUSED',
        emergencyPauseFacetInstalled,
        pauserWallet,
        pauserWalletMatchesGlobal,
      }
    }

    const msg = error instanceof Error ? error.message : errStr
    return {
      network: networkName,
      chainId: networkConfig.chainId,
      diamondAddress: checksummedAddress,
      status: 'ERROR',
      emergencyPauseFacetInstalled,
      pauserWallet,
      pauserWalletMatchesGlobal,
      error: msg.length > 70 ? `${msg.substring(0, 67)}...` : msg,
    }
  }
}

function printTable(results: IPauseStatusResult[]) {
  // Only display networks that have a diamond deployed
  const displayResults = results.filter((r) => r.status !== 'NO_DIAMOND')

  if (displayResults.length === 0) {
    consola.warn('No production diamonds found.')
    return
  }

  const networkWidth = Math.max(
    'Network'.length,
    ...displayResults.map((r) => r.network.length)
  )
  const addrWidth = 42 // checksummed EVM address length
  const facetWidth = 18 // "EmPauseFacet" column
  const pauserWidth = 54 // address + match indicator

  const header =
    `${'Network'.padEnd(networkWidth)} | ${'Chain ID'.padStart(8)}` +
    ` | ${'Diamond Address'.padEnd(addrWidth)}` +
    ` | ${'EmPauseFacet'.padEnd(facetWidth)}` +
    ` | ${'Pauser Wallet'.padEnd(pauserWidth)}` +
    ` | Status`
  console.log('\n' + header)
  console.log('-'.repeat(header.length + 4))

  for (const r of displayResults) {
    let color: 'red' | 'green' | 'yellow' | 'reset'
    let statusStr: string

    switch (r.status) {
      case 'PAUSED':
        color = 'red'
        statusStr = 'PAUSED  ⛔'
        break
      case 'NOT_PAUSED':
        color = 'green'
        statusStr = 'NOT PAUSED ✓'
        break
      default:
        color = 'yellow'
        statusStr = `ERROR: ${r.error ?? 'unknown'}`
    }

    const facetStr =
      r.emergencyPauseFacetInstalled === null
        ? 'N/A'.padEnd(facetWidth)
        : r.emergencyPauseFacetInstalled
        ? '✓ installed'.padEnd(facetWidth)
        : '✗ NOT INSTALLED'.padEnd(facetWidth)

    let pauserStr: string
    if (r.pauserWallet === null) {
      pauserStr = (r.emergencyPauseFacetInstalled ? 'N/A' : '—').padEnd(
        pauserWidth
      )
    } else {
      const matchIndicator =
        r.pauserWalletMatchesGlobal === true
          ? ' ✓'
          : r.pauserWalletMatchesGlobal === false
          ? ' ✗ MISMATCH'
          : ''
      pauserStr = `${r.pauserWallet}${matchIndicator}`.padEnd(pauserWidth)
    }

    const addr = (r.diamondAddress ?? '').padEnd(addrWidth)
    const line =
      `${r.network.padEnd(networkWidth)} | ${String(r.chainId).padStart(8)}` +
      ` | ${addr} | ${facetStr} | ${pauserStr} | ${statusStr}`

    // Highlight rows that need attention: facet missing or pauser mismatch
    const needsAttention =
      r.emergencyPauseFacetInstalled === false ||
      r.pauserWalletMatchesGlobal === false
    const lineColor = needsAttention ? 'yellow' : color
    console.log(`${getColorCode(lineColor)}${line}${getColorCode('reset')}`)
  }

  console.log('-'.repeat(header.length + 4))

  const paused = displayResults.filter((r) => r.status === 'PAUSED').length
  const notPaused = displayResults.filter(
    (r) => r.status === 'NOT_PAUSED'
  ).length
  const errors = displayResults.filter((r) => r.status === 'ERROR').length
  const skipped = results.filter((r) => r.status === 'NO_DIAMOND').length
  const facetMissing = displayResults.filter(
    (r) => r.emergencyPauseFacetInstalled === false
  ).length
  const pauserMismatch = displayResults.filter(
    (r) => r.pauserWalletMatchesGlobal === false
  ).length

  console.log(`\nSummary (${displayResults.length} networks with diamonds):`)
  if (paused > 0)
    console.log(
      `  ${getColorCode('red')}PAUSED:            ${paused}${getColorCode(
        'reset'
      )}`
    )
  console.log(
    `  ${getColorCode('green')}NOT PAUSED:        ${notPaused}${getColorCode(
      'reset'
    )}`
  )
  if (facetMissing > 0)
    console.log(
      `  ${getColorCode(
        'yellow'
      )}FACET NOT INSTALLED: ${facetMissing} — EmergencyPauseFacet missing on these networks${getColorCode(
        'reset'
      )}`
    )
  if (pauserMismatch > 0)
    console.log(
      `  ${getColorCode(
        'yellow'
      )}PAUSER MISMATCH:   ${pauserMismatch} (expected ${EXPECTED_PAUSER_WALLET})${getColorCode(
        'reset'
      )}`
    )
  if (errors > 0)
    console.log(
      `  ${getColorCode('yellow')}ERRORS:            ${errors}${getColorCode(
        'reset'
      )}`
    )
  if (skipped > 0)
    console.log(
      `  ${getColorCode(
        'dim'
      )}NO DIAMOND:        ${skipped} (not shown)${getColorCode('reset')}`
    )
  console.log('')
}

async function main() {
  consola.info(
    'Checking production diamond pause status across all networks...'
  )

  const networks = networksConfig as Record<string, Partial<INetwork>>
  const networkNames = Object.keys(networks).filter(
    (name): name is SupportedChain => name in networks
  )

  const promises = networkNames.map((name) => {
    const cfg = networks[name]
    if (!cfg) return Promise.resolve(null)
    return checkNetworkPauseStatus(name, cfg as INetwork)
  })

  const allResults = await Promise.all(promises)
  const results = allResults.filter((r): r is IPauseStatusResult => r !== null)

  // Sort: PAUSED first (needs attention), then ERROR, NOT_PAUSED, NO_DIAMOND; alphabetically within each group
  const statusOrder: Record<PauseStatus, number> = {
    PAUSED: 0,
    ERROR: 1,
    NOT_PAUSED: 2,
    NO_DIAMOND: 3,
  }
  results.sort((a, b) => {
    const diff = statusOrder[a.status] - statusOrder[b.status]
    return diff !== 0 ? diff : a.network.localeCompare(b.network)
  })

  printTable(results)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    consola.error('Fatal error:', err)
    process.exit(1)
  })
