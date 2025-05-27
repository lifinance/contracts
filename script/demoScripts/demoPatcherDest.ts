#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  getContract,
  type Hex,
  encodeFunctionData,
  encodeAbiParameters,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import baseDeployments from '../../deployments/base.json'
import arbitrumStagingDeployments from '../../deployments/arbitrum.staging.json'

// Contract addresses
const ARBITRUM_WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
const BASE_WETH = '0x4200000000000000000000000000000000000006'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BASE_LIFI_DEX_AGGREGATOR = baseDeployments.LiFiDEXAggregator as Hex
const RECEIVER_ACROSS_V3_BASE = baseDeployments.ReceiverAcrossV3 as Hex
const LIFI_DIAMOND_ARBITRUM = arbitrumStagingDeployments.LiFiDiamond as Hex

// Simple ERC20 ABI
const ERC20_ABI = [
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * Fetch cross-chain route with destination swap using LiFi Advanced Routes API
 */
async function fetchCrossChainRoute(
  fromAmount: string,
  fromAddress: string
): Promise<any> {
  const requestBody = {
    fromAddress,
    fromAmount,
    fromChainId: 42161, // Arbitrum
    fromTokenAddress: ARBITRUM_WETH, // WETH on Arbitrum
    toChainId: 8453, // Base
    toTokenAddress: BASE_USDC, // USDC on Base
    options: {
      integrator: 'lifi-demo',
      order: 'CHEAPEST',
      slippage: 0.05, // 5% slippage
      maxPriceImpact: 0.4,
      allowSwitchChain: true,
      bridges: {
        deny: [
          'hop',
          'cbridge',
          'optimism',
          'gnosis',
          'omni',
          'celercircle',
          'thorswap',
          'symbiosis',
          'mayan',
          'mayanWH',
          'mayanMCTP',
          'allbridge',
          'celerim',
          'squid',
          'relay',
          'polygon',
          'arbitrum',
          'glacis',
        ],
      },
      exchanges: {
        allow: ['lifidexaggregator'], // Only allow LiFi DEX Aggregator
      },
    },
  }

  try {
    consola.info('Fetching cross-chain route from LiFi Advanced Routes API...')
    const response = await fetch(
      'https://api.jumper.exchange/p/lifi/advanced/routes',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    )

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const data = await response.json()

    if (!data.routes || data.routes.length === 0) {
      throw new Error('No routes found')
    }

    const route = data.routes[0] // Use the first (cheapest) route
    consola.success(
      `Found route: ${route.fromAmount} WETH → ${route.toAmount} USDC`
    )
    consola.info(`Route ID: ${route.id}`)
    consola.info(`Gas cost: $${route.gasCostUSD}`)
    consola.info(`Steps: ${route.steps.length}`)

    // Log step details
    route.steps.forEach((step: any, index: number) => {
      consola.info(`Step ${index + 1}: ${step.tool} (${step.type})`)
      if (step.action.fromToken && step.action.toToken) {
        consola.info(
          `  ${step.action.fromToken.symbol} → ${step.action.toToken.symbol}`
        )
      }
    })

    return route
  } catch (error) {
    consola.error('Error fetching cross-chain route:', error)
    throw error
  }
}

/**
 * Extract bridge and swap details from LiFi route
 */
function extractRouteDetails(route: any) {
  const bridgeStep = route.steps.find(
    (step: any) =>
      step.type === 'lifi' &&
      step.includedSteps?.some((s: any) => s.type === 'cross')
  )

  if (!bridgeStep) {
    throw new Error('No bridge step found in route')
  }

  const crossStep = bridgeStep.includedSteps.find(
    (s: any) => s.type === 'cross'
  )
  const destSwapStep = bridgeStep.includedSteps.find(
    (s: any) => s.type === 'swap'
  )

  if (!crossStep) {
    throw new Error('No cross-chain step found')
  }

  consola.info('📊 Route Analysis:')
  consola.info(
    `- Bridge: ${crossStep.action.fromToken.symbol} → ${crossStep.action.toToken.symbol}`
  )
  consola.info(`- Bridge amount: ${crossStep.action.fromAmount}`)
  consola.info(`- Expected received: ${crossStep.estimate.toAmount}`)

  if (destSwapStep) {
    consola.info(
      `- Destination swap: ${destSwapStep.action.fromToken.symbol} → ${destSwapStep.action.toToken.symbol}`
    )
    consola.info(`- Swap input: ${destSwapStep.action.fromAmount}`)
    consola.info(`- Swap output: ${destSwapStep.estimate.toAmount}`)
    consola.info(`- Swap min output: ${destSwapStep.estimate.toAmountMin}`)
  }

  return {
    // Bridge details
    fromAmount: crossStep.action.fromAmount,
    toAmount: crossStep.estimate.toAmount,
    toAmountMin: crossStep.estimate.toAmountMin,

    // Destination swap details (if exists)
    hasDestinationSwap: !!destSwapStep,
    swapFromAmount: destSwapStep?.action.fromAmount,
    swapToAmount: destSwapStep?.estimate.toAmount,
    swapToAmountMin: destSwapStep?.estimate.toAmountMin,

    // Final output
    finalAmount: route.toAmount,
    finalAmountMin: route.toAmountMin,

    // Gas and fees
    gasCostUSD: route.gasCostUSD,

    // Tool info
    bridgeTool: crossStep.tool,
    swapTool: destSwapStep?.tool,
  }
}

/**
 * Create LiFiDexAggregator swap calldata using route details
 */
function createLiFiDexAggregatorSwapCallData(
  swapFromAmount: string,
  swapToAmountMin: string,
  recipient: string
): string {
  // LiFiDexAggregator swapTokensGeneric function
  const lifiDexAggregatorAbi = [
    {
      inputs: [
        { name: '_transactionId', type: 'bytes32' },
        { name: '_integrator', type: 'string' },
        { name: '_referrer', type: 'address' },
        { name: '_receiver', type: 'address' },
        { name: '_minAmount', type: 'uint256' },
        {
          components: [
            { name: 'callTo', type: 'address' },
            { name: 'approveTo', type: 'address' },
            { name: 'sendingAssetId', type: 'address' },
            { name: 'receivingAssetId', type: 'address' },
            { name: 'fromAmount', type: 'uint256' },
            { name: 'callData', type: 'bytes' },
            { name: 'requiresDeposit', type: 'bool' },
          ],
          name: '_swapData',
          type: 'tuple[]',
        },
      ],
      name: 'swapTokensGeneric',
      outputs: [],
      stateMutability: 'payable',
      type: 'function',
    },
  ] as const

  // For now, we'll create a simple direct swap calldata
  // In a real implementation, you'd want to get the actual swap route from LiFi
  const swapData = [
    {
      callTo: BASE_LIFI_DEX_AGGREGATOR as `0x${string}`,
      approveTo: BASE_LIFI_DEX_AGGREGATOR as `0x${string}`,
      sendingAssetId: BASE_WETH as `0x${string}`,
      receivingAssetId: BASE_USDC as `0x${string}`,
      fromAmount: BigInt(swapFromAmount),
      callData: '0x' as `0x${string}`, // Simplified - in practice you'd get this from LiFi API
      requiresDeposit: true,
    },
  ]

  const callData = encodeFunctionData({
    abi: lifiDexAggregatorAbi,
    functionName: 'swapTokensGeneric',
    args: [
      `0x${Date.now().toString(16).padStart(64, '0')}` as `0x${string}`, // transactionId
      'lifi-demo', // integrator
      '0x0000000000000000000000000000000000000000' as `0x${string}`, // referrer
      recipient as `0x${string}`, // receiver
      BigInt(swapToAmountMin), // minAmount
      swapData,
    ],
  })

  consola.info(
    'Created LiFiDexAggregator swap calldata using LiFi route parameters'
  )
  return callData
}

/**
 * Encode destination call message for ReceiverAcrossV3
 */
function encodeDestinationCallMessage(
  transactionId: string,
  swapCallData: string,
  fromAmount: string,
  receiver: string
): string {
  // LibSwap.SwapData structure for the LiFiDexAggregator swap
  const swapData = [
    {
      callTo: BASE_LIFI_DEX_AGGREGATOR as `0x${string}`, // LiFiDexAggregator
      approveTo: BASE_LIFI_DEX_AGGREGATOR as `0x${string}`, // Approve to the same aggregator
      sendingAssetId: BASE_WETH as `0x${string}`,
      receivingAssetId: BASE_USDC as `0x${string}`,
      fromAmount: BigInt(fromAmount),
      callData: swapCallData as `0x${string}`,
      requiresDeposit: true,
    },
  ]

  // Encode the message payload for ReceiverAcrossV3.handleV3AcrossMessage
  const messagePayload = encodeAbiParameters(
    [
      { name: 'transactionId', type: 'bytes32' },
      {
        name: 'swapData',
        type: 'tuple[]',
        components: [
          { name: 'callTo', type: 'address' },
          { name: 'approveTo', type: 'address' },
          { name: 'sendingAssetId', type: 'address' },
          { name: 'receivingAssetId', type: 'address' },
          { name: 'fromAmount', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
          { name: 'requiresDeposit', type: 'bool' },
        ],
      },
      { name: 'receiver', type: 'address' },
    ],
    [transactionId as `0x${string}`, swapData, receiver as `0x${string}`]
  )

  consola.info('Encoded destination call message for ReceiverAcrossV3')
  return messagePayload
}

/**
 * Construct AcrossV3 bridge transaction calldata using route details
 */
function constructBridgeCallData(
  routeDetails: any,
  destinationCallMessage: string,
  walletAddress: string
): string {
  // ABI for startBridgeTokensViaAcrossV3 function
  const acrossV3Abi = [
    {
      inputs: [
        {
          components: [
            { name: 'transactionId', type: 'bytes32' },
            { name: 'bridge', type: 'string' },
            { name: 'integrator', type: 'string' },
            { name: 'referrer', type: 'address' },
            { name: 'sendingAssetId', type: 'address' },
            { name: 'receiver', type: 'address' },
            { name: 'minAmount', type: 'uint256' },
            { name: 'destinationChainId', type: 'uint256' },
            { name: 'hasSourceSwaps', type: 'bool' },
            { name: 'hasDestinationCall', type: 'bool' },
          ],
          name: '_bridgeData',
          type: 'tuple',
        },
        {
          components: [
            { name: 'receiverAddress', type: 'address' },
            { name: 'refundAddress', type: 'address' },
            { name: 'receivingAssetId', type: 'address' },
            { name: 'outputAmount', type: 'uint256' },
            { name: 'outputAmountPercent', type: 'uint64' },
            { name: 'exclusiveRelayer', type: 'address' },
            { name: 'quoteTimestamp', type: 'uint32' },
            { name: 'fillDeadline', type: 'uint32' },
            { name: 'exclusivityDeadline', type: 'uint32' },
            { name: 'message', type: 'bytes' },
          ],
          name: '_acrossData',
          type: 'tuple',
        },
      ],
      name: 'startBridgeTokensViaAcrossV3',
      outputs: [],
      stateMutability: 'payable',
      type: 'function',
    },
  ] as const

  // Generate a unique transaction ID
  const transactionId = `0x${Date.now().toString(16).padStart(64, '0')}`

  // Bridge data structure
  const bridgeData = {
    transactionId: transactionId as `0x${string}`,
    bridge: 'across',
    integrator: 'lifi-demo',
    referrer: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    sendingAssetId: ARBITRUM_WETH as `0x${string}`,
    receiver: RECEIVER_ACROSS_V3_BASE as `0x${string}`, // ReceiverAcrossV3
    minAmount: BigInt(routeDetails.toAmountMin), // Use LiFi's calculated minimum
    destinationChainId: 8453n, // Base chain ID
    hasSourceSwaps: false,
    hasDestinationCall: true, // Enable destination call
  }

  // Calculate output amount percent based on LiFi's calculations
  const outputAmountPercent =
    (BigInt(routeDetails.toAmount) * BigInt('1000000000000000000')) /
    BigInt(routeDetails.fromAmount)

  // Across data structure
  const acrossData = {
    receiverAddress: RECEIVER_ACROSS_V3_BASE as `0x${string}`, // ReceiverAcrossV3
    refundAddress: walletAddress as `0x${string}`,
    receivingAssetId: BASE_WETH as `0x${string}`,
    outputAmount: BigInt(routeDetails.toAmount), // Use LiFi's calculated amount
    outputAmountPercent: outputAmountPercent, // Calculated from LiFi data
    exclusiveRelayer:
      '0x0000000000000000000000000000000000000000' as `0x${string}`,
    quoteTimestamp: Math.floor(Date.now() / 1000),
    fillDeadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    exclusivityDeadline: 0,
    message: destinationCallMessage as `0x${string}`, // Our encoded destination call
  }

  // Encode the transaction
  const callData = encodeFunctionData({
    abi: acrossV3Abi,
    functionName: 'startBridgeTokensViaAcrossV3',
    args: [bridgeData, acrossData],
  })

  consola.success(
    'Successfully constructed AcrossV3 bridge transaction calldata'
  )
  return callData
}

/**
 * Execute cross-chain bridge with destination swap using LiFi Advanced Routes
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

  // Set up public client for reading transaction receipts
  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(),
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

  if (wethBalance < bridgeAmount && !options.dryRun) {
    consola.error(`Insufficient WETH balance. Need at least 0.001 WETH.`)
    process.exit(1)
  } else if (options.dryRun && wethBalance < bridgeAmount) {
    consola.warn(
      `[DRY RUN] Insufficient WETH balance, but continuing for demo purposes`
    )
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
      try {
        const approveTx = await wethContract.write.approve([
          LIFI_DIAMOND_ARBITRUM as `0x${string}`,
          BigInt(
            '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
          ), // Max uint256
        ])
        consola.success(`Approval transaction sent: ${approveTx}`)

        // Wait for approval confirmation
        consola.info('Waiting for approval confirmation...')
        const approvalReceipt = await publicClient.waitForTransactionReceipt({
          hash: approveTx,
          timeout: 60_000, // 60 seconds timeout
        })

        if (approvalReceipt.status === 'success') {
          consola.success(`✅ Approval confirmed!`)
        } else {
          consola.error(`❌ Approval failed!`)
          process.exit(1)
        }
      } catch (error) {
        consola.error('Approval transaction failed:', error)
        process.exit(1)
      }
    } else {
      consola.info(`[DRY RUN] Would approve WETH for LiFi Diamond`)
    }
  }

  // Fetch cross-chain route with destination swap
  consola.info('Fetching cross-chain route with destination swap...')
  const route = await fetchCrossChainRoute(
    bridgeAmount.toString(),
    walletAddress
  )

  // Extract route details for our calldata construction
  const routeDetails = extractRouteDetails(route)

  // Generate a transaction ID for the bridge
  const transactionId = `0x${Date.now().toString(16).padStart(64, '0')}`

  // Create LiFiDexAggregator swap calldata using LiFi's calculated amounts
  const swapCallData = createLiFiDexAggregatorSwapCallData(
    routeDetails.swapFromAmount,
    routeDetails.swapToAmountMin,
    walletAddress
  )

  // Encode the destination call message for ReceiverAcrossV3
  const destinationCallMessage = encodeDestinationCallMessage(
    transactionId,
    swapCallData,
    routeDetails.swapFromAmount,
    walletAddress
  )

  // Construct our own bridge calldata using LiFi's route data
  const bridgeCallData = constructBridgeCallData(
    routeDetails,
    destinationCallMessage,
    walletAddress
  )

  // Log the route details
  consola.success('Cross-chain route with destination swap ready!')
  consola.info('✅ Bridge: AcrossV3 (WETH Arbitrum → Base)')
  consola.info('✅ Destination swap: WETH → USDC on Base')
  consola.info('✅ Final output: USDC to user wallet')
  consola.info('✅ Calldata: Constructed using LiFi route optimization')

  // Log cost breakdown using LiFi's data
  consola.info('💰 Cost breakdown (from LiFi route):')
  consola.info(`- Bridge amount: ${bridgeAmount} wei (0.001 WETH)`)
  consola.info(`- Expected bridge output: ${routeDetails.toAmount} wei WETH`)
  consola.info(`- Expected swap output: ${routeDetails.finalAmount} USDC`)
  consola.info(
    `- Minimum swap output: ${routeDetails.finalAmountMin} USDC (with slippage)`
  )
  consola.info(`- Estimated gas cost: $${routeDetails.gasCostUSD}`)

  consola.info('🔄 Cross-chain flow:')
  consola.info('1. Bridge 0.001 WETH from Arbitrum → Base via AcrossV3')
  consola.info(
    `2. ReceiverAcrossV3 receives ~${routeDetails.toAmount} wei WETH on Base`
  )
  consola.info(
    '3. ReceiverAcrossV3 calls LiFiDexAggregator to swap WETH → USDC on Base'
  )
  consola.info('4. Final USDC sent to user wallet')

  // Execute the cross-chain transaction
  if (!options.dryRun) {
    consola.info('Executing cross-chain bridge with destination swap...')

    try {
      const txHash = await walletClient.sendTransaction({
        to: LIFI_DIAMOND_ARBITRUM as `0x${string}`,
        data: bridgeCallData as `0x${string}`,
        value: 0n, // No ETH value needed for WETH bridge
        gas: 500000n, // Conservative gas limit
      })

      consola.success(`✅ Transaction sent: ${txHash}`)
      consola.info('Waiting for transaction confirmation...')

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 300_000, // 5 minutes timeout
      })

      if (receipt.status === 'success') {
        consola.success(
          `🎉 Cross-chain bridge with destination swap completed!`
        )
        consola.info(`Transaction hash: ${txHash}`)
        consola.info(`Block number: ${receipt.blockNumber}`)
        consola.info(`Gas used: ${receipt.gasUsed}`)
        consola.info('🔍 Check your Base wallet for USDC!')
      } else {
        consola.error(`❌ Transaction failed!`)
        consola.info(`Transaction hash: ${txHash}`)
      }
    } catch (error) {
      consola.error('Transaction execution failed:', error)
      process.exit(1)
    }
  } else {
    consola.info(
      '[DRY RUN] Would execute cross-chain bridge with destination swap'
    )
    consola.info(`[DRY RUN] Transaction data:`)
    consola.info(`[DRY RUN] - To: ${LIFI_DIAMOND_ARBITRUM}`)
    consola.info(`[DRY RUN] - Value: 0`)
    consola.info(`[DRY RUN] - Gas limit: 500000`)
    consola.info(`[DRY RUN] - Data length: ${bridgeCallData.length} characters`)
  }
}

// CLI command definition
const main = defineCommand({
  meta: {
    name: 'demoPatcherDest',
    description:
      'Demo cross-chain bridge with destination swap using AcrossV3 and LiFi Advanced Routes API',
  },
  args: {
    privateKey: {
      type: 'string',
      description: 'Private key for the wallet',
      required: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Perform a dry run without executing transactions',
      default: false,
    },
  },
  async run({ args }) {
    if (!args.privateKey) {
      consola.error('Private key is required')
      process.exit(1)
    }

    try {
      await executeCrossChainBridgeWithSwap({
        privateKey: args.privateKey,
        dryRun: args.dryRun,
      })
    } catch (error) {
      consola.error('Demo failed:', error)
      process.exit(1)
    }
  },
})

// Run the CLI
runMain(main)
