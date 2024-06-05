import { providers, Wallet, utils, Contract, BigNumber } from 'ethers'
import {
  ERC20__factory,
  ILiFi,
  IStargate__factory,
  IStargate,
  StargateFacet,
} from '../../typechain'
import { node_url } from '../../utils/network'
import deploymentsPOL from '../../deployments/polygon.staging.json'
import deploymentsOPT from '../../deployments/optimism.staging.json'
import stargateConfig from '../../config/stargate.json'
import { StargateFacet__factory } from '../../typechain/factories'

type FeeParams = {
  sender: string
  dstEid: number
  amountInSD: string
  deficitSD: string
  toOFT: boolean
  isTaxi: boolean
}

type QuoteOFTResponse = {
  oftLimit: IStargate.OFTLimitStruct
  feeDetail: IStargate.OFTFeeDetailStruct[]
  oftReceipt: IStargate.OFTReceiptStruct
}

// SUCCESSFUL TX
// https://d3k4i7b673n27r.cloudfront.net/v1/buses/bus-queue/0xbe3e0ad093578b943fce18b139fe99c8afa40074935108cc98135785b1e4a9a8 (bus, no dstCall)
// https://layerzeroscan.com/tx/0x5f42d846f4b1710df9ab6950a40990eabc6a55b7456b24c82075f00426d52566 (taxi, with dstCall)

const USDC_OPT = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
const WETH_OPT = '0x4200000000000000000000000000000000000006'
const USDC_POL = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const PAYLOAD_ABI = [
  'bytes32', // Transaction Id
  'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[]', // Swap Data
  'address', // Receiver
]

const FEE_LIBRARY_ABI = [
  'function applyFeeView((address,uint32,uint64,uint64,bool,bool)) view returns (uint64)',
]

const VALID_EXTRA_OPTIONS_VALUE =
  '0x000301001303000000000000000000000000000000061a80' // gives 400_000 gas on dstChain
const SRC_CHAIN = 'polygon'
const DST_CHAIN_ID = 10
const DIAMOND_ADDRESS_SRC = deploymentsPOL.LiFiDiamond
const RECEIVER_ADDRESS_DST = deploymentsOPT.ReceiverStargateV2
const EXECUTOR_ADDRESS_DST = deploymentsOPT.Executor
const STARGATE_POOL_USDC_POL = '0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4'
const UNISWAP_ADDRESS_DST = '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2' // Uniswap OPT
const amountIn = utils.parseUnits('1', 5) // 0.1 USDC
const TAXI_EXPLORER_URL = 'https://layerzeroscan.com/tx/'
const BUS_EXPLORER_URL =
  'https://d3k4i7b673n27r.cloudfront.net/v1/buses/bus-queue/'

// ############ CONFIGURE SCRIPT HERE ############################
const IS_TAXI = false // Bus vs. Taxi mode
const WITH_DEST_CALL = true // adds a dest call if set to true
const SEND_TX = true // disable tx sending here for debugging purposes
// ###############################################################

async function main() {
  // Every token has an assetId on every network. This needs to be looked up for each token.
  // see getSupportedTokensAndPools() for API endpoint url
  const ASSET_ID = 1 // 1 = USDC on POL

  // set up srcChain provider
  const rpcProviderSrc = new providers.JsonRpcProvider(node_url(SRC_CHAIN))
  const providerSrc = new providers.FallbackProvider([rpcProviderSrc])

  // set up wallet with provider
  const wallet = new Wallet(process.env.PRIVATE_KEY as string, providerSrc)
  const walletAddress = await wallet.getAddress()

  // get contracts
  const stargateFacet = StargateFacet__factory.connect(
    DIAMOND_ADDRESS_SRC,
    wallet
  )
  console.log('stargateFacet connected: ', stargateFacet.address)

  const stargatePool = IStargate__factory.connect(
    STARGATE_POOL_USDC_POL,
    wallet
  )
  console.log('stargatePool connected: ', stargatePool.address)

  const dstChainEid = getEndpointId(DST_CHAIN_ID)
  if (!dstChainEid)
    throw Error(`could not find endpointId for chain ${DST_CHAIN_ID}`)

  // prepare initial sendParams
  const sendParams: IStargate.SendParamStruct = {
    dstEid: dstChainEid,
    to: addressToBytes32(
      WITH_DEST_CALL ? RECEIVER_ADDRESS_DST : wallet.address
    ),
    amountLD: amountIn.toString(),
    minAmountLD: 0, //minAmountOut (will be added later)
    extraOptions: getExtraOptions(),
    composeMsg: '0x', // payload (will be added later)
    oftCmd: oftCmdHelper(),
  }
  console.log('sendParams initialized')

  // get quote from Stargate pool
  const minAmountOutBridge = await getAmountOutFeeQuoteOFT(
    stargatePool,
    sendParams
  )
  console.log(`after getAmountOutFeeQuote: ${minAmountOutBridge.toString()}`)

  // update sendParams with minAmountOut
  sendParams.minAmountLD = minAmountOutBridge

  // prepare destSwap callData
  const uniswap = new Contract(UNISWAP_ADDRESS_DST, [
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  ])
  const path = [USDC_OPT, WETH_OPT]
  const deadline = Math.floor(Date.now() / 1000) + 60 * 60 // 60 minutes from the current Unix time

  const uniswapCalldata =
    await uniswap.populateTransaction.swapExactTokensForTokens(
      minAmountOutBridge, // amountIn
      0, // amountOutMin
      path,
      EXECUTOR_ADDRESS_DST,
      deadline
    )

  // construct LibSwap.SwapData
  const swapData = {
    callTo: UNISWAP_ADDRESS_DST,
    approveTo: UNISWAP_ADDRESS_DST,
    sendingAssetId: USDC_OPT,
    receivingAssetId: WETH_OPT,
    fromAmount: minAmountOutBridge,
    callData: uniswapCalldata.data,
  }
  console.log('dst swapData prepared')

  // prepare bridgeData
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'stargate',
    integrator: 'demoScript',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: USDC_POL,
    receiver: walletAddress,
    minAmount: amountIn,
    destinationChainId: DST_CHAIN_ID,
    hasSourceSwaps: false,
    hasDestinationCall: WITH_DEST_CALL,
  }
  console.log('bridgeData prepared')

  // create stargate payload to be sent cross-chain
  const payload = utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
    bridgeData.transactionId,
    [swapData],
    walletAddress, // receiver
  ])
  console.log('payload prepared: ', payload)

  // update payload in sendParams
  sendParams.composeMsg = WITH_DEST_CALL ? payload : '0x'

  // fetch quote for layerZero fees (in native) with sendParams that include the payload and the extraOptions
  const messagingFee = await stargatePool.quoteSend(sendParams, false)
  console.log('nativeFee quote received: ', messagingFee.nativeFee.toString())

  // make sure that wallet has sufficient balance and allowance set for diamond
  await ensureBalanceAndAllowanceToDiamond(
    USDC_POL,
    wallet,
    DIAMOND_ADDRESS_SRC,
    amountIn
  )

  // construct StargateData
  const stargateData: StargateFacet.StargateDataStruct = {
    assetId: ASSET_ID,
    sendParams,
    fee: messagingFee,
    refundAddress: walletAddress,
  }
  console.log('stargateData prepared')

  // Estimate gas limit
  const gasLimit = await stargateFacet.estimateGas.startBridgeTokensViaStargate(
    bridgeData,
    stargateData,
    {
      value: messagingFee.nativeFee,
    }
  )

  const gasPrice = await providerSrc.getGasPrice()
  const maxPriorityFeePerGas = gasPrice.mul(2)
  const maxFeePerGas = gasPrice.mul(3)

  // // execute src transaction
  if (SEND_TX) {
    console.log('executing src TX now')
    const trx = await stargateFacet.startBridgeTokensViaStargate(
      bridgeData,
      stargateData,
      {
        gasLimit,
        maxPriorityFeePerGas,
        maxFeePerGas,
        value: messagingFee.nativeFee,
      }
    )

    console.log('calldata: ', trx.data)

    await trx.wait()
    const baseURL =
      WITH_DEST_CALL || IS_TAXI ? TAXI_EXPLORER_URL : BUS_EXPLORER_URL
    console.log('src TX successfully executed: ', baseURL + trx.hash)
  }
  console.log('end of script reached')
}

// Returns a value (extraOptions) that is used to signal Starcraft how much gas we need on dstChain (to execute our dst call)
// More info here: https://stargateprotocol.gitbook.io/stargate/v/v2-developer-docs/integrate-with-stargate/composability
// For this demo script we are using a hardcoded value that gives 400k gas stipend but ideally that value should be based on
// the dst payload size/cost
const getExtraOptions = () => {
  if (WITH_DEST_CALL) {
    return VALID_EXTRA_OPTIONS_VALUE // value for 400_000 dstGas and no "msg.value" on dst
  } else {
    return '0x'
  }
}

// get the amountOut at destination chain for a given amountIn based on sendParams
const getAmountOutFeeQuoteOFT = async (
  stargatePool: IStargate,
  sendParams: IStargate.SendParamStruct
) => {
  const resp = await stargatePool.callStatic.quoteOFT(sendParams)
  const response = transformQuoteOFTResponse(resp)

  if (!response)
    throw `Could not get quoteOFT response for params: ${JSON.stringify(
      sendParams,
      null,
      2
    )}`

  if ((response.oftLimit.maxAmountLD as BigNumber).isZero()) {
    throw Error('Route has no credits and cannot be used')
  }

  // console.log(`QuoteOFT response: ${JSON.stringify(response, null, 2)}`)

  return response.oftReceipt.amountReceivedLD
}

// Takes a smart contract response and converts it to typed data
function transformQuoteOFTResponse(response: any[]): QuoteOFTResponse {
  const oftLimit: IStargate.OFTLimitStruct = {
    minAmountLD: BigNumber.from(response[0][0]),
    maxAmountLD: BigNumber.from(response[0][1]), // if this value is 0 then the route has no credits i.e. cannot be used
  }

  const feeDetail: IStargate.OFTFeeDetailStruct[] = response[1].map(
    (feeDetail: any) => ({
      feeAmountLD: BigNumber.from(feeDetail[0]),
      description: feeDetail[1],
    })
  )
  const oftReceipt: IStargate.OFTReceiptStruct = {
    amountSentLD: BigNumber.from(response[2][0]),
    amountReceivedLD: BigNumber.from(response[2][1]),
  }

  return {
    oftLimit,
    feeDetail,
    oftReceipt,
  }
}

// This endpoint returns all tokens, their pools/routers and assetIds
async function getSupportedTokensAndPools() {
  const resp = await fetch(
    'https://d3k4i7b673n27r.cloudfront.net/v1/metadata?version=v2'
  )
  const responseJson = await resp.json()

  // console.log(`response: ${JSON.stringify(responseJson.data.v2, null, 2)}`)
  const filtered = responseJson.data.v2.match((pool: any) => {
    pool.chain
    pool.tokenMessaging
  })

  console.log(`filtered: ${JSON.stringify(filtered, null, 2)}`)
}

function addressToBytes32(address: string): string {
  // Validate the address
  if (!utils.isAddress(address)) {
    throw new Error('Invalid Ethereum address')
  }

  // Strip the 0x prefix
  const addressWithoutPrefix = address.replace(/^0x/, '')

  // Pad the address to 32 bytes (64 characters) with zeros on the left
  const paddedAddress =
    '0'.repeat(64 - addressWithoutPrefix.length) + addressWithoutPrefix

  // Add the 0x prefix back
  return `0x${paddedAddress}`
}

// returns the LayerZero Eid (Endpoint ID) for a given chainId
// Full list here: https://docs.layerzero.network/v2/developers/evm/technical-reference/deployed-contracts
function getEndpointId(chainId: number): number | undefined {
  const chain = stargateConfig.chains.find((chain) => chain.chainId === chainId)
  return chain ? chain.endpointId : undefined
}

// makes sure the sending wallet has sufficient balance and registers approval in the sending token from wallet to our diamond
const ensureBalanceAndAllowanceToDiamond = async (
  tokenAddress: string,
  wallet: Wallet,
  diamondAddress: string,
  amount: BigNumber
) => {
  // get current allowance in srcToken ()
  const token = ERC20__factory.connect(tokenAddress, wallet)
  const allowance = await token.allowance(wallet.address, diamondAddress)
  console.log('current allowance: %s ', allowance)

  // set allowance
  if (amount.gt(allowance)) {
    await token.approve(diamondAddress, amount)
    console.log('allowance set to: ', amount)
  }

  // check if wallet has sufficient balance
  const balance = await token.balanceOf(wallet.address)
  if (amount.gt(balance))
    throw Error(
      `Wallet has insufficient balance (should have ${amount} but only has ${balance})`
    )
}

// returns a value that signals Stargate to either use Taxi or Bus mode
function oftCmdHelper() {
  const BYTES_TAXI_MODE = '0x'
  const BYTES_BUS_MODE = new Uint8Array(1)

  // destination calls only work with taxi mode
  return WITH_DEST_CALL || IS_TAXI ? BYTES_TAXI_MODE : BYTES_BUS_MODE
}

// we probably do not need the FeeLib anymore since we can all quote info via quoteOFT() and quoteSend()
// Keeping this here for reference
const getAmountOutFeeLib = async (
  feeLibAddress: string,
  provider: providers.FallbackProvider,
  wallet: Wallet,
  dstEid: number,
  amountInSD: string,
  deficitSD: string,
  toOFT = false,
  isTaxi = false
) => {
  // prepare parameters
  const feeParams: FeeParams = {
    sender: wallet.address,
    // dstEid: dstEid,
    dstEid,
    amountInSD,
    deficitSD,
    toOFT,
    isTaxi,
  }

  // prepare FeeLib contract
  const feeLibrary = new Contract(feeLibAddress, FEE_LIBRARY_ABI, provider)

  let amountOut
  try {
    amountOut = await feeLibrary.callStatic.applyFeeView([
      feeParams.sender,
      feeParams.dstEid,
      feeParams.amountInSD,
      feeParams.deficitSD,
      feeParams.toOFT,
      feeParams.isTaxi,
    ])
  } catch (error) {
    console.error(`Error calling applyFeeView:`, error)
  }

  if (!amountOut)
    throw Error(
      `Could not get amountOut for params: ${JSON.stringify(
        feeParams,
        null,
        2
      )}`
    )

  return amountOut
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    console.log('Script ended with errors :/')
    process.exit(1)
  })
