import deployments from '../../deployments/bsc.staging.json'
import {
  fetchQuote,
  getSwapFromEvmTxPayload,
  Quote,
} from '@mayanfinance/swap-sdk'
import { BigNumber, constants } from 'ethers'
import {
  MayanFacet__factory,
  ILiFi,
  type MayanFacet,
  ERC20__factory,
  IMayan__factory,
} from '../../typechain'
import { ethers, utils } from 'ethers'
import dotenv from 'dotenv'
dotenv.config()

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_BSC
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond
  const ETH_USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const POLYGON_USDT_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const mayan = MayanFacet__factory.connect(LIFI_ADDRESS, provider)

  const address = await signer.getAddress()

  let tx

  const quote: Quote[] = await fetchQuote({
    amount: 1,
    fromToken: constants.AddressZero,
    toToken: POLYGON_USDT_ADDRESS,
    fromChain: 'ethereum',
    toChain: 'polygon',
    slippageBps: 300,
  })

  const payload = getSwapFromEvmTxPayload(
    quote[0],
    address,
    address,
    null,
    address,
    1,
    null,
    null
  )

  console.log('payload', payload)

  // const iface = IMayanBridge__factory.createInterface()
  // const parsed = iface.parseTransaction({ data: payload.data as string })
  //
  // const token = ERC20__factory.connect(BSC_USDT_ADDRESS, provider)
  //
  // const bridgeData: ILiFi.BridgeDataStruct = {
  //   transactionId: utils.randomBytes(32),
  //   bridge: 'Mayan',
  //   integrator: 'ACME Devs',
  //   referrer: '0x0000000000000000000000000000000000000000',
  //   sendingAssetId: BSC_USDT_ADDRESS,
  //   receiver: address,
  //   minAmount: utils.parseEther('10'),
  //   destinationChainId: 137,
  //   hasSourceSwaps: false,
  //   hasDestinationCall: false,
  // }
  //
  // const mayanData: MayanBridgeFacet.MayanBridgeDataStruct = {
  //   mayanAddr: parsed.args.recipient.mayanAddr,
  //   referrer: utils.hexZeroPad('0x', 32),
  //   tokenOutAddr: parsed.args.tokenOutAddr,
  //   receiver: parsed.args.recipient.destAddr,
  //   swapFee: parsed.args.relayerFees.swapFee,
  //   redeemFee: parsed.args.relayerFees.redeemFee,
  //   refundFee: parsed.args.relayerFees.refundFee,
  //   transferDeadline: parsed.args.criteria.transferDeadline,
  //   swapDeadline: parsed.args.criteria.swapDeadline,
  //   amountOutMin: parsed.args.criteria.amountOutMin,
  //   unwrap: parsed.args.criteria.unwrap,
  //   gasDrop: parsed.args.criteria.gasDrop,
  // }
  //
  // console.info('Dev Wallet Address: ', address)
  // console.info('Approving USDT...')
  // const gasPrice = await provider.getGasPrice()
  // tx = await token
  //   .connect(signer)
  //   .approve(LIFI_ADDRESS, constants.MaxUint256, { gasPrice })
  // await tx.wait()
  // console.info('Approved USDT')
  // console.info('Bridging USDT...')
  // tx = await mayan
  //   .connect(signer)
  //   .startBridgeTokensViaMayanBridge(bridgeData, mayanData, { gasPrice })
  // await tx.wait()
  // console.info('Bridged USDT')
}

main()
  .then(() => {
    console.log('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })
