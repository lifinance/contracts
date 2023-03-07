import deployments from '../deployments/polygon.staging.json'
import { SquidFacet__factory, ILiFi, SquidFacet, ERC20__factory } from '../typechain'
import { ethers, utils } from 'ethers'
import dotenv from 'dotenv'
dotenv.config()

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_BSC
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const squidFacet = SquidFacet__factory.connect(LIFI_ADDRESS, provider)

  // Get a route from the Squid API (https://squidrouter.readme.io/reference/get_route)
  const route = await fetch('https://api.0xsquid.com/v1/route?fromChain=56&toChain=42161&fromToken=0x55d398326f99059fF775485246999027B3197955&toToken=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&fromAmount=5000000000000000000&toAddress=0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0&slippage=1')
  const routeJson = await route.json()

  const token = ERC20__factory.connect(routeJson.route.params.fromToken.address, provider)

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'Squid',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: routeJson.route.params.fromToken.address,
    receiver: routeJson.route.params.toAddress,
    minAmount: routeJson.route.params.fromAmount,
    destinationChainId: routeJson.route.params.toChain,
    hasSourceSwaps: false,
    hasDestinationCall: false
  }

  const txRequest = routeJson.route.transactionRequest
  const squidData: SquidFacet.SquidDataStruct = {
    callData: txRequest.data,
  }

  let { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = txRequest
  gasLimit = (parseInt(gasLimit) + 100000).toString()

  let tx = await token.connect(signer).approve(LIFI_ADDRESS, bridgeData.minAmount, { gasLimit: '70000', maxFeePerGas, maxPriorityFeePerGas })
  await tx.wait()
  tx = await squidFacet.connect(signer).startBridgeTokensViaSquid(bridgeData, squidData, { gasLimit, maxFeePerGas, maxPriorityFeePerGas })
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
