import { utils, BigNumber, constants } from 'ethers'
import { AcrossFacetV3, AcrossFacetV3__factory, ILiFi } from '../../typechain'
import deploymentsPOL from '../../deployments/polygon.staging.json'
import deploymentsOPT from '../../deployments/optimism.staging.json'
import {
  ADDRESS_USDC_OPT,
  ADDRESS_USDC_POL,
  ADDRESS_WETH_ARB,
  ADDRESS_WETH_OPT,
  ensureBalanceAndAllowanceToDiamond,
  getProvider,
  getWalletFromPrivateKeyInDotEnv,
  isNativeTX,
  sendTransaction,
  TX_TYPE,
} from './utils/demoScriptHelpers'
import { LibSwap } from '../../typechain/AcrossFacetV3'

// Successful transactions:
// POL.USDC > OPT.USDC: https://polygonscan.com/tx/0x27c6b57653e58fb7ee9315190a5dc2a13c9d2aaba4c83e66df74abcc2074c6bc (ERC20)
// OPT.WETH > ARB.WETH: https://optimistic.etherscan.io/tx/0x3e8628b80ffdcb86f2e4d8f64afc2c93f35aaa85730b040dbdce13a9f87dd035 (Native)
// POL.USDC > OPT.USDC:  (ERC20 + destCall)

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

// const EXECUTOR_ADDRESS_DST = deploymentsOPT.Executor

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

  logDebug(`found ${resp.length} routes`)

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
  try {
    resp = await fetch(
      `${ACROSS_API_BASE_URL}${endpointURL}?token=${sendingAssetId}&originChainId=${fromChainId}&destinationChainId=${toChainId}`
    ).then((resp) => resp.json())
  } catch (error) {
    console.error(`error: ${JSON.stringify(error, null, 2)}`)
  }

  if (!resp) throw Error(`Could not obtain send limits from API`)

  logDebug(`found send limits: ${JSON.stringify(resp, null, 2)}`)

  // make sure that amount is within deposit limits
  return fromAmount.lte(resp.maxDeposit) && fromAmount.gte(resp.minDeposit)
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
    logDebug(`fromAmount (${fromAmount})  is within send limits`)
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
  amount: string
): Promise<AcrossV3Quote> => {
  const endpointURL = '/suggested-fees'
  const fullURL = `${ACROSS_API_BASE_URL}${endpointURL}?token=${sendingAssetId}&destinationChainId=${toChainId}&amount=${amount}`
  logDebug(`requesting quote: ${fullURL}`)

  let resp: AcrossV3Quote | undefined = undefined
  try {
    resp = await fetch(
      `${ACROSS_API_BASE_URL}${endpointURL}?token=${sendingAssetId}&originChainId=${fromChainId}&destinationChainId=${toChainId}&amount=${amount}`
    ).then((response) => response.json())
  } catch (error) {
    console.error(error)
  }

  if (!resp)
    throw Error(
      `Could not obtain a quote for fromToken=${sendingAssetId}, destChainId=${toChainId}, amount=${amount}`
    )

  return resp
}

const getMinAmountOut = (quote: AcrossV3Quote, fromAmount: string) => {
  //@ BackendDev: read this to understand how to display full fee breakdown to user
  // https://docs.across.to/v/developer-docs/developers/across-api#calculating-suggested-fees
  const outputAmount = BigNumber.from(fromAmount).sub(quote.totalRelayFee.total)
  if (!outputAmount) throw Error('could not calculate output amount')
  return outputAmount
}

// ########################################## CONFIGURE SCRIPT HERE ##########################################
const TRANSACTION_TYPE = TX_TYPE.ERC20 as TX_TYPE // define which type of transaction you want to send
const SEND_TX = true // let the script run without actually sending a transaction
const DEBUG = true // set to true for higher verbosity in console output

// change these values only if you need to
const FROM_AMOUNT_ERC20 = '5100000' // 5.1 USDC (min send limit is just over 5 USD for this token)
const FROM_AMOUNT_NATIVE = '2000000000000000' // 0.002 (MATIC)
const fromChainId = isNativeTX(TRANSACTION_TYPE) ? 10 : 137 // WMATIC/MATIC is not supported by AcrossV3
const toChainId = isNativeTX(TRANSACTION_TYPE) ? 42161 : 10
const sendingAssetId = isNativeTX(TRANSACTION_TYPE)
  ? ADDRESS_WETH_OPT
  : ADDRESS_USDC_POL
const receivingAssetId = isNativeTX(TRANSACTION_TYPE)
  ? ADDRESS_WETH_ARB
  : ADDRESS_USDC_OPT
const fromAmount = isNativeTX(TRANSACTION_TYPE)
  ? FROM_AMOUNT_NATIVE
  : FROM_AMOUNT_ERC20
const WITH_DEST_CALL =
  TRANSACTION_TYPE === TX_TYPE.ERC20_WITH_DEST ||
  TRANSACTION_TYPE === TX_TYPE.NATIVE_WITH_DEST
const SRC_CHAIN = isNativeTX(TRANSACTION_TYPE) ? 'optimism' : 'polygon'
const DIAMOND_ADDRESS_SRC = isNativeTX(TRANSACTION_TYPE)
  ? deploymentsOPT.LiFiDiamond
  : deploymentsPOL.LiFiDiamond
const EXPLORER_BASE_URL = isNativeTX(TRANSACTION_TYPE)
  ? 'https://optimistic.etherscan.io/tx/'
  : 'https://polygonscan.com/tx/' // Across doesnt have an explorer

// ############################################################################################################
async function main() {
  // get provider and wallet
  const provider = getProvider(SRC_CHAIN)
  console.log('SRC_CHAIN: ', SRC_CHAIN)
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

  // get a quote
  const quote = await getAcrossQuote(
    sendingAssetId,
    fromChainId,
    toChainId,
    fromAmount
  )
  console.log(`quote obtained`)

  // calculate fees/minAmountOut
  const minAmountOut = getMinAmountOut(quote, fromAmount)
  console.log('minAmountOut determined: ', minAmountOut.toString())

  // make sure that wallet has sufficient balance and allowance set for diamond
  await ensureBalanceAndAllowanceToDiamond(
    sendingAssetId,
    wallet,
    DIAMOND_ADDRESS_SRC,
    BigNumber.from(fromAmount),
    isNativeTX(TRANSACTION_TYPE) ? true : false
  )

  // prepare bridgeData
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'acrossV3',
    integrator: 'demoScript',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: isNativeTX(TRANSACTION_TYPE)
      ? constants.AddressZero
      : sendingAssetId,
    receiver: walletAddress,
    minAmount: fromAmount,
    destinationChainId: toChainId,
    hasSourceSwaps: false,
    hasDestinationCall: WITH_DEST_CALL,
  }
  console.log('bridgeData prepared')

  // prepare swapData, if applicable
  const swapData: LibSwap.SwapDataStruct[] = []

  // prepare dest calldata, if applicable
  const payload = '0x' //FIXME:
  if (WITH_DEST_CALL) console.log('payload prepared')

  // prepare AcrossV3Data
  const acrossV3Data: AcrossFacetV3.AcrossV3DataStruct = {
    receivingAssetId: receivingAssetId,
    outputAmount: minAmountOut.toString(),
    quoteTimestamp: quote.timestamp,
    fillDeadline: BigNumber.from(quote.timestamp)
      .add(60 * 60)
      .toString(), // 60 minutes from now
    message: payload,
  }
  console.log('acrossV3Data prepared')

  // // execute src transaction
  if (SEND_TX) {
    let executeTxData
    if (WITH_DEST_CALL) {
      executeTxData = acrossV3Facet.interface.encodeFunctionData(
        'swapAndStartBridgeTokensViaAcrossV3',
        [bridgeData, swapData, acrossV3Data]
      )
    } else {
      executeTxData = acrossV3Facet.interface.encodeFunctionData(
        'startBridgeTokensViaAcrossV3',
        [bridgeData, acrossV3Data]
      )
    }

    // determine msg.value
    const msgValue = BigNumber.from(
      isNativeTX(TRANSACTION_TYPE) ? bridgeData.minAmount : 0
    )

    console.log('executing src TX now')
    const transactionResponse = await sendTransaction(
      wallet,
      acrossV3Facet.address,
      executeTxData,
      msgValue
    )
    logDebug(`calldata: ${transactionResponse.data}`)

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
