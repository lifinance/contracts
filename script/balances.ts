#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { TronWeb } from 'tronweb'
import {
  createPublicClient,
  http,
  formatEther,
  isAddress as isValidEvmAddress,
} from 'viem'

import networksConfig from '../config/networks.json'

import { initTronWeb } from './troncast/utils/tronweb'
import { node_url } from './utils/network'

// Load networks configuration

interface INetworkConfig {
  name: string
  chainId: number
  nativeAddress: string
  nativeCurrency: string
  wrappedNativeAddress: string
  status: string
  type: string
  rpcUrl: string
  verificationType: string
  explorerUrl: string
  explorerApiUrl: string
  multicallAddress: string
  safeAddress: string
  gasZipChainId: number
  isZkEVM: boolean
  deployedWithEvmVersion: string
  deployedWithSolcVersion: string
  create3Factory?: string
  devNotes?: string
}

interface IBalanceResult {
  network: string
  chainId: number
  nativeCurrency: string
  balance: string
  formattedBalance: string
  error?: string
}

interface ITableRow {
  Network: string
  'Chain ID': number
  Currency: string
  Balance: string
  Status: string
}

async function getTronBalance(
  tronWeb: TronWeb,
  address: string,
  network: INetworkConfig
): Promise<IBalanceResult> {
  try {
    // Convert EVM address to Tron address if needed
    const tronAddress = address.startsWith('0x')
      ? tronWeb.address.fromHex(address)
      : address

    // Get TRX balance (in SUN, 1 TRX = 1,000,000 SUN)
    const balanceInSun = await tronWeb.trx.getBalance(tronAddress)
    const balanceInTrx = balanceInSun / 1_000_000

    return {
      network: network.name,
      chainId: network.chainId,
      nativeCurrency: network.nativeCurrency,
      balance: balanceInSun.toString(),
      formattedBalance: balanceInTrx.toFixed(6),
    }
  } catch (error) {
    return {
      network: network.name,
      chainId: network.chainId,
      nativeCurrency: network.nativeCurrency,
      balance: '0',
      formattedBalance: '0',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

async function getEvmBalance(
  network: INetworkConfig,
  address: string
): Promise<IBalanceResult> {
  try {
    // Try to get RPC URL from environment variable first, fallback to networks.json
    const rpcUrl = node_url(network.name) || network.rpcUrl

    const client = createPublicClient({
      transport: http(rpcUrl, {
        timeout: 10_000,
        retryCount: 2,
        retryDelay: 1000,
      }),
    })

    const balance = await client.getBalance({
      address: address as `0x${string}`,
    })

    const formattedBalance = formatEther(balance)

    return {
      network: network.name,
      chainId: network.chainId,
      nativeCurrency: network.nativeCurrency,
      balance: balance.toString(),
      formattedBalance: formattedBalance,
    }
  } catch (error) {
    return {
      network: network.name,
      chainId: network.chainId,
      nativeCurrency: network.nativeCurrency,
      balance: '0',
      formattedBalance: '0',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

function printTable(results: IBalanceResult[]) {
  // Sort results by network name
  const sortedResults = [...results].sort((a, b) =>
    a.network.localeCompare(b.network)
  )

  // Convert to table format
  const tableData: ITableRow[] = sortedResults.map((result) => ({
    Network: result.network,
    'Chain ID': result.chainId,
    Currency: result.nativeCurrency,
    Balance: parseFloat(result.formattedBalance).toFixed(6),
    Status: result.error
      ? `Error: ${result.error.substring(0, 30)}...`
      : 'Success',
  }))

  console.log('\nBalance Results:')
  console.table(tableData)

  // Summary
  const successCount = results.filter((r) => !r.error).length
  const errorCount = results.filter((r) => r.error).length
  const nonZeroBalances = results.filter(
    (r) => !r.error && parseFloat(r.formattedBalance) > 0
  )

  console.log('\nSummary:')
  console.log(`  Total chains checked: ${results.length}`)
  console.log(`  Successful queries: ${successCount}`)
  console.log(`  Failed queries: ${errorCount}`)
  console.log(`  Chains with non-zero balance: ${nonZeroBalances.length}`)

  if (nonZeroBalances.length > 0) {
    console.log('\nNon-zero balances:')
    const nonZeroTable = nonZeroBalances.map((result) => ({
      Network: result.network,
      Balance: `${parseFloat(result.formattedBalance).toFixed(6)} ${
        result.nativeCurrency
      }`,
    }))
    console.table(nonZeroTable)
  }
}

const main = defineCommand({
  meta: {
    name: 'balances',
    description: 'Fetch balances across all supported chains',
  },
  args: {
    address: {
      type: 'positional',
      description: 'The address to check balances for',
      required: true,
    },
    filter: {
      type: 'string',
      description: 'Filter networks by name (partial match)',
      required: false,
    },
    parallel: {
      type: 'boolean',
      description:
        'Fetch balances in parallel (faster but may hit rate limits)',
      default: true,
    },
  },
  async run({ args }) {
    const address = args.address as string

    // Validate address format
    if (!address || (!isValidEvmAddress(address) && !address.startsWith('T'))) {
      consola.error(
        'Invalid address format. Please provide a valid EVM or Tron address.'
      )
      process.exit(1)
    }

    consola.info(`Fetching balances for address: ${address}`)

    // Filter networks
    const networks = Object.entries(
      networksConfig as Record<string, INetworkConfig>
    )
      .filter(([name, config]) => {
        // Skip localanvil
        if (name === 'localanvil') return false
        // Skip inactive networks
        if (config.status !== 'active') return false
        // Apply custom filter if provided
        if (args.filter) 
          return name.toLowerCase().includes(args.filter.toLowerCase())
        
        return true
      })
      .map(([_, config]) => config)

    if (networks.length === 0) {
      consola.error('No networks found matching the criteria')
      process.exit(1)
    }

    consola.info(`Checking ${networks.length} networks...`)

    const results: IBalanceResult[] = []

    if (args.parallel) {
      // Fetch balances in parallel
      const promises = networks.map(async (network) => {
        if (network.name === 'tron' || network.name === 'tronshasta') 
          try {
            const env = network.name === 'tron' ? 'mainnet' : 'testnet'
            // initTronWeb will use environment variables if rpcUrl is not provided
            const tronWeb = initTronWeb(env as any, undefined)
            return await getTronBalance(tronWeb, address, network)
          } catch (error) {
            return {
              network: network.name,
              chainId: network.chainId,
              nativeCurrency: network.nativeCurrency,
              balance: '0',
              formattedBalance: '0',
              error: 'Failed to initialize TronWeb',
            }
          }
         else 
          return getEvmBalance(network, address)
        
      })

      const batchResults = await Promise.all(promises)
      results.push(...batchResults)
    } else 
      // Fetch balances sequentially
      for (const network of networks) {
        consola.start(`Checking ${network.name}...`)

        let result: IBalanceResult
        if (network.name === 'tron' || network.name === 'tronshasta') 
          try {
            const env = network.name === 'tron' ? 'mainnet' : 'testnet'
            // initTronWeb will use environment variables if rpcUrl is not provided
            const tronWeb = initTronWeb(env as any, undefined)
            result = await getTronBalance(tronWeb, address, network)
          } catch (error) {
            result = {
              network: network.name,
              chainId: network.chainId,
              nativeCurrency: network.nativeCurrency,
              balance: '0',
              formattedBalance: '0',
              error: 'Failed to initialize TronWeb',
            }
          }
         else 
          result = await getEvmBalance(network, address)
        

        results.push(result)

        if (result.error) 
          consola.fail(`${network.name}: Error`)
         else if (parseFloat(result.formattedBalance) > 0) 
          consola.success(
            `${network.name}: ${result.formattedBalance} ${network.nativeCurrency}`
          )
         else 
          consola.info(`${network.name}: 0 ${network.nativeCurrency}`)
        
      }
    

    // Print results table
    printTable(results)
  },
})

runMain(main)
