import deployments from '../deployments/polygon.staging.json'
import { SquidFacet__factory, ILiFi, SquidFacet } from '../typechain'
import { ethers, utils } from 'ethers'
import dotenv from 'dotenv'
dotenv.config()

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_POLYGON
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const squidFacet = SquidFacet__factory.connect(LIFI_ADDRESS, provider)

  const route = await fetch('https://api.0xsquid.com/v1/route?fromChain=137&toChain=56&fromToken=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&toToken=0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d&fromAmount=100000000000000000&toAddress=0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0&slippage=1')
  const routeJson = await route.json()

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'Squid',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: '0x0000000000000000000000000000000000000000',
    receiver: '0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0',
    minAmount: '100000000000000000',
    destinationChainId: 56,
    hasSourceSwaps: false,
    hasDestinationCall: false
  }

  const CALL_TYPES: Record<string, number> = {
    'BRIDGE_CALL': 0,
    'CALL_BRIDGE': 1,
    'CALL_BRIDGE_CALL': 2,
  }

  const txRequest = routeJson.route.transactionRequest
  const squidData: SquidFacet.SquidDataStruct = {
    callType: CALL_TYPES[txRequest.routeType],
    callData: txRequest.data,
  }

  const value = bridgeData.minAmount
  const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = txRequest
  const tx = await squidFacet.connect(signer).startBridgeTokensViaSquid(bridgeData, squidData, { value, gasLimit, maxFeePerGas, maxPriorityFeePerGas })
  await tx.wait()
}

main()
  .then(() => {
    console.error('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })
