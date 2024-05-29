import deployments from '../../deployments/arbitrum.staging.json'
import {
  fetchQuote,
  getSwapFromEvmTxPayload,
  Quote,
} from '@mayanfinance/swap-sdk'
import {
  MayanFacet__factory,
  ILiFi,
  type MayanFacet,
  ERC20__factory,
  IMayan__factory,
} from '../../typechain'
import { ethers, utils, constants } from 'ethers'
import dotenv from 'dotenv'
dotenv.config()

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_ARBITRUM
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond
  const ARB_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
  const POLYGON_USDT_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const mayan = MayanFacet__factory.connect(LIFI_ADDRESS, provider)

  const address = await signer.getAddress()

  let tx

  const quote: Quote[] = await fetchQuote({
    amount: 10,
    fromToken: ARB_USDC_ADDRESS,
    toToken: POLYGON_USDT_ADDRESS,
    fromChain: 'arbitrum',
    toChain: 'polygon',
    slippageBps: 300,
  })

  const payload = getSwapFromEvmTxPayload(
    quote[0],
    address,
    address,
    null,
    address,
    42161,
    null,
    null
  )

  console.log('payload', payload)

  const iface = IMayan__factory.createInterface()
  const parsed = iface.parseTransaction({ data: payload.data as string })

  const token = ERC20__factory.connect(ARB_USDC_ADDRESS, provider)

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'Mayan',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: ARB_USDC_ADDRESS,
    receiver: address,
    minAmount: utils.parseUnits('10', 6),
    destinationChainId: 137,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const mayanData: MayanFacet.MayanDataStruct = {
    mayanProtocol: parsed.args.mayanProtocol,
    protocolData: parsed.args.protocolData,
    nonEVMReceiver:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
  }

  console.info('Dev Wallet Address: ', address)
  console.info('Approving USDC...')
  const gasPrice = await provider.getGasPrice()
  tx = await token
    .connect(signer)
    .approve(LIFI_ADDRESS, constants.MaxUint256, { gasPrice })
  await tx.wait()
  console.info('Approved USDC')
  console.info('Bridging USDC...')
  tx = await mayan
    .connect(signer)
    .startBridgeTokensViaMayan(bridgeData, mayanData, { gasPrice })
  await tx.wait()
  console.info('Bridged USDC')
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
