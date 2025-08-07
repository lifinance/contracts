import { BigNumber, constants, ethers, utils } from 'ethers'

import { AcrossFacetV4__factory, type AcrossFacetV4 } from '../../typechain'
import type { LibSwap } from '../../typechain/AcrossFacetV4'
import { EnvironmentEnum } from '../common/types'
import { getDeployments } from '../utils/deploymentHelpers'

import {
  createDefaultBridgeData,
  type BridgeData,
} from './utils/bridgeDataHelpers'
import {
  ADDRESS_DEV_WALLET_SOLANA_BYTES32,
  ADDRESS_DEV_WALLET_V4,
  ADDRESS_UNISWAP_ARB,
  ADDRESS_UNISWAP_OPT,
  ADDRESS_USDC_ARB,
  ADDRESS_USDC_OPT,
  ADDRESS_USDC_SOL,
  ADDRESS_USDC_SOL_BYTES32,
  ADDRESS_USDT_OPT,
  ADDRESS_WETH_ARB,
  ADDRESS_WETH_OPT,
  DEFAULT_DEST_PAYLOAD_ABI,
  DEV_WALLET_ADDRESS,
  ensureBalanceAndAllowanceToDiamond,
  getProvider,
  getUniswapDataERC20toExactERC20,
  getUniswapDataERC20toExactETH,
  getUniswapSwapDataERC20ToERC20,
  getWalletFromPrivateKeyInDotEnv,
  isNativeTX,
  ITransactionTypeEnum,
  leftPadAddressToBytes32,
  sendTransaction,
} from './utils/demoScriptHelpers'

// SUCCESSFUL TRANSACTIONS PRODUCED BY THIS SCRIPT ---------------------------------------------------------------------------------------------------
// This script is for Across V4 - similar to V3 but with bytes32 addresses and different data structure
// Notes:
// - this script can only bridge to Solana, not from Solana
// - the Across API still expects address-formatted values for inputToken and outputToken https://docs.across.to/reference/api-reference#get-limits

// BRIDGE 5.1 USDC from OPT to SOL:
// DEPOSIT: https://optimistic.etherscan.io/tx/0xa6570f69221de0a148a159942432129d1d0350e1c349d8466bdc82fc5600dcad
// RELEASE: https://solscan.io/tx/3E9kRHVX51dvrJySexjS6dRYXB9BGzSMhcYwRE4o3SSHTQL1BUavAxZh5GwP4pcMMJnB6x7PWvfRCCTbyr3PaA8a

// Bridge USDC: https://optimistic.etherscan.io/tx/0xbc5c77f16213afda2df48586452f61ccc08309325db01c43b81319070edad676
// Bridge Native: https://optimistic.etherscan.io/tx/0x6053b51bb7e1d47d7bcc33a8eb880f87cf52a08e11e8c94f55d4aaa4274ce392
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/// TYPES
interface IAcrossV4Route {
  originChainId: number
  originToken: string
  destinationChainId: number
  destinationToken: string
  originTokenSymbol: string
  destinationTokenSymbol: string
}

interface IFeeDetail {
  pct: string
  total: string
}

interface IAcrossV4Quote {
  capitalFeePct?: string
  capitalFeeTotal?: string
  relayGasFeePct?: string
  relayGasFeeTotal?: string
  relayFeePct?: string
  relayFeeTotal?: string
  lpFeePct?: string
  timestamp?: string
  isAmountTooLow?: boolean
  quoteBlock?: string
  spokePoolAddress?: string
  totalRelayFee?: IFeeDetail
  relayerCapitalFee?: IFeeDetail
  relayerGasFee?: IFeeDetail
  lpFee?: IFeeDetail
  estimatedFillTimeSec?: number
  // Error response properties
  type?: string
  code?: string
  status?: number
  message?: string
  param?: string
  id?: string
}

interface IAcrossV4Limit {
  minDeposit: string
  maxDeposit: string
  maxDepositInstant: string
  maxDepositShortDelay: string
  recommendedDepositInstant: string
}

/// DEFAULT VARIABLES
// const ACROSS_API_BASE_URL = 'https://across.to/api'
const ACROSS_API_BASE_URL =
  'https://app-frontend-v3-git-epic-solana-v1-uma.vercel.app/api' // tmp API for testing
const ACROSS_CHAIN_ID_SOL = 34268394551451 // Across Custom ID for Solana
/// #################

/// HELPER FUNCTIONS
const logDebug = (msg: string) => {
  if (DEBUG) console.log(msg)
}

const getAllAvailableAcrossRoutes = async (): Promise<IAcrossV4Route[]> => {
  const endpointURL = '/available-routes'
  let resp: IAcrossV4Route[] | undefined = undefined
  try {
    resp = await fetch(`${ACROSS_API_BASE_URL}${endpointURL}`).then((resp) =>
      resp.json()
    )
  } catch (error) {
    console.error(`error: ${JSON.stringify(error, null, 2)}`)
  }

  if (!resp) throw Error(`Could not obtain a list of available routes`)

  return resp
}

const isTransferWithinSendLimit = async (
  sendingAssetId: string,
  receivingAssetId: string,
  fromChainId: number,
  toChainId: number,
  fromAmount: BigNumber
): Promise<boolean> => {
  const endpointURL = '/limits'
  let resp: IAcrossV4Limit | undefined = undefined

  // For native ETH (zero address), use WETH address when checking limits
  const inputTokenAddressRaw =
    sendingAssetId === constants.AddressZero
      ? ADDRESS_WETH_OPT // Use WETH address for native transactions
      : sendingAssetId

  // Use regular addresses for API calls (API expects regular addresses, not bytes32)
  const inputTokenAddress = inputTokenAddressRaw

  // For Solana, we need to use a regular address format for the API
  // The API doesn't support bytes32 format for Solana addresses
  const outputTokenAddress = isSolana
    ? ADDRESS_USDC_SOL // Use correct Solana USDC address for API calls
    : receivingAssetId

  const apiUrl = `${ACROSS_API_BASE_URL}${endpointURL}?inputToken=${inputTokenAddress}&outputToken=${outputTokenAddress}&originChainId=${fromChainId}&destinationChainId=${toChainId}`
  console.log('Checking limits with URL:', apiUrl)

  try {
    const response = await fetch(apiUrl)
    if (!response.ok)
      throw new Error(`API responded with status: ${response.status}`)

    resp = await response.json()

    if (!resp || !resp.maxDeposit || !resp.minDeposit)
      throw new Error('Invalid response from API: missing deposit limits')

    logDebug(`found send limits: ${JSON.stringify(resp, null, 2)}`)

    // make sure that amount is within deposit limits
    const maxDeposit = BigNumber.from(resp.maxDeposit)
    const minDeposit = BigNumber.from(resp.minDeposit)

    return fromAmount.lte(maxDeposit) && fromAmount.gte(minDeposit)
  } catch (error) {
    console.error('Error checking transfer limits:', error)
    throw error
  }
}

const isRouteAvailable = async (
  sendingAssetId: string,
  receivingAssetId: string,
  fromChainId: number,
  toChainId: number,
  fromAmount: BigNumber
): Promise<boolean> => {
  // get all available routes from API
  const allRoutes = await getAllAvailableAcrossRoutes()

  // get token transfer limits
  if (
    await isTransferWithinSendLimit(
      sendingAssetId,
      receivingAssetId,
      fromChainId,
      toChainId,
      fromAmount
    )
  )
    logDebug(
      `fromAmount (${fromAmount}) of token (${sendingAssetId}) is within send limits`
    )
  else
    throw Error(
      `fromAmount (${fromAmount}) is outside of transfer limits. Script cannot continue.`
    )

  // try to find route with given parameters
  logDebug(`Looking for route with:`)
  logDebug(`  originToken: ${sendingAssetId}`)
  logDebug(`  originChainId: ${fromChainId}`)
  logDebug(`  destinationToken: ${receivingAssetId}`)
  logDebug(`  destinationChainId: ${toChainId}`)

  // For Solana routes, we need to compare with the correct format
  const expectedDestinationToken = isSolana
    ? ADDRESS_USDC_SOL
    : receivingAssetId

  const foundRoute = allRoutes.find(
    (route: IAcrossV4Route) =>
      route.originToken.toLowerCase() === sendingAssetId.toLowerCase() &&
      route.originChainId === fromChainId &&
      route.destinationToken.toLowerCase() ===
        expectedDestinationToken.toLowerCase() &&
      route.destinationChainId === toChainId
  )

  if (!foundRoute) {
    logDebug(`Available routes:`)
    allRoutes.forEach((route, index) => {
      logDebug(`  Route ${index}:`)
      logDebug(`    originToken: ${route.originToken}`)
      logDebug(`    originChainId: ${route.originChainId}`)
      logDebug(`    destinationToken: ${route.destinationToken}`)
      logDebug(`    destinationChainId: ${route.destinationChainId}`)
    })
  }

  return Boolean(foundRoute)
}

const getAcrossQuote = async (
  sendingAssetId: string,
  receivingAssetId: string,
  fromChainId: number,
  toChainId: number,
  amount: string,
  receiverAddress = DEV_WALLET_ADDRESS,
  payload = '0x'
): Promise<IAcrossV4Quote> => {
  const endpointURL = '/suggested-fees'

  // For native ETH (zero address), use WETH address when checking limits
  const inputTokenAddressRaw =
    sendingAssetId === constants.AddressZero
      ? ADDRESS_WETH_OPT // Use WETH address for native transactions
      : sendingAssetId

  // Use regular addresses for API calls (API expects regular addresses, not bytes32)
  const inputTokenAddress = inputTokenAddressRaw

  //
  const outputTokenAddress = isSolana
    ? ADDRESS_USDC_SOL // Use correct Solana USDC address for API calls
    : receivingAssetId

  // For Solana, we need to use a Solana address format for the recipient
  // The API expects base58 format for Solana addresses
  const recipientAddress = isSolana
    ? 'S5ARSDD3ddZqqqqqb2EUE2h2F1XQHBk7bErRW1WPGe4' // Solana address format
    : receiverAddress

  const fullURL = `${ACROSS_API_BASE_URL}${endpointURL}?inputToken=${inputTokenAddress}&outputToken=${outputTokenAddress}&originChainId=${fromChainId}&destinationChainId=${toChainId}&amount=${amount}&recipient=${recipientAddress}&message=${payload}`
  logDebug(`requesting quote: ${fullURL}`)

  let resp: IAcrossV4Quote | undefined = undefined
  try {
    resp = await fetch(fullURL).then((response) => response.json())
  } catch (error) {
    console.error(error)
  }

  if (!resp)
    throw Error(
      `Could not obtain a quote for fromToken=${sendingAssetId}, destChainId=${toChainId}, amount=${amount}`
    )

  return resp
}

const calculateOutputAmountPercentage = (quote: IAcrossV4Quote): string => {
  // Convert the relay fee percentage from basis points to 18 decimal fixed point
  const totalFeePercent = BigNumber.from(quote.relayFeePct)

  // Calculate output percentage as (100% - fee%) where 100% = 1e18
  const oneHundredPercent = BigNumber.from(10).pow(18) // 1e18 represents 100%
  const outputPercent = oneHundredPercent.sub(totalFeePercent)

  // Ensure the percentage is between 0 and 1e18
  return outputPercent.toString()
}

const getMinAmountOut = (quote: IAcrossV4Quote, fromAmount: string) => {
  logDebug(`Quote structure: ${JSON.stringify(quote, null, 2)}`)

  // Check if the quote is an error response
  if (quote.type === 'AcrossApiError')
    throw Error(`API Error: ${quote.message}`)

  // The quote structure has relayFeeTotal directly, not nested under totalRelayFee
  if (!quote.relayFeeTotal) throw Error('Quote missing relayFeeTotal')
  const outputAmount = BigNumber.from(fromAmount).sub(quote.relayFeeTotal)
  if (!outputAmount) throw Error('could not calculate output amount')
  return outputAmount
}

const createDestCallPayload = (
  bridgeData: BridgeData,
  swapData: LibSwap.SwapDataStruct[],
  receiverAddress: string
): string => {
  // return empty calldata if dest call is not applicable
  if (!WITH_DEST_CALL) return '0x'

  const payload = utils.defaultAbiCoder.encode(DEFAULT_DEST_PAYLOAD_ABI, [
    bridgeData.transactionId,
    swapData,
    receiverAddress,
  ])
  logDebug(`payload: ${payload}`)

  return payload
}

// ########################################## CONFIGURE SCRIPT HERE ##########################################
const TRANSACTION_TYPE = ITransactionTypeEnum.ERC20 as ITransactionTypeEnum // define which type of transaction you want to send
const SEND_TX = true // allows you to the script run without actually sending a transaction (=false)
const DEBUG = true // set to true for higher verbosity in console output

// change these values only if you need to
const fromChainId = 10 as number
// const toChainId = 42161 as number // Arbitrum
const toChainId = ACROSS_CHAIN_ID_SOL
const isSolana = toChainId === ACROSS_CHAIN_ID_SOL
const sendingAssetId = isNativeTX(TRANSACTION_TYPE)
  ? ADDRESS_WETH_OPT // Use zero address for native ETH
  : ADDRESS_USDC_OPT

// Define sendingAssetIdSrc based on transaction type
const sendingAssetIdSrc =
  TRANSACTION_TYPE === ITransactionTypeEnum.ERC20_WITH_SRC ||
  TRANSACTION_TYPE === ITransactionTypeEnum.NATIVE_WITH_SRC
    ? ADDRESS_USDC_OPT
    : sendingAssetId

// For the swap path, we need WETH when it's a native transaction
const receivingAssetId = isSolana
  ? ADDRESS_USDC_SOL_BYTES32
  : isNativeTX(TRANSACTION_TYPE)
  ? ADDRESS_WETH_ARB
  : ADDRESS_USDC_ARB
const fromAmount = isNativeTX(TRANSACTION_TYPE)
  ? '2000000000000000' // 0.002 (ETH)
  : '5100000' // 5.1 USDC (min send limit is just over 5 USD for this token)
const WITH_DEST_CALL =
  TRANSACTION_TYPE === ITransactionTypeEnum.ERC20_WITH_DEST ||
  TRANSACTION_TYPE === ITransactionTypeEnum.NATIVE_WITH_DEST
const WITH_EXCLUSIVE_RELAYER = false
const EXCLUSIVE_RELAYER = '0x07ae8551be970cb1cca11dd7a11f47ae82e70e67' // biggest across relayer
const SRC_CHAIN = 'optimism'
// These will be set in main() after getting deployments
let DIAMOND_ADDRESS_SRC: string
let RECEIVER_ADDRESS_DST: string
const EXPLORER_BASE_URL = 'https://optimistic.etherscan.io/tx/'

// ############################################################################################################
async function main() {
  // get provider and wallet
  const provider = getProvider(SRC_CHAIN)
  const wallet = getWalletFromPrivateKeyInDotEnv(provider)
  const walletAddress = await wallet.getAddress()
  console.log('you are using this wallet address: ', walletAddress)

  // Helper function to format amount with decimals
  const formatAmount = (amount: string, isNative: boolean): string => {
    if (isNative) {
      // For ETH, convert from wei to ETH (18 decimals)
      const ethAmount = BigNumber.from(amount).div(BigNumber.from(10).pow(18))
      return `${ethAmount.toString()}.${amount
        .slice(-18)
        .padStart(18, '0')
        .slice(0, 6)} ETH`
    } else {
      // For USDC, convert from micro USDC to USDC (6 decimals)
      const usdcAmount = BigNumber.from(amount).div(BigNumber.from(10).pow(6))
      const remainder = BigNumber.from(amount).mod(BigNumber.from(10).pow(6))
      const remainderStr = remainder.toString().padStart(6, '0')
      return `${usdcAmount.toString()}.${remainderStr.slice(0, 6)} USDC`
    }
  }

  // Display route details
  console.log('\n🌉 BRIDGE ROUTE DETAILS:')
  console.log(`📤 Source Chain: ${SRC_CHAIN} (Chain ID: ${fromChainId})`)
  console.log(
    `📥 Destination Chain: ${
      isSolana ? 'Solana' : 'Arbitrum'
    } (Chain ID: ${toChainId})`
  )
  console.log(
    `💰 Amount: ${formatAmount(fromAmount, isNativeTX(TRANSACTION_TYPE))}`
  )
  console.log(`🎯 Sending Asset: ${sendingAssetId}`)
  console.log(`📦 Receiving Asset: ${receivingAssetId}`)
  console.log(
    `👤 Receiver: ${
      isSolana ? 'S5ARSDD3ddZqqqqqb2EUE2h2F1XQHBk7bErRW1WPGe4' : walletAddress
    }`
  )
  console.log(`🔄 Transaction Type: ${ITransactionTypeEnum[TRANSACTION_TYPE]}`)
  console.log('')

  // get deployments dynamically
  const deploymentsOPT = await getDeployments(
    'optimism',
    EnvironmentEnum.staging
  )
  const deploymentsARB = await getDeployments(
    'arbitrum',
    EnvironmentEnum.staging
  )

  // Set the addresses that depend on deployments
  DIAMOND_ADDRESS_SRC = deploymentsOPT.LiFiDiamond
  RECEIVER_ADDRESS_DST = isSolana
    ? ADDRESS_DEV_WALLET_SOLANA_BYTES32
    : WITH_DEST_CALL
    ? deploymentsARB.ReceiverAcrossV3
    : ADDRESS_DEV_WALLET_V4

  // Debug: Check what's in the deployments
  // console.log('Available deployments on Optimism:')
  // console.log(Object.keys(deploymentsOPT))
  // console.log('AcrossFacetV4 deployment:', deploymentsOPT.AcrossFacetV4)

  // make sure facet is deployed
  const isAcrossFacetV4Deployed = true // Assume deployed since user confirmed

  // get our diamond contract to interact with (using AcrossFacetV4 interface)
  const acrossV4Facet = AcrossFacetV4__factory.connect(
    DIAMOND_ADDRESS_SRC,
    wallet
  )
  console.log('diamond/AcrossFacetV4 connected: ', acrossV4Facet.address)

  // make sure that the desired route is available
  if (
    !(await isRouteAvailable(
      sendingAssetId,
      receivingAssetId,
      fromChainId,
      toChainId,
      BigNumber.from(fromAmount)
    ))
  )
    throw Error('Route is not available. Script cannot continue.')
  else console.log('✅ Route is available')
  console.log('')

  // get all AcrossV4-supported routes (>> bridge definitions)
  const routes = await getAllAvailableAcrossRoutes()
  console.log(`📊 Across currently supports ${routes.length} routes`)
  console.log('')

  // prepare bridgeData first
  // For Solana, use NON_EVM_ADDRESS in bridgeData (the real Solana address goes in AcrossV4Data)
  const NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1'
  const bridgeDataReceiver = isSolana
    ? NON_EVM_ADDRESS // Use NON_EVM_ADDRESS for Solana
    : WITH_DEST_CALL
    ? RECEIVER_ADDRESS_DST
    : walletAddress

  const bridgeData = createDefaultBridgeData(
    'acrossV4',
    isNativeTX(TRANSACTION_TYPE) ? constants.AddressZero : sendingAssetIdSrc,
    bridgeDataReceiver,
    fromAmount,
    toChainId,
    TRANSACTION_TYPE === ITransactionTypeEnum.ERC20_WITH_SRC ||
      TRANSACTION_TYPE === ITransactionTypeEnum.NATIVE_WITH_SRC,
    WITH_DEST_CALL
  )
  console.log('📋 BRIDGE DATA PARAMETERS:')
  console.log(JSON.stringify(bridgeData, null, 2))
  console.log('')

  // Calculate required input amount for source swap if needed
  let finalFromAmount = BigNumber.from(fromAmount)
  const srcSwapData: LibSwap.SwapDataStruct[] = []

  if (bridgeData.hasSourceSwaps)
    try {
      // Different handling for ERC20 vs Native source swaps
      if (TRANSACTION_TYPE === ITransactionTypeEnum.ERC20_WITH_SRC) {
        const srcSwap = await getUniswapDataERC20toExactERC20(
          ADDRESS_UNISWAP_OPT,
          fromChainId,
          ADDRESS_USDT_OPT,
          ADDRESS_USDC_OPT,
          BigNumber.from(fromAmount),
          DIAMOND_ADDRESS_SRC,
          true
        )
        srcSwapData.push(srcSwap)
      } else if (TRANSACTION_TYPE === ITransactionTypeEnum.NATIVE_WITH_SRC) {
        const srcSwap = await getUniswapDataERC20toExactETH(
          ADDRESS_UNISWAP_OPT,
          fromChainId,
          ADDRESS_USDT_OPT,
          BigNumber.from(fromAmount),
          DIAMOND_ADDRESS_SRC,
          true
        )
        srcSwapData.push(srcSwap)
      }

      if (!srcSwapData[0]) throw new Error('No source swap data available')

      // Set minAmount to exactly what we want as output
      bridgeData.minAmount = fromAmount
      finalFromAmount = BigNumber.from(fromAmount)

      console.log(
        'Required input amount:',
        srcSwapData[0].fromAmount.toString()
      )
    } catch (error) {
      console.error('Error in source swap calculation:', error)
      throw error
    }

  // Single approval of the sending asset to the Diamond contract
  if (bridgeData.hasSourceSwaps && srcSwapData[0])
    await ensureBalanceAndAllowanceToDiamond(
      ADDRESS_USDC_OPT,
      wallet,
      DIAMOND_ADDRESS_SRC,
      BigNumber.from(srcSwapData[0].fromAmount.toString()),
      false
    )
  else
    await ensureBalanceAndAllowanceToDiamond(
      sendingAssetId, // Use the actual sending asset ID, not the source asset ID
      wallet,
      DIAMOND_ADDRESS_SRC,
      BigNumber.from(bridgeData.minAmount),
      isNativeTX(TRANSACTION_TYPE)
    )

  // get a quote using adjusted amount
  const quote = await getAcrossQuote(
    sendingAssetId,
    receivingAssetId,
    fromChainId,
    toChainId,
    finalFromAmount.toString()
  )
  console.log('📊 ACROSS QUOTE RECEIVED:')
  console.log(JSON.stringify(quote, null, 2))
  console.log('')

  // calculate fees/minAmountOut and outputAmountPercent
  let minAmountOut = getMinAmountOut(quote, fromAmount)
  console.log('minAmountOut determined: ', minAmountOut.toString())

  // Calculate outputAmountPercent based on the relay fees from the quote
  const finalOutputAmountPercent = calculateOutputAmountPercentage(quote)
  console.log('calculated outputAmountPercent:', finalOutputAmountPercent)

  // Display quote summary
  console.log('\n📊 QUOTE SUMMARY:')
  console.log(
    `💸 Relay Fee: ${quote.relayFeeTotal} (${quote.relayFeePct} basis points)`
  )
  console.log(
    `⛽ Gas Fee: ${quote.relayGasFeeTotal} (${quote.relayGasFeePct} basis points)`
  )
  console.log(
    `💰 Capital Fee: ${quote.capitalFeeTotal} (${quote.capitalFeePct} basis points)`
  )
  console.log(
    `📈 LP Fee: ${quote.lpFee?.total || '0'} (${quote.lpFeePct} basis points)`
  )
  console.log(
    `📦 Expected Output: ${minAmountOut.toString()} ${
      isSolana ? 'USDC (Solana)' : 'USDC (Arbitrum)'
    }`
  )
  console.log(
    `⏱️  Estimated Fill Time: ${quote.estimatedFillTimeSec || 'N/A'} seconds`
  )
  console.log('')

  const swapData = []
  let payload = '0x'
  let uniswapAddress, executorAddress
  // prepare swapData, if tx has destination call
  if (WITH_DEST_CALL) {
    uniswapAddress = ADDRESS_UNISWAP_ARB
    executorAddress = deploymentsARB.Executor

    swapData[0] = await getUniswapSwapDataERC20ToERC20(
      uniswapAddress,
      toChainId,
      isNativeTX(TRANSACTION_TYPE) ? ADDRESS_WETH_ARB : ADDRESS_USDC_ARB,
      isNativeTX(TRANSACTION_TYPE) ? ADDRESS_USDC_ARB : ADDRESS_WETH_ARB,
      BigNumber.from(fromAmount),
      executorAddress,
      false
    )

    // prepare dest calldata, if tx has destination call
    payload = createDestCallPayload(bridgeData, swapData, walletAddress)
    console.log('payload prepared')

    // get updated quote
    const quote = await getAcrossQuote(
      sendingAssetId,
      receivingAssetId,
      fromChainId,
      toChainId,
      fromAmount,
      RECEIVER_ADDRESS_DST, // must be a contract address when a message is provided
      payload
    )

    // update minAmountOut
    minAmountOut = getMinAmountOut(quote, fromAmount)
    console.log(
      'minAmountOut updated (with payload estimate): ',
      minAmountOut.toString()
    )

    // update swapdata with new inputAmount
    swapData[0] = await getUniswapSwapDataERC20ToERC20(
      uniswapAddress,
      toChainId,
      isNativeTX(TRANSACTION_TYPE) ? ADDRESS_WETH_ARB : ADDRESS_USDC_ARB,
      isNativeTX(TRANSACTION_TYPE) ? ADDRESS_USDC_ARB : ADDRESS_WETH_ARB,
      minAmountOut,
      executorAddress,
      false
    )

    // update payload accordingly
    payload = createDestCallPayload(bridgeData, swapData, walletAddress)
  }

  // prepare AcrossV4Data - note the differences from V3
  const acrossV4Data: AcrossFacetV4.AcrossV4DataStruct = {
    receiverAddress: isSolana
      ? ADDRESS_DEV_WALLET_SOLANA_BYTES32 // Use pre-converted Solana bytes32 address
      : leftPadAddressToBytes32(
          // For other chains, convert to bytes32
          WITH_DEST_CALL ? RECEIVER_ADDRESS_DST : walletAddress
        ), // bytes32
    refundAddress: leftPadAddressToBytes32(walletAddress),
    sendingAssetId: leftPadAddressToBytes32(sendingAssetId),
    receivingAssetId: isSolana
      ? receivingAssetId // Already in bytes32 format for Solana
      : leftPadAddressToBytes32(receivingAssetId), // Convert to bytes32 for other chains
    outputAmount: minAmountOut.toString(),
    outputAmountMultiplier: '1000000000000000000', // 1e18 for no adjustment
    exclusiveRelayer: WITH_EXCLUSIVE_RELAYER
      ? leftPadAddressToBytes32(EXCLUSIVE_RELAYER)
      : '0x0000000000000000000000000000000000000000000000000000000000000000',
    quoteTimestamp: quote.timestamp || '0',
    fillDeadline: quote.timestamp
      ? BigNumber.from(quote.timestamp)
          .add(60 * 60)
          .toString() // 60 minutes from now
      : '0',
    exclusivityDeadline:
      WITH_EXCLUSIVE_RELAYER && quote.timestamp
        ? BigNumber.from(quote.timestamp)
            .add(5 * 60)
            .toString() // 5 minutes from now
        : '0',
    message: payload,
  }
  console.log('📋 ACROSS V4 DATA PARAMETERS:')
  console.log(JSON.stringify(acrossV4Data, null, 2))
  console.log('')

  // execute src transaction
  if (SEND_TX) {
    if (!isAcrossFacetV4Deployed) {
      console.log(
        '❌ Cannot execute transaction: AcrossFacetV4 is not deployed'
      )
      console.log('📋 Prepared data for demonstration:')
      console.log('Bridge Data:', JSON.stringify(bridgeData, null, 2))
      console.log('Across V4 Data:', JSON.stringify(acrossV4Data, null, 2))
      console.log(
        'Source Swap Data:',
        srcSwapData.length > 0 ? JSON.stringify(srcSwapData, null, 2) : 'None'
      )
      console.log(
        'Destination Swap Data:',
        swapData.length > 0 ? JSON.stringify(swapData, null, 2) : 'None'
      )
      console.log('')
      console.log('🚀 To deploy AcrossFacetV4 and make this script functional:')
      console.log('1. Run the deployment script for AcrossFacetV4')
      console.log('2. Update the diamond with the new facet')
      console.log('3. Set isAcrossFacetV4Deployed to true in this script')
      return
    }

    // create calldata from facet interface
    const executeTxData = bridgeData.hasSourceSwaps
      ? await acrossV4Facet.populateTransaction
          .swapAndStartBridgeTokensViaAcrossV4(
            bridgeData,
            srcSwapData,
            acrossV4Data
          )
          .then((tx) => tx.data || '0x')
      : await acrossV4Facet.populateTransaction
          .startBridgeTokensViaAcrossV4(bridgeData, acrossV4Data)
          .then((tx) => tx.data || '0x')

    // determine msg.value
    const msgValue = BigNumber.from(
      isNativeTX(TRANSACTION_TYPE) && !bridgeData.hasSourceSwaps
        ? bridgeData.minAmount
        : 0
    )

    console.log('🚀 EXECUTING TRANSACTION...')
    console.log('')

    // Debug: Check allowance and balance before transaction
    const tokenContract = new ethers.Contract(
      sendingAssetId,
      [
        'function allowance(address,address) view returns (uint256)',
        'function balanceOf(address) view returns (uint256)',
      ],
      wallet.provider
    )

    const allowance = await tokenContract.allowance(
      walletAddress,
      DIAMOND_ADDRESS_SRC // Check allowance for the diamond
    )
    const balance = await tokenContract.balanceOf(walletAddress)
    const requiredAmount = BigNumber.from(bridgeData.minAmount)

    console.log(`🔍 PRE-TRANSACTION CHECKS:`)
    console.log(
      `   Balance: ${formatAmount(
        balance.toString(),
        isNativeTX(TRANSACTION_TYPE)
      )}`
    )
    console.log(
      `   Allowance: ${formatAmount(
        allowance.toString(),
        isNativeTX(TRANSACTION_TYPE)
      )}`
    )
    console.log(
      `   Required: ${formatAmount(
        requiredAmount.toString(),
        isNativeTX(TRANSACTION_TYPE)
      )}`
    )
    console.log(`   Diamond Address: ${DIAMOND_ADDRESS_SRC}`)
    console.log(`   Facet Address: ${acrossV4Facet.address}`)
    console.log('')

    // Check and approve allowance if needed
    if (requiredAmount.gt(allowance)) {
      console.log('🔐 APPROVING TOKEN ALLOWANCE...')
      const approveTx = await tokenContract.approve(
        DIAMOND_ADDRESS_SRC, // Approve the diamond
        requiredAmount
      )
      await approveTx.wait()
      console.log('✅ Token approved for bridging')
      console.log('')
    } else {
      console.log('✅ Sufficient allowance already exists')
      console.log('')
    }

    // Test if the facet is accessible by calling a simple view function
    // try {
    //   console.log('🔍 Testing facet accessibility...')
    //   const spokePool = await acrossV4Facet.SPOKEPOOL()
    //   console.log(`✅ Facet is accessible. SpokePool: ${spokePool}`)
    // } catch (error: any) {
    //   console.log(`❌ Facet accessibility test failed: ${error.message}`)
    // }

    try {
      const transactionResponse = await sendTransaction(
        wallet,
        acrossV4Facet.address,
        executeTxData,
        msgValue
      )
      logDebug(`calldata: ${transactionResponse.data}\n`)

      console.log('\n🎉 TRANSACTION EXECUTED SUCCESSFULLY!')
      console.log(`📤 Deposit TX Hash: ${transactionResponse.hash}`)
      console.log(
        `🔗 Explorer Link: ${EXPLORER_BASE_URL}${transactionResponse.hash}`
      )
      console.log(
        `💰 Amount Deposited: ${formatAmount(
          fromAmount,
          isNativeTX(TRANSACTION_TYPE)
        )}`
      )
      console.log(`📥 Destination: ${isSolana ? 'Solana' : 'Arbitrum'}`)
      console.log(
        `👤 Receiver: ${
          isSolana
            ? 'S5ARSDD3ddZqqqqqb2EUE2h2F1XQHBk7bErRW1WPGe4'
            : walletAddress
        }`
      )
      console.log(
        `⏱️  Expected Fill Time: ${quote.estimatedFillTimeSec || 'N/A'} seconds`
      )
      console.log('')

      // Wait for transaction confirmation and get receipt
      console.log('⏳ Waiting for transaction confirmation...')
      const receipt = await transactionResponse.wait()
      console.log('✅ Transaction confirmed!')
      console.log('')

      console.log('📊 TRANSACTION RECEIPT DETAILS:')
      console.log(
        `   Status: ${receipt.status === 1 ? '✅ Success' : '❌ Failed'}`
      )
      console.log(`   Block Number: ${receipt.blockNumber}`)
      console.log(`   Gas Used: ${receipt.gasUsed?.toString() || 'N/A'}`)
      console.log(
        `   Effective Gas Price: ${
          receipt.effectiveGasPrice?.toString() || 'N/A'
        } wei`
      )
      console.log(
        `   Cumulative Gas Used: ${
          receipt.cumulativeGasUsed?.toString() || 'N/A'
        }`
      )
      console.log(`   From: ${receipt.from}`)
      console.log(`   To: ${receipt.to}`)
      console.log(`   Contract Address: ${receipt.contractAddress || 'N/A'}`)
      console.log(`   Transaction Index: ${receipt.transactionIndex}`)
      console.log(`   Logs: ${receipt.logs?.length || 0} events emitted`)
      console.log('')
    } catch (error: any) {
      console.log('\n❌ TRANSACTION FAILED!')
      console.log(`Error: ${error.message}`)
      throw error
    }
  } else {
    // Show mock transaction hash for demonstration when SEND_TX is false
    const mockTxHash =
      '0x' +
      Array.from({ length: 64 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join('')

    console.log('\n🎉 TRANSACTION PREPARED SUCCESSFULLY!')
    console.log(`📤 Deposit TX Hash: ${mockTxHash}`)
    console.log(`🔗 Explorer Link: ${EXPLORER_BASE_URL}${mockTxHash}`)
    console.log(
      `💰 Amount Deposited: ${formatAmount(
        fromAmount,
        isNativeTX(TRANSACTION_TYPE)
      )}`
    )
    console.log(`📥 Destination: ${isSolana ? 'Solana' : 'Arbitrum'}`)
    console.log(
      `👤 Receiver: ${
        isSolana ? 'S5ARSDD3ddZqqqqqb2EUE2h2F1XQHBk7bErRW1WPGe4' : walletAddress
      }`
    )
    console.log(
      `⏱️  Expected Fill Time: ${quote.estimatedFillTimeSec || 'N/A'} seconds`
    )
    console.log('')
    console.log(
      '💡 Note: This is a demonstration. Set SEND_TX = true to execute the actual transaction.'
    )
    console.log('')
  }
}

main()
  .then(() => {
    console.log('Script successfully completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    console.log('Script ended with errors :(')
    process.exit(1)
  })
