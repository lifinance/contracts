import { randomBytes } from 'crypto'

import { consola } from 'consola'
import { config } from 'dotenv'
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getContract,
  parseAbi,
  parseUnits,
  zeroAddress,
  type Abi,
} from 'viem'

import acrossV4SwapConfig from '../../config/across-v4-swap.json'
import networks from '../../config/networks.json'
import arbitrumProductionDeployments from '../../deployments/arbitrum.json'
import arbitrumStagingDeployments from '../../deployments/arbitrum.staging.json'
import acrossV4SwapFacetArtifact from '../../out/AcrossV4SwapFacet.sol/AcrossV4SwapFacet.json'
import type {
  AcrossV4SwapFacet,
  ILiFi,
  ISpokePoolPeriphery,
} from '../../typechain'
import type { LibSwap } from '../../typechain/GenericSwapFacetV3'
import { EnvironmentEnum, type SupportedChain } from '../common/types'

import {
  ADDRESS_WETH_ARB,
  ADDRESS_USDC_OPT,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getConfigElement,
  setupEnvironment,
} from './utils/demoScriptHelpers'

// Import deployment files for FeeCollector addresses

config()

// ==========================================================================================================
// CLI FLAGS
// ==========================================================================================================
// --collect-fee: Enable fee collection via FeeCollector before bridging
const COLLECT_FEE = process.argv.includes('--collect-fee')

// FeeCollector ABI for encoding collectTokenFees call
const FEE_COLLECTOR_ABI = parseAbi([
  'function collectTokenFees(address tokenAddress, uint256 integratorFee, uint256 lifiFee, address integratorAddress)',
])

// ==========================================================================================================
// ACROSS V4 SWAP FACET DEMO SCRIPT
// ==========================================================================================================
// This script demonstrates how to use the AcrossV4SwapFacet which integrates with Across's SpokePoolPeriphery
// to perform swap-and-bridge operations in a single transaction.
//
// Key differences from AcrossV4 (direct SpokePool):
// - Uses SpokePoolPeriphery instead of direct SpokePool calls
// - Requires DEX router calldata from Across Swap API
// - Supports source-chain swaps before bridging (e.g., WETH -> USDC -> bridge)
// - The swap is executed by Across's SwapProxy contract, not LiFi's swap infrastructure
//
// Flow: User -> LiFiDiamond -> AcrossV4SwapFacet -> SpokePoolPeriphery -> SwapProxy -> DEX -> SpokePool
//
// API INTEGRATION NOTES:
// When calling /swap/approval for contract integration:
// 1. Set recipient = user's wallet (receives tokens on destination)
// 2. Set depositor = user's wallet (receives refunds if bridge fails)
// 3. Set skipOriginTxEstimation = true (Diamond won't have tokens at quote time)
// 4. Extract transferType from API calldata and use it (don't hardcode!)
//
// EXAMPLE SUCCESSFUL TRANSACTIONS:
// - Source (Arbitrum): https://arbiscan.io/tx/0xb94bba8ae2fca41e8aacc41279829bf74d1bd94af77a8e753cca627bb66dbb9e
// - Destination (Optimism): https://optimistic.etherscan.io/tx/0xc61365d4a1d5ef4cddc6693f725e523a97da9a1c4a99d2766b359454cb8b8283
// - With Fee Collection (--collect-fee):
//   - Source (Arbitrum): https://arbiscan.io/tx/0xd6dcb70d742fc6f1d12cc04fe667c395005378d8bd2059c621b2af495d50cebc
//   - Destination (Optimism): https://optimistic.etherscan.io/tx/0x49824eef459b458b4ea6166de24d7dc863078cefac9f9fbdbf1a51a9420c2afb
//
// IMPORTANT: This demo uses WETH -> USDC route to trigger an "anyToBridgeable" swap type.
// For direct bridgeable-to-bridgeable routes (USDC -> USDC), use AcrossV4 facet instead.
// ==========================================================================================================

/// TYPES

// Actual API response structure (based on empirical testing)
interface IAcrossSwapApiResponse {
  crossSwapType:
    | 'bridgeableToAny'
    | 'anyToBridgeable'
    | 'anyToAny'
    | 'bridgeableToBridgeable'
  amountType: string
  steps: {
    originSwap?: {
      inputAmount: string
      expectedOutputAmount: string
      minOutputAmount: string
      tokenIn: {
        address: string
        symbol: string
        decimals: number
        chainId: number
      }
      tokenOut: {
        address: string
        symbol: string
        decimals: number
        chainId: number
      }
      provider: string
      swapTxn: {
        to: string
        data: string
        value: string
      }
    }
    bridge: {
      inputAmount: string
      outputAmount: string
      tokenIn: {
        address: string
        symbol: string
        decimals: number
        chainId: number
      }
      tokenOut: {
        address: string
        symbol: string
        decimals: number
        chainId: number
      }
      fees: {
        amount: string
        pct: string
      }
      provider: string
    }
    destinationSwap?: unknown
  }
  inputToken: {
    address: string
    symbol: string
    decimals: number
    chainId: number
  }
  outputToken: {
    address: string
    symbol: string
    decimals: number
    chainId: number
  }
  fees: {
    total: { amount: string; pct: string }
  }
  depositTxn?: {
    to: string
    data: string
    value: string
  }
  swapTxn?: {
    to: string
    data: string
    value: string
  }
  // These are used when there's an origin swap (swapAndBridge call to periphery)
  swapTx?: {
    to: string
    data: string
    value: string
  }
}

interface IAcrossSwapApiRequest {
  originChainId: number
  destinationChainId: number
  inputToken: string
  outputToken: string
  amount: string
  recipient: string
  depositor: string // Should be the contract calling SpokePoolPeriphery (e.g., LiFi Diamond)
  refundAddress?: string
  refundOnOrigin?: boolean
  slippageTolerance?: number // e.g., 1 for 1%
  skipOriginTxEstimation?: boolean // Skip simulation - required when depositor is a contract
}

/// HELPER FUNCTIONS
const logDebug = (msg: string) => {
  consola.debug(msg)
}

/**
 * Fetches a swap quote from the Across Swap API
 * This API provides ready-to-execute router calldata for the SpokePoolPeriphery
 */
const getAcrossSwapQuote = async (
  request: IAcrossSwapApiRequest
): Promise<IAcrossSwapApiResponse> => {
  const baseUrl = 'https://app.across.to/api/swap/approval'

  const params = new URLSearchParams({
    originChainId: request.originChainId.toString(),
    destinationChainId: request.destinationChainId.toString(),
    inputToken: request.inputToken,
    outputToken: request.outputToken,
    amount: request.amount,
    recipient: request.recipient,
    depositor: request.depositor,
    refundOnOrigin: (request.refundOnOrigin ?? true).toString(),
    slippageTolerance: (request.slippageTolerance || 1).toString(), // 1 for 1%
    // Skip origin tx estimation since the depositor (Diamond) won't have tokens at quote time
    skipOriginTxEstimation: (request.skipOriginTxEstimation ?? true).toString(),
  })

  if (request.refundAddress) {
    params.append('refundAddress', request.refundAddress)
  }

  const fullUrl = `${baseUrl}?${params.toString()}`
  consola.info(`  API URL: ${fullUrl}`)

  const response = await fetch(fullUrl)
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Across Swap API error (${response.status}): ${errorText}`)
  }

  const data: IAcrossSwapApiResponse = await response.json()
  logDebug(`Across Swap API response: ${JSON.stringify(data, null, 2)}`)

  return data
}

// ABI for decoding SpokePoolPeriphery.swapAndBridge calldata
const swapAndBridgeAbi = parseAbi([
  'function swapAndBridge((( uint256 amount, address recipient) submissionFees, (address inputToken, bytes32 outputToken, uint256 outputAmount, address depositor, bytes32 recipient, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) depositData, address swapToken, address exchange, uint8 transferType, uint256 swapTokenAmount, uint256 minExpectedInputTokenAmount, bytes routerCalldata, bool enableProportionalAdjustment, address spokePool, uint256 nonce) swapAndDepositData)',
])

/**
 * Decodes the swapAndBridge calldata to extract swap parameters
 */
const decodeSwapAndBridgeCalldata = (
  calldata: string
): {
  swapToken: string
  exchange: string
  transferType: number
  routerCalldata: string
  minExpectedInputTokenAmount: string
  depositData: {
    inputToken: string
    outputToken: string
    outputAmount: string
    depositor: string
    recipient: string
    destinationChainId: bigint
    exclusiveRelayer: string
    quoteTimestamp: number
    fillDeadline: number
    exclusivityParameter: number
    message: string
  }
} => {
  // The calldata is for SpokePoolPeriphery.swapAndBridge(SwapAndDepositData)
  const decoded = decodeFunctionData({
    abi: swapAndBridgeAbi,
    data: calldata as `0x${string}`,
  })

  if (!decoded.args) {
    throw new Error('Failed to decode swapAndBridge calldata')
  }

  const swapData = decoded.args[0] as any

  return {
    swapToken: swapData.swapToken,
    exchange: swapData.exchange,
    transferType: swapData.transferType,
    routerCalldata: swapData.routerCalldata,
    minExpectedInputTokenAmount:
      swapData.minExpectedInputTokenAmount.toString(),
    depositData: {
      inputToken: swapData.depositData.inputToken,
      outputToken: swapData.depositData.outputToken,
      outputAmount: swapData.depositData.outputAmount.toString(),
      depositor: swapData.depositData.depositor,
      recipient: swapData.depositData.recipient,
      destinationChainId: swapData.depositData.destinationChainId,
      exclusiveRelayer: swapData.depositData.exclusiveRelayer,
      quoteTimestamp: swapData.depositData.quoteTimestamp,
      fillDeadline: swapData.depositData.fillDeadline,
      exclusivityParameter: swapData.depositData.exclusivityParameter,
      message: swapData.depositData.message,
    },
  }
}

// ########################################## CONFIGURE SCRIPT HERE ##########################################
// Chain configuration - use SupportedChain type from helpers
const SRC_CHAIN: SupportedChain = 'arbitrum'
const DST_CHAIN: SupportedChain = 'optimism'

// Get chain IDs from networks config
const fromChainId = networks[SRC_CHAIN].chainId
const toChainId = networks[DST_CHAIN].chainId

// Token configuration:
// We use WETH as input to trigger an "anyToBridgeable" swap type
// This means the API will return a swapAndBridge call to the SpokePoolPeriphery
// which swaps WETH -> USDC on Arbitrum, then bridges USDC to Optimism
const INPUT_TOKEN = ADDRESS_WETH_ARB // WETH on Arbitrum
const OUTPUT_TOKEN = ADDRESS_USDC_OPT // USDC on Optimism

// Amount: 0.001 WETH (10^15 wei) - small amount for testing
const fromAmount = 1000000000000000n // 0.001 WETH

// Environment: staging or production
const ENVIRONMENT = EnvironmentEnum.staging

// Fee collection configuration (only used when --collect-fee flag is passed)
// Fees are split between integrator and LiFi protocol
const INTEGRATOR_FEE = parseUnits('0.0001', 18) // 0.0001 WETH
const LIFI_FEE = parseUnits('0.00005', 18) // 0.00005 WETH

// Get FeeCollector address based on environment
const getFeeCollectorAddress = (environment: EnvironmentEnum): string => {
  if (environment === EnvironmentEnum.staging) {
    return arbitrumStagingDeployments.FeeCollector
  }
  return arbitrumProductionDeployments.FeeCollector
}

// Get config elements using helper
const SPOKE_POOL_PERIPHERY = getConfigElement(
  acrossV4SwapConfig,
  SRC_CHAIN,
  'spokePoolPeriphery'
)
const SPOKE_POOL = getConfigElement(acrossV4SwapConfig, SRC_CHAIN, 'spokePool')

// Get explorer URL from networks config
const EXPLORER_BASE_URL = `${networks[SRC_CHAIN].explorerUrl}/tx/`
// ############################################################################################################

async function main() {
  consola.info('==========================================')
  consola.info('  Across V4 Swap Facet Demo Script')
  consola.info('==========================================\n')

  // Setup environment using viem
  const ACROSS_V4_SWAP_FACET_ABI = acrossV4SwapFacetArtifact.abi as Abi

  const {
    publicClient,
    walletClient,
    walletAccount,
    lifiDiamondContract,
    lifiDiamondAddress,
  } = await setupEnvironment(SRC_CHAIN, ACROSS_V4_SWAP_FACET_ABI, ENVIRONMENT)

  const walletAddress = walletAccount.address

  consola.info(`Wallet address: ${walletAddress}`)
  consola.info(`Diamond address: ${lifiDiamondAddress}`)
  consola.info(`SpokePoolPeriphery: ${SPOKE_POOL_PERIPHERY}`)
  consola.info(`SpokePool: ${SPOKE_POOL}\n`)

  // Display route details
  consola.info('Route Details:')
  consola.info(`  Source Chain: ${SRC_CHAIN} (Chain ID: ${fromChainId})`)
  consola.info(`  Destination Chain: ${DST_CHAIN} (Chain ID: ${toChainId})`)
  consola.info(`  Input Token: ${INPUT_TOKEN} (WETH)`)
  consola.info(`  Output Token: ${OUTPUT_TOKEN} (USDC)`)
  consola.info(`  Amount: 0.001 WETH\n`)

  // Step 1: Get quote from Across Swap API
  consola.info('Step 1: Fetching quote from Across Swap API...')

  // NOTE: Both recipient and depositor should be the user's wallet address.
  // The Diamond is only the msg.sender to SpokePoolPeriphery, not the depositor.
  // skipOriginTxEstimation=true is required because the Diamond won't have tokens at quote time.
  const swapApiRequest: IAcrossSwapApiRequest = {
    originChainId: fromChainId,
    destinationChainId: toChainId,
    inputToken: INPUT_TOKEN,
    outputToken: OUTPUT_TOKEN,
    amount: fromAmount.toString(),
    recipient: walletAddress, // User receives tokens on destination
    depositor: walletAddress, // User receives refunds if bridge fails
    refundAddress: walletAddress, // Same as depositor for consistency
    refundOnOrigin: true,
    slippageTolerance: 1, // 1%
    skipOriginTxEstimation: true, // Required: Diamond won't have tokens at quote time
  }

  const swapQuote = await getAcrossSwapQuote(swapApiRequest)
  consola.info('Quote received!')
  consola.info(`  Cross Swap Type: ${swapQuote.crossSwapType}`)

  // Check if this is the right type of route
  if (swapQuote.crossSwapType === 'bridgeableToBridgeable') {
    consola.warn('\nWARNING: This is a bridgeableToBridgeable route.')
    consola.warn(
      '   The AcrossV4SwapFacet is designed for routes that require a source swap.'
    )
    consola.warn(
      '   For direct bridgeable routes, use the AcrossV4 facet instead.'
    )
    consola.warn(
      '   Try using a non-bridgeable input token (e.g., WETH) to test swap functionality.\n'
    )
  }

  // Log bridge step details
  const bridgeStep = swapQuote.steps.bridge
  consola.info(
    `  Bridge: ${bridgeStep.inputAmount} ${bridgeStep.tokenIn.symbol} -> ${bridgeStep.outputAmount} ${bridgeStep.tokenOut.symbol}`
  )
  consola.info(
    `  Bridge Fee: ${bridgeStep.fees.amount} (${(
      Number(bridgeStep.fees.pct) / 1e16
    ).toFixed(4)}%)`
  )
  consola.info(`  Total Fee: ${swapQuote.fees.total.amount}\n`)

  // Check for origin swap
  if (swapQuote.steps.originSwap) {
    const originSwap = swapQuote.steps.originSwap
    consola.info('Origin Swap Details:')
    consola.info(
      `  Swap: ${originSwap.inputAmount} ${originSwap.tokenIn.symbol} -> ${
        originSwap.expectedOutputAmount || originSwap.minOutputAmount
      } ${originSwap.tokenOut.symbol}`
    )
    consola.info(`  Min Output: ${originSwap.minOutputAmount}`)
    consola.info(`  Provider: ${originSwap.provider || 'N/A'}`)
    if (originSwap.swapTxn) {
      consola.info(`  Target: ${originSwap.swapTxn.to}`)
    }
    consola.info('')
  }

  // Step 2: Determine transaction type and extract parameters
  consola.info('Step 2: Preparing transaction data...')

  // For anyToBridgeable routes, the API returns a swapTx that calls SpokePoolPeriphery
  if (!swapQuote.swapTx && !swapQuote.steps.originSwap) {
    consola.error(
      'No swap transaction found - this route does not require a source swap.'
    )
    consola.error('Use AcrossV4 facet for this route instead.')
    process.exit(1)
  }

  // Get the swap transaction - API uses 'swapTx' at root level
  const swapTx = swapQuote.swapTx

  if (!swapTx) {
    consola.error('Could not find swap transaction data in API response.')
    consola.info('Available top-level keys:', Object.keys(swapQuote).join(', '))
    process.exit(1)
  }

  consola.info(`  Swap TX Target: ${swapTx.to}`)
  consola.info(`  Swap TX Value: ${swapTx.value}`)

  // Step 3: Decode the swapAndBridge calldata
  consola.info('\nStep 3: Decoding swap calldata...')

  let decodedData
  try {
    decodedData = decodeSwapAndBridgeCalldata(swapTx.data)
    consola.info('  Decoded successfully!')
    consola.info(`  Swap Token: ${decodedData.swapToken}`)
    consola.info(`  Exchange: ${decodedData.exchange}`)
    consola.info(
      `  Transfer Type: ${decodedData.transferType} (0=Approval, 1=Transfer, 2=Permit2)`
    )
    consola.info(
      `  Min Expected Input: ${decodedData.minExpectedInputTokenAmount}`
    )
    consola.info(`  Output Amount: ${decodedData.depositData.outputAmount}`)
    consola.info(`  Depositor: ${decodedData.depositData.depositor}`)
    consola.info(`  Recipient: ${decodedData.depositData.recipient}`)
  } catch (error) {
    consola.error(`Failed to decode calldata: ${error}`)
    consola.info('The API may have returned a different transaction format.')
    consola.info('This could happen if the route is bridgeableToBridgeable.')
    process.exit(1)
  }

  // Step 4: Prepare LiFi BridgeData
  consola.info('\nStep 4: Preparing LiFi BridgeData...')

  const transactionId = `0x${randomBytes(32).toString('hex')}` as `0x${string}`

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId,
    bridge: 'acrossV4Swap',
    integrator: 'lifi-demoScript',
    referrer: zeroAddress,
    sendingAssetId: INPUT_TOKEN,
    receiver: walletAddress,
    minAmount: fromAmount,
    destinationChainId: toChainId,
    hasSourceSwaps: false, // Periphery handles the swap, not LiFi
    hasDestinationCall: false,
  }
  consola.info('  BridgeData prepared')

  // Step 5: Prepare AcrossV4SwapData
  consola.info('\nStep 5: Preparing AcrossV4SwapData...')

  // Use decoded deposit data directly - API was called with depositor=DIAMOND_ADDRESS
  // so all fields should be correctly set
  const depositData: ISpokePoolPeriphery.BaseDepositDataStruct = {
    inputToken: decodedData.depositData.inputToken,
    outputToken: decodedData.depositData.outputToken as `0x${string}`,
    outputAmount: decodedData.depositData.outputAmount,
    depositor: decodedData.depositData.depositor, // Should be DIAMOND_ADDRESS from API
    recipient: decodedData.depositData.recipient as `0x${string}`,
    destinationChainId: Number(decodedData.depositData.destinationChainId),
    exclusiveRelayer: decodedData.depositData.exclusiveRelayer as `0x${string}`,
    quoteTimestamp: decodedData.depositData.quoteTimestamp,
    fillDeadline: decodedData.depositData.fillDeadline,
    exclusivityParameter: decodedData.depositData.exclusivityParameter,
    message: decodedData.depositData.message,
  }

  // TransferType: 0 = Approval, 1 = Transfer, 2 = Permit2Approval
  // Use the transferType from the API calldata
  const acrossV4SwapData: AcrossV4SwapFacet.AcrossV4SwapDataStruct = {
    depositData,
    swapToken: decodedData.swapToken,
    exchange: decodedData.exchange,
    transferType: decodedData.transferType,
    routerCalldata: decodedData.routerCalldata,
    minExpectedInputTokenAmount: decodedData.minExpectedInputTokenAmount,
    enableProportionalAdjustment: true,
  }
  consola.info('  AcrossV4SwapData prepared')

  // Step 6: Display summary
  consola.info('\n==========================================')
  consola.info('  Transaction Summary')
  consola.info('==========================================')
  consola.info(`Input:  0.001 WETH on Arbitrum`)
  consola.info(
    `Output: ~${(Number(decodedData.depositData.outputAmount) / 1e6).toFixed(
      2
    )} USDC on Optimism`
  )
  consola.info(
    `Swap:   WETH -> ${bridgeStep.tokenIn.symbol} (via ${
      swapQuote.steps.originSwap?.provider || 'unknown'
    })`
  )
  consola.info(
    `Bridge: ${bridgeStep.tokenIn.symbol} -> ${bridgeStep.tokenOut.symbol} (via Across)`
  )
  consola.info(
    `Fee:    ${(Number(bridgeStep.fees.amount) / 1e6).toFixed(4)} USDC (${(
      Number(bridgeStep.fees.pct) / 1e16
    ).toFixed(4)}%)`
  )

  // Show fee collection info if enabled
  if (COLLECT_FEE) {
    consola.info('------------------------------------------')
    consola.info('Fee Collection Enabled:')
    consola.info(`  Integrator Fee: ${formatUnits(INTEGRATOR_FEE, 18)} WETH`)
    consola.info(`  LiFi Fee: ${formatUnits(LIFI_FEE, 18)} WETH`)
    consola.info(
      `  Total Fees: ${formatUnits(INTEGRATOR_FEE + LIFI_FEE, 18)} WETH`
    )
  }
  consola.info('==========================================\n')

  // Step 7: Calculate amounts and prepare fee collection if enabled
  const totalFees = COLLECT_FEE ? INTEGRATOR_FEE + LIFI_FEE : 0n
  const totalAmount = fromAmount + totalFees

  // Step 8: Check balance and allowance
  consola.info('Step 6: Checking balance and allowance...')

  // Create token contract for balance/allowance checks
  const tokenContract = getContract({
    address: INPUT_TOKEN as `0x${string}`,
    abi: erc20Abi,
    client: { public: publicClient, wallet: walletClient },
  })

  // Ensure sufficient balance (including fees if collecting)
  await ensureBalance(tokenContract, walletAddress, totalAmount, publicClient)

  // Ensure allowance to diamond (including fees if collecting)
  await ensureAllowance(
    tokenContract,
    walletAddress,
    lifiDiamondAddress as string,
    totalAmount,
    publicClient
  )

  consola.info('  Balance and allowance OK\n')

  // Step 9: Execute transaction
  consola.info('Step 7: Executing transaction...')

  if (COLLECT_FEE) {
    // Get FeeCollector address based on environment
    const feeCollectorAddress = getFeeCollectorAddress(ENVIRONMENT)
    consola.info(`  Using FeeCollector: ${feeCollectorAddress}`)

    // Prepare fee collection swap data
    // This "swap" doesn't actually swap tokens - it collects fees to FeeCollector
    // and leaves the remaining tokens in the Diamond for the bridge
    const feeCollectionSwapData: LibSwap.SwapDataStruct = {
      callTo: feeCollectorAddress,
      approveTo: feeCollectorAddress,
      sendingAssetId: INPUT_TOKEN,
      receivingAssetId: INPUT_TOKEN, // Same token - just collecting fees
      fromAmount: totalAmount,
      callData: encodeFunctionData({
        abi: FEE_COLLECTOR_ABI,
        functionName: 'collectTokenFees',
        args: [
          INPUT_TOKEN, // tokenAddress
          INTEGRATOR_FEE, // integratorFee
          LIFI_FEE, // lifiFee
          walletAddress, // integratorAddress (user receives integrator fees)
        ],
      }),
      requiresDeposit: true,
    }

    // Update bridgeData for swap flow
    // minAmount should be fromAmount (amount AFTER fees are deducted)
    // because that's what will be available for bridging after fee collection
    const bridgeDataWithSwap: ILiFi.BridgeDataStruct = {
      ...bridgeData,
      minAmount: fromAmount, // Amount after fees - what reaches the bridge
      hasSourceSwaps: true, // Required for swapAndStart function
    }

    await executeTransaction(
      () =>
        (
          lifiDiamondContract as any
        ).write.swapAndStartBridgeTokensViaAcrossV4Swap([
          bridgeDataWithSwap,
          [feeCollectionSwapData],
          acrossV4SwapData,
        ]),
      'Starting bridge with fee collection via AcrossV4Swap',
      publicClient,
      true
    )
  } else {
    // No fee collection - use the simple start function
    await executeTransaction(
      () =>
        (lifiDiamondContract as any).write.startBridgeTokensViaAcrossV4Swap([
          bridgeData,
          acrossV4SwapData,
        ]),
      'Starting bridge tokens via AcrossV4Swap',
      publicClient,
      true
    )
  }

  consola.info('\n==========================================')
  consola.info('  TRANSACTION SUCCESSFUL!')
  consola.info('==========================================')
  consola.info(`Explorer: ${EXPLORER_BASE_URL}\n`)
}

main()
  .then(() => {
    consola.info('Script completed successfully')
    process.exit(0)
  })
  .catch((error) => {
    consola.error('Script failed:', error)
    process.exit(1)
  })
