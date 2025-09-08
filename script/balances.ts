#!/usr/bin/env bun

import chalk from 'chalk'
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
  balanceThreshold?: number
}

interface IBalanceResult {
  network: string
  chainId: number
  nativeCurrency: string
  balance: string
  formattedBalance: string
  threshold?: number
  isBelowThreshold?: boolean
  error?: string
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
      threshold: network.balanceThreshold,
      isBelowThreshold:
        network.balanceThreshold !== undefined
          ? balanceInTrx < network.balanceThreshold
          : undefined,
    }
  } catch (error) {
    return {
      network: network.name,
      chainId: network.chainId,
      nativeCurrency: network.nativeCurrency,
      balance: '0',
      formattedBalance: '0',
      threshold: network.balanceThreshold,
      isBelowThreshold:
        network.balanceThreshold !== undefined ? true : undefined,
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
    const balanceNum = parseFloat(formattedBalance)

    return {
      network: network.name,
      chainId: network.chainId,
      nativeCurrency: network.nativeCurrency,
      balance: balance.toString(),
      formattedBalance: formattedBalance,
      threshold: network.balanceThreshold,
      isBelowThreshold:
        network.balanceThreshold !== undefined
          ? balanceNum < network.balanceThreshold
          : undefined,
    }
  } catch (error) {
    return {
      network: network.name,
      chainId: network.chainId,
      nativeCurrency: network.nativeCurrency,
      balance: '0',
      formattedBalance: '0',
      threshold: network.balanceThreshold,
      isBelowThreshold:
        network.balanceThreshold !== undefined ? true : undefined,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

function printMonitoringResults(results: IBalanceResult[]) {
  const belowThresholdNetworks = results.filter(
    (r) => !r.error && r.isBelowThreshold
  )

  if (belowThresholdNetworks.length === 0) {
    console.log(chalk.green('\n✅ All networks have sufficient balance'))
    return
  }

  console.log(
    chalk.red(
      `\n⚠️  ${belowThresholdNetworks.length} network(s) below threshold:\n`
    )
  )
  console.log('─'.repeat(90))
  console.log(
    `${chalk.bold('Network'.padEnd(20))} ${chalk.bold(
      'Currency'.padEnd(10)
    )} ${chalk.bold('Current Balance'.padStart(20))} ${chalk.bold(
      'Threshold'.padStart(20)
    )} ${chalk.bold('Deficit'.padStart(20))}`
  )
  console.log('─'.repeat(90))

  belowThresholdNetworks
    .sort((a, b) => {
      // Sort by deficit ratio (how much below threshold)
      const deficitA = (a.threshold || 0) - parseFloat(a.formattedBalance)
      const deficitB = (b.threshold || 0) - parseFloat(b.formattedBalance)
      return deficitB - deficitA
    })
    .forEach((result) => {
      const balance = parseFloat(result.formattedBalance)
      const threshold = result.threshold || 0
      const deficit = threshold - balance

      console.log(
        `${result.network.padEnd(20)} ${result.nativeCurrency.padEnd(
          10
        )} ${chalk.red(balance.toFixed(6).padStart(20))} ${threshold
          .toFixed(6)
          .padStart(20)} ${chalk.yellow(deficit.toFixed(6).padStart(20))}`
      )
    })

  console.log('─'.repeat(90))

  // Calculate total funding needed (rough estimate in USD terms)
  console.log('\n📊 Summary:')
  console.log(`  Networks below threshold: ${belowThresholdNetworks.length}`)

  // Group by currency for summary
  const byCurrency = belowThresholdNetworks.reduce((acc, net) => {
    const currency = net.nativeCurrency
    if (!acc[currency]) 
      acc[currency] = []
    
    acc[currency].push(net)
    return acc
  }, {} as Record<string, IBalanceResult[]>)

  console.log('\n  By currency:')
  Object.entries(byCurrency).forEach(([currency, networks]) => {
    const totalDeficit = networks.reduce((sum, net) => {
      const deficit = (net.threshold || 0) - parseFloat(net.formattedBalance)
      return sum + deficit
    }, 0)
    console.log(
      `    ${currency}: ${
        networks.length
      } network(s), total deficit: ${totalDeficit.toFixed(6)}`
    )
  })

  // Exit with error code if any networks are below threshold
  process.exit(1)
}

function printTable(results: IBalanceResult[], monitorMode = false) {
  // Sort results by network name
  const sortedResults = [...results].sort((a, b) =>
    a.network.localeCompare(b.network)
  )

  // Filter out networks with errors for the main table
  const successfulResults = sortedResults.filter((r) => !r.error)

  if (!monitorMode) {
    console.log('\nBalance Results:')
    console.log('─'.repeat(70))
    console.log(
      `${chalk.bold('Network'.padEnd(20))} ${chalk.bold(
        'Chain ID'.padEnd(12)
      )} ${chalk.bold('Currency'.padEnd(10))} ${chalk.bold(
        'Balance'.padStart(20)
      )}`
    )
    console.log('─'.repeat(70))

    successfulResults.forEach((result) => {
      const balance = parseFloat(result.formattedBalance)
      const formattedBalance = balance.toFixed(6)

      // Color balances: red for zero or below threshold, yellow for near threshold, green for healthy
      let coloredBalance
      if (result.isBelowThreshold) 
        coloredBalance = chalk.red(formattedBalance.padStart(20))
       else if (result.threshold && balance < result.threshold * 1.5) 
        coloredBalance = chalk.yellow(formattedBalance.padStart(20))
       else if (balance === 0) 
        coloredBalance = chalk.red(formattedBalance.padStart(20))
       else 
        coloredBalance = chalk.green(formattedBalance.padStart(20))
      

      console.log(
        `${result.network.padEnd(20)} ${result.chainId
          .toString()
          .padEnd(12)} ${result.nativeCurrency.padEnd(10)} ${coloredBalance}`
      )
    })
    console.log('─'.repeat(70))
  }

  // Summary
  const successCount = results.filter((r) => !r.error).length
  const errorCount = results.filter((r) => r.error).length
  const nonZeroBalances = results.filter(
    (r) => !r.error && parseFloat(r.formattedBalance) > 0
  )
  const belowThresholdNetworks = results.filter(
    (r) => !r.error && r.isBelowThreshold
  )

  if (!monitorMode) {
    console.log('\nSummary:')
    console.log(`  Total chains checked: ${results.length}`)
    console.log(`  Successful queries: ${successCount}`)
    console.log(`  Failed queries: ${errorCount}`)
    console.log(`  Chains with non-zero balance: ${nonZeroBalances.length}`)
    if (belowThresholdNetworks.length > 0) 
      console.log(
        chalk.red(
          `  ⚠️  Chains below threshold: ${belowThresholdNetworks.length}`
        )
      )
    
  }

  // Print unsuccessful networks
  const failedNetworks = results.filter((r) => r.error)
  if (failedNetworks.length > 0 && !monitorMode) {
    console.log('\nUnsuccessful networks:')
    failedNetworks.forEach((result) => {
      console.log(`  - ${result.network}: ${result.error}`)
    })
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
    'monitor-balances': {
      type: 'boolean',
      description: 'Monitor mode: show only networks below threshold',
      default: false,
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

    if (args['monitor-balances']) 
      consola.info(`🔍 Monitoring balances for address: ${address}`)
     else 
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

    if (!args['monitor-balances']) 
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
              threshold: network.balanceThreshold,
              isBelowThreshold:
                network.balanceThreshold !== undefined ? true : undefined,
              error: 'Failed to initialize TronWeb',
            }
          }
        else return getEvmBalance(network, address)
      })

      const batchResults = await Promise.all(promises)
      results.push(...batchResults)
    }
    // Fetch balances sequentially
    else
      for (const network of networks) {
        if (!args['monitor-balances']) 
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
              threshold: network.balanceThreshold,
              isBelowThreshold:
                network.balanceThreshold !== undefined ? true : undefined,
              error: 'Failed to initialize TronWeb',
            }
          }
        else result = await getEvmBalance(network, address)

        results.push(result)

        if (!args['monitor-balances']) 
          if (result.error) consola.fail(`${network.name}: Error`)
          else if (parseFloat(result.formattedBalance) > 0)
            consola.success(
              `${network.name}: ${result.formattedBalance} ${network.nativeCurrency}`
            )
          else consola.info(`${network.name}: 0 ${network.nativeCurrency}`)
        
      }

    // Print results based on mode
    if (args['monitor-balances']) 
      printMonitoringResults(results)
     else 
      printTable(results)
    
  },
})

runMain(main)
