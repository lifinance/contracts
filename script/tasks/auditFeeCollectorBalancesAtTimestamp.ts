#!/usr/bin/env bun

/**
 * FeeCollector Balances at Timestamp
 * ===================================
 *
 * Reads token list from feeCollectors CSV, resolves the block at a given Unix timestamp
 * (or the first block after it) per chain, and fetches balanceOf(FeeCollector) for each
 * token at that block.
 *
 * Use case: Snapshot balances at a specific time (e.g. 1771468800) for reconciliation
 * or reporting, using the same balanceOf-at-block pattern as auditFeeCollectorBalances.ts
 * but pinned to a timestamp instead of "latest" or event toBlock.
 *
 * CSV: token_address,symbol,blockchain,amount_raw,amount
 * Chain names in CSV are normalized: ethereum → mainnet, avalanche_c → avalanche, bnb → bsc.
 * Rows with chains not in config/networks.json (e.g. fantom) are skipped.
 *
 * Usage:
 *   bun script/tasks/auditFeeCollectorBalancesAtTimestamp.ts
 *   bun script/tasks/auditFeeCollectorBalancesAtTimestamp.ts --timestamp 1771468800 --output balances.json
 *   bun script/tasks/auditFeeCollectorBalancesAtTimestamp.ts --csv ./audit-feecollector-balances/feeCollectors.csv --output-csv out.csv
 *
 * Options:
 *   --timestamp <unix_seconds>  Target timestamp (default: 1771468800). We use the first block with block.timestamp >= this.
 *   --csv <path>               Path to feeCollectors CSV (default: audit-feecollector-balances/feeCollectors.csv).
 *   --output <path>            Write JSON results here.
 *   --output-csv <path>        Write CSV results here (token_address,symbol,blockchain,block_number,balance_raw).
 *   --concurrency <n>          Max chains in parallel (default: 4). Token fetches per chain are batched.
 */

import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import * as dotenv from 'dotenv'
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
  getContractAddressForNetwork,
  getViemChainForNetworkName,
  networks,
} from '../utils/viemScriptHelpers'

dotenv.config()

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/** CSV chain name → config/networks.json key. ethereum → mainnet; chains not listed are used as-is if they exist in config. */
const CSV_CHAIN_TO_NETWORK: Record<string, string> = {
  ethereum: 'mainnet',
  avalanche_c: 'avalanche',
  bnb: 'bsc',
}

const DEFAULT_TIMESTAMP_SEC = 1771468800
const DEFAULT_CSV_PATH = path.resolve(
  process.cwd(),
  'audit-feecollector-balances/feeCollectors.csv'
)
const BALANCE_FETCH_TIMEOUT_MS = 30_000
/** Total attempts = BALANCE_FETCH_RETRIES + 1 (e.g. 5 tries with 4 retries). */
const BALANCE_FETCH_RETRIES = 4
const BALANCE_FETCH_RETRY_DELAY_MS = 5_000
const DEFAULT_CONCURRENCY = 4

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
])

interface ICsvRow {
  token_address: string
  symbol: string
  blockchain: string
  amount_raw: string
  amount: string
}

interface IBalanceEntry {
  token_address: string
  symbol: string
  blockchain: string
  network: string
  block_number: string
  balance_raw: string
  balance_failed?: boolean
}

/**
 * Returns the first block number (smallest N) where block.timestamp >= timestampSec.
 * Uses binary search over [0, latestBlock], then verifies the chosen block's
 * timestamp so we don't use a block that is before the target (e.g. if RPC and
 * explorer disagree, or chain has odd block times).
 */
async function getBlockNumberAtTimestamp(
  publicClient: PublicClient,
  timestampSec: number
): Promise<bigint> {
  let low = 0n
  const latest = await publicClient.getBlockNumber()
  let high = latest
  let result = latest
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
  const verify = await publicClient.getBlock({ blockNumber: result })
  const verifySec = Number(verify.timestamp)
  if (verifySec < timestampSec && result < latest) {
    result += 1n
  }
  return result
}

function isRetryableBalanceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err).toLowerCase()
  const s = msg.toLowerCase()
  return (
    s.includes('timeout') ||
    s.includes('too long') ||
    s.includes('timed out') ||
    s.includes('econnreset') ||
    s.includes('econnrefused') ||
    s.includes('unknown state') ||
    s.includes('http request failed') ||
    s.includes('status: 400') ||
    s.includes('status: 429') ||
    s.includes('status: 500')
  )
}

/** True if the error is a contract revert (do not retry; we are sure the call failed). */
function isContractRevertError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err).toLowerCase()
  return /revert/i.test(msg) || msg.includes('contract function')
}

async function getBalanceAtBlock(
  publicClient: PublicClient,
  feeCollectorAddress: Address,
  token: Address,
  blockNumber: bigint,
  context?: { networkName: string; symbol?: string }
): Promise<{ balance: bigint; failed: boolean }> {
  const networkLabel = context?.networkName ?? '?'
  if (token === NULL_ADDRESS) {
    let lastErr: unknown
    for (let attempt = 0; attempt <= BALANCE_FETCH_RETRIES; attempt++) {
      try {
        const balance = await publicClient.getBalance({
          address: feeCollectorAddress,
          blockNumber,
        })
        return { balance, failed: false }
      } catch (err) {
        lastErr = err
        if (attempt < BALANCE_FETCH_RETRIES && isRetryableBalanceError(err)) {
          consola.debug(
            `[${networkLabel}] getBalance attempt ${attempt + 1}/${
              BALANCE_FETCH_RETRIES + 1
            } failed at block ${blockNumber}, retrying in ${
              BALANCE_FETCH_RETRY_DELAY_MS / 1000
            }s`
          )
          await new Promise((r) => setTimeout(r, BALANCE_FETCH_RETRY_DELAY_MS))
          continue
        }
        break
      }
    }
    const msg =
      lastErr instanceof Error ? (lastErr as Error).message : String(lastErr)
    consola.warn(
      `[${networkLabel}] getBalance failed for FeeCollector at block ${blockNumber} after ${
        BALANCE_FETCH_RETRIES + 1
      } attempts, marking failed: ${msg}`
    )
    return { balance: 0n, failed: true }
  }
  const label = context?.symbol ? `${context.symbol} (${token})` : token
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
      return { balance, failed: false }
    } catch (err) {
      lastErr = err
      if (isContractRevertError(err)) {
        consola.warn(
          `[${networkLabel}] balanceOf reverted for ${label} at block ${blockNumber}, not retrying`
        )
        return { balance: 0n, failed: true }
      }
      if (attempt < BALANCE_FETCH_RETRIES && isRetryableBalanceError(err)) {
        consola.debug(
          `[${networkLabel}] balanceOf attempt ${attempt + 1}/${
            BALANCE_FETCH_RETRIES + 1
          } failed for ${label}, retrying in ${
            BALANCE_FETCH_RETRY_DELAY_MS / 1000
          }s`
        )
        await new Promise((r) => setTimeout(r, BALANCE_FETCH_RETRY_DELAY_MS))
        continue
      }
      break
    }
  }
  const msg =
    lastErr instanceof Error ? (lastErr as Error).message : String(lastErr)
  consola.warn(
    `[${networkLabel}] balanceOf failed for ${label} at block ${blockNumber} after ${
      BALANCE_FETCH_RETRIES + 1
    } attempts, marking failed (not treating as 0): ${msg}`
  )
  return { balance: 0n, failed: true }
}

function normalizeNetworkName(csvBlockchain: string): string | null {
  const normalized = CSV_CHAIN_TO_NETWORK[csvBlockchain] ?? csvBlockchain
  return networks[normalized] ? normalized : null
}

function parseCsv(csvPath: string): ICsvRow[] {
  const content = fs.readFileSync(csvPath, 'utf-8')
  const lines = content.split(/\r?\n/).filter((line) => line.trim())
  const firstLine = lines[0]
  if (lines.length < 2 || !firstLine) return []
  const header = firstLine.toLowerCase().split(',')
  const tokenIdx = header.indexOf('token_address')
  const symbolIdx = header.indexOf('symbol')
  const chainIdx = header.indexOf('blockchain')
  const amountRawIdx = header.indexOf('amount_raw')
  const amountIdx = header.indexOf('amount')
  if (
    tokenIdx === -1 ||
    symbolIdx === -1 ||
    chainIdx === -1 ||
    amountRawIdx === -1 ||
    amountIdx === -1
  ) {
    throw new Error(
      `CSV must have columns: token_address, symbol, blockchain, amount_raw, amount. Got: ${lines[0]}`
    )
  }
  const rows: ICsvRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const parts = line.split(',')
    if (parts.length <= Math.max(tokenIdx, symbolIdx, chainIdx)) continue
    const token = parts[tokenIdx]?.trim()
    const blockchain = parts[chainIdx]?.trim()
    if (!token || !blockchain || !token.startsWith('0x')) continue
    rows.push({
      token_address: token,
      symbol: parts[symbolIdx]?.trim() ?? '',
      blockchain,
      amount_raw: parts[amountRawIdx]?.trim() ?? '',
      amount: parts[amountIdx]?.trim() ?? '',
    })
  }
  return rows
}

/** Rows in CSV order with normalized network (null if chain not in config). Used to preserve output order. */
interface ICsvOrderedRow {
  network: string | null
  token: string
  symbol: string
  blockchain: string
}

/** Unique (network, token) from CSV rows for fetching; only rows where blockchain maps to a known network. */
function getUniqueNetworkTokens(
  rows: ICsvRow[]
): Array<{ network: string; token: string; symbol: string }> {
  const seen = new Set<string>()
  const out: Array<{ network: string; token: string; symbol: string }> = []
  for (const row of rows) {
    const network = normalizeNetworkName(row.blockchain)
    if (!network) continue
    const key = `${network}:${getAddress(row.token_address)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      network,
      token: getAddress(row.token_address),
      symbol: row.symbol,
    })
  }
  return out
}

/** Build CSV-ordered list of rows with normalized network (null = skipped chain). */
function getCsvOrderedRows(rows: ICsvRow[]): ICsvOrderedRow[] {
  return rows.map((row) => ({
    network: normalizeNetworkName(row.blockchain),
    token: getAddress(row.token_address),
    symbol: row.symbol,
    blockchain: row.blockchain,
  }))
}

function balanceMapKey(network: string, token: string): string {
  return `${network}:${getAddress(token)}`
}

async function runForNetwork(
  networkName: string,
  timestampSec: number,
  entries: Array<{ network: string; token: string; symbol: string }>
): Promise<IBalanceEntry[]> {
  let feeCollectorAddress: Address
  try {
    const addr = await getContractAddressForNetwork(
      'FeeCollector',
      networkName as SupportedChain,
      EnvironmentEnum.production
    )
    if (typeof addr !== 'string' || !addr.startsWith('0x')) {
      consola.warn(`[${networkName}] No FeeCollector deployment, skipping`)
      return []
    }
    feeCollectorAddress = getAddress(addr) as Address
  } catch {
    consola.warn(
      `[${networkName}] FeeCollector not deployed or lookup failed, skipping`
    )
    return []
  }
  const chain = getViemChainForNetworkName(networkName)
  const rpcUrl = chain.rpcUrls.default.http[0]
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: BALANCE_FETCH_TIMEOUT_MS }),
  })

  const blockNumber = await getBlockNumberAtTimestamp(
    publicClient,
    timestampSec
  )
  consola.info(
    `[${networkName}] Block at timestamp ${timestampSec}: ${blockNumber}`
  )

  const results: IBalanceEntry[] = []
  for (const { token, symbol } of entries) {
    const { balance, failed } = await getBalanceAtBlock(
      publicClient,
      feeCollectorAddress,
      token as Address,
      blockNumber,
      { networkName, symbol }
    )
    results.push({
      token_address: token,
      symbol,
      blockchain: networkName,
      network: networkName,
      block_number: blockNumber.toString(),
      balance_raw: balance.toString(),
      ...(failed && { balance_failed: true }),
    })
  }
  return results
}

const main = defineCommand({
  meta: {
    name: 'auditFeeCollectorBalancesAtTimestamp',
    description:
      'Fetch FeeCollector token balances at a given Unix timestamp (per-chain block at or after that time).',
  },
  args: {
    timestamp: {
      type: 'string',
      description:
        'Unix timestamp (seconds). First block with timestamp >= this is used.',
      default: String(DEFAULT_TIMESTAMP_SEC),
    },
    csv: {
      type: 'string',
      description: 'Path to feeCollectors CSV',
      default: DEFAULT_CSV_PATH,
    },
    output: {
      type: 'string',
      description: 'Write JSON results to this path',
    },
    outputCsv: {
      type: 'string',
      description: 'Write CSV results to this path',
      alias: 'output-csv',
    },
    concurrency: {
      type: 'string',
      description: 'Max chains to process in parallel',
      default: String(DEFAULT_CONCURRENCY),
    },
  },
  run: async ({ args }) => {
    const timestampSec = parseInt(args.timestamp, 10)
    if (Number.isNaN(timestampSec) || timestampSec < 0) {
      consola.error('--timestamp must be a non-negative integer (Unix seconds)')
      process.exit(1)
    }
    const csvPath = path.resolve(process.cwd(), args.csv)
    if (!fs.existsSync(csvPath)) {
      consola.error(`CSV not found: ${csvPath}`)
      process.exit(1)
    }
    const concurrency = Math.max(
      1,
      parseInt(args.concurrency, 10) || DEFAULT_CONCURRENCY
    )

    consola.info(`Reading CSV: ${csvPath}`)
    const rows = parseCsv(csvPath)
    const csvOrderedRows = getCsvOrderedRows(rows)
    const unique = getUniqueNetworkTokens(rows)
    const byNetwork = new Map<
      string,
      Array<{ network: string; token: string; symbol: string }>
    >()
    for (const u of unique) {
      const list = byNetwork.get(u.network) ?? []
      list.push(u)
      byNetwork.set(u.network, list)
    }

    const skippedChains = new Set<string>()
    for (const row of rows) {
      const b = row.blockchain
      if (!normalizeNetworkName(b)) skippedChains.add(b)
    }
    if (skippedChains.size > 0) {
      consola.warn(
        `Chains not in config/networks.json (rows skipped): ${[...skippedChains]
          .sort()
          .join(', ')}`
      )
    }

    consola.info(
      `Networks to query: ${[...byNetwork.keys()].sort().join(', ')} (${
        unique.length
      } unique token entries)`
    )

    const networkNames = [...byNetwork.keys()].sort()
    const balanceByKey = new Map<string, IBalanceEntry>()
    for (let i = 0; i < networkNames.length; i += concurrency) {
      const chunk = networkNames.slice(i, i + concurrency)
      const promises = chunk.map((networkName) => {
        const entries = byNetwork.get(networkName) ?? []
        return runForNetwork(networkName, timestampSec, entries)
      })
      const settled = await Promise.allSettled(promises)
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j]
        const networkName = chunk[j]
        if (!s || !networkName) continue
        if (s.status === 'fulfilled') {
          for (const entry of s.value) {
            balanceByKey.set(
              balanceMapKey(entry.network, entry.token_address),
              entry
            )
          }
        } else if (s.status === 'rejected') {
          consola.error(
            `[${networkName}] Chain failed, no balances collected: ${
              s.reason instanceof Error ? s.reason.message : String(s.reason)
            }`
          )
        }
      }
    }

    const allResults: IBalanceEntry[] = []
    for (const row of csvOrderedRows) {
      if (row.network) {
        const entry = balanceByKey.get(balanceMapKey(row.network, row.token))
        if (entry) {
          allResults.push({
            token_address: row.token,
            symbol: row.symbol,
            blockchain: row.blockchain,
            network: row.network,
            block_number: entry.block_number,
            balance_raw: entry.balance_raw,
            ...(entry.balance_failed && { balance_failed: true }),
          })
        } else {
          allResults.push({
            token_address: row.token,
            symbol: row.symbol,
            blockchain: row.blockchain,
            network: row.network,
            block_number: '0',
            balance_raw: '0',
            balance_failed: true,
          })
        }
      } else {
        allResults.push({
          token_address: row.token,
          symbol: row.symbol,
          blockchain: row.blockchain,
          network: '',
          block_number: '',
          balance_raw: '0',
          balance_failed: true,
        })
      }
    }

    consola.info(
      `Fetched ${balanceByKey.size} balances, output ${allResults.length} rows (CSV order)`
    )

    if (args.output) {
      const outPath = path.resolve(process.cwd(), args.output)
      fs.writeFileSync(
        outPath,
        JSON.stringify(
          { timestamp_sec: timestampSec, balances: allResults },
          null,
          2
        ),
        'utf-8'
      )
      consola.info(`Wrote JSON: ${outPath}`)
    }
    if (args.outputCsv) {
      const outPath = path.resolve(process.cwd(), args.outputCsv)
      const header =
        'token_address,symbol,blockchain,block_number,balance_raw,balance_failed'
      const lines = [
        header,
        ...allResults.map((r) =>
          [
            r.token_address,
            r.symbol,
            r.blockchain,
            r.block_number,
            r.balance_raw,
            r.balance_failed === true ? '1' : '0',
          ].join(',')
        ),
      ]
      fs.writeFileSync(outPath, lines.join('\n'), 'utf-8')
      consola.info(`Wrote CSV: ${outPath}`)
    }
    if (!args.output && !args.outputCsv) {
      consola.log(
        JSON.stringify(
          { timestamp_sec: timestampSec, balances: allResults },
          null,
          2
        )
      )
    }
  },
})

runMain(main)
