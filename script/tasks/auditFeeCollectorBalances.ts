#!/usr/bin/env bun

/**
 * FeeCollector Balance Audit
 * =========================
 *
 * Scans historic FeeCollector events (FeesCollected, FeesWithdrawn, LiFiFeesWithdrawn) on
 * configured chains; reconciles expected vs actual token balances per chain; and reports
 * affected tokens (where expected !== actual) with optional USD valuation.
 *
 * Chains: By default uses config/auditFeeCollector.json "chains" (or mainnet, base, arbitrum).
 * Use --all-chains to run on every active EVM chain that has FeeCollector in deployments/.
 * Add more chains by editing config "chains" and optional "fromBlockByChain" (deployment block).
 *
 * fromBlock: For each chain, start block is resolved in order: --from-block override >
 * config fromBlockByChain > deployment timestamp (MongoDB or .cache/deployments_production.json)
 * converted to block number via RPC > built-in map > 0. So you can omit fromBlockByChain and
 * rely on deployment logs (set MONGODB_URI for live lookup, or use a pre-populated .cache).
 *
 * Purpose: Identify tokens with accounting discrepancies (e.g. missing balance, fee-on-transfer
 * shortfall) so the backend can disable fee collection for those tokens.
 *
 * ---
 *
 * THREE-STEP FLOW (recommended for large runs)
 * --------------------------------------------
 *
 * Step 1 — Collect events to JSON files (RPC only, no prices):
 *   bun script/tasks/auditFeeCollectorBalances.ts --step collect --events-dir ./audit-events
 *
 * Step 2 — Reconcile: fetch prices + on-chain balances, write reconciliation_<chain>.json:
 *   bun script/tasks/auditFeeCollectorBalances.ts --step reconcile --events-dir ./audit-events
 *
 * Step 3 — Report: read reconciliation files, write report (no RPC/API):
 *   bun script/tasks/auditFeeCollectorBalances.ts --step report --events-dir ./audit-events --output report.json --output-md report.md
 *
 * By default, reconcile only fetches prices for "missing" tokens (expected > actual), so the
 * number of CoinGecko calls matches the tokens that will appear in the default report. Use
 * --include-surplus to price all affected tokens (missing + surplus).
 *
 * Affected counts: "affected" = tokens where expected balance !== actual (missing + surplus).
 * Reconcile logs "X affected: Y missing, Z surplus". Report defaults to --affected-only
 * (missing only); use --include-surplus to include surplus in report. Counts can grow between
 * runs if you re-run --step collect (new toBlock = more events) or use different event files.
 *
 * ---
 *
 * FULL RUN (default: scan events in memory, reconcile, then report in one go)
 * ---------------------------------------------------------------------------
 *
 *   bun script/tasks/auditFeeCollectorBalances.ts
 *   bun script/tasks/auditFeeCollectorBalances.ts --network mainnet
 *   bun script/tasks/auditFeeCollectorBalances.ts --output report.json --output-md report.md
 *
 * ---
 *
 * CLI OPTIONS
 * -----------
 *
 *   --network <name>     Run only one chain (default: chains from config/auditFeeCollector.json, or mainnet/base/arbitrum).
 *   --networks <list>    Comma-separated chains (e.g. arbitrum,polygon). Use with --step collect to re-fetch only those with a different --chunk-size; overrides config.
 *   --all-chains         Use all active EVM chains that have FeeCollector deployed (discovered from deployments/).
 *   --step <name>       collect | reconcile | report | fill-prices-lifi | full (default: full).
 *   --fill-prices-lifi  Same as --step fill-prices-lifi: only fill missing USD from Li.FI (no CoinGecko, no RPC). Use after reconcile when many prices are N/A.
 *   --events-dir <path> Directory for event and reconciliation JSON (default: ./audit-events).
 *   --output <path>     Write JSON report here (e.g. report.json).
 *   --output-md <path>  Write Markdown report here (e.g. report.md).
 *   --output-disallowed <path>  Write token list (grouped by chain) for BE to disallow fee collection. Only tokens with missing funds; format: { "arbitrum": ["0x..."], "base": [...], "mainnet": [...] }.
 *   --from-block <n>    Override fromBlock for event scan (all chains).
 *   --to-block <n>      Override toBlock for event scan (all chains).
 *   --affected-only     Only include tokens where Current balance < Expected (default: true).
 *   --include-surplus   Include surplus tokens in report (together with missing).
 *   --skip-prices       Do not fetch token prices (all Missing USD will be N/A; no CoinGecko calls).
 *   --concurrency <n>   Max networks to process in parallel (collect, reconcile, full run). Default 6.
 *   --chunk-size <n>   Block range per getLogs chunk (collect step). Default 10000; use 2000 if standard tokens show false "missing" (RPC log limit).
 *   RPC: Uses chain default from config; override with ETH_NODE_URI_<NETWORK> (e.g. ETH_NODE_URI_MAINNET).
 *

 * PRICING: Li.FI is the source of truth for token prices (https://docs.li.fi/api-reference/introduction).
 * We fetch prices from Li.FI first (chain + token address); CoinGecko is used only when Li.FI
 * returns no price for a token. Set LIFI_API_KEY for higher rate limits.
 *
 * ENVIRONMENT
 * -----------
 *
 *   LIFI_API_KEY (optional but recommended)
 *     Passed as x-lifi-api-key for Li.FI token API (https://li.quest/v1). Source of truth for
 *     token prices; higher rate limits with key. Register at https://portal.li.fi/
 *
 *   COINGECKO_DEMO_API_KEY or COINGECKO_API_KEY (fallback only)
 *     Used only when Li.FI has no price for a token. Passed as x_cg_demo_api_key. Demo plan:
 *     30 req/min, 1 address per request. Without it, public tier may return 400/429.
 *
 * ---
 *
 * OUTPUT FILES
 * ------------
 *
 *   collect step:   <events-dir>/<chain>_FeesCollected.json
 *                   <events-dir>/<chain>_FeesWithdrawn.json
 *                   <events-dir>/<chain>_LiFiFeesWithdrawn.json
 *
 *   reconcile step: <events-dir>/reconciliation_<chain>.json  (per chain)
 *
 *   report step:    JSON and Markdown reports at --output and --output-md paths.
 *   --output-disallowed:  JSON token list by chain for BE (disallow fee collection for these tokens).
 *
 * The Markdown report includes a column reference at the top (Chain, Token address, Symbol,
 * Collected, Withdrawn, Expected, Current balance, Missing amount, Missing USD).
 *
 * EXTENDING TO MORE CHAINS (main 25 or all)
 * ------------------------------------------
 * 1. config/auditFeeCollector.json: set "chains" to an array of network names (e.g. mainnet, base,
 *    arbitrum, polygon, optimism, ...). Add "fromBlockByChain": { "<chain>": <block> } for each
 *    chain where you know the FeeCollector deployment block (avoids false "missing" from pre-deploy).
 * 2. Or run with --all-chains to audit every active EVM chain that has FeeCollector in deployments/.
 * 3. Prices: Li.FI is source of truth (chain + token); CoinGecko only when Li.FI has no price. No price → N/A.
 *
 * VALIDATION: Standard (no-tax) tokens (ETH, WETH, USDC, USDT, DAI, etc.) do not have transfer
 * fees. If they appear as "missing", the discrepancy is likely due to incomplete event data, not
 * on-chain accounting. Many RPCs limit eth_getLogs to 10,000 logs per request; a chunk of 10k
 * blocks can exceed that, causing truncated results (missed withdrawals → expected too high).
 * Re-run --step collect with --chunk-size 2000 (or smaller) to reduce block range per request and
 * re-reconcile; if the discrepancy disappears, it was incomplete events.
 *
 * IMPORTANT: For each chain, the three event files (FeesCollected, FeesWithdrawn, LiFiFeesWithdrawn)
 * must have the same fromBlock and toBlock. If they come from different runs (e.g. one scan
 * finished, another was interrupted), you get inflated "missing" for standard ERC20s because
 * collected is overcounted vs withdrawals. Reconcile step validates this and skips the chain
 * with an error if ranges differ; re-run --step collect for that chain to fix.
 *
 * Read skew fix: balanceOf (and native getBalance) are queried at the same toBlock as the
 * event scan, not at "latest". Otherwise withdrawals after toBlock would make actual < expected
 * and falsely report "missing" for standard tokens (USDC, ETH, WETH, etc.).
 *
 * If balanceOf fails (e.g. RPC does not support historical block, or token reverts at that block),
 * the script logs a warning and treats balance as 0, which can falsely show "missing". Use an
 * archive-capable RPC (ETH_NODE_URI_<NETWORK>) if you see many such warnings.
 *
 * RPC timeouts: Balance fetches use limited concurrency (BALANCE_FETCH_CONCURRENCY), transport
 * timeout/retry, and per-call retries on timeout so "request took too long" is retried before
 * treating as 0. If many timeouts persist, use a faster or less loaded RPC.
 */

import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { EnvironmentEnum, type SupportedChain } from '../common/types'
import { CachedDeploymentQuerier } from '../deploy/shared/cached-deployment-querier'
import type { IDeploymentRecord } from '../deploy/shared/mongo-log-utils'
import { getDeployments } from '../utils/deploymentHelpers'
import {
  scanEventsInChunks,
  type IEventScannerConfig,
} from '../utils/eventScanner'
import {
  getContractAddressForNetwork,
  getViemChainForNetworkName,
  networks,
} from '../utils/viemScriptHelpers'

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

const AUDIT_CONFIG_PATH = path.resolve(
  process.cwd(),
  'config/auditFeeCollector.json'
)

/** Built-in fromBlock per chain (deployment block). Config can override; missing chains use 0n. */
const BUILTIN_FEE_COLLECTOR_FROM_BLOCK: Record<string, bigint> = {
  mainnet: 23322816n,
  base: 2650157n,
  arbitrum: 18708645n,
}

interface IAuditFeeCollectorConfig {
  chains?: string[]
  fromBlockByChain?: Record<string, number>
}

function loadAuditConfig(): IAuditFeeCollectorConfig {
  try {
    const raw = fs.readFileSync(AUDIT_CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as IAuditFeeCollectorConfig
  } catch {
    return {}
  }
}

/** Resolved fromBlock map: config fromBlockByChain + built-in, then 0n for unknown chains. */
function getFeeCollectorFromBlockByChain(): Record<string, bigint> {
  const config = loadAuditConfig()
  const merged: Record<string, bigint> = { ...BUILTIN_FEE_COLLECTOR_FROM_BLOCK }
  if (config.fromBlockByChain) {
    for (const [chain, block] of Object.entries(config.fromBlockByChain)) {
      merged[chain] = BigInt(block)
    }
  }
  return merged
}

const DEPLOYMENT_CACHE_DIR = path.join(process.cwd(), '.cache')
const DEPLOYMENT_CACHE_PRODUCTION = path.join(
  DEPLOYMENT_CACHE_DIR,
  'deployments_production.json'
)
const MONGO_DEPLOYMENT_CONFIG = {
  databaseName: 'contract-deployments',
  batchSize: 100,
  mongoUri: process.env.MONGODB_URI ?? '',
}

/**
 * Returns the first block number (smallest N) where block.timestamp >= timestampSec.
 * Uses binary search over [0, latestBlock].
 */
async function getBlockNumberAtTimestamp(
  publicClient: PublicClient,
  timestampMs: number
): Promise<bigint> {
  const timestampSec = Math.floor(timestampMs / 1000)
  let low = 0n
  let high = await publicClient.getBlockNumber()
  let result = high
  while (low <= high) {
    const mid = (low + high) / 2n
    const block = await publicClient.getBlock({ blockNumber: mid })
    const blockSec = Number(block.timestamp)
    if (blockSec >= timestampSec) {
      result = mid
      if (mid === 0n) break
      high = mid - 1n
    } else {
      low = mid + 1n
    }
  }
  return result
}

/**
 * Resolves FeeCollector deployment timestamp from MongoDB (via CachedDeploymentQuerier) or
 * from local .cache/deployments_production.json. Returns null if not found or lookup unavailable.
 */
async function getFeeCollectorDeploymentTimestamp(
  networkName: string,
  feeCollectorAddress: string
): Promise<Date | null> {
  const addr = feeCollectorAddress.toLowerCase()
  if (MONGO_DEPLOYMENT_CONFIG.mongoUri) {
    try {
      const querier = new CachedDeploymentQuerier(
        MONGO_DEPLOYMENT_CONFIG,
        'production'
      )
      const record = await querier.findByAddress(
        feeCollectorAddress,
        networkName
      )
      return record?.timestamp ?? null
    } catch (e) {
      consola.debug(
        `[${networkName}] Deployment lookup via MongoDB/cache failed: ${e}`
      )
    }
  }
  if (fs.existsSync(DEPLOYMENT_CACHE_PRODUCTION)) {
    try {
      const raw = fs.readFileSync(DEPLOYMENT_CACHE_PRODUCTION, 'utf-8')
      const records = JSON.parse(raw) as Array<
        Omit<IDeploymentRecord, 'timestamp'> & { timestamp: string }
      >
      const record = records.find(
        (r) => r.address.toLowerCase() === addr && r.network === networkName
      )
      return record ? new Date(record.timestamp) : null
    } catch {
      // ignore
    }
  }
  return null
}

/**
 * Resolves fromBlock for a chain: override > config > deployment (MongoDB/cache + timestamp→block) > built-in > 0n.
 */
async function getFeeCollectorFromBlockForChain(
  networkName: SupportedChain,
  fromBlockOverride: bigint | undefined,
  publicClient: PublicClient
): Promise<bigint> {
  if (fromBlockOverride !== undefined && fromBlockOverride !== null) {
    return fromBlockOverride
  }
  const config = loadAuditConfig()
  if (
    config.fromBlockByChain &&
    config.fromBlockByChain[networkName] !== undefined
  ) {
    return BigInt(config.fromBlockByChain[networkName])
  }
  try {
    const deployments = await getDeployments(
      networkName,
      EnvironmentEnum.production
    )
    const feeCollectorAddress = (deployments as Record<string, unknown>)
      .FeeCollector as string
    if (
      typeof feeCollectorAddress === 'string' &&
      feeCollectorAddress.startsWith('0x')
    ) {
      const deploymentTimestamp = await getFeeCollectorDeploymentTimestamp(
        networkName,
        feeCollectorAddress
      )
      if (deploymentTimestamp) {
        const block = await getBlockNumberAtTimestamp(
          publicClient,
          deploymentTimestamp.getTime()
        )
        consola.debug(
          `[${networkName}] FeeCollector fromBlock ${block} (deployment ${deploymentTimestamp.toISOString()})`
        )
        return block
      }
    }
  } catch (e) {
    consola.debug(
      `[${networkName}] Dynamic fromBlock lookup failed: ${e}, using fallback`
    )
  }
  return getFeeCollectorFromBlockByChain()[networkName] ?? 0n
}

/** All active EVM chains that have FeeCollector deployed (0x address). Excludes e.g. tron. */
async function discoverChainsWithFeeCollector(): Promise<SupportedChain[]> {
  const active = Object.entries(networks)
    .filter(([, n]) => n?.status === 'active')
    .map(([name]) => name as SupportedChain)
  const result: SupportedChain[] = []
  for (const chain of active) {
    try {
      const deployments = await getDeployments(
        chain,
        EnvironmentEnum.production
      )
      const addr = (deployments as Record<string, unknown>).FeeCollector
      if (typeof addr === 'string' && addr.startsWith('0x')) {
        result.push(chain)
      }
    } catch {
      // No deployment file or no FeeCollector
    }
  }
  return result.sort((a, b) => a.localeCompare(b))
}

const DEFAULT_CHUNK_SIZE = 10_000n

/** Symbols for tokens that do not have transfer tax (fee-on-transfer). If these show as "missing", consider incomplete event fetch (RPC log limit). */
const KNOWN_NO_TAX_SYMBOLS = new Set([
  'ETH',
  'WETH',
  'USDC',
  'USDT',
  'DAI',
  'BUSD',
  'TUSD',
  'FRAX',
  'PYUSD',
])

/** True if token is a known no-tax (no fee-on-transfer) token; excluded from summary USD totals. */
function isKnownNoTaxToken(t: IAffectedToken): boolean {
  return KNOWN_NO_TAX_SYMBOLS.has(t.symbol.trim().toUpperCase())
}

/** Default number of networks to process in parallel (collect, reconcile, full run). */
const DEFAULT_NETWORK_CONCURRENCY = 10

/** Max concurrent balanceOf calls per chain to avoid RPC timeouts. */
const BALANCE_FETCH_CONCURRENCY = 50
/** Timeout for each eth_call (balanceOf). */
const BALANCE_FETCH_TIMEOUT_MS = 30_000
/** Retries for getActualBalance on timeout. */
const BALANCE_FETCH_RETRIES = 2
const BALANCE_FETCH_RETRY_DELAY_MS = 1500

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

/** CoinGecko asset platform IDs for /simple/token_price/{platform}. Wrong platform returns wrong or empty prices (e.g. "optimism" → use "optimistic-ethereum"). Missing chains fall back to network name. */
const COINGECKO_PLATFORM_BY_CHAIN_ID: Record<number, string> = {
  1: 'ethereum',
  10: 'optimistic-ethereum',
  25: 'cronos',
  56: 'binance-smart-chain',
  100: 'xdai',
  137: 'polygon-pos',
  204: 'opbnb',
  252: 'fraxtal',
  288: 'boba',
  324: 'zksync',
  747: 'flow-evm',
  988: 'stable',
  1088: 'metis-andromeda',
  1284: 'moonbeam',
  1625: 'gravity-alpha',
  167000: 'taiko',
  2741: 'abstract',
  33139: 'apechain',
  3637: 'botanix',
  34443: 'mode',
  42220: 'celo',
  43114: 'avalanche',
  534352: 'scroll',
  59144: 'linea',
  80094: 'berachain',
  81457: 'blast',
  8453: 'base',
  42161: 'arbitrum-one',
}

type DiscrepancyType = 'missing' | 'surplus'

interface IAffectedToken {
  chainId: number
  chainName: string
  tokenAddress: Address
  symbol: string
  decimals: number
  /** Total collected (sum of FeesCollected), raw wei. */
  totalFeesCollected: string
  /** Total withdrawn (sum of FeesWithdrawn + LiFiFeesWithdrawn), raw wei. */
  totalFeesWithdrawn: string
  expectedBalance: string
  actualBalance: string
  /** Amount missing (expected > actual) or surplus (actual > expected); see discrepancyType. */
  missingAmount: string
  missingUsd: number | null
  discrepancyType: DiscrepancyType
  /** Set when balanceOf(token).call reverted; actualBalance is then treated as 0. */
  note?: string
}

interface IAuditSummary {
  totalMissingUsd: number
  byChain: Record<
    string,
    {
      affectedCount: number
      totalAffected: number
      missingUsd: number
      tokensScanned: number
      /** USD value of current balance still in FeeCollector for missing tokens (value at risk). Priced tokens only. */
      remainingBalanceUsd: number
    }
  >
}

interface IReport {
  summary: IAuditSummary
  affectedTokens: IAffectedToken[]
  generatedAt: string
}

/** Token list grouped by chain for BE to disallow fee collection (only tokens with missing funds). */
interface IDisallowedTokenList {
  generatedAt: string
  description: string
  tokensByChain: Record<string, string[]>
}

/** Persisted result of reconcile step (one file per chain). */
interface IReconciliationFile {
  chainName: string
  affected: IAffectedToken[]
  tokensScanned: number
}

const DEFAULT_AUDIT_CHAINS: SupportedChain[] = ['mainnet', 'base', 'arbitrum']

function getConfigAuditChains(): SupportedChain[] {
  const config = loadAuditConfig()
  if (config.chains && config.chains.length > 0) {
    return config.chains.filter((c) => networks[c]) as SupportedChain[]
  }
  return DEFAULT_AUDIT_CHAINS
}

/** Cap per-token missing USD; above this we set N/A to avoid one bad price/decimals blowing up the total. */
const MAX_PER_TOKEN_MISSING_USD = 1_000_000
/** If implied price (missingUsd / human amount) exceeds this USD per token, treat as bad data and set missingUsd to null (e.g. wrong CoinGecko platform). */
const SANITY_MAX_PRICE_PER_TOKEN_USD = 500_000

/** CoinGecko Demo: 1 contract address per request (avoids 400). */
const COINGECKO_CHUNK_SIZE = 1
/** CoinGecko Demo: 30 req/min → 2s between requests. */
const COINGECKO_DELAY_MS = 2000
/** Wait before retry when rate limited (429). */
const COINGECKO_429_RETRY_DELAY_MS = 65_000

const LIFIQ_BASE_URL = 'https://li.quest'
/** Delay between Li.FI token requests to avoid rate limits. */
const LIFI_TOKEN_DELAY_MS = 150

function chunkArray<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
    array.slice(i * size, i * size + size)
  )
}

/** Run async tasks with a concurrency limit (chunks of `limit`). Preserves order. */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit)
    const chunkResults = await Promise.all(chunk.map(fn))
    results.push(...chunkResults)
  }
  return results
}

/** CoinGecko token price by platform + contract address. Used only when Li.FI has no price for a token (fallback). */
async function getTokenPricesMap(
  platform: string,
  tokenAddresses: string[]
): Promise<Record<string, number>> {
  const prices: Record<string, number> = {}
  const valid = tokenAddresses.filter((a) => a !== NULL_ADDRESS && a.length > 0)
  if (valid.length === 0) return prices
  const apiKey =
    process.env.COINGECKO_DEMO_API_KEY ?? process.env.COINGECKO_API_KEY ?? ''
  if (!apiKey) {
    consola.warn(
      '[CoinGecko] No COINGECKO_DEMO_API_KEY or COINGECKO_API_KEY set. Public tier may return 400/429; Missing USD will be N/A for many tokens. Set an API key for reliable prices.'
    )
  }
  const chunks = chunkArray(valid, COINGECKO_CHUNK_SIZE)
  for (const [ci, chunk] of chunks.entries()) {
    const addresses = chunk.map((a) => a.toLowerCase()).join(',')
    const baseUrl = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${addresses}&vs_currencies=usd`
    const url = apiKey ? `${baseUrl}&x_cg_demo_api_key=${apiKey}` : baseUrl
    let res = await fetch(url)
    if (res.status === 429) {
      consola.warn(
        `[CoinGecko] Rate limited (429). Waiting ${
          COINGECKO_429_RETRY_DELAY_MS / 1000
        }s before retry...`
      )
      await new Promise((r) => setTimeout(r, COINGECKO_429_RETRY_DELAY_MS))
      res = await fetch(url)
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200)
      consola.warn(
        `[CoinGecko] ${res.status} ${res.statusText} for chunk ${ci + 1}/${
          chunks.length
        }: ${text}`
      )
    } else {
      try {
        const data = (await res.json()) as Record<string, { usd?: number }>
        for (const [addr, priceData] of Object.entries(data)) {
          if (typeof priceData?.usd === 'number') {
            prices[addr.toLowerCase()] = priceData.usd
          }
        }
      } catch (e) {
        consola.warn(`[CoinGecko] Parse error for chunk ${ci + 1}: ${e}`)
      }
    }
    await new Promise((r) => setTimeout(r, COINGECKO_DELAY_MS))
  }
  const found = Object.keys(prices).length
  if (valid.length > 0 && found < valid.length) {
    consola.info(
      `[CoinGecko] Got prices for ${found}/${valid.length} token(s). Missing USD will be N/A for tokens not listed on CoinGecko or when the API did not return a price.`
    )
  }
  return prices
}

/** Li.FI token API (https://li.quest/v1, see https://docs.li.fi/api-reference/introduction). Source of truth for token prices; returns priceUSD per chain + token. */
async function getTokenPricesFromLifi(
  chainId: number,
  tokenAddresses: string[]
): Promise<Record<string, number>> {
  const prices: Record<string, number> = {}
  const valid = tokenAddresses.filter((a) => a && a.length > 0)
  if (valid.length === 0) return prices
  const apiKey = process.env.LIFI_API_KEY ?? ''
  for (const addr of valid) {
    try {
      const url = `${LIFIQ_BASE_URL}/v1/token?chain=${chainId}&token=${encodeURIComponent(
        addr
      )}`
      const headers: Record<string, string> = {}
      if (apiKey) headers['x-lifi-api-key'] = apiKey
      const res = await fetch(url, { headers })
      if (!res.ok) continue
      const data = (await res.json()) as
        | Array<{ priceUSD?: string }>
        | { priceUSD?: string }
      const token = Array.isArray(data) ? data[0] : data
      const priceStr = token?.priceUSD
      if (priceStr !== undefined && priceStr !== null && priceStr !== '') {
        const p = parseFloat(priceStr)
        if (Number.isFinite(p) && p >= 0) {
          prices[addr.toLowerCase()] = p
        }
      }
    } catch (e) {
      consola.debug(
        `[Li.FI] Token ${addr}: ${e instanceof Error ? e.message : e}`
      )
    }
    await new Promise((r) => setTimeout(r, LIFI_TOKEN_DELAY_MS))
  }
  return prices
}

async function getTokenMetadata(
  publicClient: PublicClient,
  token: Address,
  chainName: string
): Promise<{ symbol: string; decimals: number }> {
  if (token === NULL_ADDRESS) {
    const net = networks[chainName]
    return {
      symbol: net?.nativeCurrency ?? 'ETH',
      decimals: 18,
    }
  }
  try {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }),
      publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
    ])
    return { symbol: symbol as string, decimals: Number(decimals) }
  } catch {
    return { symbol: 'UNKNOWN', decimals: 18 }
  }
}

function isRetryableBalanceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err).toLowerCase()
  const s = msg.toLowerCase()
  return (
    s.includes('timeout') ||
    s.includes('too long') ||
    s.includes('timed out') ||
    s.includes('econnreset') ||
    s.includes('econnrefused')
  )
}

/** Result of balance fetch: balance (0n on failure) and whether the contract reverted. */
interface IBalanceResult {
  balance: bigint
  reverted: boolean
}

/** Pinned to blockNumber to avoid read skew: expected is from events up to toBlock, actual must be at same block. */
async function getActualBalance(
  publicClient: PublicClient,
  feeCollectorAddress: Address,
  token: Address,
  blockNumber: bigint,
  context?: { networkName: string; symbol?: string }
): Promise<IBalanceResult> {
  if (token === NULL_ADDRESS) {
    const balance = await publicClient.getBalance({
      address: feeCollectorAddress,
      blockNumber,
    })
    return { balance, reverted: false }
  }
  const label = context?.symbol ? `${context.symbol} (${token})` : token
  const networkLabel = context?.networkName ?? '?'
  let lastErr: unknown
  for (let attempt = 0; attempt <= BALANCE_FETCH_RETRIES; attempt++) {
    try {
      const balance = await publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [feeCollectorAddress],
        blockNumber,
      })
      return { balance, reverted: false }
    } catch (err) {
      lastErr = err
      if (attempt < BALANCE_FETCH_RETRIES && isRetryableBalanceError(err)) {
        await new Promise((r) => setTimeout(r, BALANCE_FETCH_RETRY_DELAY_MS))
        continue
      }
      break
    }
  }
  const msg =
    lastErr instanceof Error ? (lastErr as Error).message : String(lastErr)
  const reverted = /revert/i.test(msg)
  consola.warn(
    `[${networkLabel}] balanceOf failed for ${label} at block ${blockNumber}, treating as 0: ${msg}`
  )
  return { balance: 0n, reverted }
}

function formatHumanAmount(wei: bigint, decimals: number): string {
  const divisor = 10 ** decimals
  const intPart = wei / BigInt(divisor)
  const fracPart = wei % BigInt(divisor)
  const fracStr = fracPart.toString().padStart(decimals, '0').slice(0, decimals)
  return fracStr ? `${intPart}.${fracStr}` : `${intPart}`
}

/** Escape pipe and newlines so cell content does not break the table. */
function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '&#124;').replace(/\r?\n/g, ' ')
}

/** Price per token in USD implied by missingUsd and missingAmount; null if not available. */
function getPricePerTokenUsd(t: IAffectedToken): number | null {
  if (t.missingUsd === null) return null
  const amt = BigInt(t.missingAmount)
  if (amt === 0n) return null
  const decimals = t.decimals > 0 ? t.decimals : 18
  const human = Number(amt) / 10 ** decimals
  if (!Number.isFinite(human) || human <= 0) return null
  const price = t.missingUsd / human
  return Number.isFinite(price) && price >= 0 ? price : null
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s
}

async function runAuditForChain(
  networkName: SupportedChain,
  fromBlockOverride: bigint | undefined,
  toBlockOverride: bigint | undefined,
  options?: { skipPrices?: boolean; chunkSize?: bigint }
): Promise<{
  affected: IAffectedToken[]
  tokensScanned: number
  chainId: number
}> {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE
  const feeCollectorAddress = getAddress(
    await getContractAddressForNetwork(
      'FeeCollector',
      networkName,
      EnvironmentEnum.production
    )
  ) as Address
  const chain = getViemChainForNetworkName(networkName)
  const parsedRpcUrl = chain.rpcUrls.default.http[0]
  const publicClient = createPublicClient({
    chain,
    transport: http(parsedRpcUrl),
  })

  const fromBlock = await getFeeCollectorFromBlockForChain(
    networkName,
    fromBlockOverride,
    publicClient
  )
  const toBlock = toBlockOverride ?? (await publicClient.getBlockNumber())

  consola.info(
    `[${networkName}] FeeCollector ${feeCollectorAddress}, blocks ${fromBlock}-${toBlock} (chunk ${chunkSize})`
  )

  const eventDefs = getEventDefinitions()
  const configBase: Omit<
    IEventScannerConfig,
    'event' | 'fromBlock' | 'toBlock'
  > = {
    publicClient,
    address: feeCollectorAddress,
    networkName,
    chunkSize,
  }

  const [collectedResult, withdrawnResult, lifiWithdrawnResult] =
    await Promise.all([
      scanEventsInChunks({
        ...configBase,
        event: eventDefs.FeesCollected,
        fromBlock,
        toBlock,
      }),
      scanEventsInChunks({
        ...configBase,
        event: eventDefs.FeesWithdrawn,
        fromBlock,
        toBlock,
      }),
      scanEventsInChunks({
        ...configBase,
        event: eventDefs.LiFiFeesWithdrawn,
        fromBlock,
        toBlock,
      }),
    ])

  interface IFeesCollectedArgs {
    _token: Address
    _integrator: Address
    _integratorFee: bigint
    _lifiFee: bigint
  }
  interface IWithdrawnArgs {
    _token: Address
    _to: Address
    _amount: bigint
  }

  const totalFeesCollected: Record<string, bigint> = {}
  const totalFeesWithdrawn: Record<string, bigint> = {}

  for (const log of collectedResult.events as Array<{
    args: IFeesCollectedArgs
  }>) {
    const token = getAddress(log.args._token)
    const sum = log.args._integratorFee + log.args._lifiFee
    totalFeesCollected[token] = (totalFeesCollected[token] ?? 0n) + sum
  }
  for (const log of withdrawnResult.events as Array<{ args: IWithdrawnArgs }>) {
    const token = getAddress(log.args._token)
    totalFeesWithdrawn[token] =
      (totalFeesWithdrawn[token] ?? 0n) + log.args._amount
  }
  for (const log of lifiWithdrawnResult.events as Array<{
    args: IWithdrawnArgs
  }>) {
    const token = getAddress(log.args._token)
    totalFeesWithdrawn[token] =
      (totalFeesWithdrawn[token] ?? 0n) + log.args._amount
  }

  const { affected, tokensScanned } = await runReconcileForChain(
    networkName,
    totalFeesCollected,
    totalFeesWithdrawn,
    { skipPrices: options?.skipPrices, toBlock }
  )
  return { affected, tokensScanned, chainId: chain.id }
}

/** Serialized event args (bigint as string) for JSON event files. */
interface ISerializedFeesCollectedArgs {
  _token: string
  _integrator: string
  _integratorFee: string
  _lifiFee: string
}

interface ISerializedWithdrawnArgs {
  _token: string
  _to: string
  _amount: string
}

interface IEventFileEvent {
  blockNumber: string
  transactionHash: string
  args: ISerializedFeesCollectedArgs | ISerializedWithdrawnArgs
}

interface IEventFile {
  chainName: string
  chainId: number
  eventName: string
  fromBlock: string
  toBlock: string
  feeCollectorAddress: string
  scannedAt: string
  events: IEventFileEvent[]
}

const EVENT_NAMES = [
  'FeesCollected',
  'FeesWithdrawn',
  'LiFiFeesWithdrawn',
] as const

function getEventDefinitions(): Record<
  (typeof EVENT_NAMES)[number],
  IEventScannerConfig['event']
> {
  return {
    FeesCollected: {
      type: 'event',
      name: 'FeesCollected',
      inputs: [
        { name: '_token', type: 'address', indexed: true },
        { name: '_integrator', type: 'address', indexed: true },
        { name: '_integratorFee', type: 'uint256' },
        { name: '_lifiFee', type: 'uint256' },
      ],
    },
    FeesWithdrawn: {
      type: 'event',
      name: 'FeesWithdrawn',
      inputs: [
        { name: '_token', type: 'address', indexed: true },
        { name: '_to', type: 'address', indexed: true },
        { name: '_amount', type: 'uint256' },
      ],
    },
    LiFiFeesWithdrawn: {
      type: 'event',
      name: 'LiFiFeesWithdrawn',
      inputs: [
        { name: '_token', type: 'address', indexed: true },
        { name: '_to', type: 'address', indexed: true },
        { name: '_amount', type: 'uint256' },
      ],
    },
  }
}

function aggregateEvents(
  collected: IEventFileEvent[],
  withdrawn: IEventFileEvent[],
  lifiWithdrawn: IEventFileEvent[]
): {
  totalFeesCollected: Record<string, bigint>
  totalFeesWithdrawn: Record<string, bigint>
} {
  const totalFeesCollected: Record<string, bigint> = {}
  const totalFeesWithdrawn: Record<string, bigint> = {}
  for (const ev of collected) {
    const a = ev.args as ISerializedFeesCollectedArgs
    const token = getAddress(a._token as Address)
    const sum = BigInt(a._integratorFee) + BigInt(a._lifiFee)
    totalFeesCollected[token] = (totalFeesCollected[token] ?? 0n) + sum
  }
  for (const ev of withdrawn) {
    const a = ev.args as ISerializedWithdrawnArgs
    const token = getAddress(a._token as Address)
    totalFeesWithdrawn[token] =
      (totalFeesWithdrawn[token] ?? 0n) + BigInt(a._amount)
  }
  for (const ev of lifiWithdrawn) {
    const a = ev.args as ISerializedWithdrawnArgs
    const token = getAddress(a._token as Address)
    totalFeesWithdrawn[token] =
      (totalFeesWithdrawn[token] ?? 0n) + BigInt(a._amount)
  }
  return { totalFeesCollected, totalFeesWithdrawn }
}

async function collectOneChain(
  networkName: SupportedChain,
  eventsDir: string,
  fromBlockOverride: bigint | undefined,
  toBlockOverride: bigint | undefined,
  eventDefs: ReturnType<typeof getEventDefinitions>,
  chunkSize: bigint
): Promise<void> {
  const feeCollectorAddress = getAddress(
    await getContractAddressForNetwork(
      'FeeCollector',
      networkName,
      EnvironmentEnum.production
    )
  ) as Address
  const chain = getViemChainForNetworkName(networkName)
  const parsedRpcUrl = chain.rpcUrls.default.http[0]
  const publicClient = createPublicClient({
    chain,
    transport: http(parsedRpcUrl),
  })
  const fromBlock = await getFeeCollectorFromBlockForChain(
    networkName,
    fromBlockOverride,
    publicClient
  )
  const toBlock = toBlockOverride ?? (await publicClient.getBlockNumber())
  consola.info(
    `[${networkName}] Collecting events, blocks ${fromBlock}-${toBlock} (chunk size ${chunkSize})`
  )
  const configBase: Omit<
    IEventScannerConfig,
    'event' | 'fromBlock' | 'toBlock'
  > = {
    publicClient,
    address: feeCollectorAddress,
    networkName,
    chunkSize,
  }
  const [collectedResult, withdrawnResult, lifiWithdrawnResult] =
    await Promise.all([
      scanEventsInChunks({
        ...configBase,
        event: eventDefs.FeesCollected,
        fromBlock,
        toBlock,
      }),
      scanEventsInChunks({
        ...configBase,
        event: eventDefs.FeesWithdrawn,
        fromBlock,
        toBlock,
      }),
      scanEventsInChunks({
        ...configBase,
        event: eventDefs.LiFiFeesWithdrawn,
        fromBlock,
        toBlock,
      }),
    ])
  const toEventFileEventCollected = (log: {
    blockNumber: bigint
    transactionHash: string
    args: {
      _token: string
      _integrator: string
      _integratorFee: bigint
      _lifiFee: bigint
    }
  }): IEventFileEvent => ({
    blockNumber: String(log.blockNumber),
    transactionHash: log.transactionHash,
    args: {
      _token: log.args._token,
      _integrator: log.args._integrator,
      _integratorFee: String(log.args._integratorFee),
      _lifiFee: String(log.args._lifiFee),
    },
  })
  const toEventFileEventWithdrawn = (log: {
    blockNumber: bigint
    transactionHash: string
    args: { _token: string; _to: string; _amount: bigint }
  }): IEventFileEvent => ({
    blockNumber: String(log.blockNumber),
    transactionHash: log.transactionHash,
    args: {
      _token: log.args._token,
      _to: log.args._to,
      _amount: String(log.args._amount),
    },
  })
  const meta = {
    chainName: networkName,
    chainId: chain.id,
    fromBlock: String(fromBlock),
    toBlock: String(toBlock),
    feeCollectorAddress,
    scannedAt: new Date().toISOString(),
  }
  const collectedFile: IEventFile = {
    ...meta,
    eventName: 'FeesCollected',
    events: (
      collectedResult.events as Array<{
        blockNumber: bigint
        transactionHash: string
        args: {
          _token: string
          _integrator: string
          _integratorFee: bigint
          _lifiFee: bigint
        }
      }>
    ).map(toEventFileEventCollected),
  }
  const withdrawnFile: IEventFile = {
    ...meta,
    eventName: 'FeesWithdrawn',
    events: (
      withdrawnResult.events as Array<{
        blockNumber: bigint
        transactionHash: string
        args: { _token: string; _to: string; _amount: bigint }
      }>
    ).map(toEventFileEventWithdrawn),
  }
  const lifiWithdrawnFile: IEventFile = {
    ...meta,
    eventName: 'LiFiFeesWithdrawn',
    events: (
      lifiWithdrawnResult.events as Array<{
        blockNumber: bigint
        transactionHash: string
        args: { _token: string; _to: string; _amount: bigint }
      }>
    ).map(toEventFileEventWithdrawn),
  }
  fs.writeFileSync(
    path.join(eventsDir, `${networkName}_FeesCollected.json`),
    JSON.stringify(collectedFile, null, 2),
    'utf-8'
  )
  fs.writeFileSync(
    path.join(eventsDir, `${networkName}_FeesWithdrawn.json`),
    JSON.stringify(withdrawnFile, null, 2),
    'utf-8'
  )
  fs.writeFileSync(
    path.join(eventsDir, `${networkName}_LiFiFeesWithdrawn.json`),
    JSON.stringify(lifiWithdrawnFile, null, 2),
    'utf-8'
  )
  consola.success(
    `[${networkName}] Wrote 3 event files (${collectedResult.events.length} + ${withdrawnResult.events.length} + ${lifiWithdrawnResult.events.length} events)`
  )
}

async function runStepCollect(
  chains: SupportedChain[],
  fromBlockOverride: bigint | undefined,
  toBlockOverride: bigint | undefined,
  eventsDir: string,
  concurrency: number,
  chunkSize: bigint
): Promise<void> {
  if (!fs.existsSync(eventsDir)) {
    fs.mkdirSync(eventsDir, { recursive: true })
  }
  const eventDefs = getEventDefinitions()
  consola.info(
    `Collecting events for ${chains.length} chain(s) with concurrency ${concurrency}, chunk size ${chunkSize} blocks`
  )
  await runWithConcurrency(chains, concurrency, (networkName) =>
    collectOneChain(
      networkName,
      eventsDir,
      fromBlockOverride,
      toBlockOverride,
      eventDefs,
      chunkSize
    )
  )
}

async function runReconcileForChain(
  networkName: SupportedChain,
  totalFeesCollected: Record<string, bigint>,
  totalFeesWithdrawn: Record<string, bigint>,
  options: {
    priceOnlyMissing?: boolean
    skipPrices?: boolean
    /** Pin balanceOf to this block to avoid read skew (expected from events up to toBlock, actual at same block). */
    toBlock: bigint
  }
): Promise<{ affected: IAffectedToken[]; tokensScanned: number }> {
  const priceOnlyMissing = options.priceOnlyMissing === true
  const skipPrices = options.skipPrices === true
  const toBlock = options.toBlock
  const feeCollectorAddress = getAddress(
    await getContractAddressForNetwork(
      'FeeCollector',
      networkName,
      EnvironmentEnum.production
    )
  ) as Address
  const chain = getViemChainForNetworkName(networkName)
  const parsedRpcUrl = chain.rpcUrls.default.http[0]
  const publicClient = createPublicClient({
    chain,
    transport: http(parsedRpcUrl, {
      timeout: BALANCE_FETCH_TIMEOUT_MS,
      retryCount: 3,
      retryDelay: 1000,
    }),
  })
  const allTokensArr = Array.from(
    new Set([
      ...Object.keys(totalFeesCollected).map((k) => getAddress(k as Address)),
      ...Object.keys(totalFeesWithdrawn).map((k) => getAddress(k as Address)),
    ])
  ) as Address[]
  consola.info(
    `[${networkName}] Reconciling balances for ${allTokensArr.length} tokens at block ${toBlock} (concurrency ${BALANCE_FETCH_CONCURRENCY})...`
  )
  const balanceResults: IBalanceResult[] = []
  for (let i = 0; i < allTokensArr.length; i += BALANCE_FETCH_CONCURRENCY) {
    const chunk = allTokensArr.slice(i, i + BALANCE_FETCH_CONCURRENCY)
    const chunkResults = await Promise.all(
      chunk.map((token) =>
        getActualBalance(publicClient, feeCollectorAddress, token, toBlock, {
          networkName,
        })
      )
    )
    balanceResults.push(...chunkResults)
  }
  const tokenToActual = new Map<string, bigint>()
  const tokenReverted = new Set<string>()
  allTokensArr.forEach((t, i) => {
    const res = balanceResults[i]
    const addr = getAddress(t)
    tokenToActual.set(addr, res?.balance ?? 0n)
    if (res?.reverted) tokenReverted.add(addr)
  })
  const affectedTokensList: Address[] = []
  const discrepancyAmounts = new Map<
    string,
    { expected: bigint; actual: bigint }
  >()
  for (const tokenStr of allTokensArr) {
    const tokenAddr = getAddress(tokenStr)
    const collected = totalFeesCollected[tokenStr] ?? 0n
    const withdrawn = totalFeesWithdrawn[tokenStr] ?? 0n
    const expectedBalance = collected - withdrawn
    const actualBalance = tokenToActual.get(tokenAddr) ?? 0n
    if (actualBalance !== expectedBalance) {
      affectedTokensList.push(tokenAddr as Address)
      discrepancyAmounts.set(tokenAddr, {
        expected: expectedBalance,
        actual: actualBalance,
      })
    }
  }
  const platform = COINGECKO_PLATFORM_BY_CHAIN_ID[chain.id] ?? networkName
  const wrappedNative = networks[networkName]?.wrappedNativeAddress ?? ''
  const tokensToPrice = priceOnlyMissing
    ? affectedTokensList.filter((t) => {
        const key = getAddress(t)
        const entry = discrepancyAmounts.get(key)
        return entry ? entry.expected > entry.actual : false
      })
    : affectedTokensList
  const priceAddressesForAffected = [
    ...new Set(
      tokensToPrice.map((t) =>
        t === NULL_ADDRESS ? wrappedNative : getAddress(t)
      )
    ),
  ].filter(Boolean)
  const priceMap: Record<string, number> = {}
  let nativePrice: number | null = null
  if (!skipPrices) {
    consola.info(
      `[${networkName}] Fetching prices for ${
        priceAddressesForAffected.length
      } token(s) (${priceOnlyMissing ? 'missing only' : 'all affected'})...`
    )
    // Li.FI is source of truth (chain + token); CoinGecko only for tokens without a Li.FI price
    const lifiPrices = await getTokenPricesFromLifi(
      chain.id,
      priceAddressesForAffected
    )
    for (const [addr, p] of Object.entries(lifiPrices)) {
      priceMap[addr] = p
    }
    const missingForCg = priceAddressesForAffected.filter(
      (addr) => addr && !(addr.toLowerCase() in priceMap)
    )
    if (missingForCg.length > 0) {
      consola.info(
        `[${networkName}] Li.FI had no price for ${missingForCg.length} token(s); fetching from CoinGecko fallback...`
      )
      const cgPrices = await getTokenPricesMap(platform, missingForCg)
      for (const [addr, p] of Object.entries(cgPrices)) {
        priceMap[addr.toLowerCase()] = p
      }
    }
    nativePrice = wrappedNative
      ? priceMap[wrappedNative.toLowerCase()] ?? null
      : null
    const withUsd = affectedTokensList.filter((t) => {
      const key = getAddress(t)
      const price =
        t === NULL_ADDRESS ? nativePrice : priceMap[key.toLowerCase()] ?? null
      return price !== null
    }).length
    consola.info(
      `[${networkName}] Prices available for ${withUsd}/${affectedTokensList.length} affected token(s); Missing USD will be N/A for the rest.`
    )
  } else {
    consola.info(
      `[${networkName}] Skipping price fetch (--skip-prices). All Missing USD will be N/A. Re-run reconcile without --skip-prices to populate USD.`
    )
  }
  const metadataList = await Promise.all(
    affectedTokensList.map((token) =>
      getTokenMetadata(publicClient, token, networkName)
    )
  )
  const affected: IAffectedToken[] = []
  for (let i = 0; i < affectedTokensList.length; i++) {
    const token = affectedTokensList.at(i)
    const tokenKey = token ? getAddress(token) : ''
    const entry = tokenKey ? discrepancyAmounts.get(tokenKey) : undefined
    const meta = metadataList.at(i)
    if (!token || !entry || !meta) continue
    const { expected: expectedBalance, actual: actualBalance } = entry
    const collected = totalFeesCollected[tokenKey] ?? 0n
    const withdrawn = totalFeesWithdrawn[tokenKey] ?? 0n
    const isMissing = expectedBalance > actualBalance
    const discrepancyType: DiscrepancyType = isMissing ? 'missing' : 'surplus'
    const amount = isMissing
      ? expectedBalance - actualBalance
      : actualBalance - expectedBalance
    const priceUsd =
      token === NULL_ADDRESS
        ? nativePrice
        : priceMap[token.toLowerCase()] ?? null
    const effectiveDecimals = meta.decimals > 0 ? meta.decimals : 18
    // USD = (raw amount / 10^decimals) * pricePerTokenUsd; Li.FI and CoinGecko both return price per 1 token in USD
    const humanAmount = Number(amount) / 10 ** effectiveDecimals
    let missingUsd: number | null =
      priceUsd !== null && amount > 0n ? humanAmount * priceUsd : null
    if (
      missingUsd !== null &&
      (missingUsd > MAX_PER_TOKEN_MISSING_USD || !Number.isFinite(missingUsd))
    ) {
      missingUsd = null
    }
    if (
      missingUsd !== null &&
      humanAmount > 0 &&
      priceUsd !== null &&
      priceUsd > SANITY_MAX_PRICE_PER_TOKEN_USD
    ) {
      missingUsd = null
    }
    const note = tokenReverted.has(tokenKey) ? 'balanceOf reverted' : undefined
    affected.push({
      chainId: chain.id,
      chainName: networkName,
      tokenAddress: token,
      symbol: meta.symbol,
      decimals: meta.decimals,
      totalFeesCollected: collected.toString(),
      totalFeesWithdrawn: withdrawn.toString(),
      expectedBalance: expectedBalance.toString(),
      actualBalance: actualBalance.toString(),
      missingAmount: amount.toString(),
      missingUsd,
      discrepancyType,
      ...(note ? { note } : {}),
    })
  }
  return { affected, tokensScanned: allTokensArr.length }
}

/** Reconcile step: read event files, fetch prices + balances per chain, write reconciliation_*.json. */
async function runStepReconcile(
  eventsDir: string,
  options?: {
    priceOnlyMissing?: boolean
    skipPrices?: boolean
    concurrency?: number
  }
): Promise<void> {
  const priceOnlyMissing = options?.priceOnlyMissing !== false
  const skipPrices = options?.skipPrices === true
  const concurrency = options?.concurrency ?? DEFAULT_NETWORK_CONCURRENCY
  if (!fs.existsSync(eventsDir)) {
    consola.error(`Events dir not found: ${eventsDir}`)
    return
  }
  const files = fs.readdirSync(eventsDir)
  const collectedFiles = files.filter((f) => f.endsWith('_FeesCollected.json'))
  const chainsFromFiles = collectedFiles.map((f) =>
    f.replace(/_FeesCollected\.json$/, '')
  ) as SupportedChain[]
  if (chainsFromFiles.length === 0) {
    consola.error(`No *_FeesCollected.json files in ${eventsDir}`)
    return
  }
  const chainsToProcess = chainsFromFiles.filter((chainName) => {
    const withdrawnPath = path.join(
      eventsDir,
      `${chainName}_FeesWithdrawn.json`
    )
    const lifiPath = path.join(eventsDir, `${chainName}_LiFiFeesWithdrawn.json`)
    return fs.existsSync(withdrawnPath) && fs.existsSync(lifiPath)
  })
  for (const chainName of chainsFromFiles) {
    if (!chainsToProcess.includes(chainName)) {
      consola.warn(
        `Skipping ${chainName}: missing one of FeesWithdrawn or LiFiFeesWithdrawn file`
      )
    }
  }
  consola.info(
    `Reconciling ${chainsToProcess.length} chain(s) with concurrency ${concurrency}`
  )
  await runWithConcurrency(chainsToProcess, concurrency, async (chainName) => {
    const collectedPath = path.join(
      eventsDir,
      `${chainName}_FeesCollected.json`
    )
    const withdrawnPath = path.join(
      eventsDir,
      `${chainName}_FeesWithdrawn.json`
    )
    const lifiPath = path.join(eventsDir, `${chainName}_LiFiFeesWithdrawn.json`)
    const collected = JSON.parse(
      fs.readFileSync(collectedPath, 'utf-8')
    ) as IEventFile
    const withdrawn = JSON.parse(
      fs.readFileSync(withdrawnPath, 'utf-8')
    ) as IEventFile
    const lifiWithdrawn = JSON.parse(
      fs.readFileSync(lifiPath, 'utf-8')
    ) as IEventFile
    const fromBlocks = [
      collected.fromBlock,
      withdrawn.fromBlock,
      lifiWithdrawn.fromBlock,
    ]
    const toBlocks = [
      collected.toBlock,
      withdrawn.toBlock,
      lifiWithdrawn.toBlock,
    ]
    if (new Set(fromBlocks).size > 1 || new Set(toBlocks).size > 1) {
      consola.error(
        `[${chainName}] Inconsistent event file block ranges. FeesCollected: ${collected.fromBlock}-${collected.toBlock}, FeesWithdrawn: ${withdrawn.fromBlock}-${withdrawn.toBlock}, LiFiFeesWithdrawn: ${lifiWithdrawn.fromBlock}-${lifiWithdrawn.toBlock}. Re-run --step collect for this chain so all three files use the same range, or you will get wrong affected counts (e.g. many false "missing" if collected has a higher toBlock).`
      )
      return
    }
    const { totalFeesCollected, totalFeesWithdrawn } = aggregateEvents(
      collected.events,
      withdrawn.events,
      lifiWithdrawn.events
    )
    const result = await runReconcileForChain(
      chainName,
      totalFeesCollected,
      totalFeesWithdrawn,
      {
        priceOnlyMissing,
        skipPrices,
        toBlock: BigInt(collected.toBlock),
      }
    )
    const reconciliationFile: IReconciliationFile = {
      chainName,
      affected: result.affected,
      tokensScanned: result.tokensScanned,
    }
    const outPath = path.join(eventsDir, `reconciliation_${chainName}.json`)
    fs.writeFileSync(
      outPath,
      JSON.stringify(reconciliationFile, null, 2),
      'utf-8'
    )
    const missingCount = result.affected.filter(
      (t) => t.discrepancyType === 'missing'
    ).length
    const surplusCount = result.affected.filter(
      (t) => t.discrepancyType === 'surplus'
    ).length
    consola.success(
      `[${chainName}] Wrote ${outPath} (${result.affected.length} affected: ${missingCount} missing, ${surplusCount} surplus; ${result.tokensScanned} tokens scanned)`
    )
  })
}

/** Fill-prices-lifi step: read reconciliation_*.json, fetch only missing USD from Li.FI, write back. No CoinGecko, no RPC. */
async function runStepFillPricesLifi(eventsDir: string): Promise<void> {
  if (!fs.existsSync(eventsDir)) {
    consola.error(`Events dir not found: ${eventsDir}`)
    return
  }
  const files = fs.readdirSync(eventsDir)
  const reconciliationFiles = files.filter(
    (f) => f.startsWith('reconciliation_') && f.endsWith('.json')
  )
  if (reconciliationFiles.length === 0) {
    consola.error(
      `No reconciliation_*.json files in ${eventsDir}. Run --step reconcile first.`
    )
    return
  }
  for (const recFile of reconciliationFiles) {
    const chainName = recFile
      .replace(/^reconciliation_/, '')
      .replace(/\.json$/, '') as string
    const recPath = path.join(eventsDir, recFile)
    const rec = JSON.parse(
      fs.readFileSync(recPath, 'utf-8')
    ) as IReconciliationFile
    const wrappedNative =
      (networks[chainName] as { wrappedNativeAddress?: string } | undefined)
        ?.wrappedNativeAddress ?? ''
    const tokensNeedingPrice: { index: number; requestAddr: string }[] = []
    rec.affected.forEach((t, i) => {
      if (t.missingUsd !== null) return
      const requestAddr =
        t.tokenAddress === NULL_ADDRESS ? wrappedNative : t.tokenAddress
      if (requestAddr) tokensNeedingPrice.push({ index: i, requestAddr })
    })
    if (tokensNeedingPrice.length === 0) {
      consola.info(`[${chainName}] No missing prices to fill.`)
      continue
    }
    const chainId = rec.affected[0]?.chainId ?? 0
    if (chainId === 0) {
      consola.warn(`[${chainName}] Could not get chainId, skipping.`)
      continue
    }
    const addresses = [...new Set(tokensNeedingPrice.map((x) => x.requestAddr))]
    consola.info(
      `[${chainName}] Fetching ${addresses.length} missing price(s) from Li.FI...`
    )
    const lifiPrices = await getTokenPricesFromLifi(chainId, addresses)
    let updated = 0
    for (const { index, requestAddr } of tokensNeedingPrice) {
      const price = lifiPrices[requestAddr.toLowerCase()]
      if (
        price === undefined ||
        !Number.isFinite(price) ||
        price > SANITY_MAX_PRICE_PER_TOKEN_USD
      )
        continue
      const t = rec.affected[index]
      if (!t) continue
      const amount = BigInt(t.missingAmount)
      const decimals = t.decimals > 0 ? t.decimals : 18
      const missingUsd = (Number(amount) / 10 ** decimals) * price
      if (
        !Number.isFinite(missingUsd) ||
        missingUsd > MAX_PER_TOKEN_MISSING_USD
      ) {
        continue
      }
      rec.affected[index] = { ...t, missingUsd }
      updated++
    }
    fs.writeFileSync(recPath, JSON.stringify(rec, null, 2), 'utf-8')
    consola.success(
      `[${chainName}] Updated ${updated}/${tokensNeedingPrice.length} missing price(s) in ${recFile}.`
    )
  }
}

/** Report step: read reconciliation_*.json files, build report and write JSON + MD. */
async function runStepReport(
  eventsDir: string,
  affectedOnly: boolean,
  includeSurplus: boolean
): Promise<IReport | null> {
  if (!fs.existsSync(eventsDir)) {
    consola.error(`Events dir not found: ${eventsDir}`)
    return null
  }
  const files = fs.readdirSync(eventsDir)
  const reconciliationFiles = files.filter(
    (f) => f.startsWith('reconciliation_') && f.endsWith('.json')
  )
  const chainsFromFiles = reconciliationFiles.map((f) =>
    f.replace(/^reconciliation_/, '').replace(/\.json$/, '')
  ) as SupportedChain[]
  if (chainsFromFiles.length === 0) {
    consola.error(
      `No reconciliation_*.json files in ${eventsDir}. Run --step reconcile first.`
    )
    return null
  }
  const allAffected: IAffectedToken[] = []
  const byChain: IReport['summary']['byChain'] = {}
  for (const chainName of chainsFromFiles) {
    const recPath = path.join(eventsDir, `reconciliation_${chainName}.json`)
    const rec = JSON.parse(
      fs.readFileSync(recPath, 'utf-8')
    ) as IReconciliationFile
    allAffected.push(...rec.affected)
    const missingUsd = rec.affected
      .filter((t) => t.discrepancyType === 'missing' && !isKnownNoTaxToken(t))
      .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
    byChain[rec.chainName] = {
      affectedCount: rec.affected.length,
      totalAffected: rec.affected.length,
      missingUsd,
      tokensScanned: rec.tokensScanned,
      remainingBalanceUsd: computeRemainingBalanceUsd(rec.affected),
    }
  }
  const reportTokens =
    affectedOnly && !includeSurplus
      ? allAffected.filter((t) => t.discrepancyType === 'missing')
      : allAffected
  const reportMissingUsd = reportTokens
    .filter((t) => t.discrepancyType === 'missing' && !isKnownNoTaxToken(t))
    .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
  const reportByChain: IReport['summary']['byChain'] = {}
  for (const c of chainsFromFiles) {
    const chainTokens = reportTokens.filter((t) => t.chainName === c)
    const chainMissingUsd = chainTokens
      .filter((t) => t.discrepancyType === 'missing' && !isKnownNoTaxToken(t))
      .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
    const base = byChain[c]
    reportByChain[c] = {
      affectedCount: chainTokens.length,
      totalAffected: base?.totalAffected ?? chainTokens.length,
      missingUsd: chainMissingUsd,
      tokensScanned: base?.tokensScanned ?? 0,
      remainingBalanceUsd: computeRemainingBalanceUsd(chainTokens),
    }
  }
  return {
    summary: {
      totalMissingUsd: reportMissingUsd,
      byChain: reportByChain,
    },
    affectedTokens: reportTokens,
    generatedAt: new Date().toISOString(),
  }
}

/** USD value of current balance still in FeeCollector for missing tokens (value at risk). Priced tokens only. Excludes known no-tax tokens. */
function computeRemainingBalanceUsd(tokens: IAffectedToken[]): number {
  return tokens
    .filter((t) => t.discrepancyType === 'missing' && !isKnownNoTaxToken(t))
    .reduce((sum, t) => {
      if (t.missingUsd === null) return sum
      const missingAmount = BigInt(t.missingAmount)
      if (missingAmount === 0n) return sum
      const actualBalance = BigInt(t.actualBalance)
      const usd = t.missingUsd
      return sum + (Number(actualBalance) * usd) / Number(missingAmount)
    }, 0)
}

function buildDisallowedTokenList(report: IReport): IDisallowedTokenList {
  const missing = report.affectedTokens.filter(
    (t) => t.discrepancyType === 'missing'
  )
  const tokensByChain: Record<string, string[]> = {}
  for (const t of missing) {
    const key = t.chainName
    if (!tokensByChain[key]) tokensByChain[key] = []
    tokensByChain[key].push(t.tokenAddress)
  }
  return {
    generatedAt: report.generatedAt,
    description:
      'Token addresses to disallow fee collection (missing funds). Grouped by chain.',
    tokensByChain,
  }
}

function outputReport(
  report: IReport,
  args: {
    output?: string | string[]
    outputMd?: string | string[]
    outputDisallowed?: string | string[]
  }
): void {
  consola.info('--- Summary ---')
  consola.info(
    `Total missing USD: ${report.summary.totalMissingUsd.toFixed(2)}`
  )
  for (const [c, d] of Object.entries(report.summary.byChain)) {
    const totalAffected = d.totalAffected ?? d.affectedCount
    const countStr =
      totalAffected !== d.affectedCount
        ? `${d.affectedCount} Missing (Current balance < Expected), ${totalAffected} total affected (missing + surplus)`
        : `${d.affectedCount} Missing (Current balance < Expected)`
    const remainingStr = (d.remainingBalanceUsd ?? 0).toFixed(2)
    consola.info(
      `  ${c}: ${countStr}, missing USD ${d.missingUsd.toFixed(
        2
      )}, remaining balance in FeeCollector (USD) ${remainingStr}, tokens scanned ${
        d.tokensScanned
      }`
    )
  }
  if (report.affectedTokens.length > 0) {
    consola.info('Affected tokens (first 20):')
    for (const t of report.affectedTokens.slice(0, 20)) {
      const noteSuffix = t.note ? ` — ${t.note}` : ''
      consola.info(
        `  ${t.chainName} ${t.tokenAddress} ${t.symbol} ${t.discrepancyType}=${
          t.missingAmount
        } (${
          t.missingUsd !== null ? `$${t.missingUsd.toFixed(2)}` : 'N/A'
        })${noteSuffix}`
      )
    }
  }
  const outputPath = Array.isArray(args.output) ? args.output[0] : args.output
  if (outputPath) {
    const dir = path.dirname(outputPath)
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8')
    consola.success(`JSON report written to ${outputPath}`)
    const mdPath =
      (Array.isArray(args.outputMd) ? args.outputMd[0] : args.outputMd) ??
      outputPath.replace(/\.json$/i, '.md')
    writeMarkdownReport(report, mdPath)
  } else {
    const mdPath = Array.isArray(args.outputMd)
      ? args.outputMd[0]
      : args.outputMd
    if (mdPath) {
      writeMarkdownReport(report, mdPath)
    }
  }
  const disallowedPath = Array.isArray(args.outputDisallowed)
    ? args.outputDisallowed[0]
    : args.outputDisallowed
  if (disallowedPath) {
    const dir = path.dirname(disallowedPath)
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const disallowedList = buildDisallowedTokenList(report)
    fs.writeFileSync(
      disallowedPath,
      JSON.stringify(disallowedList, null, 2),
      'utf-8'
    )
    const totalTokens = Object.values(disallowedList.tokensByChain).reduce(
      (sum, addrs) => sum + addrs.length,
      0
    )
    consola.success(
      `Disallowed token list written to ${disallowedPath} (${totalTokens} tokens across ${
        Object.keys(disallowedList.tokensByChain).length
      } chains)`
    )
  }
}

function writeMarkdownReport(report: IReport, outputPath: string): void {
  const lines: string[] = [
    '# FeeCollector Balance Audit Report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Terminology',
    '',
    '- **Missing** — Current balance &lt; Expected (collected − withdrawn). The contract holds less than the events say it should (shortfall). The table below lists only these tokens.',
    '- **Total affected** — All tokens on that chain where expected ≠ actual (missing + surplus). Surplus = Current balance &gt; Expected.',
    '- **Remaining balance in FeeCollector (USD)** — For problematic (missing) tokens only: USD value of the current balance still held in the FeeCollector contract (value at risk). Summed per chain; only tokens with a known price are included. **Summary table USD columns (Missing funds in USD, Remaining balance in FeeCollector) exclude known no-tax tokens** (e.g. ETH, WETH, USDC, USDT, DAI) so totals are not inflated by false-positive shortfalls from incomplete event data.',
    '',
    '## Column reference (how to read the Affected Tokens table)',
    '',
    '| Column | What it means |',
    '| ------ | ------------- |',
    '| **Chain** | Network (arbitrum, base, mainnet). |',
    '| **Token address** | Contract address of the token. |',
    '| **Symbol** | Token symbol. |',
    '| **Collected** | Total credited from FeesCollected (integratorFee + lifiFee). |',
    '| **Withdrawn** | Total sent out from FeesWithdrawn + LiFiFeesWithdrawn. |',
    '| **Expected (collected - withdrawn)** | What the events say should still be in the contract. |',
    '| **Current balance** | What the contract actually holds (balanceOf(FeeCollector)). |',
    '| **Missing amount** | Shortfall: Expected − Current balance (in token units). |',
    '| **Missing USD** | Same shortfall in USD (or N/A if no price). |',
    '| **Price USD** | Price per token in USD used for Missing USD (helps spot wrong prices). |',
    '| **Note** | e.g. "balanceOf reverted" when the token contract reverted on balanceOf (actual treated as 0). |',
    '',
    '## Summary',
    '',
    `- **Total missing (USD):** ${report.summary.totalMissingUsd.toFixed(2)}`,
    '',
  ]
  for (const [chain, data] of Object.entries(report.summary.byChain)) {
    const totalAffected = data.totalAffected ?? data.affectedCount
    const countStr =
      totalAffected !== data.affectedCount
        ? `${data.affectedCount} Missing (Current balance &lt; Expected), ${totalAffected} total affected (missing + surplus)`
        : `${data.affectedCount} Missing (Current balance &lt; Expected)`
    lines.push(
      `- **${chain}:** ${countStr}, missing USD: ${data.missingUsd.toFixed(
        2
      )}, tokens scanned: ${data.tokensScanned}`
    )
  }
  const chainNames = Object.keys(report.summary.byChain)
  const summaryRows: Array<{
    chain: string
    tokensFeesCollectedIn: number
    tokensWithMissingFunds: number
    tokensWithoutPrice: number
    missingFundsUsd: number
    remainingBalanceUsd: number
  }> = []
  for (const chain of chainNames) {
    const data = report.summary.byChain[chain]
    if (!data) continue
    const chainTokens = report.affectedTokens.filter(
      (t) => t.chainName === chain
    )
    const missingCount = chainTokens.filter(
      (t) => t.discrepancyType === 'missing'
    ).length
    const noPriceCount = chainTokens.filter((t) => t.missingUsd === null).length
    summaryRows.push({
      chain,
      tokensFeesCollectedIn: data.tokensScanned ?? 0,
      tokensWithMissingFunds: missingCount,
      tokensWithoutPrice: noPriceCount,
      missingFundsUsd: data.missingUsd,
      remainingBalanceUsd: data.remainingBalanceUsd ?? 0,
    })
  }
  const totalTokensFeesCollectedIn = summaryRows.reduce(
    (sum, r) => sum + r.tokensFeesCollectedIn,
    0
  )
  const totalTokensWithMissingFunds = summaryRows.reduce(
    (sum, r) => sum + r.tokensWithMissingFunds,
    0
  )
  const totalTokensWithoutPrice = summaryRows.reduce(
    (sum, r) => sum + r.tokensWithoutPrice,
    0
  )
  const totalRemainingBalanceUsd = summaryRows.reduce(
    (sum, r) => sum + r.remainingBalanceUsd,
    0
  )
  const summaryHeaderCells = [
    'Chain',
    'Tokens fees collected in',
    'Tokens with missing funds',
    'Tokens without price',
    'Missing funds in USD',
    'Remaining balance in FeeCollector (USD)',
    'Note',
  ]
  const summaryRowCellsList: string[][] = summaryRows.map((r) => [
    r.chain,
    String(r.tokensFeesCollectedIn),
    String(r.tokensWithMissingFunds),
    String(r.tokensWithoutPrice),
    r.missingFundsUsd.toFixed(2),
    r.remainingBalanceUsd.toFixed(2),
    r.chain === 'base' ? 'excluding USDC & ETH' : '',
  ])
  summaryRowCellsList.push([
    '**Total**',
    String(totalTokensFeesCollectedIn),
    String(totalTokensWithMissingFunds),
    String(totalTokensWithoutPrice),
    report.summary.totalMissingUsd.toFixed(2),
    totalRemainingBalanceUsd.toFixed(2),
    '',
  ])
  const summaryNumCols = summaryHeaderCells.length
  const summaryWidths: number[] = []
  for (let c = 0; c < summaryNumCols; c++) {
    let w = (summaryHeaderCells[c] ?? '').length
    for (const row of summaryRowCellsList) {
      const cellLen = (row[c] ?? '').length
      if (cellLen > w) w = cellLen
    }
    summaryWidths.push(w)
  }
  const summaryTextCols = new Set([0])
  const summaryPadCell = (val: string, col: number) =>
    summaryTextCols.has(col)
      ? padRight(val, summaryWidths[col] ?? 0)
      : padLeft(val, summaryWidths[col] ?? 0)
  lines.push('', '### Summary table (per chain)', '')
  lines.push(
    '| ' +
      summaryHeaderCells.map((cell, c) => summaryPadCell(cell, c)).join(' | ') +
      ' |'
  )
  lines.push('| ' + summaryWidths.map((w) => '-'.repeat(w)).join(' | ') + ' |')
  for (const row of summaryRowCellsList) {
    lines.push(
      '| ' + row.map((cell, c) => summaryPadCell(cell, c)).join(' | ') + ' |'
    )
  }
  // Largest affected tokens by Missing USD (missing only, with USD)
  const withMissingUsd = report.affectedTokens.filter(
    (t) =>
      t.discrepancyType === 'missing' &&
      t.missingUsd !== null &&
      t.missingUsd > 0
  )
  const topByMissingUsd = [...withMissingUsd]
    .sort((a, b) => (b.missingUsd ?? 0) - (a.missingUsd ?? 0))
    .slice(0, 30)
  if (topByMissingUsd.length > 0) {
    lines.push('', '### Largest affected tokens (by Missing USD)', '')
    const topHeader = [
      'Network',
      'Token symbol',
      'Token address',
      'Missing amount',
      'Price USD',
      'Missing USD',
      'Remaining amount',
      'Remaining USD',
    ]
    const topRows: string[][] = topByMissingUsd.map((t) => {
      const missingAmt = BigInt(t.missingAmount)
      const remainingUsd =
        t.missingUsd !== null && missingAmt !== 0n
          ? (Number(t.actualBalance) * t.missingUsd) / Number(missingAmt)
          : 0
      const pricePerToken = getPricePerTokenUsd(t)
      return [
        t.chainName,
        escapeTableCell(t.symbol),
        t.tokenAddress,
        formatHumanAmount(missingAmt, t.decimals),
        pricePerToken !== null ? pricePerToken.toFixed(2) : 'N/A',
        (t.missingUsd ?? 0).toFixed(2),
        formatHumanAmount(BigInt(t.actualBalance), t.decimals),
        remainingUsd.toFixed(2),
      ]
    })
    const topW: number[] = topHeader.map((h, c) => {
      let w = h.length
      for (const row of topRows) {
        const cellLen = (row[c] ?? '').length
        if (cellLen > w) w = cellLen
      }
      return w
    })
    const topPad = (val: string, col: number) =>
      col <= 2 ? padRight(val, topW[col] ?? 0) : padLeft(val, topW[col] ?? 0)
    lines.push('| ' + topHeader.map((h, c) => topPad(h, c)).join(' | ') + ' |')
    lines.push('| ' + topW.map((w) => '-'.repeat(w)).join(' | ') + ' |')
    for (const row of topRows) {
      lines.push(
        '| ' + row.map((cell, c) => topPad(cell, c)).join(' | ') + ' |'
      )
    }
    lines.push('')
  }
  lines.push('')
  const missingTokensNoTax = report.affectedTokens.filter(
    (t) =>
      t.discrepancyType === 'missing' &&
      KNOWN_NO_TAX_SYMBOLS.has(t.symbol.trim().toUpperCase())
  )
  if (missingTokensNoTax.length > 0) {
    const symbols = [...new Set(missingTokensNoTax.map((t) => t.symbol))]
    lines.push(
      '',
      '> **⚠️ Validation: standard (no-tax) tokens listed as missing** — The following tokens do not have transfer taxes (fee-on-transfer): **' +
        symbols.join(', ') +
        '**. For such tokens, a reported shortfall often indicates **incomplete event data**, not on-chain accounting. Many RPCs limit `eth_getLogs` to 10,000 logs per request; with a large block chunk, withdrawals can be truncated so "expected" is overstated. Re-run `--step collect` with `--chunk-size 2000` (or smaller), then reconcile and report again; if the discrepancy disappears, it was due to incomplete events.'
    )
  }
  const allMissingUsdNa =
    report.affectedTokens.length > 0 &&
    report.affectedTokens.every((t) => t.missingUsd === null)
  if (allMissingUsdNa) {
    lines.push(
      '',
      '> **Why is Missing USD all N/A?** USD comes from the **reconcile** step (CoinGecko, then Li.FI as fallback). Either reconcile was run with `--skip-prices`, or no price was returned for these tokens. To get USD: run `--step reconcile` **without** `--skip-prices`, set `COINGECKO_DEMO_API_KEY` (and optionally `LIFI_API_KEY` for fallback), then run `--step report` again.'
    )
  }
  lines.push('', '## Affected Tokens', '')
  const hasSurplus = report.affectedTokens.some(
    (t) => t.discrepancyType === 'surplus'
  )
  const headerCellsMissing = [
    'Chain',
    'Token address',
    'Symbol',
    'Collected',
    'Withdrawn',
    'Expected',
    'Current balance',
    'Missing amount',
    'Missing USD',
    'Price USD',
    'Note',
  ]
  const headerCellsSurplus = [
    'Chain',
    'Token address',
    'Symbol',
    'Collected',
    'Withdrawn',
    'Expected',
    'Current balance',
    'Type',
    'Amount',
    'Missing USD',
    'Price USD',
    'Note',
  ]
  const headerCells = hasSurplus ? headerCellsSurplus : headerCellsMissing
  const numCols = headerCells.length
  const rowCellsList: string[][] = []
  for (const t of report.affectedTokens) {
    const collectedStr = formatHumanAmount(
      BigInt(t.totalFeesCollected),
      t.decimals
    )
    const withdrawnStr = formatHumanAmount(
      BigInt(t.totalFeesWithdrawn),
      t.decimals
    )
    const expectedStr = formatHumanAmount(BigInt(t.expectedBalance), t.decimals)
    const actualStr = formatHumanAmount(BigInt(t.actualBalance), t.decimals)
    const missingStr = formatHumanAmount(BigInt(t.missingAmount), t.decimals)
    const usdStr = t.missingUsd !== null ? t.missingUsd.toFixed(2) : 'N/A'
    const pricePerToken = getPricePerTokenUsd(t)
    const priceStr = pricePerToken !== null ? pricePerToken.toFixed(2) : 'N/A'
    const symbolSafe = escapeTableCell(t.symbol)
    const noteCell = escapeTableCell(t.note ?? '')
    if (hasSurplus) {
      rowCellsList.push([
        t.chainName,
        t.tokenAddress,
        symbolSafe,
        collectedStr,
        withdrawnStr,
        expectedStr,
        actualStr,
        t.discrepancyType,
        missingStr,
        usdStr,
        priceStr,
        noteCell,
      ])
    } else {
      rowCellsList.push([
        t.chainName,
        t.tokenAddress,
        symbolSafe,
        collectedStr,
        withdrawnStr,
        expectedStr,
        actualStr,
        missingStr,
        usdStr,
        priceStr,
        noteCell,
      ])
    }
  }
  const widths: number[] = []
  for (let c = 0; c < numCols; c++) {
    let w = (headerCells[c] ?? '').length
    for (const row of rowCellsList) {
      const cellLen = (row[c] ?? '').length
      if (cellLen > w) w = cellLen
    }
    widths.push(w)
  }
  const textCols = new Set([0, 1, 2, numCols - 1])
  if (hasSurplus) textCols.add(7)
  const padCell = (val: string, col: number) =>
    textCols.has(col)
      ? padRight(val, widths[col] ?? 0)
      : padLeft(val, widths[col] ?? 0)
  const headerRow =
    '| ' + headerCells.map((cell, c) => padCell(cell, c)).join(' | ') + ' |'
  const separatorRow =
    '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |'
  lines.push(headerRow)
  lines.push(separatorRow)
  for (const row of rowCellsList) {
    lines.push('| ' + row.map((cell, c) => padCell(cell, c)).join(' | ') + ' |')
  }
  const dir = path.dirname(outputPath)
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8')
  consola.success(`Markdown report written to ${outputPath}`)
}

const main = defineCommand({
  meta: {
    name: 'audit-fee-collector-balances',
    description:
      'Audit FeeCollector historic events and report token balance discrepancies. Config: config/auditFeeCollector.json; use --all-chains for all EVM chains with FeeCollector.',
  },
  args: {
    network: {
      type: 'string',
      description:
        'Single network to run (default: chains from config/auditFeeCollector.json)',
      required: false,
    },
    networks: {
      type: 'string',
      description:
        'Comma-separated list of networks to run (e.g. arbitrum,polygon). Use with --step collect to re-fetch only these chains with a different chunk-size. Overrides config and --network.',
      required: false,
    },
    allChains: {
      type: 'boolean',
      description:
        'Run on all active EVM chains that have FeeCollector deployed (from deployments/)',
      required: false,
    },
    fromBlock: {
      type: 'string',
      description: 'Override fromBlock for event scan (all chains)',
      required: false,
    },
    toBlock: {
      type: 'string',
      description: 'Override toBlock for event scan (all chains)',
      required: false,
    },
    output: {
      type: 'string',
      description: 'Path to write JSON report',
      required: false,
    },
    outputMd: {
      type: 'string',
      description: 'Path to write Markdown report (Notion-friendly)',
      required: false,
    },
    outputDisallowed: {
      type: 'string',
      description:
        'Path to write token list (grouped by chain) for BE to disallow fee collection (only tokens with missing funds)',
      required: false,
    },
    step: {
      type: 'string',
      description:
        'Step: collect | reconcile | report | fill-prices-lifi | full (default). fill-prices-lifi: fill only missing USD from Li.FI (no CoinGecko, no RPC).',
      required: false,
    },
    fillPricesLifi: {
      type: 'boolean',
      description:
        'Shorthand for --step fill-prices-lifi. Fill missing USD from Li.FI only (no CoinGecko, no RPC).',
      required: false,
    },
    eventsDir: {
      type: 'string',
      description: 'Directory for event JSON files (default: ./audit-events)',
      required: false,
    },
    affectedOnly: {
      type: 'boolean',
      description:
        'Only include missing-balance tokens in report (default: true)',
      required: false,
    },
    includeSurplus: {
      type: 'boolean',
      description: 'Include surplus tokens in report (together with missing)',
      required: false,
    },
    skipPrices: {
      type: 'boolean',
      description:
        'Do not fetch token prices (all Missing USD N/A; no CoinGecko calls)',
      required: false,
    },
    concurrency: {
      type: 'string',
      description:
        'Max networks to process in parallel (default: 6). Higher values speed up --all-chains but may hit RPC limits.',
      required: false,
    },
    chunkSize: {
      type: 'string',
      description:
        'Block range per getLogs chunk for collect step (default: 10000). Use 2000 if standard tokens (ETH, USDC) show false "missing" due to RPC log limit.',
      required: false,
    },
  },
  async run({ args }) {
    const networkArg = Array.isArray(args.network)
      ? args.network[0]
      : args.network
    const stepRaw =
      args.fillPricesLifi === true
        ? 'fill-prices-lifi'
        : Array.isArray(args.step)
        ? args.step[0]
        : args.step
    const step =
      stepRaw === 'collect' ||
      stepRaw === 'reconcile' ||
      stepRaw === 'report' ||
      stepRaw === 'fill-prices-lifi' ||
      stepRaw === 'full'
        ? stepRaw
        : 'full'
    const eventsDir =
      (Array.isArray(args.eventsDir) ? args.eventsDir[0] : args.eventsDir) ??
      './audit-events'
    const affectedOnly = args.affectedOnly !== false
    const includeSurplus = args.includeSurplus === true
    const skipPrices = args.skipPrices === true
    const concurrencyRaw = Array.isArray(args.concurrency)
      ? args.concurrency[0]
      : args.concurrency
    const concurrency =
      concurrencyRaw !== undefined && concurrencyRaw !== null
        ? Math.max(
            1,
            parseInt(concurrencyRaw, 10) || DEFAULT_NETWORK_CONCURRENCY
          )
        : DEFAULT_NETWORK_CONCURRENCY
    const chunkSizeRaw = Array.isArray(args.chunkSize)
      ? args.chunkSize[0]
      : args.chunkSize
    const chunkSize =
      chunkSizeRaw !== undefined && chunkSizeRaw !== null
        ? BigInt(parseInt(chunkSizeRaw, 10) || Number(DEFAULT_CHUNK_SIZE))
        : DEFAULT_CHUNK_SIZE

    const configChains = getConfigAuditChains()
    let chains: SupportedChain[]
    const networksArgRaw = Array.isArray(args.networks)
      ? args.networks[0]
      : args.networks
    if (networksArgRaw && typeof networksArgRaw === 'string') {
      chains = networksArgRaw
        .split(',')
        .map((s) => s.trim())
        .filter((n) => networks[n]) as SupportedChain[]
      if (chains.length > 0) {
        consola.info(
          `Using --networks: ${chains.length} chain(s) (${chains.join(', ')})`
        )
      } else {
        chains = configChains
      }
    } else if (args.allChains === true) {
      chains = await discoverChainsWithFeeCollector()
      consola.info(
        `Using --all-chains: ${chains.length} EVM chains with FeeCollector`
      )
    } else if (networkArg && networks[networkArg]) {
      chains = [networkArg as SupportedChain]
    } else {
      chains = configChains
    }

    const fromBlockOverride = args.fromBlock
      ? BigInt(args.fromBlock as string)
      : undefined
    const toBlockOverride = args.toBlock
      ? BigInt(args.toBlock as string)
      : undefined

    if (step === 'collect') {
      await runStepCollect(
        chains,
        fromBlockOverride,
        toBlockOverride,
        eventsDir,
        concurrency,
        chunkSize
      )
      process.exit(0)
      return
    }

    if (step === 'reconcile') {
      await runStepReconcile(eventsDir, {
        priceOnlyMissing: affectedOnly && !includeSurplus,
        skipPrices,
        concurrency,
      })
      process.exit(0)
      return
    }

    if (step === 'report') {
      const report = await runStepReport(
        eventsDir,
        affectedOnly,
        includeSurplus
      )
      if (report) {
        outputReport(report, args)
      }
      process.exit(0)
      return
    }

    if (step === 'fill-prices-lifi') {
      await runStepFillPricesLifi(eventsDir)
      process.exit(0)
      return
    }

    const allAffected: IAffectedToken[] = []
    const byChain: IReport['summary']['byChain'] = {}

    consola.info(
      `Running audit for ${chains.length} chain(s) with concurrency ${concurrency}`
    )
    const results = await runWithConcurrency(chains, concurrency, (chain) =>
      runAuditForChain(chain, fromBlockOverride, toBlockOverride, {
        skipPrices,
        chunkSize,
      })
    )
    for (const [i, chain] of chains.entries()) {
      const result = results[i]
      if (!result) continue
      allAffected.push(...result.affected)
      const missingUsd = result.affected
        .filter((t) => t.discrepancyType === 'missing' && !isKnownNoTaxToken(t))
        .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
      byChain[chain] = {
        affectedCount: result.affected.length,
        totalAffected: result.affected.length,
        missingUsd,
        tokensScanned: result.tokensScanned,
        remainingBalanceUsd: computeRemainingBalanceUsd(result.affected),
      }
    }

    const reportTokens =
      affectedOnly && !includeSurplus
        ? allAffected.filter((t) => t.discrepancyType === 'missing')
        : allAffected
    const reportMissingUsd = reportTokens
      .filter((t) => t.discrepancyType === 'missing' && !isKnownNoTaxToken(t))
      .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
    const reportByChain: IReport['summary']['byChain'] = {}
    for (const c of chains) {
      const chainTokens = reportTokens.filter((t) => t.chainName === c)
      const chainMissingUsd = chainTokens
        .filter((t) => t.discrepancyType === 'missing' && !isKnownNoTaxToken(t))
        .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
      const base = byChain[c]
      reportByChain[c] = {
        affectedCount: chainTokens.length,
        totalAffected: base?.totalAffected ?? chainTokens.length,
        missingUsd: chainMissingUsd,
        tokensScanned: base?.tokensScanned ?? 0,
        remainingBalanceUsd: computeRemainingBalanceUsd(chainTokens),
      }
    }

    const report: IReport = {
      summary: {
        totalMissingUsd: reportMissingUsd,
        byChain: reportByChain,
      },
      affectedTokens: reportTokens,
      generatedAt: new Date().toISOString(),
    }

    outputReport(report, args)
    process.exit(0)
  },
})

runMain(main)
