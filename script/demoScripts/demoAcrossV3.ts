import { utils, BigNumber, constants } from 'ethers'
import { AcrossFacetV3, AcrossFacetV3__factory, ILiFi } from '../../typechain'
import deploymentsOPT from '../../deployments/optimism.staging.json'
import deploymentsARB from '../../deployments/arbitrum.staging.json'
import {
  ADDRESS_UNISWAP_ARB,
  ADDRESS_UNISWAP_OPT,
  ADDRESS_USDC_ARB,
  ADDRESS_USDC_OPT,
  ADDRESS_USDT_OPT,
  ADDRESS_WETH_ARB,
  ADDRESS_WETH_OPT,
  DEFAULT_DEST_PAYLOAD_ABI,
  DEV_WALLET_ADDRESS,
  ensureBalanceAndAllowanceToDiamond,
  getAmountsOutUniswap,
  getProvider,
  getUniswapDataERC20toExactERC20,
  getUniswapDataERC20toExactETH,
  getUniswapSwapDataERC20ToERC20,
  getWalletFromPrivateKeyInDotEnv,
  isNativeTX,
  sendTransaction,
  TX_TYPE,
} from './utils/demoScriptHelpers'
import { LibSwap } from '../../typechain/AcrossFacetV3'

// SUCCESSFUL TRANSACTIONS PRODUCED BY THIS SCRIPT ---------------------------------------------------------------------------------------------------
// OPT.USDC > ARB.USDC: https://optimistic.etherscan.io/tx/0xd3562edd97fdcead8dbb556344ad80cd3b5b19cfee9f5bf33c3f094ef7b8b456 (ERC20)
// OPT.ETH > ARB.WETH: https://optimistic.etherscan.io/tx/0x3e8628b80ffdcb86f2e4d8f64afc2c93f35aaa85730b040dbdce13a9f87dd035 (Native)
// OPT.USDC > ARB.WETH: https://optimistic.etherscan.io/tx/0xd11f15e0efe22956fb57305b1dc972102316f3e2b6fc2c8a212f53448a6828b4 (ERC20 + destCall)
//                      https://arbiscan.io/tx/0x7e3ba99bc09305650291927cede3afc46e89db19d113b2af3b940ac35b2b3aca (release TX)
// OPT.ETH > ARB.USDC:  https://optimistic.etherscan.io/tx/0x7d3e7b2b14f42e504af045120d3bfec5c490e3042d14d2a4e767998414e1afec (Native + destCall)
//                      https://arbiscan.io/tx/0xca902d3080a25a6e629e9b48ad12e15d4fe3efda9ae8cc7bbb59299d2b0485a7 (release TX)
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/// TYPES
type AcrossV3Route = {
  originChainId: number
  originToken: string
  destinationChainId: number
  destinationToken: string
  originTokenSymbol: string
  destinationTokenSymbol: string
}
type FeeDetail = {
  pct: string
  total: string
}

type AcrossV3Quote = {
  capitalFeePct: string
  capitalFeeTotal: string
  relayGasFeePct: string
  relayGasFeeTotal: string
  relayFeePct: string
  relayFeeTotal: string
  lpFeePct: string
  timestamp: string
  isAmountTooLow: boolean
  quoteBlock: string
  spokePoolAddress: string
  totalRelayFee: FeeDetail
  relayerCapitalFee: FeeDetail
  relayerGasFee: FeeDetail
  lpFee: FeeDetail
}
type AcrossV3Limit = {
  minDeposit: string
  maxDeposit: string
  maxDepositInstant: string
  maxDepositShortDelay: string
  recommendedDepositInstant: string
}

/// DEFAULT VARIABLES
const ACROSS_API_BASE_URL = 'https://across.to/api'
/// #################

/// HELPER FUNCTIONS
const logDebug = (msg: string) => {
  if (DEBUG) console.log(msg)
}

const getAllAvailableAcrossRoutes = async (): Promise<AcrossV3Route[]> => {
  const endpointURL = '/available-routes'
  let resp: AcrossV3Route[] | undefined = undefined
  try {
    resp = await fetch(`${ACROSS_API_BASE_URL}${endpointURL}`).then((resp) =>
      resp.json()
    )
  } catch (error) {
    console.error(`error: ${JSON.stringify(error, null, 2)}`)
  }

  if (!resp) throw Error(`Could not obtain a list of available routes`)

  // logDebug(`found ${resp.length} routes`)

  return resp
}

const isTransferWithinSendLimit = async (
  sendingAssetId: string,
  fromChainId: number,
  toChainId: number,
  fromAmount: BigNumber
): Promise<boolean> => {
  const endpointURL = '/limits'
  let resp: AcrossV3Limit | undefined = undefined

  // For native ETH (zero address), use WETH address when checking limits
  const apiTokenAddress =
    sendingAssetId === constants.AddressZero
      ? ADDRESS_WETH_OPT // Use WETH address for native transactions
      : sendingAssetId

  const apiUrl = `${ACROSS_API_BASE_URL}${endpointURL}?token=${apiTokenAddress}&originChainId=${fromChainId}&destinationChainId=${toChainId}`
  console.log('Checking limits with URL:', apiUrl)

  try {
    const response = await fetch(apiUrl)
    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`)
    }
    resp = await response.json()

    if (!resp || !resp.maxDeposit || !resp.minDeposit) {
      throw new Error('Invalid response from API: missing deposit limits')
    }

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
  return Boolean(
    allRoutes.find(
      (route: AcrossV3Route) =>
        route.originToken.toLowerCase() === sendingAssetId.toLowerCase() &&
        route.originChainId === fromChainId &&
        route.destinationToken.toLowerCase() ===
          receivingAssetId.toLowerCase() &&
        route.destinationChainId === toChainId
    )
  )
}

const getAcrossQuote = async (
  sendingAssetId: string,
  fromChainId: number,
  toChainId: number,
  amount: string,
  receiverAddress = DEV_WALLET_ADDRESS,
  payload = '0x'
): Promise<AcrossV3Quote> => {
  const endpointURL = '/suggested-fees'
  const fullURL = `${ACROSS_API_BASE_URL}${endpointURL}?token=${sendingAssetId}&originChainId=${fromChainId}&destinationChainId=${toChainId}&amount=${amount}&recipient=${receiverAddress}&message=${payload}`
  logDebug(`requesting quote: ${fullURL}`)

  let resp: AcrossV3Quote | undefined = undefined
  try {
    resp = await fetch(fullURL).then((response) => response.json())
  } catch (error) {
    console.error(error)
  }

  if (!resp)
    throw Error(
      `Could not obtain a quote for fromToken=${sendingAssetId}, destChainId=${toChainId}, amount=${amount}`
    )

  // logDebug(`quote: ${JSON.stringify(resp, null, 2)}`)
  return resp
}

const calculateOutputAmountPercentage = (quote: AcrossV3Quote): number => {
  // Convert the relay fee percentage to basis points (10000 = 100.00%)
  const totalFeePercent = BigNumber.from(quote.relayFeePct)

  // Convert from 18 decimals to basis points (10000 = 100.00%)
  const scalingFactor = BigNumber.from(10).pow(18 - 4)
  const scaledFeePercent = totalFeePercent.div(scalingFactor)

  // Calculate output percentage as (100% - fee%)
  const outputPercent = BigNumber.from(10000).sub(scaledFeePercent)

  // Ensure the percentage is between 0 and 10000
  return Math.max(0, Math.min(10000, outputPercent.toNumber()))
}

const getMinAmountOut = (quote: AcrossV3Quote, fromAmount: string) => {
  //@ BackendDev: read this to understand how to display full fee breakdown to user
  // https://docs.across.to/v/developer-docs/developers/across-api#calculating-suggested-fees
  const outputAmount = BigNumber.from(fromAmount).sub(quote.totalRelayFee.total)
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
const TRANSACTION_TYPE = TX_TYPE.ERC20_WITH_SRC as TX_TYPE // define which type of transaction you want to send
const SEND_TX = true // allows you to the script run without actually sending a transaction (=false)
const DEBUG = false // set to true for higher verbosity in console output

// change these values only if you need to
const fromChainId = 10 // WMATIC/MATIC is not supported by AcrossV3
const toChainId = 42161
const sendingAssetId = isNativeTX(TRANSACTION_TYPE)
  ? ADDRESS_WETH_OPT // Use zero address for native ETH
  : ADDRESS_USDC_OPT

// Define sendingAssetIdSrc based on transaction type
const sendingAssetIdSrc =
  TRANSACTION_TYPE === TX_TYPE.ERC20_WITH_SRC ||
  TRANSACTION_TYPE === TX_TYPE.NATIVE_WITH_SRC
    ? ADDRESS_USDC_OPT
    : sendingAssetId

// For the swap path, we need WETH when it's a native transaction
const swapPathStartToken = isNativeTX(TRANSACTION_TYPE)
  ? ADDRESS_WETH_OPT // Use WETH in the path for native transactions
  : sendingAssetIdSrc
const receivingAssetId = isNativeTX(TRANSACTION_TYPE)
  ? ADDRESS_WETH_ARB
  : ADDRESS_USDC_ARB
const fromAmount = isNativeTX(TRANSACTION_TYPE)
  ? '2000000000000000' // 0.002 (ETH)
  : '5100000' // 5.1 USDC (min send limit is just over 5 USD for this token)
const WITH_DEST_CALL =
  TRANSACTION_TYPE === TX_TYPE.ERC20_WITH_DEST ||
  TRANSACTION_TYPE === TX_TYPE.NATIVE_WITH_DEST
const WITH_EXCLUSIVE_RELAYER = false
const EXCLUSIVE_RELAYER = '0x07ae8551be970cb1cca11dd7a11f47ae82e70e67' // biggest across relayer
const SRC_CHAIN = 'optimism'
const DIAMOND_ADDRESS_SRC = deploymentsOPT.LiFiDiamond
const RECEIVER_ADDRESS_DST = WITH_DEST_CALL
  ? deploymentsARB.ReceiverAcrossV3
  : constants.AddressZero
const EXPLORER_BASE_URL = 'https://optimistic.etherscan.io/tx/'

// ############################################################################################################
async function main() {
  // get provider and wallet
  const provider = getProvider(SRC_CHAIN)
  const wallet = getWalletFromPrivateKeyInDotEnv(provider)
  const walletAddress = await wallet.getAddress()
  console.log('you are using this wallet address: ', walletAddress)

  // get our diamond contract to interact with (using AcrossV3 interface)
  const acrossV3Facet = AcrossFacetV3__factory.connect(
    DIAMOND_ADDRESS_SRC,
    wallet
  )
  console.log('diamond/AcrossFacetV3 connected: ', acrossV3Facet.address)

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
  else logDebug('route is available')

  // get all AcrossV3-supported routes (>> bridge definitions)
  // for bridge definitions you also want to consider sending limits: https://docs.across.to/v/developer-docs/developers/across-api#querying-limits
  const routes = await getAllAvailableAcrossRoutes()
  console.log(`Across currently supports ${routes.length} routes`)

  // prepare bridgeData first
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'acrossV3',
    integrator: 'demoScript',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: isNativeTX(TRANSACTION_TYPE)
      ? constants.AddressZero
      : sendingAssetIdSrc,
    receiver: WITH_DEST_CALL ? RECEIVER_ADDRESS_DST : walletAddress,
    minAmount: fromAmount,
    destinationChainId: toChainId,
    hasSourceSwaps:
      TRANSACTION_TYPE === TX_TYPE.ERC20_WITH_SRC ||
      TRANSACTION_TYPE === TX_TYPE.NATIVE_WITH_SRC,
    hasDestinationCall: WITH_DEST_CALL,
  }
  console.log('bridgeData prepared')

  // Calculate required input amount for source swap if needed
  let finalFromAmount = BigNumber.from(fromAmount)
  const srcSwapData: LibSwap.SwapDataStruct[] = []

  if (bridgeData.hasSourceSwaps) {
    try {
      // Different handling for ERC20 vs Native source swaps
      if (TRANSACTION_TYPE === TX_TYPE.ERC20_WITH_SRC) {
        // For ERC20: Swap USDT to USDC
        const srcSwap = await getUniswapDataERC20toExactERC20(
          ADDRESS_UNISWAP_OPT,
          fromChainId,
          ADDRESS_USDT_OPT, // From USDT
          ADDRESS_USDC_OPT, // To USDC
          BigNumber.from(fromAmount),
          DIAMOND_ADDRESS_SRC,
          true
        )
        srcSwapData.push(srcSwap)
      } else if (TRANSACTION_TYPE === TX_TYPE.NATIVE_WITH_SRC) {
        // For Native: Swap USDT to exact ETH amount
        const srcSwap = await getUniswapDataERC20toExactETH(
          ADDRESS_UNISWAP_OPT,
          fromChainId,
          ADDRESS_USDT_OPT, // From USDT
          BigNumber.from(fromAmount),
          DIAMOND_ADDRESS_SRC,
          true
        )
        srcSwapData.push(srcSwap)
      }

      // Set minAmount to exactly what we want as output
      bridgeData.minAmount = fromAmount
      finalFromAmount = BigNumber.from(fromAmount)

      console.log(
        'Required input amount:',
        srcSwapData[0].fromAmount.toString()
      )
      console.log('Exact output amount:', fromAmount)
    } catch (error) {
      console.error('Error in source swap calculation:', error)
      throw error
    }
  }

  // get a quote using adjusted amount
  const quote = await getAcrossQuote(
    sendingAssetId,
    fromChainId,
    toChainId,
    finalFromAmount.toString()
  )
  console.log(`quote obtained`)

  // calculate fees/minAmountOut and outputAmountPercent
  let minAmountOut = getMinAmountOut(quote, fromAmount)
  console.log('minAmountOut determined: ', minAmountOut.toString())

  // Calculate outputAmountPercent based on the relay fees from the quote
  const finalOutputAmountPercent = calculateOutputAmountPercentage(quote)
  console.log('calculated outputAmountPercent:', finalOutputAmountPercent)

  // Single approval of the sending asset to the Diamond contract
  if (bridgeData.hasSourceSwaps) {
    // For source swaps, approve USDT since that's what we're starting with
    await ensureBalanceAndAllowanceToDiamond(
      ADDRESS_USDT_OPT, // Use USDT for source swaps
      wallet,
      DIAMOND_ADDRESS_SRC,
      BigNumber.from(srcSwapData[0].fromAmount), // Use the calculated input amount
      false // Not native token
    )
  } else {
    // For direct bridges, approve the sending asset
    await ensureBalanceAndAllowanceToDiamond(
      sendingAssetIdSrc,
      wallet,
      DIAMOND_ADDRESS_SRC,
      BigNumber.from(bridgeData.minAmount),
      isNativeTX(TRANSACTION_TYPE)
    )
  }

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

  // prepare AcrossV3Data
  const acrossV3Data: AcrossFacetV3.AcrossV3DataStruct = {
    receivingAssetId: receivingAssetId,
    outputAmount: minAmountOut.toString(),
    outputAmountPercent: finalOutputAmountPercent,
    quoteTimestamp: quote.timestamp,
    fillDeadline: BigNumber.from(quote.timestamp)
      .add(60 * 60)
      .toString(), // 60 minutes from now
    message: payload,
    receiverAddress: WITH_DEST_CALL ? RECEIVER_ADDRESS_DST : walletAddress,
    refundAddress: walletAddress,
    exclusiveRelayer: WITH_EXCLUSIVE_RELAYER
      ? EXCLUSIVE_RELAYER
      : constants.AddressZero,
    exclusivityDeadline: WITH_EXCLUSIVE_RELAYER
      ? BigNumber.from(quote.timestamp)
          .add(5 * 60)
          .toString() // 5 minutes from now
      : 0,
  }
  console.log('acrossV3Data prepared')

  // // execute src transaction
  if (SEND_TX) {
    // create calldata from facet interface
    const executeTxData = acrossV3Facet.interface.encodeFunctionData(
      bridgeData.hasSourceSwaps
        ? 'swapAndStartBridgeTokensViaAcrossV3'
        : 'startBridgeTokensViaAcrossV3',
      bridgeData.hasSourceSwaps
        ? [bridgeData, srcSwapData, acrossV3Data]
        : [bridgeData, acrossV3Data]
    )

    // determine msg.value
    const msgValue = BigNumber.from(
      isNativeTX(TRANSACTION_TYPE) && !bridgeData.hasSourceSwaps
        ? bridgeData.minAmount
        : 0
    )

    console.log('executing src TX now')
    const transactionResponse = await sendTransaction(
      wallet,
      acrossV3Facet.address,
      executeTxData,
      msgValue
    )
    logDebug(`calldata: ${transactionResponse.data}\n`)

    console.log(
      'src TX successfully executed: ',
      EXPLORER_BASE_URL + transactionResponse.hash
    )
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
