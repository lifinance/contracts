#!/usr/bin/env bun

/**
 * FeeCollector Balance Audit
 * =========================
 *
 * Scans historic FeeCollector events (FeesCollected, FeesWithdrawn, LiFiFeesWithdrawn) on
 * mainnet, base, and arbitrum; reconciles expected vs actual token balances per chain; and
 * reports affected tokens (where expected !== actual) with optional USD valuation.
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
 *   --network <name>     Run only one chain: mainnet | base | arbitrum (default: all three).
 *   --step <name>       collect | reconcile | report | full (default: full).
 *   --events-dir <path> Directory for event and reconciliation JSON (default: ./audit-events).
 *   --output <path>     Write JSON report here (e.g. report.json).
 *   --output-md <path>  Write Markdown report here (e.g. report.md).
 *   --from-block <n>    Override fromBlock for event scan (all chains).
 *   --to-block <n>      Override toBlock for event scan (all chains).
 *   --affected-only     Only include tokens where Current balance < Expected (default: true).
 *   --include-surplus   Include surplus tokens in report (together with missing).
 *   --skip-prices       Do not fetch token prices (all Missing USD will be N/A; no CoinGecko calls).
 *   RPC: Uses chain default from config; override with ETH_NODE_URI_<NETWORK> (e.g. ETH_NODE_URI_MAINNET).
 *

 * Set COINGECKO_DEMO_API_KEY (or COINGECKO_API_KEY) so requests use the Demo API; without it,
 * the public tier may return 400 (e.g. "exceeds the allowed limit of 1 contract address") or 429.
 *
 * ENVIRONMENT
 * -----------
 *
 *   COINGECKO_DEMO_API_KEY or COINGECKO_API_KEY
 *     Required for reliable price fetching. Passed as x_cg_demo_api_key. Demo plan: 30 req/min,
 *     1 address per request, 10k credits/mo. Script uses 1 address per request and 2s delay.
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
 *
 * The Markdown report includes a column reference at the top (Chain, Token address, Symbol,
 * Collected, Withdrawn, Expected, Current balance, Missing amount, Missing USD).
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

/** FeeCollector audit fromBlock per chain (deployment block for each). Do not increase or early withdrawals will be excluded and standard tokens will show false "missing". */
const FEE_COLLECTOR_FROM_BLOCK: Record<string, bigint> = {
  mainnet: 23322816n,
  base: 2650157n,
  arbitrum: 18708645n,
}

const CHUNK_SIZE = 10_000n

/** Max concurrent balanceOf calls per chain to avoid RPC timeouts. */
const BALANCE_FETCH_CONCURRENCY = 2
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

const COINGECKO_PLATFORM_BY_CHAIN_ID: Record<number, string> = {
  1: 'ethereum',
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
    }
  >
}

interface IReport {
  summary: IAuditSummary
  affectedTokens: IAffectedToken[]
  generatedAt: string
}

/** Persisted result of reconcile step (one file per chain). */
interface IReconciliationFile {
  chainName: string
  affected: IAffectedToken[]
  tokensScanned: number
}

const AUDIT_CHAINS: SupportedChain[] = ['mainnet', 'base', 'arbitrum']

/** Cap per-token missing USD; above this we set N/A to avoid one bad price/decimals blowing up the total. */
const MAX_PER_TOKEN_MISSING_USD = 1_000_000

/** CoinGecko Demo: 1 contract address per request (avoids 400). */
const COINGECKO_CHUNK_SIZE = 1
/** CoinGecko Demo: 30 req/min → 2s between requests. */
const COINGECKO_DELAY_MS = 2000
/** Wait before retry when rate limited (429). */
const COINGECKO_429_RETRY_DELAY_MS = 65_000

function chunkArray<T>(array: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
    array.slice(i * size, i * size + size)
  )
}

async function getTokenPricesMap(
  platform: string,
  tokenAddresses: string[]
): Promise<Record<string, number>> {
  const prices: Record<string, number> = {}
  const valid = tokenAddresses.filter((a) => a !== NULL_ADDRESS && a.length > 0)
  if (valid.length === 0) return prices
  const apiKey =
    process.env.COINGECKO_DEMO_API_KEY ?? process.env.COINGECKO_API_KEY ?? ''
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

async function runAuditForChain(
  networkName: SupportedChain,
  fromBlockOverride: bigint | undefined,
  toBlockOverride: bigint | undefined,
  options?: { skipPrices?: boolean }
): Promise<{
  affected: IAffectedToken[]
  tokensScanned: number
  chainId: number
}> {
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

  const fromBlock =
    fromBlockOverride ?? FEE_COLLECTOR_FROM_BLOCK[networkName] ?? 0n
  const toBlock = toBlockOverride ?? (await publicClient.getBlockNumber())

  consola.info(
    `[${networkName}] FeeCollector ${feeCollectorAddress}, blocks ${fromBlock}-${toBlock}`
  )

  const eventDefs = getEventDefinitions()
  const configBase: Omit<
    IEventScannerConfig,
    'event' | 'fromBlock' | 'toBlock'
  > = {
    publicClient,
    address: feeCollectorAddress,
    networkName,
    chunkSize: CHUNK_SIZE,
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

async function runStepCollect(
  chains: SupportedChain[],
  fromBlockOverride: bigint | undefined,
  toBlockOverride: bigint | undefined,
  eventsDir: string
): Promise<void> {
  if (!fs.existsSync(eventsDir)) {
    fs.mkdirSync(eventsDir, { recursive: true })
  }
  const eventDefs = getEventDefinitions()
  for (const networkName of chains) {
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
    const fromBlock =
      fromBlockOverride ?? FEE_COLLECTOR_FROM_BLOCK[networkName] ?? 0n
    const toBlock = toBlockOverride ?? (await publicClient.getBlockNumber())
    consola.info(
      `[${networkName}] Collecting events, blocks ${fromBlock}-${toBlock}`
    )
    const configBase: Omit<
      IEventScannerConfig,
      'event' | 'fromBlock' | 'toBlock'
    > = {
      publicClient,
      address: feeCollectorAddress,
      networkName,
      chunkSize: CHUNK_SIZE,
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
  let priceMap: Record<string, number> = {}
  let nativePrice: number | null = null
  if (!skipPrices) {
    consola.info(
      `[${networkName}] Fetching prices for ${
        priceAddressesForAffected.length
      } token(s) (${priceOnlyMissing ? 'missing only' : 'all affected'})...`
    )
    priceMap = await getTokenPricesMap(platform, priceAddressesForAffected)
    nativePrice = wrappedNative
      ? priceMap[wrappedNative.toLowerCase()] ?? null
      : null
  } else {
    consola.info(`[${networkName}] Skipping price fetch (--skip-prices).`)
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
    let missingUsd: number | null =
      priceUsd !== null && amount > 0n
        ? (Number(amount) / 10 ** effectiveDecimals) * priceUsd
        : null
    if (
      missingUsd !== null &&
      (missingUsd > MAX_PER_TOKEN_MISSING_USD || !Number.isFinite(missingUsd))
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
  options?: { priceOnlyMissing?: boolean; skipPrices?: boolean }
): Promise<void> {
  const priceOnlyMissing = options?.priceOnlyMissing !== false
  const skipPrices = options?.skipPrices === true
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
  for (const chainName of chainsFromFiles) {
    const collectedPath = path.join(
      eventsDir,
      `${chainName}_FeesCollected.json`
    )
    const withdrawnPath = path.join(
      eventsDir,
      `${chainName}_FeesWithdrawn.json`
    )
    const lifiPath = path.join(eventsDir, `${chainName}_LiFiFeesWithdrawn.json`)
    if (!fs.existsSync(withdrawnPath) || !fs.existsSync(lifiPath)) {
      consola.warn(
        `Skipping ${chainName}: missing one of FeesWithdrawn or LiFiFeesWithdrawn file`
      )
      continue
    }
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
      continue
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
      .filter((t) => t.discrepancyType === 'missing')
      .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
    byChain[rec.chainName] = {
      affectedCount: rec.affected.length,
      totalAffected: rec.affected.length,
      missingUsd,
      tokensScanned: rec.tokensScanned,
    }
  }
  const reportTokens =
    affectedOnly && !includeSurplus
      ? allAffected.filter((t) => t.discrepancyType === 'missing')
      : allAffected
  const reportMissingUsd = reportTokens
    .filter((t) => t.discrepancyType === 'missing')
    .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
  const reportByChain: IReport['summary']['byChain'] = {}
  for (const c of chainsFromFiles) {
    const chainTokens = reportTokens.filter((t) => t.chainName === c)
    const chainMissingUsd = chainTokens
      .filter((t) => t.discrepancyType === 'missing')
      .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
    const base = byChain[c]
    reportByChain[c] = {
      affectedCount: chainTokens.length,
      totalAffected: base?.totalAffected ?? chainTokens.length,
      missingUsd: chainMissingUsd,
      tokensScanned: base?.tokensScanned ?? 0,
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

function outputReport(
  report: IReport,
  args: { output?: string | string[]; outputMd?: string | string[] }
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
    consola.info(
      `  ${c}: ${countStr}, missing USD ${d.missingUsd.toFixed(
        2
      )}, tokens scanned ${d.tokensScanned}`
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
    '',
    '## Column reference (how to read the Affected Tokens table)',
    '',
    '| Column | What it means |',
    '| ------ | ------------- |',
    '| **Chain** | Network (arbitrum, base, mainnet). |',
    '| **Token address / Symbol** | Which token. |',
    '| **Collected** | Total credited from FeesCollected (integratorFee + lifiFee). |',
    '| **Withdrawn** | Total sent out from FeesWithdrawn + LiFiFeesWithdrawn. |',
    '| **Expected (collected - withdrawn)** | What the events say should still be in the contract. |',
    '| **Current balance** | What the contract actually holds (balanceOf(FeeCollector)). |',
    '| **Missing amount** | Shortfall: Expected − Current balance (in token units). |',
    '| **Missing USD** | Same shortfall in USD (or N/A if no price). |',
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
  lines.push('', '## Affected Tokens', '')
  const hasSurplus = report.affectedTokens.some(
    (t) => t.discrepancyType === 'surplus'
  )
  const tableHeader =
    '| Chain | Token address | Symbol | Collected | Withdrawn | Expected (collected - withdrawn) | Current balance | Missing amount | Missing USD | Note |'
  const tableHeaderSurplus =
    '| Chain | Token address | Symbol | Collected | Withdrawn | Expected | Current balance | Discrepancy | Amount | USD | Note |'
  const tableDivider =
    '| ----- | ------------- | ------ | --------- | --------- | ------------------------------- | --------------- | ------------- | ----------- | ---- |'
  const tableDividerSurplus =
    '| ----- | ------------- | ------ | --------- | --------- | --------- | --------------- | ----------- | ------ | --- | ---- |'
  if (hasSurplus) {
    lines.push(tableHeaderSurplus)
    lines.push(tableDividerSurplus)
  } else {
    lines.push(tableHeader)
    lines.push(tableDivider)
  }
  for (const t of report.affectedTokens) {
    const collectedHuman = formatHumanAmount(
      BigInt(t.totalFeesCollected),
      t.decimals
    )
    const withdrawnHuman = formatHumanAmount(
      BigInt(t.totalFeesWithdrawn),
      t.decimals
    )
    const expectedHuman = formatHumanAmount(
      BigInt(t.expectedBalance),
      t.decimals
    )
    const actualHuman = formatHumanAmount(BigInt(t.actualBalance), t.decimals)
    const missingHuman = formatHumanAmount(BigInt(t.missingAmount), t.decimals)
    const usdStr = t.missingUsd !== null ? t.missingUsd.toFixed(2) : 'N/A'
    const noteCell = t.note ?? ''
    if (hasSurplus) {
      lines.push(
        `| ${t.chainName} | ${t.tokenAddress} | ${t.symbol} | ${collectedHuman} | ${withdrawnHuman} | ${expectedHuman} | ${actualHuman} | ${t.discrepancyType} | ${missingHuman} | ${usdStr} | ${noteCell} |`
      )
    } else {
      lines.push(
        `| ${t.chainName} | ${t.tokenAddress} | ${t.symbol} | ${collectedHuman} | ${withdrawnHuman} | ${expectedHuman} | ${actualHuman} | ${missingHuman} | ${usdStr} | ${noteCell} |`
      )
    }
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
      'Audit FeeCollector historic events and report token balance discrepancies (mainnet, base, arbitrum).',
  },
  args: {
    network: {
      type: 'string',
      description: 'Single network to run (default: mainnet, base, arbitrum)',
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
    step: {
      type: 'string',
      description:
        'Step: collect (events to files), reconcile (prices+balances to files), report (from reconciliation files), full (default)',
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
  },
  async run({ args }) {
    const networkArg = Array.isArray(args.network)
      ? args.network[0]
      : args.network
    const stepRaw = Array.isArray(args.step) ? args.step[0] : args.step
    const step =
      stepRaw === 'collect' ||
      stepRaw === 'reconcile' ||
      stepRaw === 'report' ||
      stepRaw === 'full'
        ? stepRaw
        : 'full'
    const eventsDir =
      (Array.isArray(args.eventsDir) ? args.eventsDir[0] : args.eventsDir) ??
      './audit-events'
    const affectedOnly = args.affectedOnly !== false
    const includeSurplus = args.includeSurplus === true
    const skipPrices = args.skipPrices === true

    const chains: SupportedChain[] =
      networkArg && AUDIT_CHAINS.includes(networkArg as SupportedChain)
        ? [networkArg as SupportedChain]
        : AUDIT_CHAINS

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
        eventsDir
      )
      process.exit(0)
      return
    }

    if (step === 'reconcile') {
      await runStepReconcile(eventsDir, {
        priceOnlyMissing: affectedOnly && !includeSurplus,
        skipPrices,
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

    const allAffected: IAffectedToken[] = []
    const byChain: IReport['summary']['byChain'] = {}

    for (const chain of chains) {
      const result = await runAuditForChain(
        chain,
        fromBlockOverride,
        toBlockOverride,
        { skipPrices }
      )
      allAffected.push(...result.affected)
      const missingUsd = result.affected
        .filter((t) => t.discrepancyType === 'missing')
        .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
      byChain[chain] = {
        affectedCount: result.affected.length,
        totalAffected: result.affected.length,
        missingUsd,
        tokensScanned: result.tokensScanned,
      }
    }

    const reportTokens =
      affectedOnly && !includeSurplus
        ? allAffected.filter((t) => t.discrepancyType === 'missing')
        : allAffected
    const reportMissingUsd = reportTokens
      .filter((t) => t.discrepancyType === 'missing')
      .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
    const reportByChain: IReport['summary']['byChain'] = {}
    for (const c of chains) {
      const chainTokens = reportTokens.filter((t) => t.chainName === c)
      const chainMissingUsd = chainTokens
        .filter((t) => t.discrepancyType === 'missing')
        .reduce((sum, t) => sum + (t.missingUsd ?? 0), 0)
      const base = byChain[c]
      reportByChain[c] = {
        affectedCount: chainTokens.length,
        totalAffected: base?.totalAffected ?? chainTokens.length,
        missingUsd: chainMissingUsd,
        tokensScanned: base?.tokensScanned ?? 0,
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
