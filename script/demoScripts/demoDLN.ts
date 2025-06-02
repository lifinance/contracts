import dotenv from 'dotenv'
import { ethers, utils } from 'ethers'

import deployments from '../../deployments/arbitrum.staging.json'
import {
  DeBridgeDlnFacet__factory,
  ILiFi,
  type DeBridgeDlnFacet,
  ERC20__factory,
} from '../../typechain'
dotenv.config()

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_ARBITRUM
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const dln = DeBridgeDlnFacet__factory.connect(LIFI_ADDRESS, provider)

  const address = await signer.getAddress()

  let tx

  // Bridge 5 ARB from Polygon to USDC on Optimism
  const resp = await fetch(
    'https://api.dln.trade/v1.0/dln/order/quote?srcChainId=42161&srcChainTokenIn=0x912CE59144191C1204E64559FE8253a0e49E6548&srcChainTokenInAmount=95000000000000000000&dstChainId=100000002&dstChainTokenOut=0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d&prependOperatingExpenses=false'
  )
  const quote = await resp.json()

  console.log(quote)

  const { srcChainTokenIn, dstChainTokenOut } = quote.estimation

  const token = ERC20__factory.connect(srcChainTokenIn.address, provider)

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'ThorSwap',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: srcChainTokenIn.address,
    receiver: address,
    minAmount: srcChainTokenIn.amount,
    destinationChainId: 100,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const dlnData: DeBridgeDlnFacet.DeBridgeDlnDataStruct = {
    receivingAssetId: dstChainTokenOut.address,
    receiver: ethers.utils.solidityPack(['address'], [address]),
    orderAuthorityDst: ethers.utils.solidityPack(['address'], [address]),
    minAmountOut: dstChainTokenOut.recommendedAmount,
  }

  console.info('Dev Wallet Address: ', address)
  console.info('Approving ARB...')
  tx = await token.connect(signer).approve(LIFI_ADDRESS, srcChainTokenIn.amount)
  await tx.wait()
  console.info('Approved ARB')
  console.info('Bridging ARB...')
  tx = await dln
    .connect(signer)
    .startBridgeTokensViaDeBridgeDln(bridgeData, dlnData, {
      value: quote.fixFee,
    })
  await tx.wait()
  console.info('Bridged ARB')
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
