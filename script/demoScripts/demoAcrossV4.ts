import { consola } from 'consola'
import { BigNumber, constants, utils } from 'ethers'

import deploymentsARB from '../../deployments/arbitrum.staging.json'
import deploymentsOPT from '../../deployments/optimism.staging.json'
import {
  type AcrossFacetV4,
  type ILiFi,
  AcrossFacetV4__factory,
} from '../../typechain'
import type { LibSwap } from '../../typechain/AcrossFacetV4'

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
const ACROSS_CHAIN_ID_SOL = 34268394551451 // Across Custom ID for Solana (differs from LiFi internal ID 1151111081099710)
/// #################

/// HELPER FUNCTIONS
const logDebug = (msg: string) => {
  consola.debug(msg)
}

const getAllAvailableAcrossRoutes = async (): Promise<IAcrossV4Route[]> => {
  const endpointURL = '/available-routes'
  let resp: IAcrossV4Route[] | undefined = undefined
  try {
    resp = await fetch(`${ACROSS_API_BASE_URL}${endpointURL}`).then((resp) =>
      resp.json()
    )
  } catch (error) {
    consola.error(`error: ${JSON.stringify(error, null, 2)}`)
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
  logDebug(`Checking limits with URL: ${apiUrl}`)

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
    consola.error('Error checking transfer limits:', error)
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
    consola.error(error)
  }

  if (!resp)
    throw Error(
      `Could not obtain a quote for fromToken=${sendingAssetId}, destChainId=${toChainId}, amount=${amount}`
    )

  return resp
}

const calculateOutputAmountPercentage = (quote: IAcrossV4Quote): string => {
  // Convert the relay fee percentage from basis points to 18 decimal fixed point
  const totalFeePercent = BigNumber.from(quote.relayFeePct || '0')

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
  bridgeData: ILiFi.BridgeDataStruct,
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
const DIAMOND_ADDRESS_SRC = deploymentsOPT.LiFiDiamond
const RECEIVER_ADDRESS_DST = isSolana
  ? ADDRESS_DEV_WALLET_SOLANA_BYTES32
  : WITH_DEST_CALL
  ? deploymentsARB.ReceiverAcrossV3
  : ADDRESS_DEV_WALLET_V4
const EXPLORER_BASE_URL = 'https://optimistic.etherscan.io/tx/'

// ############################################################################################################
async function main() {
  // get provider and wallet
  const provider = getProvider(SRC_CHAIN)
  const wallet = getWalletFromPrivateKeyInDotEnv(provider)
  const walletAddress = await wallet.getAddress()
  consola.info('you are using this wallet address: ', walletAddress)

  // Helper function to format amount with decimals
  const formatAmount = (amount: string, isNative: boolean): string => {
    if (isNative) {
      // For ETH, convert from wei to ETH (18 decimals)
      const ethAmount = BigNumber.from(amount).div(BigNumber.from(10).pow(18))
      const remainder = BigNumber.from(amount).mod(BigNumber.from(10).pow(18))
      const remainderStr = remainder.toString().padStart(18, '0')
      return `${ethAmount.toString()}.${remainderStr.slice(0, 6)} ETH`
    } else {
      // For USDC, convert from micro USDC to USDC (6 decimals)
      const usdcAmount = BigNumber.from(amount).div(BigNumber.from(10).pow(6))
      const remainder = BigNumber.from(amount).mod(BigNumber.from(10).pow(6))
      const remainderStr = remainder.toString().padStart(6, '0')
      return `${usdcAmount.toString()}.${remainderStr.slice(0, 6)} USDC`
    }
  }

  // Display route details
  consola.info('\n🌉 BRIDGE ROUTE DETAILS:')
  consola.info(`📤 Source Chain: ${SRC_CHAIN} (Chain ID: ${fromChainId})`)
  consola.info(
    `📥 Destination Chain: ${
      isSolana ? 'Solana' : 'Arbitrum'
    } (Chain ID: ${toChainId})`
  )
  consola.info(
    `💰 Amount: ${formatAmount(fromAmount, isNativeTX(TRANSACTION_TYPE))}`
  )
  consola.info(`🎯 Sending Asset: ${sendingAssetId}`)
  consola.info(`📦 Receiving Asset: ${receivingAssetId}`)
  consola.info(
    `👤 Receiver: ${
      isSolana ? 'S5ARSDD3ddZqqqqqb2EUE2h2F1XQHBk7bErRW1WPGe4' : walletAddress
    }`
  )
  consola.info(`🔄 Transaction Type: ${ITransactionTypeEnum[TRANSACTION_TYPE]}`)
  consola.info('')

  // get our diamond contract to interact with (using AcrossV4 interface)
  const acrossV4Facet = AcrossFacetV4__factory.connect(
    DIAMOND_ADDRESS_SRC,
    wallet
  )
  consola.info('diamond/AcrossFacetV4 connected: ', acrossV4Facet.address)

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
  else consola.info('✅ Route is available')

  // get all AcrossV4-supported routes (>> bridge definitions)
  const routes = await getAllAvailableAcrossRoutes()
  consola.info(`📊 Across currently supports ${routes.length} routes`)
  consola.info('')

  // prepare bridgeData first
  // For Solana, use NON_EVM_ADDRESS in bridgeData (the real Solana address goes in AcrossV4Data)
  const NON_EVM_ADDRESS = '0x11f111f111f111F111f111f111F111f111f111F1'
  const bridgeDataReceiver = isSolana
    ? NON_EVM_ADDRESS // Use NON_EVM_ADDRESS for Solana
    : WITH_DEST_CALL
    ? RECEIVER_ADDRESS_DST
    : walletAddress

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'acrossV4',
    integrator: 'demoScript',
    referrer: constants.AddressZero,
    sendingAssetId: isNativeTX(TRANSACTION_TYPE)
      ? constants.AddressZero
      : sendingAssetIdSrc,
    receiver: bridgeDataReceiver,
    minAmount: fromAmount,
    destinationChainId: toChainId,
    hasSourceSwaps:
      TRANSACTION_TYPE === ITransactionTypeEnum.ERC20_WITH_SRC ||
      TRANSACTION_TYPE === ITransactionTypeEnum.NATIVE_WITH_SRC,
    hasDestinationCall: WITH_DEST_CALL,
  }
  consola.info('📋 bridgeData prepared')

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

      consola.info(
        'Required input amount:',
        srcSwapData[0].fromAmount.toString()
      )
    } catch (error) {
      consola.error('Error in source swap calculation:', error)
      throw error
    }

  // Single approval of the sending asset to the Diamond contract (only when sending TX)
  if (SEND_TX)
    if (bridgeData.hasSourceSwaps && srcSwapData[0])
      await ensureBalanceAndAllowanceToDiamond(
        ADDRESS_USDT_OPT,
        wallet,
        DIAMOND_ADDRESS_SRC,
        BigNumber.from(srcSwapData[0].fromAmount.toString()),
        false
      )
    else
      await ensureBalanceAndAllowanceToDiamond(
        sendingAssetIdSrc,
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
  consola.info('📊 quote obtained')

  // calculate fees/minAmountOut and outputAmountPercent
  let minAmountOut = getMinAmountOut(quote, fromAmount)
  consola.info('💰 minAmountOut determined: ', minAmountOut.toString())

  // Calculate outputAmountPercent based on the relay fees from the quote
  const finalOutputAmountPercent = calculateOutputAmountPercentage(quote)
  logDebug('calculated outputAmountPercent: ' + finalOutputAmountPercent)

  // Display quote summary
  consola.info('\n📊 QUOTE SUMMARY:')
  consola.info(
    `💸 Relay Fee: ${quote.relayFeeTotal} (${quote.relayFeePct} basis points)`
  )
  consola.info(
    `⛽ Gas Fee: ${quote.relayGasFeeTotal} (${quote.relayGasFeePct} basis points)`
  )
  consola.info(
    `💰 Capital Fee: ${quote.capitalFeeTotal} (${quote.capitalFeePct} basis points)`
  )
  consola.info(
    `📈 LP Fee: ${quote.lpFee?.total || '0'} (${quote.lpFeePct} basis points)`
  )
  consola.info(
    `📦 Expected Output: ${formatAmount(minAmountOut.toString(), false)} on ${
      isSolana ? 'Solana' : 'Arbitrum'
    }`
  )
  consola.info(
    `⏱️  Estimated Fill Time: ${quote.estimatedFillTimeSec || 'N/A'} seconds`
  )
  consola.info('')

  const swapData = []
  let payload = '0x'
  let uniswapAddress, executorAddress
  // prepare swapData, if tx has destination call
  if (WITH_DEST_CALL) {
    if (isSolana) {
      throw new Error(
        'Destination call is not supported for Solana routes in this demo.'
      )
    }
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
    consola.info('🎯 payload prepared')

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
    consola.info(
      '💰 minAmountOut updated (with payload estimate): ',
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
      : constants.HashZero,
    quoteTimestamp: quote.timestamp || '0',
    fillDeadline: quote.timestamp
      ? BigNumber.from(quote.timestamp)
          .add(60 * 60)
          .toString() // 60 minutes from now
      : '0',
    exclusivityParameter:
      WITH_EXCLUSIVE_RELAYER && quote.timestamp
        ? BigNumber.from(quote.timestamp)
            .add(5 * 60)
            .toString() // 5 minutes from now
        : '0',
    message: payload,
  }
  consola.info('📋 acrossV4Data prepared')

  // execute src transaction
  if (SEND_TX) {
    // create calldata from facet interface
    const executeTxData = bridgeData.hasSourceSwaps
      ? await acrossV4Facet.populateTransaction
          .swapAndStartBridgeTokensViaAcrossV4(
            bridgeData,
            srcSwapData,
            acrossV4Data
          )
          .then((tx: any) => tx.data)
      : await acrossV4Facet.populateTransaction
          .startBridgeTokensViaAcrossV4(bridgeData, acrossV4Data)
          .then((tx: any) => tx.data)

    // determine msg.value
    const msgValue = BigNumber.from(
      isNativeTX(TRANSACTION_TYPE) && !bridgeData.hasSourceSwaps
        ? bridgeData.minAmount
        : 0
    )

    consola.info('🚀 executing bridge transaction now...')
    const transactionResponse = await sendTransaction(
      wallet,
      acrossV4Facet.address,
      executeTxData,
      msgValue
    )
    logDebug(`calldata: ${transactionResponse.data}\n`)

    consola.info('\n🎉 BRIDGE TRANSACTION EXECUTED SUCCESSFULLY!')
    consola.info(`📤 Deposit TX Hash: ${transactionResponse.hash}`)
    consola.info(
      `🔗 Explorer Link: ${EXPLORER_BASE_URL}${transactionResponse.hash}`
    )
    consola.info(
      `💰 Amount Deposited: ${formatAmount(
        fromAmount,
        isNativeTX(TRANSACTION_TYPE)
      )}`
    )
    consola.info(`📥 Destination: ${isSolana ? 'Solana' : 'Arbitrum'}`)
    consola.info(
      `👤 Receiver: ${
        isSolana ? 'S5ARSDD3ddZqqqqqb2EUE2h2F1XQHBk7bErRW1WPGe4' : walletAddress
      }`
    )
    consola.info(
      `⏱️  Expected Fill Time: ${quote.estimatedFillTimeSec || 'N/A'} seconds`
    )
    consola.info('')
  }
}

main()
  .then(() => {
    consola.info('Script successfully completed')
    process.exit(0)
  })
  .catch((error) => {
    consola.error(error)
    consola.info('Script ended with errors :(')
    process.exit(1)
  })
