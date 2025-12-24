import { consola } from 'consola'
import { BigNumber, constants, utils } from 'ethers'

import acrossV4SwapConfig from '../../config/across-v4-swap.json'
import deploymentsARB from '../../deployments/arbitrum.staging.json'
import {
  type AcrossV4SwapFacet,
  type ILiFi,
  type ISpokePoolPeriphery,
  AcrossV4SwapFacet__factory,
} from '../../typechain'

import {
  ADDRESS_WETH_ARB,
  ADDRESS_USDC_OPT,
  ensureBalanceAndAllowanceToDiamond,
  getProvider,
  getWalletFromPrivateKeyInDotEnv,
  sendTransaction,
} from './utils/demoScriptHelpers'

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
  depositor?: string
  refundAddress?: string
  refundOnOrigin?: boolean
  slippageTolerance?: number // e.g., 1 for 1%
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
    depositor: request.depositor || request.recipient,
    refundOnOrigin: (request.refundOnOrigin ?? true).toString(),
    slippageTolerance: (request.slippageTolerance || 1).toString(), // 1 for 1%
  })

  if (request.refundAddress) {
    params.append('refundAddress', request.refundAddress)
  }

  const fullUrl = `${baseUrl}?${params.toString()}`
  logDebug(`Requesting Across Swap API: ${fullUrl}`)

  const response = await fetch(fullUrl)
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Across Swap API error (${response.status}): ${errorText}`)
  }

  const data: IAcrossSwapApiResponse = await response.json()
  logDebug(`Across Swap API response: ${JSON.stringify(data, null, 2)}`)

  return data
}

/**
 * Decodes the swapAndBridge calldata to extract swap parameters
 */
const decodeSwapAndBridgeCalldata = (
  calldata: string
): {
  swapToken: string
  exchange: string
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
  const iface = new utils.Interface([
    'function swapAndBridge(tuple(tuple(uint256 amount, address recipient) submissionFees, tuple(address inputToken, bytes32 outputToken, uint256 outputAmount, address depositor, bytes32 recipient, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message) depositData, address swapToken, address exchange, uint8 transferType, uint256 swapTokenAmount, uint256 minExpectedInputTokenAmount, bytes routerCalldata, bool enableProportionalAdjustment, address spokePool, uint256 nonce) swapAndDepositData)',
  ])

  const decoded = iface.decodeFunctionData('swapAndBridge', calldata)
  const swapData = decoded.swapAndDepositData

  return {
    swapToken: swapData.swapToken,
    exchange: swapData.exchange,
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
// Source chain configuration
const SRC_CHAIN = 'arbitrum'
const fromChainId = 42161 // Arbitrum
const toChainId = 10 // Optimism

// Token configuration:
// We use WETH as input to trigger an "anyToBridgeable" swap type
// This means the API will return a swapAndBridge call to the SpokePoolPeriphery
// which swaps WETH -> USDC on Arbitrum, then bridges USDC to Optimism
const INPUT_TOKEN = ADDRESS_WETH_ARB // WETH on Arbitrum
const OUTPUT_TOKEN = ADDRESS_USDC_OPT // USDC on Optimism

// Amount: 0.001 WETH (10^15 wei) - small amount for testing
const fromAmount = '1000000000000000' // 0.001 WETH

// Contract addresses
const DIAMOND_ADDRESS = deploymentsARB.LiFiDiamond as string
const config = acrossV4SwapConfig as Record<
  string,
  { spokePoolPeriphery: string; spokePool: string }
>

// Validate chain is supported
if (!config[SRC_CHAIN]) {
  throw new Error(`Chain ${SRC_CHAIN} not supported in across-v4-swap config`)
}

const SPOKE_POOL_PERIPHERY = config[SRC_CHAIN].spokePoolPeriphery
const SPOKE_POOL = config[SRC_CHAIN].spokePool

const EXPLORER_BASE_URL = 'https://arbiscan.io/tx/'
// ############################################################################################################

async function main() {
  consola.info('==========================================')
  consola.info('  Across V4 Swap Facet Demo Script')
  consola.info('==========================================\n')

  // Setup wallet and provider
  const provider = getProvider(SRC_CHAIN)
  const wallet = getWalletFromPrivateKeyInDotEnv(provider)
  const walletAddress = await wallet.getAddress()
  consola.info(`Wallet address: ${walletAddress}`)

  // Connect to diamond with AcrossV4SwapFacet interface
  const acrossV4SwapFacet = AcrossV4SwapFacet__factory.connect(
    DIAMOND_ADDRESS,
    wallet
  )
  consola.info(`Diamond address: ${DIAMOND_ADDRESS}`)
  consola.info(`SpokePoolPeriphery: ${SPOKE_POOL_PERIPHERY}`)
  consola.info(`SpokePool: ${SPOKE_POOL}\n`)

  // Display route details
  consola.info('Route Details:')
  consola.info(`  Source Chain: ${SRC_CHAIN} (Chain ID: ${fromChainId})`)
  consola.info(`  Destination Chain: Optimism (Chain ID: ${toChainId})`)
  consola.info(`  Input Token: ${INPUT_TOKEN} (WETH)`)
  consola.info(`  Output Token: ${OUTPUT_TOKEN} (USDC)`)
  consola.info(`  Amount: 0.001 WETH\n`)

  // Step 1: Get quote from Across Swap API
  consola.info('Step 1: Fetching quote from Across Swap API...')

  const swapApiRequest: IAcrossSwapApiRequest = {
    originChainId: fromChainId,
    destinationChainId: toChainId,
    inputToken: INPUT_TOKEN,
    outputToken: OUTPUT_TOKEN,
    amount: fromAmount,
    recipient: walletAddress,
    depositor: walletAddress, // User is depositor (facet will handle approval)
    refundAddress: walletAddress,
    refundOnOrigin: true,
    slippageTolerance: 1, // 1%
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
      `  Min Expected Input: ${decodedData.minExpectedInputTokenAmount}`
    )
    consola.info(`  Output Amount: ${decodedData.depositData.outputAmount}`)
  } catch (error) {
    consola.error(`Failed to decode calldata: ${error}`)
    consola.info('The API may have returned a different transaction format.')
    consola.info('This could happen if the route is bridgeableToBridgeable.')
    process.exit(1)
  }

  // Step 4: Prepare LiFi BridgeData
  consola.info('\nStep 4: Preparing LiFi BridgeData...')

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'acrossV4Swap',
    integrator: 'lifi-demoScript',
    referrer: constants.AddressZero,
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

  const depositData: ISpokePoolPeriphery.BaseDepositDataStruct = {
    inputToken: decodedData.depositData.inputToken,
    outputToken: decodedData.depositData.outputToken as `0x${string}`,
    outputAmount: decodedData.depositData.outputAmount,
    depositor: DIAMOND_ADDRESS, // Diamond is depositor when going through facet
    recipient: decodedData.depositData.recipient as `0x${string}`,
    destinationChainId: Number(decodedData.depositData.destinationChainId),
    exclusiveRelayer: decodedData.depositData.exclusiveRelayer as `0x${string}`,
    quoteTimestamp: decodedData.depositData.quoteTimestamp,
    fillDeadline: decodedData.depositData.fillDeadline,
    exclusivityParameter: decodedData.depositData.exclusivityParameter,
    message: decodedData.depositData.message,
  }

  // TransferType: 0 = Approval, 1 = Transfer, 2 = Permit2Approval
  const acrossV4SwapData: AcrossV4SwapFacet.AcrossV4SwapDataStruct = {
    depositData,
    swapToken: decodedData.swapToken,
    exchange: decodedData.exchange,
    transferType: 0, // Approval
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
  consola.info('==========================================\n')

  // Step 7: Execute transaction
  consola.info('Step 6: Checking balance and allowance...')
  await ensureBalanceAndAllowanceToDiamond(
    INPUT_TOKEN,
    wallet,
    DIAMOND_ADDRESS,
    BigNumber.from(fromAmount),
    false
  )
  consola.info('  Balance and allowance OK\n')

  consola.info('Step 7: Executing transaction...')
  const txData = await acrossV4SwapFacet.populateTransaction
    .startBridgeTokensViaAcrossV4Swap(bridgeData, acrossV4SwapData)
    .then((tx) => tx.data)

  const transactionResponse = await sendTransaction(
    wallet,
    DIAMOND_ADDRESS,
    txData as string,
    BigNumber.from(0)
  )

  consola.info('\n==========================================')
  consola.info('  TRANSACTION SUCCESSFUL!')
  consola.info('==========================================')
  consola.info(`TX Hash: ${transactionResponse.hash}`)
  consola.info(`Explorer: ${EXPLORER_BASE_URL}${transactionResponse.hash}\n`)
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
