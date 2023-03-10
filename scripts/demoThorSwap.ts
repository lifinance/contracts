import deployments from '../deployments/mainnet.staging.json'
import { ThorSwapFacet__factory, ILiFi, ThorSwapFacet, ERC20__factory } from '../typechain'
import { ethers, utils } from 'ethers'
import dotenv from 'dotenv'
dotenv.config()

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_MAINNET
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const thorSwapFacet = ThorSwapFacet__factory.connect(LIFI_ADDRESS, provider)

  let resp
  let quote
  let route
  let tx

  resp = await fetch('https://dev-api.thorswap.net/aggregator/tokens/quote?sellAsset=ETH.USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&buyAsset=LTC.LTC&sellAmount=10&recipientAddress=ltc1qpl20tgr56q6wk7t6gug0z77dhk80ppw728mvzx&providers=THORCHAIN')
  quote = await resp.json()
  // @ts-ignore
  route = quote.routes.filter(r => r.optimal === true)[0]

  const token = ERC20__factory.connect(route.calldata.assetAddress, provider)

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'ThorSwap',
    integrator: 'ACME Devs',
    referrer: '0x0000000000000000000000000000000000000000',
    sendingAssetId: route.calldata.assetAddress,
    receiver: ethers.constants.AddressZero,
    minAmount: route.calldata.amountIn,
    destinationChainId: 12121212121212,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const thorSwapData: ThorSwapFacet.ThorSwapDataStruct = {
    routerType: 2, // Thorchain
    tsRouter: route.contract,
    tcRouter: route.calldata.tcRouter,
    tcVault: route.calldata.tcVault,
    tcMemo: route.calldata.memo,
    token: route.calldata.assetAddress,
    router: ethers.constants.AddressZero,
    data: '0x',
    deadline: route.calldata.expiration
  }


  tx = await token.connect(signer).approve(LIFI_ADDRESS, route.calldata.amountIn)
  await tx.wait()
  tx = await thorSwapFacet.connect(signer).startBridgeTokensViaThorSwap(bridgeData, thorSwapData)
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
