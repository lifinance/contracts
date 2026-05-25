/**
 * Health check for the LiFi emergency-pause infrastructure across every active
 * network and environment (production + staging). Tron is supported natively
 * via TronGrid's JSON-RPC bridge (same transport as other Tron-aware scripts).
 *
 * Per (network, environment), verifies:
 *   - EmergencyPauseFacet selectors registered (all four).
 *   - On-chain pauserWallet() matches config/global.json (EVM hex; Tron uses
 *     config/global.json → tronWallets.pauserWallet).
 *   - Pauser wallet native balance (so an out-of-gas pauser is visible).
 *   - Current pause state: NOT_PAUSED ✓ | PAUSED ⛔ | ERROR — derived from an
 *     owner() revert probe against the DiamondIsPaused() custom-error selector.
 *
 * Use before/after emergency-pause drills, after deploying EmergencyPauseFacet
 * to a new network, or after rotating PRIV_KEY_PAUSER_WALLET. Replaces the
 * earlier checkPauserWalletPerNetwork.ts + checkPauseStatusPerNetwork.ts pair.
 *
 * Run: `bunx tsx ./script/tasks/temp/checkEmergencyPausePerNetwork.ts`
 */

import { consola } from 'consola'
import {
  createPublicClient,
  formatUnits,
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
import { isTronNetworkKey } from '../../deploy/shared/tron-network-keys'
import { sleep } from '../../utils/delay'
import { getDeployments } from '../../utils/deploymentHelpers'
import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'
import { getRPCEnvVarName } from '../../utils/utils'
import {
  getTransportConfigFromRpcUrl,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'

const EMERGENCY_PAUSE_FACET_ABI = parseAbi([
  'function pauserWallet() view returns (address)',
])
const DIAMOND_LOUPE_ABI = parseAbi([
  'function facetAddress(bytes4) view returns (address)',
])
const OWNER_ABI = parseAbi(['function owner() view returns (address)'])

// 4-byte selectors of every external/public function on EmergencyPauseFacet.
// Reference: out/EmergencyPauseFacet.sol/EmergencyPauseFacet.json `methodIdentifiers`.
const SELECTORS = {
  pauseDiamond: '0xf86368ae' as `0x${string}`, // pauseDiamond()
  removeFacet: '0x0340e905' as `0x${string}`, // removeFacet(address)
  unpauseDiamond: '0x2fc487ae' as `0x${string}`, // unpauseDiamond(address[])
  pauserWallet: '0x5ad317a4' as `0x${string}`, // pauserWallet()
} as const

type SelectorName = keyof typeof SELECTORS
const SELECTOR_NAMES = Object.keys(SELECTORS) as SelectorName[]

// DiamondIsPaused() custom-error selector — emitted by every non-EmergencyPause
// facet call while the diamond is paused.
const DIAMOND_IS_PAUSED_SELECTOR = '0x0149422e'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const ENVIRONMENTS = ['production', 'staging'] as const
type Environment = (typeof ENVIRONMENTS)[number]

type PauseStatus = 'PAUSED' | 'NOT_PAUSED' | 'ERROR'

interface IEmergencyPauseStatus {
  network: string
  environment: Environment
  chainId: number
  diamondAddress: Address | null
  selectors: Record<SelectorName, boolean | null> | null
  hasEmergencyPauseFacet: boolean | null
  pauserWalletOnChain: Address | null
  pauserWalletExpected: Address
  pauserWalletMatches: boolean | null
  balance: bigint | null
  formattedBalance: string | null
  nativeCurrency: string | null
  balanceError: string | null
  pauseStatus: PauseStatus | null
  errors: string[]
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

function formatBool(value: boolean | null): string {
  if (value === null) return '❓'
  return value ? '✓' : '✗'
}

/**
 * Map a verbose viem/RPC error to a short, table-friendly label.
 * @param errorMessage - The raw error message (from `error.message` or `String(error)`).
 * @returns A ≤ 60-char human-readable label.
 */
function extractConciseError(errorMessage: string): string {
  if (errorMessage.includes('Unauthorized')) return 'RPC auth required'
  if (errorMessage.includes('HTTP request failed')) {
    if (errorMessage.includes('403')) return 'RPC unavailable (403)'
    if (errorMessage.includes('Blast API')) return 'RPC deprecated'
    return 'RPC request failed'
  }
  if (errorMessage.includes('Unexpected end of JSON'))
    return 'RPC response error'
  if (errorMessage.includes('fetch failed')) return 'Network error'
  if (errorMessage.includes('execution reverted'))
    return 'Contract call reverted'
  if (errorMessage.includes('function does not exist'))
    return 'EmergencyPauseFacet not deployed'
  return errorMessage.length > 60
    ? `${errorMessage.substring(0, 57)}...`
    : errorMessage
}

/**
 * Expected pauser wallet for a network, normalized to a viem `Address`.
 * Tron networks read from `global.json → tronWallets.pauserWallet` (base58);
 * EVM networks read from `global.json → pauserWallet`.
 * @param networkName - The network key from `networks.json`.
 */
function getExpectedPauserWallet(networkName: string): Address {
  if (isTronNetworkKey(networkName)) {
    const tronPauser = (
      globalConfig as { tronWallets?: { pauserWallet?: string } }
    ).tronWallets?.pauserWallet
    if (!tronPauser) {
      throw new Error(
        'tronWallets.pauserWallet not found in config/global.json'
      )
    }
    return normalizeAddressForNetwork(networkName, tronPauser)
  }
  return getAddress(globalConfig.pauserWallet)
}

/**
 * Probe DiamondLoupe.facetAddress() for every EmergencyPauseFacet selector
 * with INTER_CALL_DELAY pacing between calls (free-tier RPC friendly).
 * @returns A `(selectorName -> registered?)` map; missing selectors fall through to `false`.
 */
async function checkSelectorsRegistered(
  publicClient: ReturnType<typeof createPublicClient>,
  diamondAddress: Address
): Promise<Record<SelectorName, boolean>> {
  const result: Record<SelectorName, boolean> = {
    pauseDiamond: false,
    removeFacet: false,
    unpauseDiamond: false,
    pauserWallet: false,
  }
  for (let i = 0; i < SELECTOR_NAMES.length; i++) {
    const name = SELECTOR_NAMES[i] as SelectorName
    try {
      const facetAddr = (await publicClient.readContract({
        address: diamondAddress,
        abi: DIAMOND_LOUPE_ABI,
        functionName: 'facetAddress',
        args: [SELECTORS[name]],
      })) as string
      result[name] = facetAddr.toLowerCase() !== ZERO_ADDRESS
    } catch {
      // Treat any failure as "not registered" — explicit value already false.
    }
    if (i < SELECTOR_NAMES.length - 1) await sleep()
  }
  return result
}

/**
 * Call owner() and decide pause state from the result/error.
 * - A successful read → NOT_PAUSED (the diamond exposes OwnershipFacet).
 * - A revert that matches the DiamondIsPaused() selector → PAUSED (only
 *   EmergencyPauseFacet is callable when paused, owner() is on OwnershipFacet).
 * - Anything else → ERROR with a concise message attached.
 */
async function probePauseStatus(
  publicClient: ReturnType<typeof createPublicClient>,
  diamondAddress: Address
): Promise<{ status: PauseStatus; error?: string }> {
  try {
    await publicClient.readContract({
      address: diamondAddress,
      abi: OWNER_ABI,
      functionName: 'owner',
    })
    return { status: 'NOT_PAUSED' }
  } catch (error: unknown) {
    const raw = String(error)
    if (
      raw.includes(DIAMOND_IS_PAUSED_SELECTOR) ||
      raw.toLowerCase().includes('diamondispaused')
    )
      return { status: 'PAUSED' }
    const msg = error instanceof Error ? error.message : raw
    return { status: 'ERROR', error: extractConciseError(msg) }
  }
}

/**
 * Read the pauser wallet's native balance.
 * Works on Tron via TronGrid's JSON-RPC bridge (viem's `getBalance` maps to
 * `eth_getBalance`, which the bridge proxies to the TRX balance in SUN).
 * Tron native currency (TRX) uses 6 decimals, not 18 — format accordingly so
 * a 1 TRX balance isn't shown as 1e-12 and falsely flagged as zero.
 */
async function readBalance(
  publicClient: ReturnType<typeof createPublicClient>,
  address: Address,
  networkName: string
): Promise<{ balance: bigint; formatted: string }> {
  const balance = await publicClient.getBalance({ address })
  const decimals = isTronNetworkKey(networkName) ? 6 : 18
  return { balance, formatted: formatUnits(balance, decimals) }
}

/**
 * Run every check for one (network, environment) pair.
 * Returns `null` when the network is inactive or when no diamond is deployed
 * for that environment (silently filtered from the table).
 */
async function checkNetworkEmergencyPause(
  networkName: SupportedChain,
  networkConfig: INetwork,
  environment: Environment
): Promise<IEmergencyPauseStatus | null> {
  if (networkConfig.status !== 'active') return null

  const expected = getExpectedPauserWallet(networkName)
  const result: IEmergencyPauseStatus = {
    network: networkName,
    environment,
    chainId: networkConfig.chainId,
    diamondAddress: null,
    selectors: null,
    hasEmergencyPauseFacet: null,
    pauserWalletOnChain: null,
    pauserWalletExpected: expected,
    pauserWalletMatches: null,
    balance: null,
    formattedBalance: null,
    nativeCurrency: networkConfig.nativeCurrency ?? null,
    balanceError: null,
    pauseStatus: null,
    errors: [],
  }

  let diamondRaw: string | null = null
  try {
    const deployments = await getDeployments(
      networkName,
      environment === 'production'
        ? EnvironmentEnum.production
        : EnvironmentEnum.staging
    )
    diamondRaw = (deployments.LiFiDiamond as string | undefined) ?? null
  } catch {
    // No deployment file for this env on this network — silently skip.
  }
  if (!diamondRaw) return null

  let diamond: Address
  try {
    diamond = normalizeAddressForNetwork(networkName, diamondRaw)
  } catch (error: unknown) {
    result.errors.push(
      `Invalid diamond address: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return result
  }
  result.diamondAddress = diamond

  const rpcEnvVarName = getRPCEnvVarName(networkName)
  const rpcUrl = process.env[rpcEnvVarName] ?? networkConfig.rpcUrl
  if (!rpcUrl) {
    result.errors.push('No RPC URL')
    return result
  }

  // TronGrid serves Tron's native HTTP API at the root; viem talks JSON-RPC
  // through the `/jsonrpc` suffix. getTransportConfigFromRpcUrl also injects
  // the TRONGRID_API_KEY header when present.
  const effectiveRpcUrl =
    isTronNetworkKey(networkName) &&
    !rpcUrl.replace(/\/+$/, '').endsWith('/jsonrpc')
      ? `${rpcUrl.replace(/\/+$/, '')}/jsonrpc`
      : rpcUrl
  const {
    url: transportUrl,
    fetchOptions,
    retryCount,
    retryDelay,
  } = getTransportConfigFromRpcUrl(effectiveRpcUrl)
  const publicClient = createPublicClient({
    chain: getViemChainForNetworkName(networkName),
    transport: http(transportUrl, { fetchOptions, retryCount, retryDelay }),
  })

  // Probe pause state first: when the diamond is paused, the loupe itself is
  // redirected to EmergencyPauseFacet's fallback (DiamondIsPaused), so the
  // selector probe below would return false negatives for all four selectors.
  const pause = await probePauseStatus(publicClient, diamond)
  result.pauseStatus = pause.status
  if (pause.error) result.errors.push(pause.error)

  await sleep()

  if (pause.status === 'PAUSED') {
    // DiamondIsPaused() proves EmergencyPauseFacet was installed at pause time,
    // but the loupe is unreachable so individual selectors can't be re-verified
    // here — a later diamondCut could have removed removeFacet/unpauseDiamond/
    // pauserWallet. Mark facet-installed as true, leave per-selector flags
    // unknown so drift stays visible instead of being papered over.
    result.selectors = {
      pauseDiamond: null,
      removeFacet: null,
      unpauseDiamond: null,
      pauserWallet: null,
    }
    result.hasEmergencyPauseFacet = true
  } else
    try {
      const selectors = await checkSelectorsRegistered(publicClient, diamond)
      result.selectors = selectors
      result.hasEmergencyPauseFacet =
        selectors.pauseDiamond &&
        selectors.removeFacet &&
        selectors.unpauseDiamond &&
        selectors.pauserWallet
    } catch (error: unknown) {
      result.errors.push(
        `Selector check failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      result.hasEmergencyPauseFacet = false
    }

  await sleep()

  // pauserWallet() stays callable while paused (its selector is never redirected),
  // so attempt it whenever EmergencyPauseFacet appears installed — including the
  // PAUSED branch where per-selector flags are intentionally left unknown.
  if (pause.status === 'PAUSED' || result.selectors?.pauserWallet === true)
    try {
      const raw = (await publicClient.readContract({
        address: diamond,
        abi: EMERGENCY_PAUSE_FACET_ABI,
        functionName: 'pauserWallet',
      })) as string
      const onChain = getAddress(raw)
      result.pauserWalletOnChain = onChain
      result.pauserWalletMatches =
        onChain.toLowerCase() === expected.toLowerCase()
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      result.errors.push(`pauserWallet() failed: ${extractConciseError(msg)}`)
    }

  await sleep()

  if (result.pauserWalletOnChain)
    try {
      const { balance, formatted } = await readBalance(
        publicClient,
        result.pauserWalletOnChain,
        networkName
      )
      result.balance = balance
      result.formattedBalance = formatted
    } catch (error: unknown) {
      result.balanceError =
        error instanceof Error ? error.message : String(error)
    }

  return result
}

function printTable(results: IEmergencyPauseStatus[]): void {
  if (results.length === 0) {
    consola.warn('No diamonds found.')
    return
  }

  const networkWidth = Math.max(
    'Network'.length,
    ...results.map((r) => `${r.network} (${r.environment})`.length)
  )
  const addrWidth = 42
  const facetWidth = 'pauseDiamond removeFacet unpauseDiamond pauserWallet'
    .length // selector flags
  const pauserWidth = 54
  const balanceWidth = Math.max(
    'Balance'.length,
    ...results.map((r) => {
      if (!r.formattedBalance || !r.nativeCurrency) return 0
      return `${r.formattedBalance} ${r.nativeCurrency}`.length
    })
  )

  const header =
    `${'Network'.padEnd(networkWidth)} | ${'Chain ID'.padStart(8)}` +
    ` | ${'Diamond Address'.padEnd(addrWidth)}` +
    ` | ${'Selectors (pD rF uD pW)'.padEnd(facetWidth)}` +
    ` | ${'Pauser Wallet'.padEnd(pauserWidth)}` +
    ` | ${'Balance'.padEnd(balanceWidth)}` +
    ` | Status`
  console.log('\nLegend:')
  console.log(
    '  Selectors:  pD=pauseDiamond  rF=removeFacet  uD=unpauseDiamond  pW=pauserWallet'
  )
  console.log(
    '  Pauser Wallet column shows the on-chain address with ✓ (match) / ✗ MISMATCH against config/global.json'
  )
  console.log(
    '  Status: PAUSED ⛔ | NOT PAUSED ✓ | ERROR (owner() revert probe)'
  )
  console.log('')
  console.log(header)
  console.log('-'.repeat(header.length + 4))

  for (const r of results) {
    let statusStr: string
    let color: 'red' | 'green' | 'yellow' | 'reset'
    switch (r.pauseStatus) {
      case 'PAUSED':
        statusStr = 'PAUSED  ⛔'
        color = 'red'
        break
      case 'NOT_PAUSED':
        statusStr = 'NOT PAUSED ✓'
        color = 'green'
        break
      default:
        statusStr = `ERROR${r.errors[0] ? `: ${r.errors[0]}` : ''}`
        color = 'yellow'
    }

    const selectorStr = r.selectors
      ? `${formatBool(r.selectors.pauseDiamond)}  ${formatBool(
          r.selectors.removeFacet
        )}  ${formatBool(r.selectors.unpauseDiamond)}  ${formatBool(
          r.selectors.pauserWallet
        )}`.padEnd(facetWidth)
      : 'N/A'.padEnd(facetWidth)

    let pauserStr: string
    if (r.pauserWalletOnChain) {
      const marker =
        r.pauserWalletMatches === true
          ? ' ✓'
          : r.pauserWalletMatches === false
          ? ' ✗ MISMATCH'
          : ''
      pauserStr = `${r.pauserWalletOnChain}${marker}`.padEnd(pauserWidth)
    } else pauserStr = '—'.padEnd(pauserWidth)

    let balanceStr: string
    if (r.formattedBalance && r.nativeCurrency)
      balanceStr = `${r.formattedBalance} ${r.nativeCurrency}`.padEnd(
        balanceWidth
      )
    else if (r.balanceError) balanceStr = 'Error'.padEnd(balanceWidth)
    else balanceStr = '—'.padEnd(balanceWidth)

    const networkLabel = `${r.network} (${r.environment})`.padEnd(networkWidth)
    const addr = (r.diamondAddress ?? '').padEnd(addrWidth)
    const line =
      `${networkLabel} | ${String(r.chainId).padStart(8)}` +
      ` | ${addr} | ${selectorStr} | ${pauserStr} | ${balanceStr} | ${statusStr}`

    // PAUSED is the headline signal — it must always stay red. For non-PAUSED
    // rows, downgrade to yellow when the facet is incomplete, the pauser
    // mismatches, or the balance is zero; the in-row markers carry specifics.
    const hasZeroBalance =
      r.formattedBalance !== null && parseFloat(r.formattedBalance) === 0
    const needsAttention =
      r.hasEmergencyPauseFacet === false ||
      r.pauserWalletMatches === false ||
      hasZeroBalance ||
      !!r.balanceError
    const lineColor =
      r.pauseStatus !== 'PAUSED' && needsAttention ? 'yellow' : color
    console.log(`${getColorCode(lineColor)}${line}${getColorCode('reset')}`)
  }

  console.log('-'.repeat(header.length + 4))

  const paused = results.filter((r) => r.pauseStatus === 'PAUSED').length
  const notPaused = results.filter((r) => r.pauseStatus === 'NOT_PAUSED').length
  const errors = results.filter((r) => r.pauseStatus === 'ERROR').length
  const facetIncomplete = results.filter(
    (r) => r.hasEmergencyPauseFacet === false
  ).length
  const pauserMismatch = results.filter(
    (r) => r.pauserWalletMatches === false
  ).length
  const zeroBalance = results.filter(
    (r) => r.formattedBalance !== null && parseFloat(r.formattedBalance) === 0
  ).length

  console.log(`\nSummary (${results.length} (network, env) pairs):`)
  if (paused > 0)
    console.log(
      `  ${getColorCode('red')}PAUSED:              ${paused}${getColorCode(
        'reset'
      )}`
    )
  console.log(
    `  ${getColorCode('green')}NOT PAUSED:          ${notPaused}${getColorCode(
      'reset'
    )}`
  )
  if (facetIncomplete > 0)
    console.log(
      `  ${getColorCode(
        'yellow'
      )}FACET INCOMPLETE:    ${facetIncomplete} — one or more EmergencyPauseFacet selectors missing${getColorCode(
        'reset'
      )}`
    )
  if (pauserMismatch > 0)
    console.log(
      `  ${getColorCode(
        'yellow'
      )}PAUSER MISMATCH:     ${pauserMismatch} — on-chain pauserWallet differs from config/global.json${getColorCode(
        'reset'
      )}`
    )
  if (zeroBalance > 0)
    console.log(
      `  ${getColorCode(
        'yellow'
      )}PAUSER ZERO BALANCE: ${zeroBalance} — pauser wallet has no native gas${getColorCode(
        'reset'
      )}`
    )
  if (errors > 0)
    console.log(
      `  ${getColorCode('yellow')}ERRORS:              ${errors}${getColorCode(
        'reset'
      )}`
    )
  console.log('')
}

async function main(): Promise<void> {
  consola.info(
    'Checking emergency-pause infrastructure across all networks (production + staging)...'
  )

  const networks = networksConfig as Record<string, Partial<INetwork>>
  const networkNames = Object.keys(networks).filter(
    (name): name is SupportedChain => name in networks
  )

  const promises: Promise<IEmergencyPauseStatus | null>[] = []
  for (const name of networkNames) {
    const cfg = networks[name]
    if (!cfg) continue
    for (const env of ENVIRONMENTS)
      promises.push(checkNetworkEmergencyPause(name, cfg as INetwork, env))
  }

  const allResults = await Promise.all(promises)
  const results = allResults.filter(
    (r): r is IEmergencyPauseStatus => r !== null
  )

  // Sort: PAUSED (loudest) → ERROR → NOT_PAUSED; within each group network
  // alphabetical, production before staging.
  const statusOrder: Record<PauseStatus, number> = {
    PAUSED: 0,
    ERROR: 1,
    NOT_PAUSED: 2,
  }
  results.sort((a, b) => {
    const sa = statusOrder[a.pauseStatus ?? 'ERROR']
    const sb = statusOrder[b.pauseStatus ?? 'ERROR']
    if (sa !== sb) return sa - sb
    if (a.network !== b.network) return a.network.localeCompare(b.network)
    return a.environment === 'production' ? -1 : 1
  })

  printTable(results)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    consola.error('Fatal error:', err)
    process.exit(1)
  })
