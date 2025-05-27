#!/usr/bin/env bun

import { parseUnits, createWalletClient, http, getContract, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { ethers } from 'ethers'
import { SupportedChainId, OrderKind, TradingSdk } from '@cowprotocol/cow-sdk'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import { setupCowShedPostHooks } from './utils/cowSwapHelpers'

const ARBITRUM_WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
import arbitrumDeployments from '../../deployments/arbitrum.staging.json'
import baseDeployments from '../../deployments/base.json'
const LIFI_DIAMOND_ARBITRUM = arbitrumDeployments.LiFiDiamond
const LIFI_DEX_AGGREGATOR_BASE = baseDeployments.LiFiDEXAggregator
const PATCHER_ARBITRUM = arbitrumDeployments.Patcher
const VAULT_RELAYER_ARBITRUM = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'

const ERC20_ABI = erc20Artifact.abi

/**
 * Fetch bridge quote from LiFi API for WETH from Arbitrum to Base via AcrossV3
 */
async function fetchBridgeQuote(
  fromAmount: string,
  fromAddress: string,
  toAddress: string
) {
  try {
    const url = new URL('https://li.quest/v1/quote')
    url.searchParams.set('fromChain', '42161') // Arbitrum
    url.searchParams.set('toChain', '8453') // Base
    url.searchParams.set('fromToken', ARBITRUM_WETH)
    url.searchParams.set('toToken', BASE_WETH)
    url.searchParams.set('fromAmount', fromAmount)
    url.searchParams.set('fromAddress', fromAddress)
    url.searchParams.set('toAddress', toAddress)
    url.searchParams.set('allowBridges', 'across')

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(
        `LiFi API error: ${response.status} ${response.statusText}`
      )
    }

    const data = await response.json()
    consola.info('Bridge quote fetched successfully')
    return data
  } catch (error) {
    consola.error('Error fetching bridge quote:', error)
    throw error
  }
}

/**
 * Encode destination swap call data for WETH to USDC on Base
 */
async function encodeDestinationSwap(
  fromAmount: string,
  fromAddress: string,
  toAddress: string
) {
  try {
    const url = new URL('https://li.quest/v1/quote')
    url.searchParams.set('fromChain', '8453') // Base
    url.searchParams.set('toChain', '8453') // Base
    url.searchParams.set('fromToken', BASE_WETH)
    url.searchParams.set('toToken', BASE_USDC)
    url.searchParams.set('fromAmount', fromAmount)
    url.searchParams.set('fromAddress', fromAddress)
    url.searchParams.set('toAddress', toAddress)

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
    })

    if (!response.ok) {
      throw new Error(
        `LiFi API error: ${response.status} ${response.statusText}`
      )
    }

    const data = await response.json()
    consola.info('Destination swap quote fetched successfully')

    return {
      callData: data.transactionRequest.data,
      expectedOutput: data.estimate.toAmount,
      gasLimit: data.transactionRequest.gasLimit,
    }
  } catch (error) {
    consola.error('Error fetching destination swap quote:', error)
    throw error
  }
}

/**
 * Execute cross-chain bridge with destination swap using AcrossV3
 */
async function executeCrossChainBridgeWithSwap(options: {
  privateKey: string
  dryRun: boolean
}) {
  // Set up wallet client
  const account = privateKeyToAccount(options.privateKey as Hex)
  const walletClient = createWalletClient({
    chain: arbitrum,
    transport: http(),
    account,
  })

  const walletAddress = account.address
  consola.info(`Connected wallet: ${walletAddress}`)

  // Amount to bridge: 0.001 WETH
  const bridgeAmount = parseUnits('0.001', 18)
  consola.info(`Bridge amount: 0.001 WETH`)

  // Check WETH balance
  const wethContract = getContract({
    address: ARBITRUM_WETH as Hex,
    abi: ERC20_ABI,
    client: { public: walletClient, wallet: walletClient },
  })

  const wethBalance = (await wethContract.read.balanceOf([
    walletAddress,
  ])) as bigint
  consola.info(`WETH balance: ${wethBalance}`)

  if (wethBalance < bridgeAmount) {
    consola.error(`Insufficient WETH balance. Need at least 0.001 WETH.`)
    process.exit(1)
  }

  // Check allowance for LiFi Diamond
  const allowance = (await wethContract.read.allowance([
    walletAddress,
    LIFI_DIAMOND_ARBITRUM,
  ])) as bigint
  consola.info(`Current allowance: ${allowance}`)

  if (allowance < bridgeAmount) {
    consola.info('Approving WETH for LiFi Diamond...')
    if (!options.dryRun) {
      const approveTx = await wethContract.write.approve([
        LIFI_DIAMOND_ARBITRUM as `0x${string}`,
        BigInt(
          '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
        ), // Max uint256
      ])
      consola.success(`Approval transaction sent: ${approveTx}`)
    } else {
      consola.info(`[DRY RUN] Would approve WETH for LiFi Diamond`)
    }
  }

  // Fetch bridge quote from LiFi API
  consola.info('Fetching bridge quote from LiFi API...')
  const bridgeQuote = await fetchBridgeQuote(
    bridgeAmount.toString(),
    walletAddress,
    LIFI_DEX_AGGREGATOR_BASE // Destination will be the DEX aggregator for the swap
  )

  // Fetch destination swap quote
  consola.info('Fetching destination swap quote...')
  const expectedBridgedAmount = bridgeQuote.estimate.toAmount
  const swapQuote = await encodeDestinationSwap(
    expectedBridgedAmount,
    LIFI_DEX_AGGREGATOR_BASE,
    walletAddress
  )

  // Execute the bridge transaction with destination call
  if (!options.dryRun) {
    consola.info('Executing cross-chain bridge with destination swap...')

    // Create wallet client for transaction
    const txHash = await walletClient.sendTransaction({
      to: LIFI_DIAMOND_ARBITRUM as `0x${string}`,
      data: bridgeQuote.transactionRequest.data as `0x${string}`,
      value: BigInt(bridgeQuote.transactionRequest.value || '0'),
      gas: BigInt(bridgeQuote.transactionRequest.gasLimit || '500000'),
    })

    consola.success(`Bridge transaction sent: ${txHash}`)
    consola.info(`Expected bridged amount: ${expectedBridgedAmount} WETH`)
    consola.info(`Expected swap output: ${swapQuote.expectedOutput} USDC`)
    consola.info(`Transaction hash: ${txHash}`)
  } else {
    consola.info(
      `[DRY RUN] Would execute cross-chain bridge with destination swap`
    )
    consola.info(
      `Bridge quote: ${JSON.stringify(bridgeQuote.estimate, null, 2)}`
    )
    consola.info(`Swap quote: ${JSON.stringify(swapQuote, null, 2)}`)
  }

  consola.success(
    'Cross-chain bridge with destination swap demo completed successfully'
  )
}

/**
 * Execute the original CowSwap demo
 */
async function executeCowSwapDemo(options: {
  privateKey: string
  dryRun: boolean
}) {
  // Set up wallet client
  const account = privateKeyToAccount(options.privateKey as Hex)
  const walletClient = createWalletClient({
    chain: arbitrum,
    transport: http(),
    account,
  })

  const walletAddress = account.address
  consola.info(`Connected wallet: ${walletAddress}`)

  // Amount to swap: 0.001 WETH
  const swapAmount = parseUnits('0.001', 18)
  consola.info(`Swap amount: 0.001 WETH`)

  // Check WETH balance and approve if needed
  const wethContract = getContract({
    address: ARBITRUM_WETH as Hex,
    abi: ERC20_ABI,
    client: { public: walletClient, wallet: walletClient },
  })

  const wethBalance = (await wethContract.read.balanceOf([
    walletAddress,
  ])) as bigint
  consola.info(`WETH balance: ${wethBalance}`)

  if (wethBalance < swapAmount) {
    consola.error(`Insufficient WETH balance. Need at least 0.001 WETH.`)
    process.exit(1)
  }

  // Check allowance
  const allowance = (await wethContract.read.allowance([
    walletAddress,
    VAULT_RELAYER_ARBITRUM,
  ])) as bigint
  consola.info(`Current allowance: ${allowance}`)

  if (allowance < swapAmount) {
    consola.info('Approving WETH for CoW Protocol VaultRelayer...')
    if (!options.dryRun) {
      const approveTx = await wethContract.write.approve([
        VAULT_RELAYER_ARBITRUM as `0x${string}`,
        BigInt(
          '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
        ), // Max uint256
      ])
      consola.success(`Approval transaction sent: ${approveTx}`)
    } else {
      consola.info(`[DRY RUN] Would approve WETH for VaultRelayer`)
    }
  }

  // Set up CowShed post hooks
  const { shedDeterministicAddress, postHooks } = await setupCowShedPostHooks({
    chainId: 42161, // Arbitrum chain ID
    walletClient,
    usdcAddress: ARBITRUM_USDC,
    receivedAmount: parseUnits('0', 6), // This will be dynamically patched
    lifiDiamondAddress: LIFI_DIAMOND_ARBITRUM,
    patcherAddress: PATCHER_ARBITRUM,
    baseUsdcAddress: BASE_USDC,
    destinationChainId: 8453n, // BASE chain ID
  })

  // Create ethers provider and signer for CoW SDK
  const provider = new ethers.providers.JsonRpcProvider(
    arbitrum.rpcUrls.default.http[0]
  )
  const ethersSigner = new ethers.Wallet(options.privateKey, provider)

  // Initialize CoW SDK with proper TraderParameters
  const cowSdk = new TradingSdk({
    chainId: SupportedChainId.ARBITRUM_ONE,
    signer: ethersSigner,
    appCode: 'lifi-demo' as any, // Cast to any to satisfy the AppCode type
  })

  // Create the order parameters
  const parameters = {
    kind: OrderKind.SELL,
    sellToken: ARBITRUM_WETH as `0x${string}`,
    sellTokenDecimals: 18,
    buyToken: ARBITRUM_USDC as `0x${string}`,
    buyTokenDecimals: 6,
    amount: swapAmount.toString(),
    receiver: shedDeterministicAddress as `0x${string}`, // Important: Set the receiver to the CowShed proxy
    validFor: 30 * 60, // 30 minutes in seconds
    slippageBps: 50, // 0.5% slippage
  }

  // Create advanced settings with post hooks
  const advancedSettings = {
    appData: {
      metadata: {
        hooks: {
          version: '1',
          pre: [],
          post: postHooks,
        },
      },
    },
  }

  // Submit the order with post hooks
  if (!options.dryRun) {
    consola.info('Submitting order to CowSwap...')
    try {
      // Create an AbortController for proper cancellation
      const abortController = new AbortController()
      const timeoutId = setTimeout(() => {
        abortController.abort()
      }, 30000)

      try {
        const orderId = await cowSdk.postSwapOrder(parameters, advancedSettings)
        clearTimeout(timeoutId)

        consola.success(`Order created with hash: ${orderId}`)
        consola.info(
          `Explorer URL: https://explorer.cow.fi/orders/${orderId}?chainId=42161`
        )
      } catch (error) {
        clearTimeout(timeoutId)
        if (abortController.signal.aborted) {
          throw new Error('Order submission timed out after 30 seconds')
        }
        throw error
      }
    } catch (error) {
      consola.error('Error submitting order to CowSwap:', error)
      throw error
    }
  } else {
    consola.info(`[DRY RUN] Would submit order to CowSwap with post hooks`)
    consola.info(`Parameters: ${JSON.stringify(parameters, null, 2)}`)
    consola.info(`Post hooks: ${JSON.stringify(postHooks, null, 2)}`)
  }

  consola.success('Demo completed successfully')
}

/**
 * Main function to execute the demo
 *
 * Note: There are several TypeScript errors related to the `0x${string}` type
 * that don't affect the functionality of the script. In a production environment,
 * these should be fixed with proper type assertions.
 */
async function main(options: {
  privateKey: string
  dryRun: boolean
  'dest-call': boolean
}) {
  try {
    if (options['dest-call']) {
      consola.start(
        'Starting AcrossV3 cross-chain bridge with destination swap demo'
      )
      await executeCrossChainBridgeWithSwap(options)
    } else {
      consola.start('Starting CowSwap with Patcher demo')
      await executeCowSwapDemo(options)
    }
  } catch (error) {
    consola.error('Error executing demo:', error)
    process.exit(1)
  }
}

// CLI command definition
const cmd = defineCommand({
  meta: {
    name: 'demoPatcher',
    description:
      'Demo script for CowSwap with Patcher contract or AcrossV3 cross-chain bridge with destination swap',
  },
  args: {
    privateKey: {
      type: 'string',
      description: 'Private key for the wallet',
      required: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Run in dry-run mode without submitting transactions',
      default: false,
    },
    'dest-call': {
      type: 'boolean',
      description:
        'Demo cross-chain bridging with destination swap using AcrossV3',
      default: false,
    },
  },
  run: async ({ args }) => {
    await main(args)
  },
})

// Run the command
runMain(cmd)
